"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.askModel = askModel;
exports.repairJsonWithModel = repairJsonWithModel;
exports.askAndParseJson = askAndParseJson;
const axios_1 = __importDefault(require("axios"));
const config_1 = require("../config");
const text_1 = require("../core/text");
const logger_1 = require("../core/logger");
async function askModel(model, prompt) {
    const response = await axios_1.default.post(config_1.CONFIG.OLLAMA_URL, { model, prompt, stream: false }, { timeout: 1000 * 60 * 10 });
    return response.data?.response || '';
}
async function repairJsonWithModel(model, raw, label) {
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
    const repairedRaw = await askModel(model, prompt);
    const parsed = (0, text_1.parseJsonSafe)(repairedRaw);
    if (parsed) {
        (0, logger_1.log)(`🧩 JSON repaired for ${label}`);
        return parsed;
    }
    return null;
}
async function askAndParseJson(model, prompt, label, validator) {
    const raw = await askModel(model, prompt);
    let parsed = (0, text_1.parseJsonSafe)(raw);
    if (!parsed && config_1.CONFIG.MAX_JSON_REPAIR_ATTEMPTS > 0) {
        parsed = await repairJsonWithModel(config_1.CONFIG.MODEL_JSON_REPAIR, raw, label);
    }
    if (!parsed) {
        throw new Error(`Falha ao parsear JSON para ${label}`);
    }
    if (validator && !validator(parsed)) {
        throw new Error(`JSON inválido para ${label}`);
    }
    return parsed;
}
