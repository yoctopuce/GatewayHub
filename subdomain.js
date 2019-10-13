"use strict";

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const YCallback = require('./callback.js');

// Configuration file
const configfile = path.join(__dirname, 'gateway.conf');

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
            let errmsg = new YErrorMsg();
            if (!this.yapi || await this.yapi.TestHub('callback', 0, errmsg) !== YAPI.SUCCESS) {
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
                await yctx.FreeAPI();
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
            let errmsg = new YErrorMsg();
            await YAPI.Sleep(100, errmsg);
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

    findUser(username, onlyAdmin = true)
    {
        let auth = this.auth;
        for (let j = 0; j < auth.length; j++) {
            if (auth[j].user === username) {
                if (!onlyAdmin || auth[j].admin) {
                    return auth[j];
                }
            }
        }
        return null;
    }

    findUserId(userid, onlyAdmin = true)
    {
        let auth = this.auth;
        for (let j = 0; j < auth.length; j++) {
            if (auth[j].id === userid) {
                if (!onlyAdmin || auth[j].admin) {
                    return auth[j];
                }
            }
        }
        return null;
    }


    // Handle a user management action:
    // Cb-callback_id to remove a callback definition
    // Cb#callback_id to change/add a callback definition
    //
    handleEditCbMgmtAction(subdomMngr, action, defstr)
    {
        let id = parseInt(action.substr(3));
        switch (action.substr(2, 1)) {
            case '-':
                if (id < this.cback.length) {
                    this.cback.splice(id, 1);
                    subdomMngr.SaveConfig();
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
                    subdomMngr.SaveConfig();
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
    handleUserMgmtAction(subdomMngr, action)
    {
        let auth = this.auth;
        let words = action.slice(1).split('|');
        switch (action[0]) {
            case '-':
                if (words.length === 1) {
                    for (let j = 0; j < auth.length; j++) {
                        if (auth[j].user === words[0]) {
                            auth.splice(j, 1);
                            subdomMngr.SaveConfig();
                            break;
                        }
                    }
                }
                break;
            case '+':
                if (words.length === 3) {
                    var userid = subdomMngr.getNewUserID();
                    auth.push({id: userid, user: words[0], pass: words[1], admin: (parseInt(words[2]) > 0)});
                    subdomMngr.SaveConfig();
                }
                break;
            case '#':
                if (words.length === 1) {
                    this.pass = words[0];
                    subdomMngr.SaveConfig();
                }
        }
    }

}

class YSubdomainManager
{
    constructor(app, http_port, https_port)
    {
        this.app = app;
        this.http_port = http_port;
        this.https_port = https_port;
        this.list = {};
        let webapp = path.join(__dirname, 'data/webapp.html');
        this.WebAppSize = fs.statSync(webapp).size;
    }


    // Function to detect if this is the first login (creation of admin user)
    //
    IsFirstLogin()
    {
        // noinspection LoopStatementThatDoesntLoopJS
        for (let name in this.list) {
            return false;
        }
        return true;
    }

    // Setup a new Subdomain and register it in the Web server
    //
    Create(name, cbpass, auth, outcb)
    {
        let iframe = path.join(__dirname, 'data/iframe.html');
        let webapp = path.join(__dirname, 'data/webapp.html');
        let subdom = new YSubdomain(name, cbpass, auth, outcb);
        this.list[name] = subdom;
        this.app.ws('/' + name + '/callback', (ws, req) => {
            this.WebSocketCallbackHandler(ws, req);
        });
        this.app.ws('/' + name + '/not.byn', (ws, req) => {
            this.WebSocketAPIHandler(ws, req);
        });
        this.app.get('/' + name + '/iframe.html', (req, res) => {
            res.sendFile(iframe);
        });
        this.app.get('/' + name + '/webapp.html', (req, res) => {
            res.sendFile(webapp);
        });
        this.app.post('/' + name + '/editcb.html', (req, res, next) => {
            if (!req.isAuthenticated())
                return res.redirect('/login');

            if (req.body && subdom.isAuthorized(req.user.user, req.user.pass) > 1) {
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
                    "YSubdomain": this,
                    "USER": {username: req.user.user, userpass: req.user.pass},
                    "Server": req.hostname + ':' + this.https_port,
                    "subdom": subdom,
                    "cbdata": cbdata
                });
                cbdata.Schedule.paused = true;
            } else {
                res.redirect('/');
            }
        });
        this.app.get('/' + name + '/logcb.html', (req, res, next) => {
            if (!req.isAuthenticated())
                return res.redirect('/login');

            if (subdom.isAuthorized(req.user.user, req.user.pass)) {
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
        this.app.all('/' + name + '/', (req, res, next) => {
            if (!req.isAuthenticated()) {
                return res.redirect('/login');
            }

            if (req.body && subdom.isAuthorized(req.user.user, req.user.pass)) {
                if (req.body.action) {
                    if (req.body.action.match(/^[\-+#].+$/)) {
                        subdom.handleUserMgmtAction(this, req.body.action);
                    } else if (req.body.action.match(/^Cb[\-+][0-9]+$/)) {
                        if (subdom.testcb) {
                            subdom.testcb.imm_abort();
                            subdom.testcb = null;
                        }
                        subdom.handleEditCbMgmtAction(this, req.body.action, req.body.json);
                    }
                }
                if (subdom.testcb && subdom.testcb.imm_isIdle()) {
                    subdom.testcb = null;
                }
                let WS_Server = {
                    'hostname': req.hostname,
                    'wsport': this.http_port,
                    'wssport': this.https_port
                };
                res.render('subdomain', {
                    "FORM": req.body,
                    "USER": {username: req.user.user, userpass: req.user.pass},
                    "YSubdomain": this,
                    "Server": req.hostname + ':' + this.https_port,
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
    GetSubdomainsFor(username, userpass)
    {
        let res = [];
        for (let name in this.list) {
            if (this.list[name].isAuthorized(username, userpass)) {
                res.push(name);
            }
        }
        return res;
    }

    // Returns the names of all subdomains allowed for a given username
    //
    IsAdmin(username, userpass)
    {
        let res = true; // When no domain are defined, first login = admin login
        for (let name in this.list) {
            if (this.list[name].isAuthorized(username, userpass) > 1) {
                return true;
            }
            res = false;
        }
        return res;
    }

    // Returns the names of all subdomains allowed for a given username
    //
    FindUser(username, onlyAdmin = true)
    {
        for (let name in this.list) {
            let user_rec = this.list[name].findUser(username, onlyAdmin);
            if (user_rec != null) {
                return user_rec;
            }
        }
        return null;
    }

    // Returns the names of all subdomains allowed for a given username
    //
    FindById(userid, onlyAdmin = true)
    {
        for (let name in this.list) {
            let user_rec = this.list[name].findUserId(userid, onlyAdmin);
            if (user_rec != null) {
                return user_rec;
            }
        }
        return null;
    }


    async WebSocketCallbackHandler(ws, req)
    {
        // Ensure the request comes for a registered subdomain
        let name = req.url.slice(1, req.url.indexOf('/', 1));
        let subdom = this.list[name];
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

    async WebSocketAPIHandler(ws, req)
    {
        // Ensure the request comes for a registered subdomain
        let name = req.url.slice(1, req.url.indexOf('/', 1));
        let subdom = this.list[name];
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


    // Handle a subdomain management action:
    // -subdomain           to remove a subdomain
    // +subdomain,pass      to create a new subdomain
    //
    HandleSubdomainMgmtAction(action, username, userpass)
    {
        let words = action.slice(1).split('|');
        switch (action[0]) {
            case '-':
                if (this.list[words[0]]) {
                    delete this.list[words[0]];
                    this.SaveConfig();
                }
                break;
            case '+':
                if (words.length > 0 && words[1].length > 0 && !this.list[words[0]]) {
                    this.Create(words[0], (words[1] || ''), [{
                        id: this.getNewUserID(),
                        user: username,
                        pass: userpass,
                        admin: true
                    }], []);
                    this.SaveConfig();
                }
                break;
        }
    }

    // Returns a subdomain object given its name
    //
    GetSubdomain(name)
    {
        return this.list[name];
    }

    Obfuscate(str)
    {
        let iv = new Buffer(crypto.randomBytes(16));
        let cipher = crypto.createCipheriv('aes-256-cbc', new Buffer('G4t3wayHubConf1gG4t3wayHubConf1g'), iv);
        let ct = cipher.update(str, 'utf8', 'hex');
        ct += cipher.final('hex');
        return '$$' + ct + iv.toString('hex');
    }

    Reveal(str)
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
    SaveConfig()
    {
        let conf = [];
        for (let name in this.list) {
            let subdom = this.list[name];
            let auth = [];
            for (let i = 0; i < subdom.auth.length; i++) {
                let cred = subdom.auth[i];
                auth.push({
                    id: cred.id,
                    user: this.Obfuscate(cred.user),
                    pass: this.Obfuscate(cred.pass),
                    admin: cred.admin
                });
            }
            let outcb = [];
            for (let i = 0; i < subdom.cback.length; i++) {
                let cbdata = subdom.cback[i];
                outcb.push({
                    Method: cbdata.Method, Encoding: cbdata.Encoding, Url: cbdata.Url,
                    Credentials: {
                        user: this.Obfuscate(cbdata.Credentials.user),
                        pass: this.Obfuscate(cbdata.Credentials.pass)
                    },
                    Schedule: cbdata.Schedule
                });
            }
            conf.push({name: subdom.name, pass: this.Obfuscate(subdom.pass), auth: auth, outcb: outcb});
        }
        fs.writeFileSync(configfile, JSON.stringify(conf, null, 2), 'utf8');
    }

    getNewUserID()
    {
        return Math.floor(Math.random() * Math.floor(Number.MAX_SAFE_INTEGER));
    }

    // Save the current app configuration
    // Returns false if no config file can be found
    //
    LoadConfig()
    {
        if (!fs.existsSync(configfile)) {
            console.log('No config file (' + configfile + ')');
            return false;
        }
        let all_ids = [];
        try {
            let conf = JSON.parse(fs.readFileSync(configfile, 'utf8'));
            for (let i = 0; i < conf.length; i++) {
                conf[i].pass = this.Reveal(conf[i].pass);
                for (let j = 0; j < conf[i].auth.length; j++) {
                    if (conf[i].auth[j].id === undefined) {
                        let id;
                        do {
                            id = this.getNewUserID();
                        } while (all_ids.includes(id));
                        conf[i].auth[j].id = id;
                    }
                    all_ids.push(conf[i].auth[j].id);
                    conf[i].auth[j].user = this.Reveal(conf[i].auth[j].user);
                    conf[i].auth[j].pass = this.Reveal(conf[i].auth[j].pass);
                }
                for (let j = 0; j < conf[i].outcb.length; j++) {
                    conf[i].outcb[j].Credentials.user = this.Reveal(conf[i].outcb[j].Credentials.user);
                    conf[i].outcb[j].Credentials.pass = this.Reveal(conf[i].outcb[j].Credentials.pass);
                }
                this.Create(conf[i].name, conf[i].pass, conf[i].auth, conf[i].outcb);
            }
        } catch (e) {
            console.log('Cannot load ' + configfile);
            return false;
        }
        return true;
    }

}

module.exports = {
    YSubdomain: YSubdomain,
    YSubdomainManager: YSubdomainManager
};
