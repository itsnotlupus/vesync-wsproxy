// MitM proxy for Etekcity Voltson Smart Wi-Fi Outlet

// network configuration:
// 1. have the DNS server that the outlet is using return your server IP address for "server2.vesync.com"
// ( for example with dnsmasq, use `address=/server2.vesync.com/192.168.0.5` )
// 2. Ensure that your server still knows how to access the real server.
// ( for example, add to your /etc/hosts something like `104.200.30.164  server2.vesync.com`)

// for wifi setup, it looks like the firmware has support for both air kiss and esp-touch
// esp-touch apparently fires opaque UDP packets over the WIFI and the device is expected to use the 
// length field of those packets to decode the wifi bssid, password, etc.

import WebSocket = require('ws');
import express = require('express');
import DeviceState = require('./state');
import winston = require('winston');

const config = require('../config.json');

const LOCAL_PORT = 17273; // port for the local websocket server
const LOCAL_PATH = "/gnws";

// OTHER REMOTE URL found in user1.bin:
// ws://192.168.1.99:17273/gnws        // intriguing. 
// ws://server2.vesync.com:17275/gnwss // doesn't seem to be setup
// ws://server2.vesync.com:17273/gnws

//const REMOTE_URL = "ws://server2.vesync.com:17273/gnws";
const REMOTE_URL = "ws://" + process.env.REMOTE_IP + ":17273/gnws";
const SERVICE_PORT = 16522; // port for the web service

// logger stuff
const logger = new winston.Logger({
    transports: [
        new winston.transports.File({
            level: 'info',
            filename: './logs/server.log',
            handleExceptions: true,
            json: true,
            maxsize: 524880, // 5MB
            maxFiles: 5,
            colorize: false
        }),
        new winston.transports.Console({
            level: 'debug',
            handleExceptions: true,
            json: false,
            colorize: true
        })
    ],
    exitOnError: false
});

// basic websocket proxy
function startWebsocketProxy(localPort: number, localPath: string, remoteUrl: string) {
    DeviceState.setLogger(logger);
    const wss = new WebSocket.Server({port: localPort, path: localPath});
    wss.on('connection', function(local_ws) {  
        let state: DeviceState;
        logger.info("Device connected.");
        // start buffering device payloads immediately
        const buffer: string[] = [];
        let remote_ready = false;
        let connected = true;
        setTimeout(()=>{
            if (!state) {
                logger.warn("no login seen after 2 seconds. killing websocket.");
                cleanup();
            }
        }, 2000); // 2 seconds to see a login packet, else we bail.
        local_ws.on('message', function(message: string) {
            if (!state) {
                // must be a login message.
		logger.info("loginmessage: ", message);
                state = DeviceState.getDeviceStateByLogin(message);
                state.setInjector({
                    sendToDevice: (json) => {
                        local_ws.send(JSON.stringify(json));
                    },
                    sendToCloud: (json) => {
                        remote_ws.send(JSON.stringify(json));
                    }
                })
            }
            message = state.handleDeviceMessage(message);
            if (message) {
                if (remote_ready) {
                    connected && remote_ws.send(message);
                } else {
                    buffer.push(message);
                }
            }
        }).on('close', cleanup).on('error', cleanup);

        // open connection to other side
        const remote_ws = new WebSocket(remoteUrl, {});
        remote_ws.on('open', function(){
            logger.info("Cloud connected.");
            // flush buffer
            while (buffer.length){
                remote_ws.send(buffer.shift());
            }
            // both connections are established. start piping.
            remote_ready = true;
            remote_ws.on('message', function(message: string) {
                message = state.handleCloudMessage(message);
                if (message) {
                    connected && local_ws.send(message);
                }
            }).on('close', cleanup).on('error', cleanup);
        })

        function cleanup(code?: number|Error, description?: string) {
            if (code || description) {
                logger.warn("WebSocket error: ",code, description);
            }
            connected = false; // prevent further attempts to .send(), which would throw.
            if (state) {
                state.unsetInjector();
            }
            try{remote_ws.close();}catch(e){}
            try{local_ws.close();}catch(e){}
            logger.info("Connections closed.");
        }
    });
}

// basic web service
function startWebService(servicePort: number) {
    const app = express();

    function stringParam(req: express.Request, name: string, minSize: number =0, maxSize: number = 1000) {
        const value = req.query[name];
        if (value.length>=minSize || value.length<=maxSize) {
            return value;
        } 
    }

    function setRelayState(id: string, relay: "open"|"break") {
        const state = DeviceState.getDeviceStateById(id);
        state.injectRelay(relay);
    }
    function getPower(id: string, callback: Function) {
        const state = DeviceState.getDeviceStateById(id);
        state.once("power", () => {
            const power_tmp = state.energy.power.split(":").map((s)=>parseInt(s,16));
            const power = (power_tmp[0]+power_tmp[1])/8192; // XXX probably not quite right.
            const voltage_tmp = state.energy.voltage.split(":").map((s)=>parseInt(s,16));
            const voltage = (voltage_tmp[0]+voltage_tmp[1])/8192; // XXX same issue
            callback({relay: state.state.relay, watts: power, volts: voltage});
        });
        state.injectGetRuntime();
    }
    function enableNightlight(id: string) {
        const time = new Date();
        const state = DeviceState.getDeviceStateById(id);
        if (time.getHours() > 18 || time.getHours()<9) { // night between 6pm and 9am. deal.
            if (state.state.relay !== "open") {
                state.injectRelay("open");
                setTimeout(() => {
                    state.injectRelay("break");
                }, 2*60*1000);
            }
        }
    }
    let matchers: { regex: RegExp, names: string[] }[];
    function parseTextIntoNames(text: string): string[] {
        let label = text.trim().toLowerCase();
        if (label.startsWith("the ")) {
            label = label.slice(4);
        }
        if (!matchers) {
            // parse labels once.
            matchers = [];
            Object.keys(config.labels).forEach((incantation)=> {
                const regex = new RegExp(incantation, "i");
                matchers.push({ regex, names: config.labels[incantation] });
            });
        }
        let names: string[] = [];
        matchers.some(matcher => {
            if (label.match(matcher.regex)) {
                names = matcher.names;
                return true;
            }
        });
        return names;
    }

    // GET is very much the wrong verb for this, but it's so easy to test with.
    // also, some kind of AUTH might be handy here..

    // flip a relay on or off by guid or by friendly name, as defined in config
    app.all('/api/relay', function (req: express.Request, res: express.Response) {
        const name = stringParam(req, "name");
        const id = config.outlets[name].id || stringParam(req, "id", 5, 40);
        const on = stringParam(req, "on", 1, 1)==="1";
        // grab a DeviceState object
        const relay = on?"open":"break";
        setRelayState(id, relay);
        res.send("OK. relay="+relay);
    });
    // get instant power readout for an outlet, by guid or by friendly name
    app.all('/api/power', function (req: express.Request, res:express.Response) {
        const name = stringParam(req, "name");
        const id = config.outlets[name].id || stringParam(req, "id", 5, 40);
        getPower(id, (json) => res.send(json));
    });
    // open relay IF it's night time, for 2 minutes.
    // If it was already open, do nothing.
    app.all('/api/nightlight', function (req:express.Request, res: express.Response) {
        const name = stringParam(req, "name");
        const id = config.outlets[name].id || stringParam(req, "id", 5, 40);
        enableNightlight(id);
        res.send("OK, whatever.");
    });
    // open all the known outlets if it's night time, for 2 minutes
    app.all('/api/nightlights', function (req:express.Request, res: express.Response) {
        Object.keys(config.outlets).forEach((name: string)=> {
            const id = config.outlets[name].id;
            enableNightlight(id);
        });
        res.send("Yeah ok.");
    });
    // cheapo regex-powered NLP to map some text to some relays to flip on or off.
    app.all('/api/natural', function (req:express.Request, res:express.Response) {
        const text = stringParam(req, "text");
        const names = parseTextIntoNames(text);
        const on = stringParam(req, "on", 1, 1)==="1";
        const relay = on?"open":"break";
        console.log("/natural: text=", text, "mapped to", names);
        names.forEach((name) => {
            const id = config.outlets[name].id;
            setRelayState(id, relay);
        });
        res.send("ooh look at me, I'm sooo smart.");
    });

    // logger stuff
    const access_logger = new winston.Logger({
        transports: [
            new winston.transports.File({
                level: 'info',
                filename: './logs/access.log',
                handleExceptions: true,
                json: true,
                maxsize: 524880, // 5MB
                maxFiles: 5,
                colorize: false
            }),
            new winston.transports.Console({
                level: 'debug',
                handleExceptions: true,
                json: false,
                colorize: true
            })
        ],
        exitOnError: false
    });
    class MyStream {
        write(text: string) {
            access_logger.info(text)
        }
    }
    app.use(require("morgan")("combined", { "stream": new MyStream() }));

    app.listen(servicePort);
}

startWebsocketProxy(LOCAL_PORT, LOCAL_PATH, REMOTE_URL);
startWebService(SERVICE_PORT);

logger.info("REMOTE_URL: ", REMOTE_URL);
logger.info("Server started");
