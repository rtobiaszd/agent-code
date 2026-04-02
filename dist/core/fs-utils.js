"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.exists = exists;
exports.ensureDir = ensureDir;
exports.safeRead = safeRead;
exports.safeWrite = safeWrite;
exports.normalizeSlashes = normalizeSlashes;
exports.abs = abs;
exports.rel = rel;
exports.fileLooksText = fileLooksText;
exports.basenameNormalized = basenameNormalized;
exports.isProtectedFile = isProtectedFile;
exports.isBlockedFileName = isBlockedFileName;
exports.isSpecialAllowedFile = isSpecialAllowedFile;
exports.hasAllowedExtension = hasAllowedExtension;
exports.classifyFileEligibility = classifyFileEligibility;
exports.walkFiles = walkFiles;
exports.backupFiles = backupFiles;
exports.restoreBackup = restoreBackup;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const config_1 = require("../config");
function exists(filePath) {
    try {
        return fs_1.default.existsSync(filePath);
    }
    catch {
        return false;
    }
}
function ensureDir(dir) {
    if (!exists(dir))
        fs_1.default.mkdirSync(dir, { recursive: true });
}
function safeRead(filePath, fallback = '') {
    try {
        return fs_1.default.readFileSync(filePath, 'utf8');
    }
    catch {
        return fallback;
    }
}
function safeWrite(filePath, content) {
    ensureDir(path_1.default.dirname(filePath));
    fs_1.default.writeFileSync(filePath, content, 'utf8');
}
function normalizeSlashes(filePath) {
    return String(filePath ?? '').replace(/\\/g, '/');
}
function abs(relPath) {
    if (path_1.default.isAbsolute(relPath))
        return relPath;
    return path_1.default.join(config_1.CONFIG.REPO_PATH, relPath);
}
function rel(absPath) {
    return normalizeSlashes(path_1.default.relative(config_1.CONFIG.REPO_PATH, absPath));
}
function fileLooksText(filePath) {
    try {
        const buf = fs_1.default.readFileSync(filePath);
        const len = Math.min(buf.length, 512);
        for (let i = 0; i < len; i += 1) {
            if (buf[i] === 0)
                return false;
        }
        return true;
    }
    catch {
        return false;
    }
}
function basenameNormalized(filePath) {
    return path_1.default.basename(normalizeSlashes(filePath)).toLowerCase();
}
function isProtectedFile(filePath) {
    const normalized = normalizeSlashes(filePath).toLowerCase();
    return config_1.CONFIG.PROTECTED_FILES.some((item) => normalized.endsWith(item.toLowerCase()));
}
function isBlockedFileName(filePath) {
    return config_1.CONFIG.BLOCKED_FILE_NAMES.includes(basenameNormalized(filePath));
}
function isSpecialAllowedFile(filePath) {
    return config_1.CONFIG.SPECIAL_ALLOWED_FILES.includes(basenameNormalized(filePath));
}
function hasAllowedExtension(filePath) {
    const lower = normalizeSlashes(filePath).toLowerCase();
    if (isSpecialAllowedFile(lower))
        return true;
    return config_1.CONFIG.ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
function classifyFileEligibility(filePath, task = null) {
    const normalized = normalizeSlashes(filePath);
    const base = basenameNormalized(normalized);
    if (!normalized)
        return { allowed: false, reason: 'empty_path', fatal: false };
    if (isProtectedFile(normalized))
        return { allowed: false, reason: `protected:${base}`, fatal: true };
    if (isBlockedFileName(normalized))
        return { allowed: false, reason: `blocked_name:${base}`, fatal: false };
    if (!hasAllowedExtension(normalized))
        return { allowed: false, reason: `blocked_extension:${base}`, fatal: false };
    if (task?.kind === 'stabilization' &&
        !exists(abs(normalized)) &&
        !config_1.CONFIG.STABILIZATION_ALLOWED_NEW_FILES.includes(normalized)) {
        return { allowed: false, reason: `stabilization_create_not_allowed:${base}`, fatal: false };
    }
    return { allowed: true, reason: 'allowed', fatal: false };
}
function walkFiles(dir, list = []) {
    let entries = [];
    try {
        entries = fs_1.default.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return list;
    }
    for (const entry of entries) {
        const full = path_1.default.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (config_1.CONFIG.IGNORE_DIRS.includes(entry.name))
                continue;
            walkFiles(full, list);
            continue;
        }
        if (config_1.CONFIG.IGNORE_FILES.includes(entry.name))
            continue;
        if (isBlockedFileName(entry.name))
            continue;
        if (!hasAllowedExtension(entry.name) && !isSpecialAllowedFile(entry.name))
            continue;
        if (!fileLooksText(full))
            continue;
        list.push(full);
    }
    return list;
}
function backupFiles(paths) {
    const map = new Map();
    for (const filePath of paths || []) {
        const full = abs(filePath);
        map.set(normalizeSlashes(filePath), exists(full) ? safeRead(full, '') : null);
    }
    return map;
}
function restoreBackup(backupMap) {
    for (const [filePath, content] of backupMap.entries()) {
        const full = abs(filePath);
        if (content === null) {
            if (exists(full))
                fs_1.default.unlinkSync(full);
            continue;
        }
        safeWrite(full, content);
    }
}
