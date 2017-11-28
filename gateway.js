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

class YSubdomain
{
    constructor(name, cbpass, auth)
    {
        this.name = name;
        this.pass = cbpass;
        this.auth = auth;
        this.netname = '';
        this.yapi = null;
        this.client = '';
        this.devs = {};
        this.hublog = [];
        this.apilog = [];
        this.timeoutId = null;
        // configurable parameters
        this.maxLogSize = 10;
        this.pingDelay = 2000;
    }

    // Log-to-memory that detects duplicate messages
    //
    async log(logtype, msg)
    {
        let logbuff = this[logtype+'log'];
        let now = new Date();
        let day = now.getFullYear().toString()+'-'+('0'+(now.getMonth()+1)).slice(-2)+'-'+('0'+now.getDate()).slice(-2);
        let time = now.getHours().toString()+':'+('0'+(now.getMinutes()+1)).slice(-2)+':'+('0'+now.getSeconds()).slice(-2);
        console.log(day+' '+time+' ['+this.name+'] '+msg);
        msg = day+' '+time+' '+msg;
        if(logbuff.length > 0) {
            let found = logbuff[logbuff.length-1].match(/last message repeated ([0-9]+) times/);
            if(found) {
                if(logbuff[logbuff.length-2].slice(20) == msg.slice(20)) {
                    logbuff.pop();
                    msg = day+' '+time+' (last message repeated '+(parseInt(found[1])+1)+' times)';
                }
            } else {
                if(logbuff[logbuff.length-1].slice(20) == msg.slice(20)) {
                    msg = day+' '+time+' (last message repeated 2 times)';
                }
            }
        }
        logbuff.push(msg);
        if(logbuff.length > this.maxLogSize) {
            logbuff.shift();
        }
    }

    // Close hub connection forcefully, to reinitialize it
    //
    async closeHub(reason)
    {
        if(this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }
        if(this.yapi) {
            this.log('hub', reason || ('Disconnecting '+this.netname));
            try {
                await this.yapi.KillAPI();
            } catch(e) {
                console.log('Caught exception in FreeAPI', e);
            }
        }
        this.netname = '';
        this.yapi = null;
        this.client = '';
        this.devs = {};
    }

    // Function called periodically when no client is connected
    //
    async pingHub()
    {
        if(this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }
        if(!this.yapi || await this.yapi.TestHub('callback',0) != YAPI.SUCCESS) {
            return this.closeHub('Hub '+this.netname+' stalled, disconnecting');
        }
        this.timeoutId = setTimeout(() => { this.pingHub(); }, this.pingDelay);
    }

    // Register an incoming hub and store device details.
    // Called by the incoming websocket handler.
    //
    async acceptHub(ws)
    {
        // Drop any previous open context for this subdomain
        this.closeHub();

        // Attempt to connect to the incoming hub and enumerate devices
        let yctx = new YAPIContext();
        try {
            let errmsg = new YErrorMsg();
            if ((await yctx.RegisterHubWebSocketCallback(ws, errmsg, this.pass)) != YAPI.SUCCESS) {
                this.log('hub', 'RegisterHub error: ' + errmsg);
                yctx.FreeAPI();
                return false;
            }

            // Enumerate available devices
            await yctx.UpdateDeviceList(errmsg);
            let network = YNetwork.FirstNetworkInContext(yctx);
            if(network) {
                this.netname = await network.get_logicalName();
                this.log('hub', 'Hub '+this.netname+' connected');
            }
            let module = YModule.FirstModuleInContext(yctx);
            while (module) {
                let serial = await module.get_serialNumber();
                this.devs[serial] = {
                    "serialNumber": serial,
                    "logicalName" : await module.get_logicalName(),
                    "productName" : await module.get_productName()
                };
                module = module.nextModule();
            }

            // Keep this context available for API connections
            this.yapi = yctx;

            // Prepare to ping host while there is no client connected
            this.pingHub();
        } catch(e) {
            this.log('hub', 'Exception: ' + e.toString());
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
        while((!this.yapi || this.yapi._hubs.length == 0) && timeout > 0) {
            // no hub connected yet, wait a bit
            await YAPI.Sleep(100);
            timeout -= 100;
        }
        if(!this.yapi || this.yapi._hubs.length == 0) {
            return false;
        }
        // Disable ping task when client is connected
        if(this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }
        this.client = client;
        await this.yapi.WebSocketJoin(ws, this.auth, ()=>{this.closeHub();});

        // Success
        return true;
    }

    static async WebSocketCallbackHandler(ws, req)
    {
        // Ensure the request comes for a registered subdomain
        let name = req.url.slice(1, req.url.indexOf('/',1));
        let subdom = YSubdomain.list[name];
        if(!subdom) {
            console.log('Websocket callback for invalid subdomain '+name);
        } else {
            subdom.log('hub', 'Incoming hub: ' + req.socket.remoteAddress.replace('::ffff:',''));
            if(await subdom.acceptHub(ws) == true) {
                // keep websocket connection open
                return;
            }
        }
        ws.close();
    }

    static async WebSocketAPIHandler(ws, req)
    {
        // Ensure the request comes for a registered subdomain
        let name = req.url.slice(1, req.url.indexOf('/',1));
        let subdom = YSubdomain.list[name];
        if(!subdom) {
            console.log('API connection for invalid subdomain '+name);
        } else {
            subdom.log('api', 'Incoming API client: ' + req.socket.remoteAddress.replace('::ffff:',''));
            if(await subdom.acceptAPI(ws,1000) == true) {
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
        for(let j = 0; j < auth.length; j++) {
            if(auth[j].user == username && auth[j].pass == userpass) {
                return (auth[j].admin ? 2 : 1);
            }
        }
        return false;
    }

    // Handle a user management action:
    // -username            to remove a user
    // +username,pass,admin to add a user
    //
    handleUserMgmtAction(action)
    {
        let auth = this.auth;
        let words = action.slice(1).split('|');
        switch(action[0]) {
            case '-':
                if(words.length == 1) {
                    for (let j = 0; j < auth.length; j++) {
                        if (auth[j].user == words[0]) {
                            auth.splice(j, 1);
                            YSubdomain.SaveConfig();
                            break;
                        }
                    }
                }
                break;
            case '+':
                if(words.length == 3) {
                    auth.push({user: words[0], pass: words[1], admin: (parseInt(words[2])>0 ? true : false)});
                    YSubdomain.SaveConfig();
                }
                break;
            case '#':
                if(words.length == 1) {
                    this.pass = words[0];
                }
        }
    }

    // Function to detect if this is the first login (creation of admin user)
    //
    static IsFirstLogin()
    {
        if(YSubdomain.list == null) {
            YSubdomain.list = {};
        }
        for(let name in YSubdomain.list) {
            return false;
        }
        return true;
    }

    // Setup a new Subdomain and register it in the Web server
    //
    static Create(app, name, cbpass, auth)
    {
        if(YSubdomain.list == null) {
            YSubdomain.list = {};
        }
        let iframe = path.join(__dirname, 'data/iframe.html');
        let webapp = path.join(__dirname, 'data/webapp.html');
        let subdom = new YSubdomain(name, cbpass, auth);
        YSubdomain.list[name] = subdom;
        YSubdomain.WebAppSize = fs.statSync(webapp).size;
        app.ws('/'+name+'/callback', YSubdomain.WebSocketCallbackHandler);
        app.ws('/'+name+'/not.byn', YSubdomain.WebSocketAPIHandler);
        app.get('/'+name+'/iframe.html', (req, res) => { res.sendFile(iframe); });
        app.get('/'+name+'/webapp.html', (req, res) => { res.sendFile(webapp); });
        app.post('/'+name+'/', (req, res) => {
            if(req.body && subdom.isAuthorized(req.body.username, req.body.userpass)) {
                if(req.body.action && req.body.action.match(/[\+\-\#].+/)) {
                    subdom.handleUserMgmtAction(req.body.action);
                }
                res.render('subdomain', {
                    "FORM": req.body,
                    "YSubdomain": YSubdomain,
                    "Server": req.hostname + ':' + https_port,
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
        for(let name in YSubdomain.list) {
            if(YSubdomain.list[name].isAuthorized(username, userpass)) {
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
        for(let name in YSubdomain.list) {
            if(YSubdomain.list[name].isAuthorized(username, userpass) > 1) {
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
        switch(action[0]) {
            case '-':
                if(YSubdomain.list[words[0]]) {
                    delete YSubdomain.list[words[0]];
                    YSubdomain.SaveConfig();
                }
                break;
            case '+':
                if(words.length > 0 && words[1].length > 0 && !YSubdomain.list[words[0]]) {
                    YSubdomain.Create(app, words[0], (words[1] || ''), [ { user: username, pass: userpass, admin: true } ]);
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

    // Save the current app configuration
    //
    static SaveConfig()
    {
        let conf = [];
        for(let name in YSubdomain.list) {
            let subdom = YSubdomain.list[name];
            conf.push({ name: subdom.name, pass: subdom.pass, auth: subdom.auth });
        }
        fs.writeFileSync(configfile, JSON.stringify(conf), 'utf8');
    }

    // Save the current app configuration
    // Returns false if no config file can be found
    //
    static LoadConfig()
    {
        if(!fs.existsSync(configfile)) {
            console.log('No config file ('+configfile+')');
            return false;
        }
        try {
            let conf = JSON.parse(fs.readFileSync(configfile, 'utf8'));
            for(let i = 0; i < conf.length; i++) {
                YSubdomain.Create(app, conf[i].name, conf[i].pass, conf[i].auth);
            }
        } catch (e) {
            console.log('Cannot load '+configfile);
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
app.use(bodyParser.urlencoded({extended:false}));
app.set('views', path.join(__dirname, 'data'));
app.set('view engine', 'pug');
app.get('/', (req, res, next) =>  {     // Redirect simple HTTP requests to HTTPS for security
    if(req.protocol == 'http') {
        res.redirect(301, 'https://'+req.hostname+':'+https_port+req.url);
    } else {
        next();
    }
});
app.all('/', (req, res) => {            // Handle login page
    if(req.body && YSubdomain.IsAdmin(req.body.username, req.body.userpass)) {
        if (req.body.action && req.body.action.match(/[\+\-].+/)) {
            YSubdomain.HandleSubdomainMgmtAction(req.body.action, req.body.username, req.body.userpass);
        }
    }
    res.render('login', {
        "FORM": req.body,
        "YSubdomain": YSubdomain,
        "Server": req.hostname+':'+https_port });
});
app.get('/iframe.html', (req, res) => { res.sendFile(path.join(__dirname, 'data/iframe.html')); });
app.use(express.static(path.join(__dirname, 'public')));
YSubdomain.LoadConfig();

// Start web server
httpServer.listen(http_port, function() {
    console.log('HTTP Server running on port', http_port);
});
httpsServer.listen(https_port, function() {
    console.log('HTTPS Server running on port', https_port);
});

