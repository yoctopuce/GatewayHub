"use strict";

require('yoctolib-es2017/yocto_api.js');

const { URL } = require('url');
const http = require('http');
const https = require('https');
const mqtt = require('mqtt');
const wsWebSocket = require('ws');

const CALLBACK_TIMEOUT = 10000;

const CB_IDLE = 0;
const CB_TRIGGERED = 1;
const CB_OPEN = 4;
const CB_MQTT_WAIT_CONNECT = 5;
const CB_MQTT_CONNECTED = 6;
const CB_READ_BODY = 20;
const CB_WEBSOCK_ACCEPT = 22;
const CB_WEBSOCK_CONNECTED = 23;
const CB_EXEC_QUERY = 25;
const CB_FAILED = 26;
const CB_WAIT = 27;

const NOT_YET_RUN = '[callback not yet started]';

function timeUtc()
{
    return Math.floor(Date.now() / 1000);
}

class YCallback
{
    constructor(parent, template)
    {
        this.parent = parent;

        this.state = CB_IDLE;
        this.trigger = false;       // trigger to start as soon as minTime is elapsed
        this.hardtrigger = false;   // trigger to retry callback as soon as possible
        this.timeref = 0;
        this.utcref = 0;
        this.cbConn = {
            isHttp: false,
            isWebsocket: false,
            isMqtt: false,
            connected: false,
            ctx: null
        };
        this.errmsg = '';
        this.buf = '';
        this.cbOutput = '';
        this.cbOutPos = 0;
        this.lastOutput = NOT_YET_RUN;

        this.imm_reset(template);
    }

    imm_reset(template)
    {
        let prevSettings = '';
        if(this.lastOutput !== NOT_YET_RUN) {
            prevSettings = this.Method+this.Encoding+this.Url+JSON.stringify(this.Credentials);
        }
        this.Method = (template.Method || 'POST');
        this.Encoding = (template.Encoding || 'Yocto-API');
        this.Url = (template.Url || '');
        this.Credentials = (template.Credentials || { user: '', pass: '' });
        this.Schedule = (template.Schedule || {
            minPeriod: 30,          // periodicity when a value has chanegd (in sec, min or hours)
            minMinutes: false,      // min periodicity unit: minute
            minHours: false,        // min periodicity unit: hour
            maxPeriod: 30,          // periodicity when no value changes (in sec, min or hours)
            maxMinutes: false,      // max periodicity unit: minute
            maxHours: false,        // max periodicity unit: hour
            maxOffset: 0,           // in aligned mode, offset of long callback within period
            alignPeriod: true,      // period alignment
            paused: false           // currently paused
        });

        if(prevSettings !== this.Method+this.Encoding+this.Url+JSON.stringify(this.Credentials)) {
            this.lastOutput = NOT_YET_RUN;
        }
    }

    imm_describeSchedule()
    {
        let res = (this.Schedule.alignPeriod ? 'every ' : 'after ');
        let minwait = this.Schedule.minPeriod.toString();
        let minunit = (this.Schedule.minHours ? 'h' : (this.Schedule.minMinutes ? 'm' : 's'));
        let maxwait = this.Schedule.maxPeriod.toString();
        let maxunit = (this.Schedule.maxHours ? 'h' : (this.Schedule.maxMinutes ? 'm' : 's'));
        minwait += minunit;
        maxwait += maxunit;
        if(minwait === maxwait) {
            res += maxwait;
        } else {
            res += minwait + ' / ' + maxwait;
        }
        if(this.Schedule.alignPeriod) {
            res += ' + ' + this.Schedule.maxOffset.toString() + maxunit;
        }
        return res;
    }

    async buildBuff()
    {
        let yctx = this.parent.yapi;
        let hubip = this.parent.hubip;
        let utcSec = timeUtc();

        // Build buffer
        let buf = '';
        let module = YModule.FirstModuleInContext(yctx);
        while(module) {
            let serial = await module.get_serialNumber();
            let logname = await module.get_logicalName();
            let devname = (logname !== '' ? logname : serial);
            let fcount = await module.functionCount();
            for(let f = 0; f < fcount; f++) {
                let fclass = await module.functionBaseType(f);
                let ftype = await module.functionType(f);
                if (ftype === 'Files' || ftype === 'Network') {
                    continue;
                }
                let autoname = (ftype === 'HubPort');
                let funcName = await module.functionName(f);
                let funcId = await module.functionId(f);
                let funcVal = await module.functionValue(f);
                if (this.Encoding === 'CSV') {
                    if (autoname) continue;
                    if (ftype === 'DataLogger') continue;
                }
                // report only YSensor and AnButton functions with some exceptions
                if (fclass !== 'Sensor' && ftype !== 'AnButton') {
                    if (ftype === 'Cellular' || ftype === 'Wireless') {
                        if (this.Encoding === 'CSV' || this.Encoding === 'JSON-Num' || this.Encoding === 'EMONCMS' ||
                            this.Encoding === 'INFLUXDB' || this.Encoding === 'PRTG') {
                            // drop non numerical value and remove '%' sign at end of advertised values
                            // (would break many graphing software, including Cosm, influxdb, etc)
                            let numVal = parseInt(funcVal);
                            if (!numVal) continue;
                            funcVal = '' + numVal;
                        }
                    } else {
                        if (this.Encoding === 'JSON-Num' || this.Encoding === 'EMONCMS' ||
                            this.Encoding === 'INFLUXDB' || this.Encoding === 'PRTG') {
                            continue;
                        }
                    }
                }
                if (funcVal === '') {
                    continue;
                }
                if (buf === '') {
                    // prepend timestamp and network name
                    if (this.Encoding === 'WWW-Form') {
                        buf = 'timestamp=' + utcSec + '&network=' + this.parent.netname + '&';
                    } else if (this.Encoding === 'CSV') {
                        if (this.Method !== 'GET') {
                            buf = 'timestamp=' + utcSec + '\r\n';
                        }
                    } else if (this.Encoding === 'INFLUXDB') {
                        buf = 'yoctopuce,name=' + this.parent.netname + ',ip=' + hubip + ' ';
                    } else if (this.Encoding === 'EMONCMS') {
                        let utcRdy = utcSec > 0x40000000;
                        if (utcRdy) {
                            buf = '&time=' + utcSec;
                        }
                        buf += '&json={';
                    } else if (this.Encoding === 'PRTG') {
                        buf = '{"prtg":{"result":[\r\n';
                    } else {
                        buf = '{"timestamp":';
                        if (this.Encoding !== 'JSON-Num') {
                            buf += '"';
                        }
                        buf += utcSec;
                        if (this.Url.substr(7, 18) === "things.ubidots.com") {
                            buf += '000';
                        }
                        if (this.Encoding !== 'JSON-Num') {
                            buf += '",';
                            if (this.Method !== 'GET') buf += '\r\n';
                            buf += '"network":"' + this.parent.netname + '"';
                        }
                        buf += ',';
                        if (this.Method !== 'GET') buf += '\r\n';
                    }
                } else {
                    // prepend separator
                    if (this.Encoding === 'WWW-Form') buf += '&';
                    else if (this.Encoding !== 'CSV' || this.Method === 'GET') buf += ',';
                }
                if (funcName !== '' && !autoname) {
                    // add named function
                    if (this.Encoding === 'WWW-Form') {
                        buf += funcName + '=' + funcVal;
                    } else if (this.Encoding === 'CSV') {
                        buf += funcName + ',' + funcVal;
                        if (this.Method !== 'GET') buf += '\r\n';
                    } else if (this.Encoding === 'INFLUXDB') {
                        buf += funcName + '=' + funcVal;
                    } else {
                        if (this.Encoding === 'PRTG') {
                            buf += '{"channel":';
                        }
                        buf += '"' + funcName + '"';
                        if (this.Encoding === 'PRTG') {
                            buf += ',"value"';
                        }
                        buf += ':';
                        if (this.Encoding !== 'JSON-Num' && this.Encoding !== 'EMONCMS') buf += '"';
                        buf += funcVal;
                        if (this.Encoding !== 'JSON-Num' && this.Encoding !== 'EMONCMS') buf += '"';
                        if (this.Encoding === 'PRTG') {
                            buf += ',"float":"1","DecimalMode":"All"}';
                        }
                        if (this.Method !== 'GET') buf += '\r\n';
                    }
                } else {
                    // add generic
                    if (this.Encoding === 'WWW-Form') {
                        buf += devname + '%23' + funcId + '=' + (autoname && funcName ? funcName : funcVal);
                    } else if (this.Encoding === 'CSV') {
                        buf += devname + '.' + funcId + ',' + funcVal;
                        if (this.Method !== 'GET') buf += '\r\n';
                    } else if (this.Encoding === 'INFLUXDB') {
                        buf += devname + '_' + funcId + '=' + funcVal;
                    } else {
                        if (this.Encoding === 'PRTG') {
                            buf += '{"channel":';
                        }
                        buf += '"' + devname + '.' + funcId + '"';
                        if (this.Encoding === 'PRTG') {
                            buf += ',"value"';
                        }
                        buf += ':';
                        if (this.Encoding !== 'JSON-Num' && this.Encoding !== 'EMONCMS') buf += '"';
                        buf += (autoname && funcName ? funcName : funcVal);
                        if (this.Encoding !== 'JSON-Num' && this.Encoding !== 'EMONCMS') buf += '"';
                        if (this.Encoding === 'PRTG') {
                            buf += ',"float":"1","DecimalMode":"All"}';
                        }
                        if (this.Method !== 'GET') buf += '\r\n';
                    }
                }
            }
            module = module.nextModule();
        }
        if(this.Encoding === 'INFLUXDB') {
            if (buf !== '') {
                // append timestamp
                buf += ' '+utcSec;
            }
        } else if(this.Encoding === 'PRTG') {
            if (buf === '') {
                buf = '{"prtg":{"result":[';
            }
            buf += ']}}';
        } else if(this.Encoding !== 'WWW-Form' && this.Encoding !== 'CSV') {
            if (buf === '') buf = '{';
            buf += '}'
        }
        return buf;
    }

    async buildYoctoAPI()
    {
        let yctx = this.parent.yapi;
        let jsonapi = { "serial": this.parent.hubserial };

        // Add API content
        let module = YModule.FirstModuleInContext(yctx, this.parent.hubserial);
        jsonapi['/api.json'] = JSON.parse(yctx.imm_bin2str(await module.download('api.json')));
        module = YModule.FirstModuleInContext(yctx);
        while(module) {
            let serial = await module.get_serialNumber();
            if(serial !== this.parent.hubserial) {
                jsonapi['/bySerial/'+serial+'/api.json'] = JSON.parse(yctx.imm_bin2str(await module.download('api.json')));
            }
            module = module.nextModule();
        }

        // Append signature if needed
        if(this.Credentials.user === 'md5') {
            let hexpass = this.Credentials.pass;
            if(hexpass.length !== 32) {
                let md5ctx = new Y_MD5Ctx();
                md5ctx.addData(this.Credentials.pass);
                hexpass = yctx.imm_bin2hexstr(md5ctx.calculate());
            }
            hexpass = hexpass.toLowerCase();
            jsonapi["sign"] = hexpass;
            let buf = JSON.stringify(jsonapi);
            let md5ctx = new Y_MD5Ctx();
            md5ctx.addData(buf);
            return buf.replace(hexpass, yctx.imm_bin2hexstr(md5ctx.calculate()))
        } else {
            return JSON.stringify(jsonapi);
        }
    }

    async useCbData()
    {
        if(this.cbdataBusy) return;
        this.cbdataBusy = true;
        let yctx = this.parent.yapi;
        let endLine = this.cbdata.indexOf('\n', this.cbOutPos);
        while(endLine >= 0) {
            if(endLine >= this.cbOutPos) {
                let line = this.cbdata.substr(this.cbOutPos, endLine-this.cbOutPos);
                if(/^@YoctoAPI:/.test(line)) {
                    if(/^@YoctoAPI:GET \//.test(line)) {
                        let relUrl = line.substr(15);
                        let module = YModule.FindModuleInContext(yctx, this.parent.hubserial);
                        await module.download(relUrl);
                    } else {
                        let parts = /^@YoctoAPI:POST \/([^ ]*)upload.html ([0-9]+):/.exec(line);
                        if(parts) {
                            let devUrl = parts[1];
                            let size = parseInt(parts[2]);
                            if(this.cbdata.length < endLine+1+size) break;
                            let body = this.cbdata.substr(endLine+1, size);
                            let fnamePos = body.indexOf('name="');
                            let endHeader = body.indexOf('\r\n\r\n');
                            if(fnamePos > 0 && endHeader > fnamePos) {
                                let fnameLen = body.indexOf('"', fnamePos+6) - (fnamePos+6);
                                let boundary = line.substr(parts[0].length);
                                let fname = body.substr(fnamePos+6, fnameLen);
                                let payload = yctx.imm_str2bin(body.slice(endHeader+4, -(boundary.length+8)));
                                let serial = (devUrl === '' ? this.parent.hubserial : devUrl.slice(9,-1));
                                let module = YModule.FindModuleInContext(yctx, serial);
                                await module._upload(fname, payload);
                            }
                            // prune body from output
                            this.cbdata = this.cbdata.slice(0, endLine+1) + this.cbdata.slice(endLine+1+size);
                        }
                    }
                }
            }
            this.cbOutPos = endLine+1;
            endLine = this.cbdata.indexOf('\n', this.cbOutPos);
        }
        this.cbOutput = this.cbdata.substr(0,this.cbOutPos);
        this.cbdataBusy = false;
    }

    imm_setupWait(nextState)
    {
        this.state = nextState;
        if(nextState === CB_WAIT) {
            // Reference time is always the switch to WAIT state
            this.utcref = timeUtc();
            // Also backup last output at that point
            this.lastOutput = this.cbOutput;
        }
        if(!this.Schedule.alignPeriod) {
            return;
        }
        let offsetSec = this.Schedule.maxOffset;

        if(this.Schedule.maxMinutes) offsetSec *= 60;
        else if(this.Schedule.maxHours) offsetSec *= 3600;
        if(nextState === CB_WAIT) {
            let cbackMinSec = this.Schedule.minPeriod;
            if(this.Schedule.minMinutes) cbackMinSec *= 60;
            else if(this.Schedule.minHours) cbackMinSec *= 3600;
            this.utcref = (this.utcref - offsetSec) / cbackMinSec * cbackMinSec + offsetSec;
        } else {
            let cbackMaxSec = this.Schedule.maxPeriod;
            if(this.Schedule.maxMinutes) cbackMaxSec *= 60;
            else if(this.Schedule.maxHours) cbackMaxSec *= 3600;
            this.utcref = (this.utcref - offsetSec) / cbackMaxSec * cbackMaxSec + offsetSec;
        }
    }

    imm_cbConnIsInvalid()
    {
        return this.cbConn.ctx === null;
    }

    imm_cbConnSetInvalid()
    {
        this.cbConn.isHttp = false;
        this.cbConn.isWebsocket = false;
        this.cbConn.isMqtt = false;
        this.cbConn.connected = false;
        this.cbConn.ctx = null;
    }

    imm_cbConnect()
    {
        let errHandler = (err) => {
            console.log(err);
            this.state = CB_FAILED;
            this.errmsg = err.msg;
            this.cbConn.connected = false;
        };
        if(this.cbConn.isHttp) {
            let url = new URL(this.Url);
            let options = {
                method : this.Method,
                protocol : url.protocol,
                hostname: url.hostname,
                port: url.port,
                path: url.pathname+url.search
            };
            if(this.Method === 'GET' && this.Encoding !== 'Yocto-API') {
                if(!url.search) options.path += '?';
                options.path += this.buf;
            }
            if (this.Credentials.user) {
                options.auth = this.Credentials.user+':'+this.Credentials.pass;
            }
            if(this.Method !== 'GET') {
                let mimeType = (this.Encoding === 'WWW-Form' ? 'x-www-form-urlencoded':
                    (this.Encoding === 'CSV' || this.Encoding === 'INFLUXDB' ? 'csv' : 'json'));
                options.headers = {
                    'Content-Type': 'application/'+mimeType,
                    'User-Agent': this.parent.hubtype,
                    'Content-Length': Buffer.byteLength(this.buf)
                };
            }
            this.cbConn.ctx = (options.protocol === 'https:' ? https : http).request(options, (res) => {
                this.cbConn.connected = true;
                this.cbdata = '';
                this.cbdataBusy = false;
                this.cbOutput = '[Connected]\n';
                res.on('data', (data) => {
                    this.timeref = Date.now();
                    this.cbdata += YAPI.imm_bin2str(data);
                    this.useCbData();
                });
                res.on('end', () => {
                    this.cbOutput = this.cbdata;
                    this.cbConn.connected = false;
                });
            });
            this.cbConn.ctx.on('error', errHandler);
            if(this.Method !== 'GET') {
                this.cbConn.ctx.write(this.buf);
            }
            this.cbConn.ctx.end();
            return true;
        } else if(this.cbConn.isWebsocket) {
            this.cbConn.ctx = new wsWebSocket(this.Url);
            this.cbConn.ctx.on('open', () => { this.cbConn.connected = true; });
            this.cbConn.ctx.on('error', errHandler);
            return true;
        } else if(this.cbConn.isMqtt) {
            let options = { clientId: this.parent.hubserial };
            let url = /[^?]+/.exec(this.Url)[0];
            let cid = /cid=[^&]+/.exec(this.Url);
            let root = /root=[^&]+/.exec(this.Url);
            if (cid) {
                options.clientId = cid[0].substr(4);
            }
            if (this.Credentials.user) {
                options.username = this.Credentials.user;
                options.password = this.Credentials.pass;
            }
            this.cbConn.ctx = mqtt.connect(url, options);
            this.cbConn.ctx.on('connect', () => {
                this.cbConn.connected = true;
            });
            this.cbConn.ctx.on('error', errHandler);
            if(root) {
                root = root[0].substr(5);
                if(root.substr(-1) !== '/') root += '/';
            } else {
                root = '';
            }
            this.buf = { rootTopic: root };
            return true;
        }
        return false;
    }

    imm_cbIsConnected()
    {
        return this.cbConn.connected;
    }

    imm_cbClose()
    {
        if(this.cbConn.isHttp) {
            this.cbConn.ctx.abort();
        } else if(this.cbConn.isWebsocket) {
            this.cbConn.ctx.close();
        } else if(this.cbConn.isMqtt) {
            this.cbConn.ctx.end();
        }
        this.cbConn.connected = false;
    }

    imm_abort()
    {
        if(!this.imm_isIdle()) {
            this.errmsg = "user abort";
            this.state = CB_FAILED;
            if(!this.imm_cbConnIsInvalid()) {
                this.imm_cbClose();
                this.imm_cbConnSetInvalid();
            }
        }
    }

    imm_isIdle()
    {
        return (this.state === CB_IDLE || this.state === CB_WAIT);
    }

    imm_isActive()
    {
        return (this.state >= CB_OPEN && this.state <= CB_FAILED);
    }

    imm_isCompleted()
    {
        return (this.state === CB_WAIT);
    }

    async run()
    {
        let yctx = this.parent.yapi;
        let initState = this.state;
        let res = 0;

        // Handle disconnection from callback
        if(this.state > CB_OPEN && this.state < CB_FAILED) {
            if(!this.imm_cbIsConnected()) {
                if(this.state !== CB_EXEC_QUERY) {
                    res = 1;
                    if(this.state !== CB_READ_BODY && this.state !== CB_WEBSOCK_CONNECTED && this.state !== CB_MQTT_CONNECTED) {
                        this.errmsg = 'closed by server';
                        this.buf = '';
                        this.state = CB_FAILED;
                    } else {
                        if(!this.imm_cbConnIsInvalid()) {
                            this.imm_cbClose();
                            this.imm_cbConnSetInvalid();
                        }
                        this.imm_setupWait(CB_WAIT);
                    }
                }
            }
        }
        switch(this.state) {
            case CB_FAILED:
                if(this.errmsg) {
                    this.parent.log('out','Error: '+this.errmsg);
                    this.cbOutput += '\n[ERROR: '+this.errmsg+']\n';
                }
                if(!this.imm_cbConnIsInvalid()) {
                    this.imm_cbClose();
                    this.imm_cbConnSetInvalid();
                }
                if(this.Encoding === 'Yocto-API') {
                    // cleanup parent api connection for next call
                    this.parent.closeHub();
                }
                // trigger retry after shortest wait period
                this.trigger = true;
                // retry after MinWait
                this.imm_setupWait(CB_WAIT);
            // fall through
            case CB_WAIT:
                this.cbOutput = '';
                this.cbOutPos = 0;
                if(this.hardtrigger) {
                    // fast connection requested after 5 seconds in any case
                    if((timeUtc() - this.utcref) < 5) break;
                    this.hardtrigger = false;
                    this.trigger = true;
                } else {
                    let cbackMinSec = this.Schedule.minPeriod;
                    if(this.Schedule.minMinutes) cbackMinSec *= 60;
                    else if(this.Schedule.minHours) cbackMinSec *= 3600;
                    if((timeUtc() - this.utcref) < cbackMinSec) break;
                }
                this.imm_setupWait(CB_IDLE);
            // fall through
            case CB_IDLE:
                let cbackMaxSec = this.Schedule.maxPeriod;
                if(this.Schedule.maxMinutes) cbackMaxSec *= 60;
                else if(this.Schedule.maxHours) cbackMaxSec *= 3600;
                if ((this.trigger || (timeUtc() - this.utcref) > cbackMaxSec) && !this.Schedule.paused) {
                    if (this.Encoding === 'MQTT') {
                        this.cbConn.isMqtt = true;
                    } else if(/^https*:\/\//.test(this.Url)) {
                        this.cbConn.isHttp = true;
                    } else if(/^wss*:\/\//.test(this.Url)) {
                        this.cbConn.isWebsocket = true;
                    } else {
                        break;
                    }
                    if (this.Encoding === 'Yocto-API') {
                        this.trigger = false;
                        this.buf = await this.buildYoctoAPI();
                    } else if (this.Encoding !== 'MQTT') {
                        this.trigger = false;
                        this.buf = await this.buildBuff();
                    }
                    this.timeref = Date.now();
                    this.state = CB_TRIGGERED;
                }
                break;
            case CB_TRIGGERED:
                // wait 50ms more to get all grouped notifications
                if(Date.now() - this.timeref < 50) break;
                this.timeref = Date.now();
                // Open connection
                let i = this.Url.indexOf('//')+2;
                if(this.Url.substr(i) === '') {
                    // empty URL, don't send any notification
                    this.errmsg = 'bad URL';
                    this.state = CB_FAILED;
                    break;
                }
                if ((this.Encoding === 'Yocto-API') && this.Credentials.user === "md5") {
                    this.md5ctx = new Y_MD5Ctx();
                }
                if(!this.imm_cbConnect()) {
                    this.errmsg = 'failed to initiate connection';
                    this.hardtrigger = true;
                    this.state = CB_FAILED;
                } else {
                    if (this.cbConn.isMqtt) {
                        this.state = CB_MQTT_WAIT_CONNECT;
                    } else if (this.cbConn.isWebsocket) {
                        this.state = CB_WEBSOCK_ACCEPT;
                    } else {
                        this.state = CB_OPEN;
                    }
                }
                break;
            case CB_MQTT_WAIT_CONNECT:
                if (!this.imm_cbIsConnected()) {
                    if (Date.now() - this.timeref > CALLBACK_TIMEOUT) {
                        this.errmsg = "failed to connect";
                        this.hardtrigger = true;
                        this.state = CB_FAILED;
                    }
                    break;
                }
                this.cbOutput += '[MQTT Connected]\n';
                this.parent.log('out',"Outgoing callback connected (MQTT)");
                this.state = CB_MQTT_CONNECTED;
                break;
            case CB_MQTT_CONNECTED:
                let module = YModule.FirstModuleInContext(this.parent.yapi);
                while(module) {
                    let serial = await module.get_serialNumber();
                    let devname = await module.get_logicalName();
                    let prefix = (devname === '' ? serial : devname) + '/';
                    let fcount = await module.functionCount();
                    for (let f = 0; f < fcount; f++) {
                        let fclass = await module.functionBaseType(f);
                        let ftype = await module.functionType(f);
                        if (ftype === 'Files' || ftype === 'Network') {
                            continue;
                        }
                        let funcName = await module.functionName(f);
                        if(funcName === '') {
                            funcName = await module.functionId(f);
                        }
                        let funcVal = await module.functionValue(f);
                        if(this.buf[prefix+funcName] === undefined || this.buf[prefix+funcName] !== funcVal) {
                            this.buf[prefix+funcName] = funcVal;
                            this.cbConn.ctx.publish(this.buf.rootTopic+prefix+funcName, funcVal)
                        }
                    }
                    module = module.nextModule();
                }
                break;
            case CB_OPEN:
                if(!this.imm_cbIsConnected() && this.cbOutput === '') {
                    if(Date.now() - this.timeref > CALLBACK_TIMEOUT) {
                        this.errmsg = "failed to connect";
                        this.hardtrigger = true;
                        this.state = CB_FAILED;
                    }
                    break;
                }
                this.parent.log('out','Outgoing HTTP callback connected');
                this.timeref = Date.now();
                this.state = CB_READ_BODY;
            // fall through
            case CB_READ_BODY:
                // consume until disconnected
                if(Date.now() - this.timeref > CALLBACK_TIMEOUT) {
                    this.errmsg = "timeout reading body";
                    this.buf = '';
                    this.state = CB_FAILED;
                }
                break;
            case CB_WEBSOCK_ACCEPT:
                if(!this.imm_cbIsConnected()) {
                    if(Date.now() - this.timeref > CALLBACK_TIMEOUT) {
                        this.errmsg = "failed to connect";
                        this.hardtrigger = true;
                        this.state = CB_FAILED;
                    }
                    break;
                }
                await yctx.WebSocketJoin(this.cbConn.ctx, [ { user: 'ws', pass: this.Credentials.pass, admin: true } ], ()=>{this.parent.closeHub();});
                this.cbOutput += '[WebSocket Connected]\n';
                this.parent.log('out','Outgoing callback connected (WebSocket)');
                this.state = CB_WEBSOCK_CONNECTED;
                break;
            case CB_WEBSOCK_CONNECTED:
                break;
        }
        if(initState !== this.state) {
            //this.parent.log('out','State '+initState+' -> '+this.state);
        }
    }
}

module.exports = YCallback;

