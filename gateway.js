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
// Setup ports
const http_port = (process.argv.length < 3 ? 44080 : parseInt(process.argv[2]));
const https_port = (process.argv.length < 4 ? 44443 : parseInt(process.argv[3]));

const subdomains = require('./subdomain.js');
const subdomainsManger = new subdomains.YSubdomainManager(app, http_port, https_port);
// noinspection JSIgnoredPromiseFromCall
YAPI.LogUnhandledPromiseRejections();

// Instantiate a Web server with both HTTP/WS and HTTPS/WSS support
const options = {
    key: fs.readFileSync('key.pem'),
    cert: fs.readFileSync('cert.pem')
};
const httpServer = http.createServer(app);
// noinspection JSUnusedLocalSymbols
const wsServer = express_ws(app, httpServer);
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
    console.log('HTTP Server running on port', https_port);
});
httpsServer.listen(https_port, function () {
    console.log('HTTPS Server running on port', https_port);
});

