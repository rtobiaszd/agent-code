"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.collectFailureFiles = collectFailureFiles;
exports.classifyFailure = classifyFailure;
exports.registerFailureAndDecide = registerFailureAndDecide;
const config_1 = require("../config");
const logger_1 = require("../core/logger");
const text_1 = require("../core/text");
const health_1 = require("../repo/health");
const memory_1 = require("../state/memory");
function collectFailureFiles(task, reason, implementation) {
    return [
        ...new Set([
            ...(Array.isArray(task.files) ? task.files : []),
            ...(0, health_1.extractRelevantFilesFromErrors)(reason || ''),
            ...((implementation?.files || []).map((item) => item.path))
        ])
    ].filter(Boolean);
}
function classifyFailure(reason) {
    const low = String(reason || '').toLowerCase();
    if (low.includes('invalid_json') ||
        low.includes('json_comment_not_allowed') ||
        low.includes('implementação sanitizada ficou vazia') ||
        low.includes('blocked_extension') ||
        low.includes('blocked_name:') ||
        low.includes('arquivo protegido') ||
        low.includes('non_fatal_invalid_file_selection') ||
        low.includes('empty_implementation') ||
        low.includes('policy_denied') ||
        low.includes('policy_denied_command') ||
        low.includes('policy_denied_pattern') ||
        low.includes('policy_denied_write_scope')) {
        return 'replanable';
    }
    if (low.includes('lint') ||
        low.includes('eslint') ||
        low.includes('typecheck') ||
        low.includes('typescript') ||
        low.includes('build') ||
        low.includes('test')) {
        return 'healable';
    }
    if (low.includes('repository health check failed') || low.includes('stabilize repository')) {
        return 'stabilization';
    }
    if (low.includes('fatal_protected_file'))
        return 'fatal';
    return 'unknown';
}
function registerFailureAndDecide(memory, task, reason, implementation) {
    const classification = classifyFailure(reason);
    memory.failed.unshift({
        at: new Date().toISOString(),
        title: task.title,
        category: String(task.category),
        reason: (0, text_1.sanitizeOneLine)(reason, 400),
        signature: (0, text_1.stableTaskSignature)(task),
        error_signature: (0, text_1.stableTextSignature)(reason),
        classification
    });
    memory.failed = memory.failed.slice(0, 300);
    memory.metrics.lastErrorAt = new Date().toISOString();
    (0, memory_1.rememberFailure)(memory, task, reason);
    (0, memory_1.rememberFileFailures)(memory, collectFailureFiles(task, reason, implementation), reason);
    const identical = (0, memory_1.registerIdenticalFailure)(memory, task, reason);
    const taskFailures = (0, memory_1.countTaskFailures)(memory, task);
    const replans = (0, memory_1.getTaskReplanCount)(memory, task);
    let action = 'retry';
    if (classification === 'replanable') {
        if (replans < config_1.CONFIG.MAX_REPLAN_PER_TASK) {
            (0, memory_1.incrementTaskReplan)(memory, task);
            memory.metrics.replans += 1;
            action = 'replan';
        }
        else if (identical.count >= config_1.CONFIG.MAX_IDENTICAL_ERROR_RETRIES) {
            action = 'drop';
        }
    }
    else if (classification === 'healable') {
        if (taskFailures >= config_1.CONFIG.MAX_REPEAT_FAILURES_PER_TASK && identical.count >= config_1.CONFIG.MAX_IDENTICAL_ERROR_RETRIES) {
            action = 'drop';
        }
    }
    else if (classification === 'fatal') {
        action = 'drop';
    }
    else {
        if (taskFailures >= config_1.CONFIG.MAX_REPEAT_FAILURES_PER_TASK) {
            action = 'drop';
        }
    }
    if (action === 'drop') {
        (0, memory_1.clearTaskFailureBursts)(memory, task);
        (0, logger_1.log)('⛔ dropping task after exhausted retries');
    }
    else if (action === 'replan') {
        (0, logger_1.log)('🔁 task will be replanned instead of dropped');
    }
    else {
        (0, logger_1.log)('🔁 keeping task for retry/self-heal');
    }
    (0, memory_1.saveMemory)(memory);
    return { action, classification, identicalCount: identical.count, taskFailures };
}
