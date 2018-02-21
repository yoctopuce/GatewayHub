Yoctopuce Gateway Hub
=====================

## What is this tool good for ?

This Node.js service works as a gateway to enhance the connectivity
options for Yoctopuce networked hubs (also known as
[YoctoHubs](https://www.yoctopuce.com/EN/products/category/extensions-and-networking)).

In particular, the Gateway Hub can act as a secure front-end
to access the interactive user interface of a YoctoHub protected
by a NAT filter or a firewall, without using port forwarding.
For more details, see [this article](https://www.yoctopuce.com/EN/article/a-gateway-to-remotely-access-yoctohubs)
It can also be used to dispatch callbacks to multiple third-party
services, as described in [this other article](https://www.yoctopuce.com/EN/article/a-gateway-to-forward-yoctohub-callbacks)

## Installation

This small gateway is based on standard Node.js solutions to offer a 
simple (http://) and secure (https://) web service, with simple (ws://) 
and secure (wss://) WebSocket service. 

This code requires a recent version of Node.js. Often, hosts allow you 
to select the Node.js version with the nvm version manager. If it is the 
case, you can use the following commands to enable the latest version: 

`nvm install node`

`nvm use node`
 
Copy the gateway files on your Node.js server, and run the following 
command to automatically install all the dependencies: 

`npm install`
 
In order to enable the secure interface https, you will also have to put 
in the same directory the certificates to be used: two files named cert.pem 
and key.pem, which are usually provided by our SSL certificate provider or 
hosting provider. In case you just want to make a test, you can also use 
self-signed certificates created using OpenSSL, by typing the following 
command (on a single line): 

`openssl req -newkey rsa:2048 -new -nodes -x509 -days 3650 -keyout key.pem -out cert.pem` 

You then only have to manually run the application, indicating the ports 
to be used respectively for the http and https protocols: 

`node gateway.js 44080 44443`

For your application to run and run again automatically, you can use the 
forever package, or another solution recommended by your provider. 

You will probably also have to open these two incoming TCP ports in your 
hosting configuration (44080 and 44443) as in most cases the default 
setting for node.js is to have all ports blocked by default. 

To connect a YoctoHub or a VirtualHub to a HomeAutomation subdomain, for 
example, and supposing that you installed the gateway on a server named 
yoctohost.org with HTTP port 38088, you must configure the hub callback 
as follows:

* Callback type: Yocto-API callback
* Callback URL: ws://yoctohost.org:44080/HomeAutomation/callback
* Security type: WebSocket
* Websocket callback password: of your own making...
* Connection delay: 3 seconds

## License information

Copyright (C) 2015 and beyond by Yoctopuce Sarl, Switzerland.

Yoctopuce Sarl (hereafter Licensor) grants to you a perpetual
non-exclusive license to use, modify, copy and integrate this
file into your software for the sole purpose of interfacing
with Yoctopuce products.

You may reproduce and distribute copies of this file in
source or object form, as long as the sole purpose of this
code is to interface with Yoctopuce products. You must retain
this notice in the distributed source file.

You should refer to Yoctopuce General Terms and Conditions
for additional information regarding your rights and
obligations.

THE SOFTWARE AND DOCUMENTATION ARE PROVIDED "AS IS" WITHOUT
WARRANTY OF ANY KIND, EITHER EXPRESS OR IMPLIED, INCLUDING
WITHOUT LIMITATION, ANY WARRANTY OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE, TITLE AND NON-INFRINGEMENT. IN NO
EVENT SHALL LICENSOR BE LIABLE FOR ANY INCIDENTAL, SPECIAL,
INDIRECT OR CONSEQUENTIAL DAMAGES, LOST PROFITS OR LOST DATA,
COST OF PROCUREMENT OF SUBSTITUTE GOODS, TECHNOLOGY OR
SERVICES, ANY CLAIMS BY THIRD PARTIES (INCLUDING BUT NOT
LIMITED TO ANY DEFENSE THEREOF), ANY CLAIMS FOR INDEMNITY OR
CONTRIBUTION, OR OTHER SIMILAR COSTS, WHETHER ASSERTED ON THE
BASIS OF CONTRACT, TORT (INCLUDING NEGLIGENCE), BREACH OF
WARRANTY, OR OTHERWISE.
