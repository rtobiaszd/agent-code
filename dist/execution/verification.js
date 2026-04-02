"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runVerification = runVerification;
const config_1 = require("../config");
const health_1 = require("../repo/health");
function runVerification(memory, input) {
    const mode = input.mode || 'fast';
    const commands = (0, health_1.detectProjectCommands)(config_1.CONFIG);
    const verifyResults = (0, health_1.runCommands)(config_1.CONFIG, commands.verify, 'verify', input.logger);
    const verifyOk = verifyResults.every((item) => item.ok);
    let testResults = [];
    let testOk = true;
    if (verifyOk && mode === 'full') {
        testResults = (0, health_1.runCommands)(config_1.CONFIG, commands.test, 'test', input.logger);
        testOk = testResults.every((item) => item.ok);
    }
    if (verifyOk)
        memory.metrics.verifyPass += 1;
    else
        memory.metrics.verifyFail += 1;
    if (mode === 'full') {
        if (testOk)
            memory.metrics.testPass += 1;
        else
            memory.metrics.testFail += 1;
    }
    return {
        ok: verifyOk && testOk,
        mode,
        commands,
        verifyResults,
        testResults,
        summary: (0, health_1.summarizeVerificationResults)(verifyResults, testResults)
    };
}
