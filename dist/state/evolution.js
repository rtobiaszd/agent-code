"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deriveNextOpportunities = deriveNextOpportunities;
exports.updateMainEvolutionDoc = updateMainEvolutionDoc;
const config_1 = require("../config");
const fs_utils_1 = require("../core/fs-utils");
const text_1 = require("../core/text");
const memory_1 = require("./memory");
function deriveNextOpportunities(input) {
    const { task, implementation, review } = input;
    const touchedFiles = (0, text_1.unique)((implementation.files || []).map((item) => item.path)).slice(0, 6);
    const opportunities = [];
    if (task.category !== 'tests' && touchedFiles.length) {
        opportunities.push(`Add or expand automated tests for: ${touchedFiles.join(', ')}`);
    }
    if (task.category !== 'dx' && touchedFiles.length) {
        opportunities.push(`Improve developer experience around changed modules: ${touchedFiles.join(', ')}`);
    }
    if ((review.warnings || []).length) {
        opportunities.push(`Resolve remaining reviewer warnings related to ${(0, text_1.sanitizeOneLine)(task.title, 120)}`);
    }
    opportunities.push(`Monitor regressions after ${(0, text_1.sanitizeOneLine)(task.title, 120)} and harden validation where needed`);
    return (0, text_1.unique)(opportunities).slice(0, 4);
}
function buildEvolutionEntry(input) {
    const { task, implementation, review, commitMessage, nextOpportunities } = input;
    const touchedFiles = implementation.files?.map((file) => file.path) || [];
    const deletedFiles = implementation.delete_files || [];
    const notes = implementation.notes || [];
    const warnings = review.warnings || [];
    return [
        `### ${new Date().toISOString()} | ${(0, text_1.sanitizeOneLine)(task.title, 160)}`,
        `- category: ${(0, text_1.sanitizeOneLine)(task.category, 40)}`,
        `- priority: ${(0, text_1.sanitizeOneLine)(task.priority, 20)}`,
        `- goal: ${(0, text_1.sanitizeOneLine)(task.goal, 300)}`,
        `- commit: ${(0, text_1.sanitizeOneLine)(commitMessage || task.commit_message || '', 220)}`,
        `- files changed: ${touchedFiles.length ? touchedFiles.join(', ') : 'none'}`,
        deletedFiles.length ? `- files deleted: ${deletedFiles.join(', ')}` : '- files deleted: none',
        `- implementation summary: ${(0, text_1.sanitizeOneLine)(implementation.summary || 'completed successfully', 320)}`,
        `- review reason: ${(0, text_1.sanitizeOneLine)(review.reason || 'approved', 220)}`,
        `- notes:\n${(0, text_1.listToBullets)(notes)}`,
        `- warnings:\n${(0, text_1.listToBullets)(warnings)}`,
        `- next opportunities:\n${(0, text_1.listToBullets)(nextOpportunities)}`
    ].join('\n');
}
function trimEvolutionEntries(entries) {
    return entries.slice(0, config_1.CONFIG.MAX_EVOLUTION_ENTRIES);
}
function upsertEvolutionSection(originalContent, entry) {
    const marker = config_1.CONFIG.EVOLUTION_SECTION_TITLE;
    const text = String(originalContent || '').trimEnd();
    if (!text.includes(marker)) {
        return `${text}\n\n${marker}\n\n${entry}\n`;
    }
    const idx = text.indexOf(marker);
    const before = text.slice(0, idx + marker.length).trimEnd();
    const after = text.slice(idx + marker.length).trim();
    const blocks = after ? after.split(/\n(?=###\s)/g).map((chunk) => chunk.trim()).filter(Boolean) : [];
    const updated = trimEvolutionEntries([entry, ...blocks]).join('\n\n');
    return `${before}\n\n${updated}\n`;
}
function updateMainEvolutionDoc(input) {
    const { task, implementation, review, commitMessage, memory } = input;
    const target = (0, fs_utils_1.abs)(config_1.CONFIG.MAIN_EVOLUTION_DOC);
    const previous = (0, fs_utils_1.safeRead)(target, '');
    const nextOpportunities = deriveNextOpportunities({ task, implementation, review });
    const entry = buildEvolutionEntry({ task, implementation, review, commitMessage, nextOpportunities });
    const next = upsertEvolutionSection(previous, entry);
    (0, fs_utils_1.safeWrite)(target, next);
    (0, memory_1.rememberNextOpportunities)(memory, nextOpportunities);
    memory.metrics.blueprintUpdates += 1;
    return { path: (0, fs_utils_1.rel)(target), nextOpportunities };
}
