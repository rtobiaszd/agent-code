"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRuntimeLoopContext = createRuntimeLoopContext;
exports.evaluateRuntimePolicy = evaluateRuntimePolicy;
exports.registerCycleMetric = registerCycleMetric;
exports.delayBetweenCycles = delayBetweenCycles;
const config_1 = require("../config");
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_CYCLE_METRICS = 300;
function createRuntimeLoopContext() {
    return {
        startedAtMs: Date.now(),
        iteration: 0,
        consecutiveFailures: 0
    };
}
function evaluateRuntimePolicy(context) {
    if (context.iteration >= config_1.CONFIG.MAX_ITERATIONS) {
        return {
            shouldContinue: false,
            reason: `max_iterations_reached:${config_1.CONFIG.MAX_ITERATIONS}`
        };
    }
    const elapsedMs = Date.now() - context.startedAtMs;
    if (elapsedMs >= config_1.CONFIG.MAX_RUNTIME_MS) {
        return {
            shouldContinue: false,
            reason: `max_runtime_reached:${config_1.CONFIG.MAX_RUNTIME_MS}ms`
        };
    }
    if (context.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        return {
            shouldContinue: false,
            reason: `consecutive_cycle_failures:${context.consecutiveFailures}`
        };
    }
    return { shouldContinue: true };
}
function registerCycleMetric(memory, metric) {
    memory.runtime.cycleMetrics.unshift(metric);
    memory.runtime.cycleMetrics = memory.runtime.cycleMetrics.slice(0, MAX_CYCLE_METRICS);
    memory.runtime.lastLoopResult = metric.result;
    if (metric.result === 'failure') {
        memory.runtime.consecutiveCycleFailures += 1;
    }
    else {
        memory.runtime.consecutiveCycleFailures = 0;
    }
}
async function delayBetweenCycles() {
    if (config_1.CONFIG.LOOP_DELAY_MS <= 0)
        return;
    await new Promise((resolve) => {
        setTimeout(resolve, config_1.CONFIG.LOOP_DELAY_MS);
    });
}
