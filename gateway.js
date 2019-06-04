"use strict";

require('yoctolib-es2017/yocto_api.js');
require('yoctolib-es2017/yocto_network.js');

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const express = require('express');
const express_ws = require("express-ws");
const bodyParser = require('body-parser');
const app = express();

// Setup ports
const http_port = (process.argv.length < 3 ? 44080 : parseInt(process.argv[2]));
const https_port = (process.argv.length < 4 ? 44443 : parseInt(process.argv[3]));
// Configuration file
const configfile = path.join(__dirname, 'gateway.conf');

const YCallback = require('./callback.js');

class YSubdomain
{
    constructor(name, cbpass, auth, outcb)
    {
        this.name = name;
        this.pass = cbpass;
        this.auth = auth;
        this.cback = [];
        this.hubserial = '';
        this.hubtype = '';
        this.hubip = '';
        this.netname = '';
        this.yapi = null;
        this.client = '';
        this.devs = {};
        this.hublog = [];
        this.apilog = [];
        this.outlog = [];
        this.timeoutId = null;
        this.prevPing = 0;
        this.testcb = null;
        this.cbIdx = 0;

        // configurable parameters
        this.maxLogSize = 10;
        this.pingDelay = 10000; // 10 seconds

        // instantiate callback handlers
        if (outcb) {
            for (let i = 0; i < outcb.length; i++) {
                this.cback.push(new YCallback(this, outcb[i]));
            }
        }
    }

    // Log-to-memory that detects duplicate messages
    //
    async log(logtype, msg)
    {
        let logbuff = this[logtype + 'log'];
        let now = new Date();
        let day = now.getFullYear().toString() + '-' + ('0' + (now.getMonth() + 1)).slice(-2) + '-' + ('0' + now.getDate()).slice(-2);
        let time = now.getHours().toString() + ':' + ('0' + now.getMinutes()).slice(-2) + ':' + ('0' + now.getSeconds()).slice(-2);
        console.log(day + ' ' + time + ' [' + this.name + '] ' + msg);
        msg = day + ' ' + time + ' ' + msg;
        if (logbuff.length > 0) {
            let found = logbuff[logbuff.length - 1].match(/last message repeated ([0-9]+) times/);
            if (found) {
                if (logbuff[logbuff.length - 2].slice(20) === msg.slice(20)) {
                    logbuff.pop();
                    msg = day + ' ' + time + ' (last message repeated ' + (parseInt(found[1]) + 1) + ' times)';
                }
            } else {
                if (logbuff[logbuff.length - 1].slice(20) === msg.slice(20)) {
                    msg = day + ' ' + time + ' (last message repeated 2 times)';
                }
            }
        }
        logbuff.push(msg);
        if (logbuff.length > this.maxLogSize) {
            logbuff.shift();
        }
    }

    // Close hub connection forcefully, to reinitialize it
    //
    async closeHub(reason)
    {
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }
        if (this.yapi) {
            this.log('hub', reason || ('Disconnecting ' + this.netname));
            try {
                await this.yapi.KillAPI();
            } catch (e) {
                console.log('Caught exception in FreeAPI', e);
            }
        }
        this.hubserial = '';
        this.hubtype = '';
        this.hubip = '';
        this.netname = '';
        this.yapi = null;
        this.client = '';
        this.devs = {};
    }

    // Function called periodically when no client is connected
    //
    async runJob()
    {
        let nextRun = 500;
        let nextCb = null;

        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }

        // Determine if we need to work on another callback
        if (this.cbIdx >= this.cback.length) {
            this.cbIdx = 0;
        }
        if (this.testcb && !this.testcb.imm_isCompleted()) {
            if (this.cbIdx >= 0 && this.cbIdx < this.cback.length) {
                if (!this.cback[this.cbIdx].imm_isIdle()) {
                    this.cback[this.cbIdx].imm_abort();
                }
                nextCb = -1;
            }
        } else {
            if (this.cbIdx === -1) this.cbIdx = 0;
            if (this.cback.length > 0) {
                if (this.cback[this.cbIdx].imm_isIdle()) {
                    nextCb = this.cbIdx + 1;
                    if (nextCb >= this.cback.length) nextCb = 0;
                    if (nextCb === this.cbIdx) nextCb = null;
                }
            }
        }
        if (nextCb !== null) {
            this.cbIdx = nextCb;
        }

        // Every while, or before starting a callback, check that hub is alive
        // (this does not cause any extra communication)
        if (nextCb !== null || (Date.now() - this.prevPing) >= this.pingDelay) {
            if (!this.yapi || await this.yapi.TestHub('callback', 0) !== YAPI.SUCCESS) {
                return this.closeHub('Hub ' + this.netname + ' stalled, disconnecting');
            }
            this.prevPing = Date.now();
        }

        // Invoke callback if needed
        if (this.cbIdx === -1) {
            await this.testcb.run();
            if (this.testcb.imm_isActive()) nextRun = 5;
        } else if (this.cbIdx < this.cback.length) {
            await this.cback[this.cbIdx].run();
            if (this.cback[this.cbIdx].imm_isActive()) nextRun = 5;
        }

        this.timeoutId = setTimeout(() => {
            this.runJob();
        }, nextRun);
    }

    // Register an incoming hub and store device details.
    // Called by the incoming websocket handler.
    //
    async acceptHub(ws, remoteAddress)
    {
        // Drop any previous open context for this subdomain
        this.closeHub();

        // Attempt to connect to the incoming hub and enumerate devices
        let yctx = new YAPIContext();
        try {
            let errmsg = new YErrorMsg();
            if ((await yctx.RegisterHubWebSocketCallback(ws, errmsg, this.pass)) !== YAPI.SUCCESS) {
                this.log('hub', 'RegisterHub error: ' + errmsg);
                yctx.FreeAPI();
                return false;
            }

            // Enumerate available devices
            await yctx.UpdateDeviceList(errmsg);
            // Find network interface name from yellow pages
            let network = YNetwork.FirstNetworkInContext(yctx);
            if (network) {
                let module = await network.get_module();
                let fcount = await module.functionCount();
                this.hubserial = await module.get_serialNumber();
                this.hubtype = await module.get_productName();
                this.hubip = remoteAddress;
                for (let f = 0; f < fcount; f++) {
                    if (await module.functionId(f) === 'network') {
                        this.netname = await module.functionName(f);
                    }
                }
                this.log('hub', 'Hub ' + this.hubserial + ' (' + this.netname + ') connected');
            }
            let module = YModule.FirstModuleInContext(yctx);
            while (module) {
                let serial = await module.get_serialNumber();
                this.devs[serial] = {
                    "serialNumber": serial,
                    "logicalName": await module.get_logicalName(),
                    "productName": await module.get_productName()
                };
                module = module.nextModule();
            }

            // Keep this context available for API connections
            this.yapi = yctx;

            // Run background tasks on hub while no client is connected
            this.prevPing = Date.now();
            this.runJob();
        } catch (e) {
            this.log('hub', 'Exception: ' + e.toString());
            this.hubserial = '';
            this.hubtype = '';
            this.hubip = '';
            this.netname = '';
            this.devs = {};
            await yctx.FreeAPI();
            return false;
        }
        // Success
        return true;
    }

    // Register an incoming API connection
    // Called by the incoming websocket handler.
    //
    async acceptAPI(ws, timeout, client)
    {
        while ((!this.yapi || this.yapi._hubs.length === 0 || !this.timeoutId) && timeout > 0) {
            // no hub connected yet, or busy with a callback: wait a bit
            await YAPI.Sleep(100);
            timeout -= 100;
        }
        if (!this.yapi || this.yapi._hubs.length === 0) {
            // no hub is connected, bad luck
            return false;
        }
        // Disable ping task when client is connected
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }
        this.client = client;
        await this.yapi.WebSocketJoin(ws, this.auth, () => {
            this.closeHub();
        });

        // Success
        return true;
    }

    static async WebSocketCallbackHandler(ws, req)
    {
        // Ensure the request comes for a registered subdomain
        let name = req.url.slice(1, req.url.indexOf('/', 1));
        let subdom = YSubdomain.list[name];
        if (!subdom) {
            console.log('Websocket callback for invalid subdomain ' + name);
        } else {
            let remoteAddress = req.socket.remoteAddress.replace('::ffff:', '');
            subdom.log('hub', 'Incoming hub: ' + remoteAddress);
            if (await subdom.acceptHub(ws, remoteAddress) === true) {
                // keep websocket connection open
                return;
            }
        }
        ws.close();
    }

    static async WebSocketAPIHandler(ws, req)
    {
        // Ensure the request comes for a registered subdomain
        let name = req.url.slice(1, req.url.indexOf('/', 1));
        let subdom = YSubdomain.list[name];
        if (!subdom) {
            console.log('API connection for invalid subdomain ' + name);
        } else {
            subdom.log('api', 'Incoming API client: ' + req.socket.remoteAddress.replace('::ffff:', ''));
            if (await subdom.acceptAPI(ws, 2000) === true) {
                subdom.log('api', 'API client connected');
                // keep websocket connection open
                return;
            }
        }
        ws.close();
    }

    // Check credentials of a user/pass is valid for this subdomain
    // 0=unauthorized, 1=authorized, 2=admin
    //
    isAuthorized(username, userpass)
    {
        let auth = this.auth;
        for (let j = 0; j < auth.length; j++) {
            if (auth[j].user === username && auth[j].pass === userpass) {
                return (auth[j].admin ? 2 : 1);
            }
        }
        return false;
    }

    // Handle a user management action:
    // Cb-callback_id to remove a callback definition
    // Cb#callback_id to change/add a callback definition
    //
    handleEditCbMgmtAction(action, defstr)
    {
        let id = parseInt(action.substr(3));
        switch (action.substr(2, 1)) {
            case '-':
                if (id < this.cback.length) {
                    this.cback.splice(id, 1);
                    YSubdomain.SaveConfig();
                }
                break;
            case '+':
                try {
                    let def = JSON.parse(defstr);
                    if (id < this.cback.length) {
                        this.cback[id].imm_reset(def);
                    } else {
                        this.cback.push(new YCallback(this, def));
                    }
                    YSubdomain.SaveConfig();
                } catch (e) {
                    console.log(e);
                }
        }
    }

    // Handle a user management action:
    // -username            to remove a user
    // +username,pass,admin to add a user
    // #cbpass              to change the callback password of the subdomain
    //
    handleUserMgmtAction(action)
    {
        let auth = this.auth;
        let words = action.slice(1).split('|');
        switch (action[0]) {
            case '-':
                if (words.length === 1) {
                    for (let j = 0; j < auth.length; j++) {
                        if (auth[j].user === words[0]) {
                            auth.splice(j, 1);
                            YSubdomain.SaveConfig();
                            break;
                        }
                    }
                }
                break;
            case '+':
                if (words.length === 3) {
                    auth.push({user: words[0], pass: words[1], admin: (parseInt(words[2]) > 0)});
                    YSubdomain.SaveConfig();
                }
                break;
            case '#':
                if (words.length === 1) {
                    this.pass = words[0];
                    YSubdomain.SaveConfig();
                }
        }
    }

    // Function to detect if this is the first login (creation of admin user)
    //
    static IsFirstLogin()
    {
        if (YSubdomain.list == null) {
            YSubdomain.list = {};
        }
        for (let name in YSubdomain.list) {
            return false;
        }
        return true;
    }

    // Setup a new Subdomain and register it in the Web server
    //
    static Create(app, name, cbpass, auth, outcb)
    {
        if (YSubdomain.list == null) {
            YSubdomain.list = {};
        }
        let iframe = path.join(__dirname, 'data/iframe.html');
        let webapp = path.join(__dirname, 'data/webapp.html');
        let subdom = new YSubdomain(name, cbpass, auth, outcb);
        YSubdomain.list[name] = subdom;
        YSubdomain.WebAppSize = fs.statSync(webapp).size;
        app.ws('/' + name + '/callback', YSubdomain.WebSocketCallbackHandler);
        app.ws('/' + name + '/not.byn', YSubdomain.WebSocketAPIHandler);
        app.get('/' + name + '/iframe.html', (req, res) => {
            res.sendFile(iframe);
        });
        app.get('/' + name + '/webapp.html', (req, res) => {
            res.sendFile(webapp);
        });
        app.post('/' + name + '/editcb.html', (req, res) => {
            if (req.body && subdom.isAuthorized(req.body.username, req.body.userpass) > 1) {
                let cbdata;
                if (req.body.idx >= 0 && req.body.idx < subdom.cback.length) {
                    cbdata = subdom.cback[req.body.idx];
                    cbdata.idx = req.body.idx;
                } else {
                    cbdata = new YCallback(subdom, {});
                    cbdata.idx = subdom.cback.length;
                }
                res.render('editcb', {
                    "FORM": req.body,
                    "YSubdomain": YSubdomain,
                    "Server": req.hostname + ':' + https_port,
                    "subdom": subdom,
                    "cbdata": cbdata
                });
                cbdata.Schedule.paused = true;
            } else {
                res.redirect('/');
            }
        });
        app.get('/' + name + '/logcb.html', (req, res) => {
            if (subdom.isAuthorized(req.query.username, req.query.userpass)) {
                if (req.query.testcb) {
                    subdom.testcb = new YCallback(subdom, JSON.parse(req.query.testcb));
                    subdom.testcb.lastOutput = '[triggering callback...]';
                    subdom.testcb.Schedule.paused = false;
                    subdom.testcb.Schedule.alignPeriod = false;
                    subdom.testcb.Schedule.maxPeriod = 24;
                    subdom.testcb.Schedule.maxHours = 1;
                    subdom.testcb.trigger = true;
                    res.render('logcb', {"lines": [subdom.testcb.lastOutput], "autoRefresh": false});
                } else if (req.query.idx === '-1' && subdom.testcb) {
                    let text = subdom.testcb.cbOutput || subdom.testcb.lastOutput;
                    res.render('logcb', {"lines": text.split(/\r?\n/), "autoRefresh": !subdom.testcb.imm_isIdle()});
                } else if (req.query.idx >= 0 && req.query.idx < subdom.cback.length) {
                    let cbdata = subdom.cback[req.query.idx];
                    let text = cbdata.cbOutput || cbdata.lastOutput;
                    res.render('logcb', {"lines": text.split(/\r?\n/), "autoRefresh": !cbdata.imm_isIdle()});
                }
            } else {
                res.redirect('/');
            }
        });
        app.post('/' + name + '/', (req, res) => {
            if (req.body && subdom.isAuthorized(req.body.username, req.body.userpass)) {
                if (req.body.action) {
                    if (req.body.action.match(/^[\-+#].+$/)) {
                        subdom.handleUserMgmtAction(req.body.action);
                    } else if (req.body.action.match(/^Cb[\-+][0-9]+$/)) {
                        if (subdom.testcb) {
                            subdom.testcb.imm_abort();
                            subdom.testcb = null;
                        }
                        subdom.handleEditCbMgmtAction(req.body.action, req.body.json);
                    }
                }
                if (subdom.testcb && subdom.testcb.imm_isIdle()) {
                    subdom.testcb = null;
                }
                let WS_Server = {
                    'hostname': req.hostname,
                    'wsport': http_port,
                    'wssport': https_port
                };
                res.render('subdomain', {
                    "FORM": req.body,
                    "YSubdomain": YSubdomain,
                    "Server": req.hostname + ':' + https_port,
                    "WS_Server": WS_Server,
                    "subdom": subdom
                });
            } else {
                res.redirect('/');
            }
        });
    }

    // Returns the names of all subdomains allowed for a given username
    //
    static GetSubdomainsFor(username, userpass)
    {
        let res = [];
        for (let name in YSubdomain.list) {
            if (YSubdomain.list[name].isAuthorized(username, userpass)) {
                res.push(name);
            }
        }
        return res;
    }

    // Returns the names of all subdomains allowed for a given username
    //
    static IsAdmin(username, userpass)
    {
        let res = true; // When no domain are defined, first login = admin login
        for (let name in YSubdomain.list) {
            if (YSubdomain.list[name].isAuthorized(username, userpass) > 1) {
                return true;
            }
            res = false;
        }
        return res;
    }

    // Handle a subdomain management action:
    // -subdomain           to remove a subdomain
    // +subdomain,pass      to create a new subdomain
    //
    static HandleSubdomainMgmtAction(action, username, userpass)
    {
        let words = action.slice(1).split('|');
        switch (action[0]) {
            case '-':
                if (YSubdomain.list[words[0]]) {
                    delete YSubdomain.list[words[0]];
                    YSubdomain.SaveConfig();
                }
                break;
            case '+':
                if (words.length > 0 && words[1].length > 0 && !YSubdomain.list[words[0]]) {
                    YSubdomain.Create(app, words[0], (words[1] || ''), [{
                        user: username,
                        pass: userpass,
                        admin: true
                    }], []);
                    YSubdomain.SaveConfig();
                }
                break;
        }
    }

    // Returns a subdomain object given its name
    //
    static GetSubdomain(name)
    {
        return YSubdomain.list[name];
    }

    static Obfuscate(str)
    {
        let iv = new Buffer(crypto.randomBytes(16));
        let cipher = crypto.createCipheriv('aes-256-cbc', new Buffer('G4t3wayHubConf1gG4t3wayHubConf1g'), iv);
        let ct = cipher.update(str, 'utf8', 'hex');
        ct += cipher.final('hex');
        return '$$' + ct + iv.toString('hex');
    }

    static Reveal(str)
    {
        if (!/^\$\$[0-9a-f]+$/i.test(str)) {
            return str;
        }
        let iv = new Buffer(str.slice(-32), 'hex');
        let ct = str.slice(2, -32);
        let decipher = crypto.createDecipheriv('aes-256-cbc', new Buffer('G4t3wayHubConf1gG4t3wayHubConf1g'), iv);
        let res = decipher.update(ct, 'hex', 'utf8');
        res += decipher.final('utf8');
        return res;
    }

    // Save the current app configuration
    //
    static SaveConfig()
    {
        let conf = [];
        for (let name in YSubdomain.list) {
            let subdom = YSubdomain.list[name];
            let auth = [];
            for (let i = 0; i < subdom.auth.length; i++) {
                let cred = subdom.auth[i];
                auth.push({
                    user: YSubdomain.Obfuscate(cred.user), pass: YSubdomain.Obfuscate(cred.pass), admin: cred.admin
                });
            }
            let outcb = [];
            for (let i = 0; i < subdom.cback.length; i++) {
                let cbdata = subdom.cback[i];
                outcb.push({
                    Method: cbdata.Method, Encoding: cbdata.Encoding, Url: cbdata.Url,
                    Credentials: {
                        user: YSubdomain.Obfuscate(cbdata.Credentials.user),
                        pass: YSubdomain.Obfuscate(cbdata.Credentials.pass)
                    },
                    Schedule: cbdata.Schedule
                });
            }
            conf.push({name: subdom.name, pass: YSubdomain.Obfuscate(subdom.pass), auth: auth, outcb: outcb});
        }
        fs.writeFileSync(configfile, JSON.stringify(conf, null, 2), 'utf8');
    }

    // Save the current app configuration
    // Returns false if no config file can be found
    //
    static LoadConfig()
    {
        if (!fs.existsSync(configfile)) {
            console.log('No config file (' + configfile + ')');
            return false;
        }
        try {
            let conf = JSON.parse(fs.readFileSync(configfile, 'utf8'));
            for (let i = 0; i < conf.length; i++) {
                conf[i].pass = YSubdomain.Reveal(conf[i].pass);
                for (let j = 0; j < conf[i].auth.length; j++) {
                    conf[i].auth[j].user = YSubdomain.Reveal(conf[i].auth[j].user);
                    conf[i].auth[j].pass = YSubdomain.Reveal(conf[i].auth[j].pass);
                }
                for (let j = 0; j < conf[i].outcb.length; j++) {
                    conf[i].outcb[j].Credentials.user = YSubdomain.Reveal(conf[i].outcb[j].Credentials.user);
                    conf[i].outcb[j].Credentials.pass = YSubdomain.Reveal(conf[i].outcb[j].Credentials.pass);
                }
                YSubdomain.Create(app, conf[i].name, conf[i].pass, conf[i].auth, conf[i].outcb);
            }
        } catch (e) {
            console.log('Cannot load ' + configfile);
            return false;
        }
        return true;
    }
}

YAPI.LogUnhandledPromiseRejections();

// Instantiate a Web server with both HTTP/WS and HTTPS/WSS support
const options = {
    key: fs.readFileSync('key.pem'),
    cert: fs.readFileSync('cert.pem')
};
const httpServer = http.createServer(app);
const wsServer = express_ws(app, httpServer);
const httpsServer = https.createServer(options, app);
const wssServer = express_ws(app, httpsServer);

// Setup Express app server
app.use(bodyParser.urlencoded({extended: false}));
app.set('views', path.join(__dirname, 'data'));
app.set('view engine', 'pug');
app.get('/', (req, res, next) => {     // Redirect simple HTTP requests to HTTPS for security
    if (req.protocol === 'http') {
        res.redirect(301, 'https://' + req.hostname + ':' + https_port + req.url);
    } else {
        next();
    }
});
app.all('/', (req, res) => {            // Handle login page
    if (req.body && YSubdomain.IsAdmin(req.body.username, req.body.userpass)) {
        if (req.body.action && req.body.action.match(/[\-+].+/)) {
            YSubdomain.HandleSubdomainMgmtAction(req.body.action, req.body.username, req.body.userpass);
        }
    }
    res.render('login', {
        "FORM": req.body,
        "YSubdomain": YSubdomain,
        "Server": req.hostname + ':' + https_port
    });
});
app.get('/iframe.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'data/iframe.html'));
});

app.get('/ajax.json', (req, res) => {
    let outlist = [];
    let subdomains = YSubdomain.GetSubdomainsFor(req.query.username, req.query.userpass);
    for (let i = 0; i < subdomains.length; i++) {
        let subdomain = YSubdomain.GetSubdomain(subdomains[i]);
        let client_val;
        if (!subdomain.yapi)
            client_val = "(hub offline)";
        else
            client_val = subdomain.client;
        outlist[i] = {name: subdomain.name, netname: subdomain.netname, client: client_val};
    }
    console.log(outlist);
    res.json(outlist);
});

app.use(express.static(path.join(__dirname, 'public')));
YSubdomain.LoadConfig();

// Start web server
httpServer.listen(http_port, function () {
    console.log('HTTP Server running on port', http_port);
});
httpsServer.listen(https_port, function () {
    console.log('HTTPS Server running on port', https_port);
});

