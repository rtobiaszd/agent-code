"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.selfHeal = selfHeal;
const config_1 = require("../config");
const fs_utils_1 = require("../core/fs-utils");
const git_1 = require("../core/git");
const logger_1 = require("../core/logger");
const text_1 = require("../core/text");
const ollama_1 = require("../models/ollama");
const prompts_1 = require("../planning/prompts");
const health_1 = require("../repo/health");
const indexer_1 = require("../repo/indexer");
const implementation_1 = require("./implementation");
const verification_1 = require("./verification");
async function selfHeal(input) {
    const { blueprint, task, memory, baselineHealth } = input;
    let currentImpl = input.implementation;
    let previousSummary = baselineHealth.summary || '';
    let previousSignature = (0, text_1.stableTextSignature)(previousSummary);
    for (let attempt = 1; attempt <= config_1.CONFIG.MAX_SELF_HEAL_ATTEMPTS; attempt += 1) {
        const currentFiles = (0, indexer_1.collectFileContents)((0, text_1.unique)([...(task.files || []), ...(currentImpl.files || []).map((item) => item.path)]).slice(0, config_1.CONFIG.MAX_CONTEXT_FILES));
        const prompt = (0, prompts_1.buildSelfHealPrompt)({
            blueprint,
            task,
            implementation: currentImpl,
            failedSummary: previousSummary,
            currentFiles,
            commands: baselineHealth.commands || {}
        });
        let fixedImpl;
        try {
            fixedImpl = await (0, ollama_1.askAndParseJson)(config_1.CONFIG.MODEL_FIXER, prompt, 'self-heal', implementation_1.isValidImplementation);
        }
        catch (error) {
            (0, logger_1.debug)('self-heal parse error:', error instanceof Error ? error.message : String(error));
            continue;
        }
        try {
            fixedImpl = (0, implementation_1.sanitizeImplementation)(fixedImpl, task).impl;
        }
        catch (error) {
            (0, logger_1.debug)('self-heal sanitize error:', error instanceof Error ? error.message : String(error));
            continue;
        }
        if ((0, implementation_1.containsDangerousContent)(fixedImpl))
            continue;
        const touchedPaths = (0, text_1.unique)([
            ...fixedImpl.files.map((item) => (0, fs_utils_1.normalizeSlashes)(item.path)),
            ...(fixedImpl.delete_files || []).map((item) => (0, fs_utils_1.normalizeSlashes)(item))
        ]);
        const backups = (0, fs_utils_1.backupFiles)(touchedPaths);
        try {
            (0, implementation_1.applyImplementation)(fixedImpl);
            const checks = (0, verification_1.runVerification)(memory, { mode: 'fast', logger: logger_1.log });
            const nextSummary = checks.summary || previousSummary;
            const nextSignature = (0, text_1.stableTextSignature)(nextSummary);
            const progress = (0, text_1.errorProgressScore)(nextSummary) < (0, text_1.errorProgressScore)(previousSummary) || nextSignature !== previousSignature;
            if (checks.ok) {
                memory.metrics.selfHealSuccess += 1;
                return {
                    ok: true,
                    implementation: (0, implementation_1.mergeImplementations)(currentImpl, fixedImpl),
                    progress: true,
                    lastFailedSummary: previousSummary
                };
            }
            const afterHealth = { ok: checks.ok, summary: checks.summary, signature: nextSignature };
            const comparison = (0, health_1.compareRepoHealth)(baselineHealth, afterHealth);
            currentImpl = (0, implementation_1.mergeImplementations)(currentImpl, fixedImpl);
            previousSummary = nextSummary;
            previousSignature = nextSignature;
            if (progress || comparison.improved) {
                (0, logger_1.log)(`⚠️ self-heal attempt ${attempt} improved the failure surface; continuing`);
                continue;
            }
            (0, fs_utils_1.restoreBackup)(backups);
            (0, git_1.rollbackHard)();
        }
        catch (error) {
            (0, logger_1.debug)('self-heal apply error:', error instanceof Error ? error.message : String(error));
            (0, fs_utils_1.restoreBackup)(backups);
            (0, git_1.rollbackHard)();
        }
    }
    memory.metrics.selfHealFail += 1;
    return { ok: false, implementation: currentImpl, lastFailedSummary: previousSummary };
}
