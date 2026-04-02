"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateJsonContent = validateJsonContent;
exports.isValidImplementation = isValidImplementation;
exports.containsDangerousContent = containsDangerousContent;
exports.sanitizeImplementation = sanitizeImplementation;
exports.applyImplementation = applyImplementation;
exports.mergeImplementations = mergeImplementations;
const fs_1 = __importDefault(require("fs"));
const config_1 = require("../config");
const fs_utils_1 = require("../core/fs-utils");
const text_1 = require("../core/text");
function isJsonFilePath(filePath) {
    return (0, fs_utils_1.normalizeSlashes)(filePath).toLowerCase().endsWith('.json');
}
function detectJsonCommentViolation(content) {
    const text = String(content || '').trimStart();
    return text.startsWith('//') || text.startsWith('/*');
}
function validateJsonContent(filePath, content) {
    if (!isJsonFilePath(filePath))
        return { ok: true };
    if (detectJsonCommentViolation(content))
        return { ok: false, reason: `json_comment_not_allowed:${filePath}` };
    try {
        JSON.parse(String(content));
        return { ok: true };
    }
    catch (error) {
        return {
            ok: false,
            reason: `invalid_json:${filePath}:${(0, text_1.sanitizeOneLine)(error instanceof Error ? error.message : String(error), 220)}`
        };
    }
}
function isValidImplementation(value) {
    const impl = value;
    return Boolean(impl &&
        typeof impl === 'object' &&
        Array.isArray(impl.files) &&
        impl.files.every((item) => item && typeof item.path === 'string' && typeof item.content === 'string'));
}
function containsDangerousContent(value) {
    const text = JSON.stringify(value);
    const patterns = [
        /rm\s+-rf/gi,
        /DROP\s+TABLE/gi,
        /TRUNCATE\s+TABLE/gi,
        /-----BEGIN (?:RSA|OPENSSH|PRIVATE KEY)-----/g,
        /process\.env\.[A-Z0-9_]+\s*=\s*["'`]/g
    ];
    return patterns.some((pattern) => pattern.test(text));
}
function sanitizeImplementation(impl, task, config = config_1.CONFIG) {
    if (!impl || typeof impl !== 'object')
        throw new Error('Implementação inválida.');
    if (!Array.isArray(impl.files))
        impl.files = [];
    if (!Array.isArray(impl.delete_files))
        impl.delete_files = [];
    if (!Array.isArray(impl.notes))
        impl.notes = [];
    const skipped = [];
    const cleanedFiles = [];
    for (const file of impl.files) {
        if (!file || typeof file.path !== 'string') {
            skipped.push({ path: '(unknown)', reason: 'invalid_path', fatal: false });
            continue;
        }
        const eligibility = (0, fs_utils_1.classifyFileEligibility)(file.path, task);
        if (!eligibility.allowed) {
            skipped.push({ path: (0, fs_utils_1.normalizeSlashes)(file.path), reason: eligibility.reason, fatal: eligibility.fatal });
            if (eligibility.fatal) {
                const fatal = new Error(`Tentativa de alterar arquivo protegido: ${file.path}`);
                fatal.code = 'FATAL_PROTECTED_FILE';
                throw fatal;
            }
            continue;
        }
        if (!['update', 'create'].includes(file.action)) {
            skipped.push({ path: (0, fs_utils_1.normalizeSlashes)(file.path), reason: `invalid_action:${file.action}`, fatal: false });
            continue;
        }
        if (typeof file.content !== 'string') {
            skipped.push({ path: (0, fs_utils_1.normalizeSlashes)(file.path), reason: 'invalid_content', fatal: false });
            continue;
        }
        if (file.action === 'create' && !config.ALLOW_NEW_FILES && !task.new_files_allowed) {
            skipped.push({ path: (0, fs_utils_1.normalizeSlashes)(file.path), reason: 'create_not_allowed', fatal: false });
            continue;
        }
        const jsonValidation = validateJsonContent(file.path, file.content);
        if (!jsonValidation.ok) {
            skipped.push({ path: (0, fs_utils_1.normalizeSlashes)(file.path), reason: jsonValidation.reason, fatal: false });
            continue;
        }
        cleanedFiles.push({
            path: (0, fs_utils_1.normalizeSlashes)(file.path),
            action: file.action,
            content: String(file.content)
        });
    }
    const cleanedDeletes = [];
    for (const delPath of impl.delete_files || []) {
        const eligibility = (0, fs_utils_1.classifyFileEligibility)(delPath, task);
        if (!eligibility.allowed || eligibility.fatal) {
            skipped.push({ path: (0, fs_utils_1.normalizeSlashes)(delPath), reason: `delete_${eligibility.reason}`, fatal: Boolean(eligibility.fatal) });
            continue;
        }
        cleanedDeletes.push((0, fs_utils_1.normalizeSlashes)(delPath));
    }
    if (cleanedDeletes.length > 0 && !config.ALLOW_DELETE_FILES) {
        throw new Error('Delete de arquivos bloqueado pela configuração.');
    }
    impl.files = cleanedFiles;
    impl.delete_files = cleanedDeletes;
    impl.notes = impl.notes || [];
    if (skipped.length) {
        impl.notes.unshift(`Skipped files: ${skipped.map((item) => `${item.path} [${item.reason}]`).join(', ')}`);
    }
    if (impl.files.length === 0 && (impl.delete_files || []).length === 0) {
        const empty = new Error(`Implementação sanitizada ficou vazia. Ignorados: ${skipped.map((item) => `${item.path} [${item.reason}]`).join(', ')}`);
        empty.code = skipped.some((item) => item.reason.startsWith('blocked_'))
            ? 'NON_FATAL_INVALID_FILE_SELECTION'
            : 'EMPTY_IMPLEMENTATION';
        throw empty;
    }
    if (impl.files.length > config.MAX_FILES_PER_TASK + 8) {
        throw new Error('Implementação alterou arquivos demais.');
    }
    return { impl, skipped };
}
function applyImplementation(impl) {
    const touched = [];
    for (const file of impl.files) {
        const jsonValidation = validateJsonContent(file.path, file.content);
        if (!jsonValidation.ok) {
            throw new Error(`Conteúdo inválido para ${file.path}: ${jsonValidation.reason}`);
        }
        (0, fs_utils_1.safeWrite)((0, fs_utils_1.abs)(file.path), file.content);
        touched.push((0, fs_utils_1.normalizeSlashes)(file.path));
    }
    for (const delPath of impl.delete_files || []) {
        const full = (0, fs_utils_1.abs)(delPath);
        if ((0, fs_utils_1.exists)(full)) {
            fs_1.default.unlinkSync(full);
            touched.push((0, fs_utils_1.normalizeSlashes)(delPath));
        }
    }
    return (0, text_1.unique)(touched);
}
function mergeImplementations(baseImpl, nextImpl) {
    const fileMap = new Map();
    for (const file of [...(baseImpl.files || []), ...(nextImpl.files || [])]) {
        if (!file || !file.path)
            continue;
        fileMap.set((0, fs_utils_1.normalizeSlashes)(file.path), {
            path: (0, fs_utils_1.normalizeSlashes)(file.path),
            action: (file.action || ((0, fs_utils_1.exists)((0, fs_utils_1.abs)(file.path)) ? 'update' : 'create')),
            content: String(file.content || '')
        });
    }
    return {
        summary: (0, text_1.sanitizeOneLine)(nextImpl.summary || baseImpl.summary || 'implementation updated', 320),
        files: [...fileMap.values()],
        delete_files: (0, text_1.unique)([...(baseImpl.delete_files || []), ...(nextImpl.delete_files || [])].map(fs_utils_1.normalizeSlashes)),
        notes: (0, text_1.unique)([...(baseImpl.notes || []), ...(nextImpl.notes || [])])
    };
}
