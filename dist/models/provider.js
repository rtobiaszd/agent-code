"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.withExponentialBackoff = withExponentialBackoff;
exports.withTimeout = withTimeout;
const config_1 = require("../config");
async function withExponentialBackoff(operation, input) {
    const retries = Number(input?.retries ?? config_1.CONFIG.MODEL_RETRY_ATTEMPTS);
    const initialDelayMs = Number(input?.initialDelayMs ?? config_1.CONFIG.MODEL_RETRY_BACKOFF_MS);
    const maxDelayMs = Number(input?.maxDelayMs ?? config_1.CONFIG.MODEL_RETRY_MAX_BACKOFF_MS);
    let attempt = 0;
    let lastError = null;
    while (attempt <= retries) {
        try {
            return await operation();
        }
        catch (error) {
            lastError = error;
            if (attempt >= retries)
                break;
            const waitMs = Math.min(initialDelayMs * 2 ** attempt, maxDelayMs);
            await new Promise((resolve) => setTimeout(resolve, waitMs));
            attempt += 1;
        }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError || 'unknown model provider error'));
}
async function withTimeout(operation, timeoutMs, label) {
    if (timeoutMs <= 0)
        return operation();
    return await Promise.race([
        operation(),
        new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`Timeout em ${label} após ${timeoutMs}ms`)), timeoutMs);
        })
    ]);
}
