// maintain state for a given device
// this needs to:
//   - work with multiple devices cleanly
//   - understand the websocket packets passing through
//   - accept state changes from outside of the websocket stream
//   - inject packets in the websocket stream to keep the device and cloud states consistent
"use strict";
// -> use "id" to uniquely identify devices.
const events = require("events");
const messageSchemas = {
    "login": {
        "account": "string",
        "id": "string",
        "deviceName": "string",
        "deviceVersion": "string",
        "deviceVersionCode": "number",
        "type": "string",
        "apptype": "string",
        "firmName": "string",
        "firmVersion": "string",
        "firmVersionCode": "number",
        "key": "number",
        "relay": "string"
    },
    "loginreply": {
        "uri": "string",
        "error": "number",
        "wd": "number",
        "year": "number",
        "month": "number",
        "day": "number",
        "ms": "number",
        "hh": "number",
        "hl": "number",
        "lh": "number",
        "ll": "number"
    },
    "ka": {
        "uri": "string"
    },
    "kr": {
        "uri": "string",
        "error": "number",
        "wd": "number",
        "year": "number",
        "month": "number",
        "day": "number",
        "ms": "number"
    },
    "report": {
        "uri": "string",
        "e": "string",
        "t": "string" // This is likely to be a measure of time during which the energy was used
    },
    "gettriggercount": {
        "uri": "string",
        // sent from cloud
        "cid": "string",
        "aboveInteger": "number",
        "aboveFraction": "number",
        "belowInteger": "number",
        "belowFraction": "number",
        "aboveAction": "number",
        "belowAction": "number",
        // sent by device
        "aboveTriggerCount": "number",
        "belowTriggerCount": "number"
    },
    "getruntime": {
        "uri": "string",
        "cid": "string"
    },
    "runtimeinfo": {
        "uri": "string",
        "relay": "string",
        "meastate": "string",
        "power": "string",
        "voltage": "string",
        "current": "string"
    },
    "relay": {
        "uri": "string",
        "cid": "string",
        "action": "string"
    },
    "setcontrolflags": {
        "uri": "string",
        "flag": "number",
        "set": "number"
    },
    "timer": {
        "uri": "string",
        // sent from cloud
        "action": "string",
        "id": "number",
        "year": "number",
        "month": "number",
        "day": "number",
        "start_time": "number",
        "start_action": "number",
        "duration": "number",
        "end_action": "number",
        "loop": "number",
        "cd": "number",
        // sent by device
        "error": "number"
    },
    "evtimer": {
        "uri": "string",
        "aname": "string",
        "relay": "string",
        "id": "number"
    },
    "upgrade": {
        "uri": "string",
        "url": "string",
        "newVersion": "string" // "1.75". whatever.
    },
    "state": {
        "uri": "string",
        "relay": "string"
    },
    "trigger": {
        "uri": "string",
        "type": "number"
    }
};
let logger;
class DeviceState extends events.EventEmitter {
    constructor(state = {}) {
        super();
        this.state = state;
        this.energy = {
            power: "0:0",
            voltage: "0:0"
        };
    }
    static setLogger(_logger) {
        logger = _logger;
    }
    static getDeviceStateByLogin(loginMessage) {
        const json = JSON.parse(loginMessage);
        return DeviceState.getDeviceStateById(json.id, true);
    }
    static getDeviceStateById(id, create = false) {
        if (!DeviceState.states[id]) {
            DeviceState.states[id] = new DeviceState();
        }
        return DeviceState.states[id];
    }
    validateMessage(json, schemaId) {
        const schema = messageSchemas[schemaId];
        const keys = Object.keys(json);
        let failedToValidate = false; // optimistic;
        keys.forEach((key) => {
            const type = typeof json[key];
            if (schema[key] !== type) {
                failedToValidate = true;
                if (schema[key]) {
                    logger.warn("Unexpected type for field [" + key + "] in payload ", json);
                }
                else {
                    logger.warn("Unknown field [" + key + "] found in payload ", json);
                }
            }
        });
        return !failedToValidate;
    }
    handleDeviceMessage(message) {
        logger.info("DEVICE -", (new Date).toLocaleString(), "\n", message);
        const json = JSON.parse(message);
        let validated = false;
        if (json.account) {
            // login message.
            validated = this.validateMessage(json, "login");
            this.state = json;
            // great to see what an /upgrade command looks like
            /*
            json.firmVersion = "1.65";
            json.firmVersionCode = 65;
            message = JSON.stringify(json);
            */
        }
        else {
            switch (json.uri) {
                case "/ka":
                    validated = this.validateMessage(json, "ka");
                    break;
                case "/kr":
                    validated = this.validateMessage(json, "kr"); // doesn't actually have any fields. that's okay.
                    break;
                case "/report":
                    validated = this.validateMessage(json, "report");
                    break;
                case "/evtimer":
                    validated = this.validateMessage(json, "evtimer");
                    this.state.relay = json.relay; // update internal state accordingly
                    this.emit("relay");
                    break;
                case "/getTriggerCnt":
                    validated = this.validateMessage(json, "gettriggercount");
                    // XXX track triggers? maybe later.
                    break;
                case "/runtimeInfo":
                    validated = this.validateMessage(json, "runtimeinfo");
                    this.state.relay = json.relay;
                    // XXX track those over time if we want pretty graphs/trends/whatever.
                    this.energy.power = json.power;
                    this.energy.voltage = json.voltage;
                    this.emit("relay");
                    this.emit("power");
                    break;
                case "/setCtlFlags":
                    validated = this.validateMessage(json, "setcontrolflags");
                    // no state here. this is a write only API apparently.
                    break;
                case "/timer":
                    validated = this.validateMessage(json, "timer");
                    break;
                case "/state":
                    validated = this.validateMessage(json, "state");
                    this.state.relay = json.relay;
                    this.emit("relay");
                    break;
                case "/trigger":
                    validated = this.validateMessage(json, "trigger");
                    break;
                // other URIs I should expect to pop out of this device include
                // "/assignGuid",
                // "/complete",
                // "/beginMeasure",
                // "/delDevice",
                // "/setTrigger",
                // "/delTrigger",
                // "/clrTriggerCnt",
                // "/resetID",
                // "/softRestore"
                // "/resetManufactureFlag"
                // "/beginConfigReply"
                default:
                    // unknown message. scary, but exciting.
                    logger.warn("Unknown device payload ", json);
            }
        }
        if (validated) {
            return message;
        }
        else {
            logger.error("BLOCKED DEVICE MESSAGE: \n", message);
        }
    }
    handleCloudMessage(message) {
        logger.info("CLOUD -", (new Date).toLocaleString(), "\n", message);
        const json = JSON.parse(message);
        let validated = false;
        switch (json.uri) {
            case "/loginReply":
                validated = this.validateMessage(json, "loginreply");
                break;
            case "/ka":
                validated = this.validateMessage(json, "ka");
                break;
            case "/kr":
                validated = this.validateMessage(json, "kr");
                break;
            case "/getTriggerCnt":
                validated = this.validateMessage(json, "gettriggercount");
                break;
            case "/getRuntime":
                validated = this.validateMessage(json, "getruntime");
                break;
            case "/relay":
                validated = this.validateMessage(json, "relay");
                // don't use state given here. the device is the Source of Truth.
                break;
            case "/setCtlFlags":
                validated = this.validateMessage(json, "setcontrolflags");
                // XXX store flags somewhere?
                break;
            case "/timer":
                validated = this.validateMessage(json, "timer");
                // XXX if we want to track timers, it needs to be here
                break;
            // other URIs I should expect to come from the cloud include
            // "/upgrade" <- literally a firmware upgrade. CAREFUL WITH THIS ONE
            // "/assignGuid"
            // "/calibration"
            // "/complete"
            // "/delDevice"
            // "/setTrigger"
            // "/delTrigger"
            // "/clrTriggerCnt"
            // "/resetID"
            // "/softRestore"
            // "/beginMeasure"
            // "/setManufactureFlag"
            // "/beginConfigRequest" ( wifiID wifiPassword account wifiGateway wifiDNS wifiBssid serverIP )
            // "/discoverReply"
            // "/register"
            default:
                // unknown message from the cloud. mostly just scary.
                logger.warn("Unknown cloud payload ", json);
        }
        if (validated) {
            return message;
        }
        else {
            logger.error("BLOCKED CLOUD MESSAGE: \n", message);
        }
    }
    setInjector(injector) {
        this.injector = injector;
    }
    unsetInjector() {
        delete this.injector;
    }
    injectRelay(relay) {
        if (!this.injector) {
            throw "Nope. can't inject relay state right now. sorry.";
        }
        this.state.relay = relay;
        this.injector.sendToDevice({
            cid: this.state.id,
            uri: "/relay",
            action: relay
        });
        this.injector.sendToCloud({
            uri: "/state",
            relay
        });
    }
    injectGetRuntime() {
        if (!this.injector) {
            throw "Nope. can't inject getRuntime right now. sorry.";
        }
        this.injector.sendToDevice({
            cid: this.state.id,
            uri: "/getRuntime"
        });
    }
}
// factory pattern. #sorrynotsorry.
DeviceState.states = {};
module.exports = DeviceState;
