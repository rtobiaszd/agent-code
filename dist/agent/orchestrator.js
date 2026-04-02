"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runAgent = runAgent;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const config_1 = require("../config");
const fs_utils_1 = require("../core/fs-utils");
const git_1 = require("../core/git");
const logger_1 = require("../core/logger");
const text_1 = require("../core/text");
const implementation_1 = require("../execution/implementation");
const failure_policy_1 = require("../execution/failure-policy");
const self_heal_1 = require("../execution/self-heal");
const stabilization_1 = require("../execution/stabilization");
const verification_1 = require("../execution/verification");
const ollama_1 = require("../models/ollama");
const planner_1 = require("../planning/planner");
const prompts_1 = require("../planning/prompts");
const health_1 = require("../repo/health");
const indexer_1 = require("../repo/indexer");
const evolution_1 = require("../state/evolution");
const memory_1 = require("../state/memory");
function lockFile() {
    return path_1.default.join(config_1.CONFIG.REPO_PATH, '.agent-lock');
}
function acquireLock() {
    if ((0, fs_utils_1.exists)(lockFile()))
        throw new Error('Já existe outro agente em execução (.agent-lock).');
    (0, fs_utils_1.safeWrite)(lockFile(), String(process.pid));
}
function releaseLock() {
    try {
        if ((0, fs_utils_1.exists)(lockFile()))
            fs_1.default.unlinkSync(lockFile());
    }
    catch {
        // noop
    }
}
function nowDate() {
    const date = new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function ensureSafeStart() {
    if (!(0, git_1.hasGitRepo)())
        throw new Error('Este diretório não é um repositório git.');
    if (config_1.CONFIG.STRICT_CLEAN_START && (0, git_1.workingTreeDirty)()) {
        throw new Error('Há alterações não commitadas. Limpe o repo antes de iniciar o agente.');
    }
}
function pickNextTask(memory) {
    const backlog = Array.isArray(memory.backlog) ? memory.backlog : [];
    if (!backlog.length)
        return null;
    const hotFiles = new Set((0, memory_1.getHotFiles)(memory));
    const successful = new Set(memory.learned.successfulTaskSignatures || []);
    const categoryScore = {
        security: 100,
        bugfix: 95,
        performance: 90,
        optimization: 85,
        product: 80,
        tests: 75,
        refactor: 60,
        dx: 50
    };
    const priorityScore = { high: 30, medium: 20, low: 10 };
    const candidates = backlog
        .filter((task) => !successful.has((0, text_1.stableTaskSignature)(task)))
        .sort((a, b) => {
        const aHot = (a.files || []).filter((item) => hotFiles.has(item)).length;
        const bHot = (b.files || []).filter((item) => hotFiles.has(item)).length;
        if (aHot !== bHot)
            return aHot - bHot;
        const aScore = (categoryScore[String(a.category)] || 0) + (priorityScore[String(a.priority)] || 0);
        const bScore = (categoryScore[String(b.category)] || 0) + (priorityScore[String(b.priority)] || 0);
        return bScore - aScore;
    });
    return candidates[0] || null;
}
function removeTaskFromBacklog(memory, taskId) {
    memory.backlog = (memory.backlog || []).filter((task) => task.id !== taskId);
}
function isValidReview(value) {
    return Boolean(value && typeof value === 'object' && typeof value.verdict === 'string');
}
async function executeTask(input) {
    const { task, blueprint, memory } = input;
    const fileContexts = (0, indexer_1.collectFileContents)(task.files || []);
    const baselineHealth = (0, health_1.getRepoHealth)(config_1.CONFIG, logger_1.log);
    const executorPrompt = (0, prompts_1.buildExecutorPrompt)({
        blueprint,
        task,
        fileContexts,
        commands: baselineHealth.commands || {},
        memory
    });
    const rawImplementation = await (0, ollama_1.askAndParseJson)(config_1.CONFIG.MODEL_EXECUTOR, executorPrompt, 'executor', implementation_1.isValidImplementation);
    const implementation = (0, implementation_1.sanitizeImplementation)(rawImplementation, task).impl;
    if ((0, implementation_1.containsDangerousContent)(implementation)) {
        throw new Error('Implementação recusada por conteúdo perigoso.');
    }
    (0, implementation_1.applyImplementation)(implementation);
    const quickChecks = (0, verification_1.runVerification)(memory, { mode: 'fast', logger: logger_1.log });
    if (!quickChecks.ok) {
        const healed = await (0, self_heal_1.selfHeal)({ blueprint, task, implementation, memory, baselineHealth });
        if (!healed.ok) {
            throw new Error(healed.lastFailedSummary || quickChecks.summary || 'Self-heal falhou.');
        }
    }
    const finalChecks = (0, verification_1.runVerification)(memory, { mode: 'full', logger: logger_1.log });
    if (!finalChecks.ok) {
        throw new Error(finalChecks.summary || 'Verificação final falhou.');
    }
    const afterHealth = {
        ok: finalChecks.ok,
        summary: finalChecks.summary,
        signature: finalChecks.summary
    };
    const repoDelta = (0, health_1.compareRepoHealth)(baselineHealth, afterHealth);
    const reviewPrompt = (0, prompts_1.buildReviewerPrompt)({
        blueprint,
        task,
        implementation,
        diff: (0, text_1.truncate)((0, git_1.git)('diff -- .', true), 45000)
    });
    const review = await (0, ollama_1.askAndParseJson)(config_1.CONFIG.MODEL_REVIEWER, reviewPrompt, 'review', isValidReview);
    if (String(review.verdict).toUpperCase() !== 'APPROVED') {
        throw new Error(review.reason || 'Reviewer rejeitou a implementação.');
    }
    return { implementation, review, repoDelta };
}
async function runAgent() {
    acquireLock();
    try {
        ensureSafeStart();
        const memory = (0, memory_1.loadMemory)();
        const blueprint = (0, indexer_1.loadBlueprint)();
        const repoIndex = (0, indexer_1.buildRepoIndex)();
        memory.repoHash = repoIndex.repoHash;
        memory.blueprintHash = blueprint.hash;
        (0, memory_1.saveMemory)(memory);
        const branch = (0, git_1.ensureBranch)(nowDate());
        (0, logger_1.log)('🚀 AGENT STARTED');
        (0, logger_1.log)('📁 repo:', config_1.CONFIG.REPO_PATH);
        (0, logger_1.log)('📘 blueprint:', config_1.CONFIG.BLUEPRINT_FILE);
        (0, logger_1.log)('🌿 branch:', branch);
        const repoHealth = (0, health_1.getRepoHealth)(config_1.CONFIG, logger_1.log);
        if (!repoHealth.ok && config_1.CONFIG.REPO_STABILIZATION_MODE) {
            const stabilizationTask = (0, stabilization_1.createRepoStabilizationTask)(repoHealth);
            memory.backlog = [stabilizationTask, ...(memory.backlog || [])];
            (0, memory_1.saveMemory)(memory);
            (0, logger_1.log)('🛠️ repo unhealthy, entering stabilization mode');
        }
        if (!memory.backlog.length) {
            const snapshot = (0, indexer_1.buildRepoSnapshot)(repoIndex);
            const backlog = await (0, planner_1.createBacklog)({ blueprint, snapshot, memory, branch, repoIndex, config: config_1.CONFIG });
            memory.backlog = backlog.tasks || [];
            memory.metrics.plannerRuns += 1;
            (0, memory_1.saveMemory)(memory);
        }
        const task = pickNextTask(memory);
        if (!task) {
            (0, logger_1.log)('⏸️ no valid task available');
            return;
        }
        memory.metrics.iterations += 1;
        memory.metrics.tasksExecuted += 1;
        (0, memory_1.pushHistory)(memory, { type: 'task_selected', task });
        (0, memory_1.saveMemory)(memory);
        (0, logger_1.log)('🎯 task:', task.title);
        (0, logger_1.log)('📌 goal:', task.goal);
        try {
            const result = await executeTask({ task, blueprint, memory });
            const commitMessage = result.review.suggested_commit_message || task.commit_message;
            const committed = (0, git_1.commitAll)(commitMessage);
            if (committed)
                memory.metrics.commits += 1;
            if (config_1.CONFIG.AUTO_PUSH && committed) {
                (0, git_1.pushBranch)();
                memory.metrics.pushes += 1;
            }
            memory.accepted.unshift({
                at: new Date().toISOString(),
                title: task.title,
                category: task.category,
                commit_message: commitMessage
            });
            memory.accepted = memory.accepted.slice(0, 300);
            memory.metrics.lastSuccessAt = new Date().toISOString();
            (0, memory_1.rememberSuccess)(memory, task, commitMessage);
            (0, evolution_1.updateMainEvolutionDoc)({
                task,
                implementation: result.implementation,
                review: result.review,
                commitMessage,
                memory
            });
            removeTaskFromBacklog(memory, task.id);
            (0, memory_1.saveMemory)(memory);
            (0, logger_1.log)('✅ task concluída:', task.title);
        }
        catch (error) {
            (0, git_1.rollbackHard)();
            const reason = error instanceof Error ? error.message : String(error);
            const decision = (0, failure_policy_1.registerFailureAndDecide)(memory, task, reason, null);
            if (decision.action === 'replan') {
                try {
                    const nextTask = await (0, planner_1.replanTask)({ blueprint, task, failureSummary: reason, memory, config: config_1.CONFIG });
                    memory.backlog = (memory.backlog || []).map((item) => (item.id === task.id ? nextTask : item));
                    (0, memory_1.saveMemory)(memory);
                    (0, logger_1.log)('🧠 task replanned:', nextTask.title);
                }
                catch (replanError) {
                    (0, logger_1.debug)('replan error:', replanError instanceof Error ? replanError.message : String(replanError));
                    removeTaskFromBacklog(memory, task.id);
                    (0, memory_1.saveMemory)(memory);
                }
            }
            else if (decision.action === 'drop') {
                removeTaskFromBacklog(memory, task.id);
                (0, memory_1.saveMemory)(memory);
            }
            (0, logger_1.log)('❌ task failed:', reason);
        }
    }
    finally {
        releaseLock();
    }
}
