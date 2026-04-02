"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createModelProvider = createModelProvider;
exports.getModelProvider = getModelProvider;
const config_1 = require("../config");
const logger_1 = require("../core/logger");
const ollama_1 = require("./ollama");
let providerSingleton = null;
function createModelProvider(providerName = config_1.CONFIG.MODEL_PROVIDER) {
    switch (String(providerName || '').toUpperCase()) {
        case 'OLLAMA':
            return new ollama_1.OllamaProvider();
        case 'OPENAI':
            throw new Error('Provider OPENAI ainda não implementado.');
        default:
            throw new Error(`Provider não suportado: ${providerName}`);
    }
}
function getModelProvider() {
    if (!providerSingleton) {
        providerSingleton = createModelProvider(config_1.CONFIG.MODEL_PROVIDER);
        (0, logger_1.log)(`🤖 model provider: ${providerSingleton.name}`);
    }
    return providerSingleton;
}
