"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PolicyError = exports.WRITE_SCOPE_ALLOWLIST = exports.DANGEROUS_COMMAND_PATTERNS = exports.EXECUTABLE_ALLOWLIST = void 0;
exports.isDryRunMode = isDryRunMode;
exports.makePromptHash = makePromptHash;
exports.appendAuditLog = appendAuditLog;
exports.assertCommandAllowed = assertCommandAllowed;
exports.assertImplementationWriteScope = assertImplementationWriteScope;
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const config_1 = require("../config");
const fs_utils_1 = require("../core/fs-utils");
exports.EXECUTABLE_ALLOWLIST = ['git', 'npm', 'pnpm', 'yarn', 'node', 'npx', 'bash', 'sh'];
exports.DANGEROUS_COMMAND_PATTERNS = [
    /(^|\s)rm\s+-rf(\s|$)/i,
    /(^|\s)(mkfs|dd)\s+/i,
    /(^|\s)chmod\s+777(\s|$)/i,
    /(^|\s)(sudo|su)\s+/i,
    /(^|\s)curl\s+[^|\n]+\|\s*(bash|sh)/i,
    /(^|\s)wget\s+[^|\n]+\|\s*(bash|sh)/i,
    /(^|\s):\s*>\s*\/dev\/(sda|disk)/i
];
exports.WRITE_SCOPE_ALLOWLIST = [
    'src/',
    'test/',
    'tests/',
    'docs/',
    'README.md',
    'package.json',
    'package-lock.json',
    'tsconfig.json'
];
const AUDIT_LOG_FILE = '.agent-audit.log';
class PolicyError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'PolicyError';
        this.code = code;
    }
}
exports.PolicyError = PolicyError;
function isDryRunMode() {
    return String(process.env.DRY_RUN || '').toLowerCase() === 'true';
}
function normalizeExecutable(token) {
    return token.trim().replace(/^['"]|['"]$/g, '').toLowerCase();
}
function getCommandExecutable(command) {
    const cleaned = String(command || '').trim();
    if (!cleaned)
        return '';
    const withoutEnvPrefix = cleaned.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*/, '');
    const token = withoutEnvPrefix.split(/\s+/)[0] || '';
    return normalizeExecutable(token);
}
function isWritePathAllowed(filePath) {
    const normalized = (0, fs_utils_1.normalizeSlashes)(path_1.default.relative(config_1.CONFIG.REPO_PATH, (0, fs_utils_1.abs)(filePath)));
    if (!normalized || normalized.startsWith('..'))
        return false;
    return exports.WRITE_SCOPE_ALLOWLIST.some((allowed) => normalized === allowed || normalized.startsWith(allowed));
}
function hash(value) {
    return crypto_1.default.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}
function makePromptHash(prompt) {
    return hash(prompt);
}
function appendAuditLog(entry) {
    const timestamp = new Date().toISOString();
    const line = JSON.stringify({ timestamp, ...entry });
    const full = (0, fs_utils_1.abs)(AUDIT_LOG_FILE);
    const previous = fs_1.default.existsSync(full) ? fs_1.default.readFileSync(full, 'utf8') : '';
    (0, fs_utils_1.safeWrite)(full, `${previous}${line}\n`);
}
function assertCommandAllowed(command, context = {}) {
    const executable = getCommandExecutable(command);
    if (!executable || !exports.EXECUTABLE_ALLOWLIST.includes(executable)) {
        appendAuditLog({
            type: 'policy.command',
            promptHash: context.promptHash || null,
            command,
            executable,
            verdict: 'deny',
            reason: 'command_not_allowlisted'
        });
        throw new PolicyError('POLICY_DENIED_COMMAND', `policy_denied:command_not_allowlisted:${executable || 'empty'}`);
    }
    const dangerousPattern = exports.DANGEROUS_COMMAND_PATTERNS.find((pattern) => pattern.test(command));
    if (dangerousPattern) {
        appendAuditLog({
            type: 'policy.command',
            promptHash: context.promptHash || null,
            command,
            executable,
            verdict: 'deny',
            reason: 'command_matches_denylist',
            pattern: String(dangerousPattern)
        });
        throw new PolicyError('POLICY_DENIED_PATTERN', 'policy_denied:command_matches_denylist');
    }
    appendAuditLog({
        type: 'policy.command',
        promptHash: context.promptHash || null,
        command,
        executable,
        cwd: context.cwd || config_1.CONFIG.REPO_PATH,
        verdict: 'allow'
    });
}
function assertImplementationWriteScope(impl, context = {}) {
    const touchedFiles = [...(impl.files || []).map((item) => item.path), ...(impl.delete_files || [])].map(fs_utils_1.normalizeSlashes);
    const blocked = touchedFiles.filter((item) => !isWritePathAllowed(item));
    if (blocked.length > 0) {
        appendAuditLog({
            type: 'policy.write',
            promptHash: context.promptHash || null,
            filesTouched: touchedFiles,
            verdict: 'deny',
            reason: 'write_scope_violation',
            blocked
        });
        throw new PolicyError('POLICY_DENIED_WRITE_SCOPE', `policy_denied:write_scope:${blocked.join(',')}`);
    }
    appendAuditLog({
        type: 'policy.write',
        promptHash: context.promptHash || null,
        filesTouched: touchedFiles,
        verdict: 'allow',
        dryRun: isDryRunMode()
    });
}
