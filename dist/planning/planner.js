"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isValidBacklog = isValidBacklog;
exports.validateTaskShape = validateTaskShape;
exports.detectForbiddenKeywordsInTask = detectForbiddenKeywordsInTask;
exports.validateBacklog = validateBacklog;
exports.createBacklog = createBacklog;
exports.replanTask = replanTask;
const config_1 = require("../config");
const fs_utils_1 = require("../core/fs-utils");
const text_1 = require("../core/text");
const models_1 = require("../models");
const memory_1 = require("../state/memory");
const prompts_1 = require("./prompts");
function isValidBacklog(value) {
    return Boolean(value && typeof value === 'object' && Array.isArray(value.tasks));
}
function validateTaskShape(value) {
    const task = value;
    return Boolean(task && typeof task === 'object' && task.id && task.title && task.category && task.goal);
}
function detectForbiddenKeywordsInTask(task, config = config_1.CONFIG) {
    const serialized = JSON.stringify(task).toLowerCase();
    return config.FORBIDDEN_TECH_KEYWORDS.filter((keyword) => serialized.includes(keyword));
}
function sanitizeDependencies(dependsOn, taskId) {
    const list = Array.isArray(dependsOn) ? dependsOn : [];
    return (0, text_1.unique)(list
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .filter((depId) => depId !== taskId));
}
function classifyTaskStatus(task, knownTaskIds) {
    const dependencies = sanitizeDependencies(task.depends_on, task.id).filter((depId) => knownTaskIds.has(depId));
    if (!dependencies.length)
        return 'ready';
    return 'blocked';
}
function validateBacklog(backlog, repoIndex, memory, config = config_1.CONFIG) {
    const realFiles = new Set(repoIndex.rels);
    const cleaned = [];
    for (const task of backlog.tasks.slice(0, config.MAX_BACKLOG_ITEMS)) {
        if (!validateTaskShape(task))
            continue;
        const forbidden = detectForbiddenKeywordsInTask(task, config);
        if (forbidden.length) {
            memory.learned.forbiddenKeywordsObserved.push(...forbidden);
            memory.learned.forbiddenKeywordsObserved = (0, text_1.unique)(memory.learned.forbiddenKeywordsObserved).slice(0, 100);
            continue;
        }
        const validFiles = (Array.isArray(task.files) ? task.files : [])
            .filter(Boolean)
            .map(fs_utils_1.normalizeSlashes)
            .filter((file) => !(0, fs_utils_1.isProtectedFile)(file))
            .filter((file) => !(0, fs_utils_1.isBlockedFileName)(file))
            .filter((file) => realFiles.has(file));
        const acceptanceCriteria = (0, text_1.unique)((Array.isArray(task.acceptance_criteria) ? task.acceptance_criteria : []).map((item) => String(item || '').trim()).filter(Boolean));
        const normalizedTask = {
            id: String(task.id),
            title: String(task.title),
            category: String(task.category),
            priority: String(task.priority || 'medium'),
            goal: String(task.goal),
            why: String(task.why || ''),
            files: validFiles.slice(0, config.MAX_FILES_PER_TASK),
            depends_on: sanitizeDependencies(task.depends_on, String(task.id)),
            acceptance_criteria: acceptanceCriteria,
            estimated_size: String(task.estimated_size || 'm'),
            risk_level: String(task.risk_level || 'medium'),
            status: String(task.status || 'pending'),
            new_files_allowed: Boolean(task.new_files_allowed),
            commit_message: String(task.commit_message || `chore: ${task.title}`),
            kind: task.kind
        };
        if (!normalizedTask.files.length && !normalizedTask.new_files_allowed)
            continue;
        cleaned.push(normalizedTask);
    }
    const taskIds = new Set(cleaned.map((task) => task.id));
    backlog.tasks = cleaned.map((task) => {
        const validDependsOn = task.depends_on.filter((depId) => taskIds.has(depId));
        return {
            ...task,
            depends_on: validDependsOn,
            status: classifyTaskStatus({ ...task, depends_on: validDependsOn }, taskIds)
        };
    });
    return backlog;
}
async function generateJsonWithFallback(provider, input) {
    try {
        return await provider.generateJson({
            model: input.primaryModel,
            prompt: input.prompt,
            label: input.label,
            validator: input.validator
        });
    }
    catch {
        return await provider.generateJson({
            model: input.fallbackModel || input.primaryModel,
            prompt: input.prompt,
            label: `${input.label}:fallback`,
            validator: input.validator
        });
    }
}
async function createBacklog(input) {
    const { blueprint, snapshot, memory, branch, repoIndex, config = config_1.CONFIG, provider = (0, models_1.getModelProvider)() } = input;
    const prompt = (0, prompts_1.buildBacklogPlannerPrompt)({
        blueprint,
        snapshot,
        memory,
        branch,
        config,
        hotFiles: (0, memory_1.getHotFiles)(memory)
    });
    const backlog = await generateJsonWithFallback(provider, {
        primaryModel: config.MODEL_PLANNER,
        fallbackModel: config.MODEL_PLANNER_FALLBACK,
        prompt,
        label: 'backlog',
        validator: isValidBacklog
    });
    return validateBacklog(backlog, repoIndex, memory, config);
}
async function replanTask(input) {
    const { blueprint, task, failureSummary, memory, config = config_1.CONFIG, provider = (0, models_1.getModelProvider)() } = input;
    const prompt = (0, prompts_1.buildReplanPrompt)({
        blueprint,
        task,
        failureSummary,
        replanCount: Number(memory.learned.taskReplanStats?.[task.id] || 0)
    });
    const nextTask = await generateJsonWithFallback(provider, {
        primaryModel: config.MODEL_PLANNER,
        fallbackModel: config.MODEL_PLANNER_FALLBACK,
        prompt,
        label: 'task-replan',
        validator: validateTaskShape
    });
    return {
        ...task,
        ...nextTask,
        depends_on: sanitizeDependencies(nextTask.depends_on, String(nextTask.id || task.id)),
        acceptance_criteria: Array.isArray(nextTask.acceptance_criteria)
            ? (0, text_1.unique)(nextTask.acceptance_criteria.map((item) => String(item || '').trim()).filter(Boolean))
            : task.acceptance_criteria,
        estimated_size: String(nextTask.estimated_size || task.estimated_size || 'm'),
        risk_level: String(nextTask.risk_level || task.risk_level || 'medium'),
        status: String(nextTask.status || task.status || 'pending'),
        files: Array.isArray(nextTask.files)
            ? nextTask.files.map(fs_utils_1.normalizeSlashes).slice(0, config.MAX_FILES_PER_TASK)
            : task.files,
        new_files_allowed: Boolean(nextTask.new_files_allowed),
        commit_message: String(nextTask.commit_message || task.commit_message || `chore: ${nextTask.title || task.title}`)
    };
}
