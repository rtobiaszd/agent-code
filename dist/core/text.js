"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sha1 = sha1;
exports.unique = unique;
exports.stripCodeFence = stripCodeFence;
exports.sanitizeOneLine = sanitizeOneLine;
exports.truncate = truncate;
exports.stableTextSignature = stableTextSignature;
exports.stableTaskSignature = stableTaskSignature;
exports.listToBullets = listToBullets;
exports.sanitizeModelOutput = sanitizeModelOutput;
exports.parseJsonSafe = parseJsonSafe;
exports.errorProgressScore = errorProgressScore;
const crypto_1 = __importDefault(require("crypto"));
function sha1(value) {
    return crypto_1.default.createHash('sha1').update(String(value ?? '')).digest('hex');
}
function unique(arr) {
    return [...new Set(arr.filter(Boolean))];
}
function stripCodeFence(text) {
    return String(text ?? '')
        .replace(/^```(?:json|javascript|js|txt)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
}
function sanitizeOneLine(text, max = 220) {
    return String(text ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}
function truncate(text, max = 20000) {
    const content = String(text ?? '');
    if (content.length <= max)
        return content;
    return `${content.slice(0, max)}\n/* ...TRUNCATED... */`;
}
function stableTextSignature(text) {
    return sha1(String(text ?? '').trim().toLowerCase());
}
function stableTaskSignature(task) {
    const payload = {
        title: String(task?.title ?? ''),
        category: String(task?.category ?? ''),
        goal: String(task?.goal ?? ''),
        files: Array.isArray(task?.files) ? [...task.files].sort() : []
    };
    return sha1(JSON.stringify(payload));
}
function listToBullets(items, fallback = '- none') {
    const cleaned = unique(items.map((item) => sanitizeOneLine(item, 260)).filter(Boolean));
    if (!cleaned.length)
        return fallback;
    return cleaned.map((item) => `- ${item}`).join('\n');
}
function sanitizeModelOutput(raw) {
    let cleaned = stripCodeFence(raw).trim();
    cleaned = cleaned.replace(/^\uFEFF/, '');
    cleaned = cleaned.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
    return cleaned;
}
function parseJsonSafe(raw) {
    if (!raw)
        return null;
    try {
        let cleaned = sanitizeModelOutput(raw)
            .replace(/```json/gi, '')
            .replace(/```/g, '')
            .trim();
        try {
            return JSON.parse(cleaned);
        }
        catch {
            // noop
        }
        const match = cleaned.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
        if (!match)
            return null;
        let candidate = match[0];
        candidate = candidate.replace(/,\s*([}\]])/g, '$1');
        candidate = candidate.replace(/:\s*`([\s\S]*?)`(?=\s*[,}])/g, (_full, content) => {
            return ': ' + JSON.stringify(content);
        });
        return JSON.parse(candidate);
    }
    catch {
        return null;
    }
}
function errorProgressScore(summary) {
    const text = String(summary ?? '').toLowerCase();
    let score = 0;
    if (text.includes('error'))
        score += 10;
    if (text.includes('typescript'))
        score += 8;
    if (text.includes('typecheck'))
        score += 8;
    if (text.includes('eslint'))
        score += 6;
    if (text.includes('lint'))
        score += 6;
    if (text.includes('build'))
        score += 5;
    if (text.includes('test'))
        score += 4;
    return score + text.length / 1000;
}
