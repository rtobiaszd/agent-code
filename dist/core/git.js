"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.git = git;
exports.hasGitRepo = hasGitRepo;
exports.currentBranch = currentBranch;
exports.stageAll = stageAll;
exports.commitAll = commitAll;
exports.pushBranch = pushBranch;
exports.getStatusPorcelain = getStatusPorcelain;
exports.workingTreeDirty = workingTreeDirty;
exports.ensureBranch = ensureBranch;
exports.rollbackHard = rollbackHard;
const config_1 = require("../config");
const process_utils_1 = require("./process-utils");
const fs_utils_1 = require("./fs-utils");
const logger_1 = require("./logger");
function git(cmd, allowFail = false) {
    const res = (0, process_utils_1.run)(`git ${cmd}`, { cwd: config_1.CONFIG.REPO_PATH });
    if (!allowFail && !res.ok) {
        throw new Error(`git ${cmd} falhou:\n${res.stderr || res.stdout}`);
    }
    return (res.stdout || '').trim();
}
function hasGitRepo() {
    const res = (0, process_utils_1.run)('git rev-parse --is-inside-work-tree', { cwd: config_1.CONFIG.REPO_PATH });
    return res.ok && String(res.stdout).trim() === 'true';
}
function currentBranch() {
    return git('rev-parse --abbrev-ref HEAD', true) || 'unknown';
}
function stageAll() {
    git('add .');
}
function commitAll(message) {
    stageAll();
    const res = (0, process_utils_1.run)(`git commit -m ${JSON.stringify(message)}`, { cwd: config_1.CONFIG.REPO_PATH });
    const output = `${res.stdout}\n${res.stderr}`.trim();
    if (!res.ok) {
        if (/nothing to commit/i.test(output))
            return false;
        throw new Error(`Commit falhou:\n${output}`);
    }
    return true;
}
function pushBranch() {
    const branch = currentBranch();
    const res = (0, process_utils_1.run)(`git push -u ${config_1.CONFIG.REMOTE_NAME} ${branch}`, { cwd: config_1.CONFIG.REPO_PATH });
    if (!res.ok) {
        throw new Error(`Push falhou:\n${res.stderr || res.stdout}`);
    }
}
function getStatusPorcelain() {
    const out = git('status --porcelain', true);
    return out ? out.split(/\r?\n/).filter(Boolean) : [];
}
function workingTreeDirty() {
    const lines = getStatusPorcelain();
    if (!lines.length)
        return false;
    if (!config_1.CONFIG.IGNORE_UNTRACKED_PROTECTED_FILES_ONLY)
        return true;
    for (const line of lines) {
        const candidate = line.slice(3).trim();
        const isUntracked = line.startsWith('??');
        if (isUntracked && (0, fs_utils_1.isProtectedFile)(candidate))
            continue;
        return true;
    }
    return false;
}
function ensureBranch(nowDate) {
    if (!config_1.CONFIG.AUTO_BRANCH)
        return currentBranch();
    const target = `${config_1.CONFIG.BRANCH_PREFIX}/${nowDate}`;
    const current = currentBranch();
    if (current === target)
        return current;
    const existsBranch = (0, process_utils_1.run)(`git rev-parse --verify ${target}`, { cwd: config_1.CONFIG.REPO_PATH }).ok;
    if (existsBranch) {
        git(`checkout ${target}`);
        return target;
    }
    git(`checkout -b ${target}`);
    return target;
}
function rollbackHard() {
    const backup = new Map();
    for (const filePath of config_1.CONFIG.PROTECTED_FILES) {
        const full = (0, fs_utils_1.abs)(filePath);
        if ((0, fs_utils_1.exists)(full))
            backup.set(full, (0, fs_utils_1.safeRead)(full, ''));
    }
    const mainDoc = (0, fs_utils_1.abs)(config_1.CONFIG.MAIN_EVOLUTION_DOC);
    if ((0, fs_utils_1.exists)(mainDoc))
        backup.set(mainDoc, (0, fs_utils_1.safeRead)(mainDoc, ''));
    git('reset --hard', true);
    git('clean -fd', true);
    for (const [full, content] of backup.entries()) {
        try {
            (0, fs_utils_1.safeWrite)(full, content);
        }
        catch (error) {
            (0, logger_1.log)('⚠️ falha ao restaurar backup:', full, error instanceof Error ? error.message : String(error));
        }
    }
}
