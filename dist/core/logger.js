"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.log = log;
exports.debug = debug;
const config_1 = require("../config");
function stamp() {
    return new Date().toISOString();
}
function log(...args) {
    console.log(stamp(), '-', ...args);
}
function debug(...args) {
    if (config_1.CONFIG.DEBUG) {
        console.log(stamp(), '-', '[DEBUG]', ...args);
    }
}
