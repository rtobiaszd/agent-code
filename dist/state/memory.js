"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.memoryFile = memoryFile;
exports.createMemory = createMemory;
exports.sanitizeMemory = sanitizeMemory;
exports.loadMemory = loadMemory;
exports.saveMemory = saveMemory;
exports.pushHistory = pushHistory;
exports.rememberSuccess = rememberSuccess;
exports.rememberFailure = rememberFailure;
exports.rememberInstalledPackages = rememberInstalledPackages;
exports.rememberNextOpportunities = rememberNextOpportunities;
exports.incrementTaskReplan = incrementTaskReplan;
exports.getTaskReplanCount = getTaskReplanCount;
exports.rememberFileFailures = rememberFileFailures;
exports.getHotFiles = getHotFiles;
exports.countTaskFailures = countTaskFailures;
exports.registerIdenticalFailure = registerIdenticalFailure;
exports.clearTaskFailureBursts = clearTaskFailureBursts;
exports.registerProviderMetrics = registerProviderMetrics;
const path_1 = __importDefault(require("path"));
const config_1 = require("../config");
const fs_utils_1 = require("../core/fs-utils");
const text_1 = require("../core/text");
function memoryFile() {
    return path_1.default.join(config_1.CONFIG.REPO_PATH, '.agent-memory.json');
}
function createMemory() {
    return {
        repoHash: '',
        blueprintHash: '',
        backlog: [],
        accepted: [],
        failed: [],
        skipped: [],
        history: [],
        identicalFailureBursts: {},
        runtime: {
            startedAt: null,
            endedAt: null,
            lastLoopResult: null,
            consecutiveCycleFailures: 0,
            cycleMetrics: []
        },
        learned: {
            successfulTaskSignatures: [],
            failedTaskSignatures: [],
            successfulCommitMessages: [],
            forbiddenKeywordsObserved: [],
            lintPatterns: [],
            buildPatterns: [],
            testPatterns: [],
            fileFailureStats: {},
            taskReplanStats: {},
            nextOpportunityPatterns: [],
            dependencyInstallPatterns: [],
            goalProgressByObjective: {},
            categoryCompletionByCategory: {}
        },
        metrics: {
            iterations: 0,
            plannerRuns: 0,
            tasksExecuted: 0,
            approvals: 0,
            rejections: 0,
            applied: 0,
            commits: 0,
            pushes: 0,
            verifyPass: 0,
            verifyFail: 0,
            testPass: 0,
            testFail: 0,
            selfHealSuccess: 0,
            selfHealFail: 0,
            replans: 0,
            blueprintUpdates: 0,
            installs: 0,
            installSuccess: 0,
            installFail: 0,
            providerMetrics: {},
            lastSuccessAt: null,
            lastErrorAt: null
        }
    };
}
function sanitizeMemory(raw) {
    const base = createMemory();
    const m = (raw && typeof raw === 'object' ? raw : {});
    return {
        ...base,
        ...m,
        backlog: Array.isArray(m.backlog) ? m.backlog : [],
        accepted: Array.isArray(m.accepted) ? m.accepted : [],
        failed: Array.isArray(m.failed) ? m.failed : [],
        skipped: Array.isArray(m.skipped) ? m.skipped : [],
        history: Array.isArray(m.history) ? m.history : [],
        identicalFailureBursts: m.identicalFailureBursts && typeof m.identicalFailureBursts === 'object' ? m.identicalFailureBursts : {},
        runtime: {
            ...base.runtime,
            ...(m.runtime || {}),
            cycleMetrics: Array.isArray(m.runtime?.cycleMetrics) ? m.runtime.cycleMetrics : []
        },
        learned: {
            ...base.learned,
            ...(m.learned || {}),
            successfulTaskSignatures: Array.isArray(m.learned?.successfulTaskSignatures) ? m.learned.successfulTaskSignatures : [],
            failedTaskSignatures: Array.isArray(m.learned?.failedTaskSignatures) ? m.learned.failedTaskSignatures : [],
            successfulCommitMessages: Array.isArray(m.learned?.successfulCommitMessages) ? m.learned.successfulCommitMessages : [],
            forbiddenKeywordsObserved: Array.isArray(m.learned?.forbiddenKeywordsObserved) ? m.learned.forbiddenKeywordsObserved : [],
            lintPatterns: Array.isArray(m.learned?.lintPatterns) ? m.learned.lintPatterns : [],
            buildPatterns: Array.isArray(m.learned?.buildPatterns) ? m.learned.buildPatterns : [],
            testPatterns: Array.isArray(m.learned?.testPatterns) ? m.learned.testPatterns : [],
            fileFailureStats: m.learned?.fileFailureStats && typeof m.learned.fileFailureStats === 'object' ? m.learned.fileFailureStats : {},
            taskReplanStats: m.learned?.taskReplanStats && typeof m.learned.taskReplanStats === 'object' ? m.learned.taskReplanStats : {},
            nextOpportunityPatterns: Array.isArray(m.learned?.nextOpportunityPatterns) ? m.learned.nextOpportunityPatterns : [],
            dependencyInstallPatterns: Array.isArray(m.learned?.dependencyInstallPatterns) ? m.learned.dependencyInstallPatterns : [],
            goalProgressByObjective: m.learned?.goalProgressByObjective && typeof m.learned.goalProgressByObjective === 'object'
                ? m.learned.goalProgressByObjective
                : {},
            categoryCompletionByCategory: m.learned?.categoryCompletionByCategory && typeof m.learned.categoryCompletionByCategory === 'object'
                ? m.learned.categoryCompletionByCategory
                : {}
        },
        metrics: {
            ...base.metrics,
            ...(m.metrics || {})
        }
    };
}
function loadMemory() {
    if (!(0, fs_utils_1.exists)(memoryFile()))
        return createMemory();
    try {
        return sanitizeMemory(JSON.parse((0, fs_utils_1.safeRead)(memoryFile(), '{}')));
    }
    catch {
        return createMemory();
    }
}
function saveMemory(memory) {
    (0, fs_utils_1.safeWrite)(memoryFile(), JSON.stringify(sanitizeMemory(memory), null, 2));
}
function pushHistory(memory, item) {
    memory.history.unshift({ at: new Date().toISOString(), ...item });
    if (memory.history.length > config_1.CONFIG.MAX_HISTORY_ITEMS) {
        memory.history = memory.history.slice(0, config_1.CONFIG.MAX_HISTORY_ITEMS);
    }
}
function updateGoalProgress(memory, task, status) {
    const objectiveKey = String(task.goal || task.title || '').trim();
    if (!objectiveKey)
        return;
    const current = memory.learned.goalProgressByObjective[objectiveKey] || {
        goal: objectiveKey,
        success: 0,
        failure: 0,
        lastTaskId: null,
        lastStatus: 'pending',
        lastUpdatedAt: null
    };
    memory.learned.goalProgressByObjective[objectiveKey] = {
        ...current,
        goal: objectiveKey,
        success: Number(current.success || 0) + (status === 'done' ? 1 : 0),
        failure: Number(current.failure || 0) + (status === 'failed' ? 1 : 0),
        lastTaskId: task.id,
        lastStatus: status,
        lastUpdatedAt: new Date().toISOString()
    };
}
function updateCategoryCompletion(memory, task, status) {
    const category = String(task.category || 'unknown');
    const current = memory.learned.categoryCompletionByCategory[category] || {
        category,
        completed: 0,
        failed: 0,
        total: 0,
        completionRate: 0
    };
    const completed = Number(current.completed || 0) + (status === 'done' ? 1 : 0);
    const failed = Number(current.failed || 0) + (status === 'failed' ? 1 : 0);
    const total = Number(current.total || 0) + 1;
    memory.learned.categoryCompletionByCategory[category] = {
        category,
        completed,
        failed,
        total,
        completionRate: total > 0 ? Number((completed / total).toFixed(4)) : 0
    };
}
function rememberSuccess(memory, task, commitMessage) {
    const signature = (0, text_1.stableTaskSignature)(task);
    if (!memory.learned.successfulTaskSignatures.includes(signature)) {
        memory.learned.successfulTaskSignatures.unshift(signature);
    }
    memory.learned.successfulTaskSignatures = memory.learned.successfulTaskSignatures.slice(0, 200);
    if (commitMessage && !memory.learned.successfulCommitMessages.includes(commitMessage)) {
        memory.learned.successfulCommitMessages.unshift(commitMessage);
    }
    memory.learned.successfulCommitMessages = memory.learned.successfulCommitMessages.slice(0, 100);
    clearTaskFailureBursts(memory, task);
    updateGoalProgress(memory, task, 'done');
    updateCategoryCompletion(memory, task, 'done');
}
function rememberFailure(memory, task, reason) {
    const signature = (0, text_1.stableTaskSignature)(task);
    if (!memory.learned.failedTaskSignatures.includes(signature)) {
        memory.learned.failedTaskSignatures.unshift(signature);
    }
    memory.learned.failedTaskSignatures = memory.learned.failedTaskSignatures.slice(0, 200);
    const low = String(reason || '').toLowerCase();
    if (low.includes('lint')) {
        memory.learned.lintPatterns.unshift(reason);
        memory.learned.lintPatterns = memory.learned.lintPatterns.slice(0, 50);
    }
    else if (low.includes('build') || low.includes('typecheck') || low.includes('typescript')) {
        memory.learned.buildPatterns.unshift(reason);
        memory.learned.buildPatterns = memory.learned.buildPatterns.slice(0, 50);
    }
    else if (low.includes('test')) {
        memory.learned.testPatterns.unshift(reason);
        memory.learned.testPatterns = memory.learned.testPatterns.slice(0, 50);
    }
    updateGoalProgress(memory, task, 'failed');
    updateCategoryCompletion(memory, task, 'failed');
}
function rememberInstalledPackages(memory, packages, reason) {
    const items = (0, text_1.unique)(packages.map((pkg) => `${pkg} :: ${(0, text_1.sanitizeOneLine)(reason || '', 180)}`));
    memory.learned.dependencyInstallPatterns = (0, text_1.unique)([...items, ...memory.learned.dependencyInstallPatterns]).slice(0, 100);
}
function rememberNextOpportunities(memory, opportunities) {
    const next = (0, text_1.unique)(opportunities.map((item) => (0, text_1.sanitizeOneLine)(item, 220)).filter(Boolean));
    memory.learned.nextOpportunityPatterns = (0, text_1.unique)([...next, ...memory.learned.nextOpportunityPatterns]).slice(0, 100);
}
function incrementTaskReplan(memory, task) {
    const signature = (0, text_1.stableTaskSignature)(task);
    const current = Number(memory.learned.taskReplanStats?.[signature] || 0);
    memory.learned.taskReplanStats[signature] = current + 1;
    return memory.learned.taskReplanStats[signature];
}
function getTaskReplanCount(memory, task) {
    const signature = (0, text_1.stableTaskSignature)(task);
    return Number(memory.learned.taskReplanStats?.[signature] || 0);
}
function rememberFileFailures(memory, files, reason) {
    const stats = memory.learned.fileFailureStats || {};
    const cleanFiles = (0, text_1.unique)(files.map(fs_utils_1.normalizeSlashes).filter(Boolean).filter((file) => !(0, fs_utils_1.isProtectedFile)(file)));
    for (const file of cleanFiles) {
        const current = stats[file] || { count: 0, lastReason: '', lastAt: null };
        stats[file] = {
            count: Number(current.count || 0) + 1,
            lastReason: (0, text_1.sanitizeOneLine)(reason || '', 220),
            lastAt: new Date().toISOString()
        };
    }
    const sortedEntries = Object.entries(stats)
        .sort((a, b) => Number(b[1]?.count || 0) - Number(a[1]?.count || 0))
        .slice(0, config_1.CONFIG.MAX_HOT_FILES);
    memory.learned.fileFailureStats = Object.fromEntries(sortedEntries);
}
function getHotFiles(memory) {
    return Object.entries(memory.learned.fileFailureStats || {})
        .filter(([, meta]) => Number(meta?.count || 0) >= config_1.CONFIG.HOT_FILE_FAILURE_THRESHOLD)
        .sort((a, b) => Number(b[1]?.count || 0) - Number(a[1]?.count || 0))
        .map(([file]) => file)
        .slice(0, config_1.CONFIG.MAX_HOT_FILES);
}
function countTaskFailures(memory, task) {
    const signature = (0, text_1.stableTaskSignature)(task);
    return memory.failed.filter((entry) => entry.signature === signature).length;
}
function registerIdenticalFailure(memory, task, reason) {
    const signature = (0, text_1.stableTaskSignature)(task);
    const errorSignature = (0, text_1.stableTextSignature)(reason);
    const key = `${signature}:${errorSignature}`;
    const current = Number(memory.identicalFailureBursts[key] || 0) + 1;
    memory.identicalFailureBursts[key] = current;
    return { key, count: current, errorSignature };
}
function clearTaskFailureBursts(memory, task) {
    const signature = (0, text_1.stableTaskSignature)(task);
    for (const key of Object.keys(memory.identicalFailureBursts || {})) {
        if (key.startsWith(`${signature}:`)) {
            delete memory.identicalFailureBursts[key];
        }
    }
}
function registerProviderMetrics(memory, snapshot) {
    if (!snapshot || !snapshot.provider)
        return;
    memory.metrics.providerMetrics[snapshot.provider] = {
        totalRequests: snapshot.totalRequests,
        totalErrors: snapshot.totalErrors,
        errorRate: snapshot.errorRate,
        models: Object.fromEntries(Object.entries(snapshot.byModel || {}).map(([model, metric]) => [
            model,
            {
                requests: Number(metric.requests || 0),
                errors: Number(metric.errors || 0),
                averageLatencyMs: Number(metric.averageLatencyMs || 0),
                averageResponseSize: Number(metric.averageResponseSize || 0)
            }
        ]))
    };
}
