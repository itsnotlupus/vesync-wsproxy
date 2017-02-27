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

const LOCAL_PORT = 17273; // port for the local websocket server
const LOCAL_PATH = "/gnws";

// OTHER REMOTE URL found in user1.bin:
// ws://192.168.1.99:17273/gnws        // intriguing. 
// ws://server2.vesync.com:17275/gnwss // doesn't seem to be setup
// ws://server2.vesync.com:17273/gnws

const REMOTE_URL = "ws://server2.vesync.com:17273/gnws";
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
        },2000); // 2 seconds to see a login packet, else we bail.
        local_ws.on('message', function(message: string) {
            if (!state) {
                // must be a login message.
                state = DeviceState.getDeviceStateByLogin(message);
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
        var remote_ws = new WebSocket(remoteUrl, {});
        remote_ws.on('open', function(){
            logger.info("Cloud connected.");
            state.setInjector({
                sendToDevice: (json) => {
                    local_ws.send(JSON.stringify(json));
                },
                sendToCloud: (json) => {
                    remote_ws.send(JSON.stringify(json));
                }
            })
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

    // GET is very much the wrong verb for this, but it's so easy to test with.
    // also, some kind of AUTH might be handy here..
    app.get('/relay', function (req: express.Request, res: express.Response) {
        const id = req.query.id;
        const on = req.query.on==="1";
        // grab a DeviceState object
        const state = DeviceState.getDeviceStateById(id);
        const relay = on?"open":"break";
        state.injectRelay(relay);
        res.send("OK. relay="+relay);
    });
    app.get('/power', function (req: express.Request, res:express.Response) {
        const id = req.query.id;
        const state = DeviceState.getDeviceStateById(id);
        state.once("power", () => {
            const power_tmp = state.energy.power.split(":").map((s)=>parseInt(s,16));
            const power = (power_tmp[0]+power_tmp[1])/8192; // XXX probably not quite right.
            const voltage_tmp = state.energy.voltage.split(":").map((s)=>parseInt(s,16));
            const voltage = (voltage_tmp[0]+voltage_tmp[1])/8192; // XXX same issue
            res.send({relay: state.state.relay, watts: power, volts: voltage});
        });
        state.injectGetRuntime();
    });
    // open relay IF it's night time, for 2 minutes.
    // If it was already open, do nothing.
    app.get('/nightlight', function (req:express.Request, res: express.Response) {
        const id = req.query.id;
        const time = new Date();
        const state = DeviceState.getDeviceStateById(id);
        if (time.getHours() > 19 || time.getHours()<7) { // night between 7pm and 7am. deal.
            if (state.state.relay !== "open") {
                state.injectRelay("open");
                setTimeout(() => {
                    state.injectRelay("break");
                }, 2*60*1000);
            }
        }
        res.send("OK, whatever.");
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

logger.info("Server started");
