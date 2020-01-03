#!/usr/bin/env node
"use strict";

require('yoctolib-es2017/yocto_api.js');
require('yoctolib-es2017/yocto_network.js');

const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const express = require('express');
const app = express();
const express_ws = require("express-ws");
const bodyParser = require('body-parser');
const session = require('express-session');
const MemoryStore = require('memorystore')(session);
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;




const argv = require('yargs')
    .usage('Usage: $0 [options]')
    .example('$0 -c config.conf --http_port 44080 --https_port 44443', '')
    .alias('c', 'config')
    .describe('c', 'A config file')
    .help('h')
    .alias('h', 'help')
    .default('c', 'gateway.conf')
    .default('http_port', 44080)
    .default('https_port', 44443)
    .default('key_file', 'key.pem')
    .default('cert_file', 'cert.pem')
    .argv;

if (argv.version) {
    console.log("gatewayhub v1.0.39031");
    process.exit(0);
}

// Setup ports
const http_port = (argv._.length < 1 ? argv.http_port : parseInt(argv._[0]));
const https_port = (argv._.length < 2 ? argv.https_port : parseInt(argv._[1]));


const subdomains = require('./subdomain.js');
const subdomainsManger = new subdomains.YSubdomainManager(app, argv.c, http_port, https_port);
// noinspection JSIgnoredPromiseFromCall
YAPI.LogUnhandledPromiseRejections();

// Instantiate a Web server with both HTTP/WS and HTTPS/WSS support
const httpServer = http.createServer(app);
// noinspection JSUnusedLocalSymbols
const wsServer = express_ws(app, httpServer);
let use_https = false;
if (!fs.existsSync(argv.key_file) || !fs.existsSync(argv.cert_file)) {
    console.log("Warning: No key.pem and cert.pem file found\n");
    console.log("In order to enable the secure interface https, you will also have to put");
    console.log("in the same directory the certificates to be used: two files named cert.pem");
    console.log("and key.pem, which are usually provided by our SSL certificate provider or");
    console.log("hosting provider. In case you just want to make a test, you can also use");
    console.log("self-signed certificates created using OpenSSL, by typing the following");
    console.log("command (on a single line):");
    console.log("openssl req -newkey rsa:2048 -new -nodes -x509 -days 3650 -keyout key.pem -out cert.pem");
    process.exit(1);
}
const options = {
    key: fs.readFileSync(argv.key_file),
    cert: fs.readFileSync(argv.cert_file)
};
const httpsServer = https.createServer(options, app);
// noinspection JSUnusedLocalSymbols
const wssServer = express_ws(app, httpsServer);

// Configure the local strategy for use by Passport.
//
// The local strategy require a `verify` function which receives the credentials
// (`username` and `password`) submitted by the user.  The function must verify
// that the password is correct and then invoke `cb` with a user object, which
// will be set at `req.user` in route handlers after authentication.
passport.use('local-login', new LocalStrategy(
    function (username, password, done) {
        process.nextTick(function () {
            let user = subdomainsManger.FindUser(username, false);
            if (!user) { return done(null, false); }
            if (user.pass !== password) {
                return done(null, false);
            }
            return done(null, user);
        });
    }));


// Configure Passport authenticated session persistence.
//
// In order to restore authentication state across HTTP requests, Passport needs
// to serialize users into and deserialize users out of the session.  The
// typical implementation of this is as simple as supplying the user ID when
// serializing, and querying the user record by ID from the database when
// deserializing.
passport.serializeUser(function (user, cb) {
    cb(null, user.id);
});

passport.deserializeUser(function (id, cb) {
    process.nextTick(function () {
        let user = subdomainsManger.FindById(id, false);
        cb(null, user);
    });
});

// Setup Express app server
app.use(bodyParser.urlencoded({extended: false}));
app.use(session({
    resave: true,
    saveUninitialized: false,
    secret: 'ycook_secret',
    cookie: {maxAge: 3600000},
    store: new MemoryStore({
        checkPeriod: 86400000 // prune expired entries every 24h
    }),
}));

// Initialize Passport and restore authentication state, if any, from the
// session.
app.use(passport.initialize());
app.use(passport.session());


app.set('views', path.join(__dirname, 'data'));
app.set('view engine', 'pug');
app.get('/', (req, res, next) => {     // Redirect simple HTTP requests to HTTPS for security
    if (req.protocol === 'http') {
        res.redirect(301, 'https://' + req.hostname + ':' + https_port + req.url);
    } else {
        next();
    }
});


app.get('/login', (req, res, next) => {
    if (subdomainsManger.IsFirstLogin()) {
        return res.redirect("/firstlogin");
    } else {
        res.render('login', {
            "FORM": req.body,
            "Server": req.hostname + ':' + https_port
        });
    }
});

app.post('/login',
    passport.authenticate("local-login", {failureRedirect: '/login'}),
    function (req, res) {
        return res.redirect('/');
    });

app.get('/logout',
    function (req, res) {
        req.logout();
        res.redirect('/');
    });

app.get('/firstlogin', (req, res, next) => {
    if (subdomainsManger.IsFirstLogin()) {
        res.render('first_login', {
            "FORM": req.body,
            "YSubdomain": subdomainsManger,
            "Server": req.hostname + ':' + https_port
        });
    }
});


app.post('/firstlogin', function (req, res) {
    if (subdomainsManger.IsFirstLogin()) {
        if (req.body.action && req.body.action.match(/[\-+].+/)) {
            subdomainsManger.HandleSubdomainMgmtAction(req.body.action, req.body.username, req.body.password, http_port, https_port);
        }
    }
    return res.redirect('/');
});


// route middleware to ensure user is logged in
function isLoggedIn(req, res, next)
{
    if (req.isAuthenticated())
        return next();
    return res.redirect('/login');
}


app.all('/', isLoggedIn, (req, res) => {
    if (subdomainsManger.IsFirstLogin()) {
        return res.redirect("/firstlogin");
    }

    // Handle login page
    if (subdomainsManger.IsAdmin(req.user.user, req.user.pass)) {
        if (req.body.action && req.body.action.match(/[\-+].+/)) {
            subdomainsManger.HandleSubdomainMgmtAction(req.body.action, req.user.user, req.user.pass, http_port, https_port);
        }
    }
    res.render('main', {
        "FORM": req.body,
        "USER": {username: req.user.user, userpass: req.user.pass},
        "YSubdomain": subdomainsManger,
        "Server": req.hostname + ':' + https_port
    });
});


app.get('/iframe.html', isLoggedIn, (req, res) => {
    res.sendFile(path.join(__dirname, 'data/iframe.html'));
});

app.get('/ajax.json', isLoggedIn, (req, res) => {
    let outlist = [];
    let subdomains = subdomainsManger.GetSubdomainsFor(req.user.user, req.user.pass);
    for (let i = 0; i < subdomains.length; i++) {
        let subdomain = subdomainsManger.GetSubdomain(subdomains[i]);
        let client_val;
        if (!subdomain.yapi)
            client_val = "(hub offline)";
        else
            client_val = subdomain.client;
        let link = subdomain.getRemoteLink();
        outlist[i] = {name: subdomain.name, netname: subdomain.netname, client: client_val, remotelink: link};
    }
    res.json(outlist);
});


app.use(express.static(path.join(__dirname, 'public')));
subdomainsManger.LoadConfig(app, http_port, https_port);

// Start web server
httpServer.listen(http_port, function () {
    console.log('HTTP Server running on port', http_port);
});
httpsServer.listen(https_port, function () {
    console.log('HTTPS Server running on port', https_port);
});

