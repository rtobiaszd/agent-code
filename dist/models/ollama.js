"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OllamaProvider = void 0;
exports.askModel = askModel;
exports.askAndParseJson = askAndParseJson;
exports.repairJsonWithModel = repairJsonWithModel;
const axios_1 = __importDefault(require("axios"));
const config_1 = require("../config");
const text_1 = require("../core/text");
const logger_1 = require("../core/logger");
const provider_1 = require("./provider");
class OllamaProvider {
    constructor() {
        this.name = 'OLLAMA';
        this.metrics = {};
    }
    registerMetric(model, input) {
        const current = this.metrics[model] || {
            requests: 0,
            errors: 0,
            totalLatencyMs: 0,
            lastLatencyMs: 0,
            totalResponseSize: 0,
            lastResponseSize: 0
        };
        current.requests += 1;
        if (!input.ok)
            current.errors += 1;
        current.totalLatencyMs += input.latencyMs;
        current.lastLatencyMs = input.latencyMs;
        current.totalResponseSize += input.responseSize;
        current.lastResponseSize = input.responseSize;
        this.metrics[model] = current;
    }
    async generateText(input) {
        const timeoutMs = Number(input.timeoutMs ?? config_1.CONFIG.MODEL_TIMEOUT_MS);
        const startedAt = Date.now();
        let responseText = '';
        try {
            responseText = await (0, provider_1.withTimeout)(async () => {
                const response = await axios_1.default.post(config_1.CONFIG.OLLAMA_URL, { model: input.model, prompt: input.prompt, stream: false }, { timeout: timeoutMs });
                return String(response.data?.response || '');
            }, timeoutMs, `${this.name}:${input.model}`);
            this.registerMetric(input.model, { ok: true, latencyMs: Date.now() - startedAt, responseSize: responseText.length });
            return responseText;
        }
        catch (error) {
            this.registerMetric(input.model, { ok: false, latencyMs: Date.now() - startedAt, responseSize: responseText.length });
            throw error;
        }
    }
    async repairJsonWithModel(model, raw, label) {
        const prompt = [
            'You are a JSON repair engine.',
            '',
            'TASK:',
            'Repair the following broken JSON so it becomes directly parsable by JSON.parse.',
            '',
            'RULES:',
            '- Return ONLY valid JSON',
            '- No markdown',
            '- No explanation',
            '- Keep the original structure and intent',
            '- Escape all strings correctly',
            '- Preserve file contents exactly as much as possible',
            '',
            'BROKEN INPUT:',
            (0, text_1.truncate)(raw, 40000)
        ].join('\n');
        const repairedRaw = await this.generateText({ model, prompt });
        const parsed = (0, text_1.parseJsonSafe)(repairedRaw);
        if (parsed) {
            (0, logger_1.log)(`🧩 JSON repaired for ${label}`);
            return parsed;
        }
        return null;
    }
    async generateJson(input) {
        return await (0, provider_1.withExponentialBackoff)(async () => {
            const raw = await this.generateText({ model: input.model, prompt: input.prompt, timeoutMs: input.timeoutMs });
            let parsed = (0, text_1.parseJsonSafe)(raw);
            if (!parsed && config_1.CONFIG.MAX_JSON_REPAIR_ATTEMPTS > 0) {
                parsed = await this.repairJsonWithModel(config_1.CONFIG.MODEL_JSON_REPAIR, raw, input.label);
            }
            if (!parsed) {
                throw new Error(`Falha ao parsear JSON para ${input.label}`);
            }
            if (input.validator && !input.validator(parsed)) {
                throw new Error(`JSON inválido para ${input.label}`);
            }
            return parsed;
        }, { retries: config_1.CONFIG.MODEL_RETRY_ATTEMPTS, initialDelayMs: config_1.CONFIG.MODEL_RETRY_BACKOFF_MS, maxDelayMs: config_1.CONFIG.MODEL_RETRY_MAX_BACKOFF_MS });
    }
    async healthCheck() {
        try {
            await axios_1.default.get(config_1.CONFIG.OLLAMA_URL.replace('/api/generate', '/api/tags'), { timeout: Math.min(config_1.CONFIG.MODEL_TIMEOUT_MS, 5000) });
            return true;
        }
        catch {
            return false;
        }
    }
    getMetrics() {
        const byModel = Object.fromEntries(Object.entries(this.metrics).map(([model, metric]) => [
            model,
            {
                requests: metric.requests,
                errors: metric.errors,
                averageLatencyMs: metric.requests > 0 ? Math.round(metric.totalLatencyMs / metric.requests) : 0,
                lastLatencyMs: metric.lastLatencyMs,
                averageResponseSize: metric.requests > 0 ? Math.round(metric.totalResponseSize / metric.requests) : 0,
                lastResponseSize: metric.lastResponseSize
            }
        ]));
        const totals = Object.values(this.metrics).reduce((acc, metric) => {
            acc.requests += metric.requests;
            acc.errors += metric.errors;
            return acc;
        }, { requests: 0, errors: 0 });
        return {
            provider: this.name,
            byModel,
            totalRequests: totals.requests,
            totalErrors: totals.errors,
            errorRate: totals.requests > 0 ? totals.errors / totals.requests : 0
        };
    }
}
exports.OllamaProvider = OllamaProvider;
const legacyOllamaProvider = new OllamaProvider();
async function askModel(model, prompt) {
    return legacyOllamaProvider.generateText({ model, prompt });
}
async function askAndParseJson(model, prompt, label, validator) {
    return legacyOllamaProvider.generateJson({ model, prompt, label, validator });
}
async function repairJsonWithModel(model, raw, label) {
    return legacyOllamaProvider.repairJsonWithModel(model, raw, label);
}
