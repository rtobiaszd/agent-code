"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildRepoIndex = buildRepoIndex;
exports.readFileContext = readFileContext;
exports.loadBlueprint = loadBlueprint;
exports.readPackageJsonSafe = readPackageJsonSafe;
exports.buildRepoSnapshot = buildRepoSnapshot;
exports.collectFileContents = collectFileContents;
const path_1 = __importDefault(require("path"));
const config_1 = require("../config");
const fs_utils_1 = require("../core/fs-utils");
const text_1 = require("../core/text");
function buildRepoIndex() {
    const files = (0, fs_utils_1.walkFiles)(config_1.CONFIG.REPO_PATH);
    const rels = files.map(fs_utils_1.rel).filter((item) => !(0, fs_utils_1.isProtectedFile)(item)).sort();
    const importantNames = [
        'package.json',
        'README.md',
        'tsconfig.json',
        'jsconfig.json',
        'vite.config.ts',
        'vite.config.js',
        'next.config.js',
        'next.config.mjs',
        'nest-cli.json',
        'docker-compose.yml',
        'docker-compose.yaml',
        'prisma/schema.prisma',
        'eslint.config.js',
        'eslint.config.cjs',
        'eslint.config.mjs',
        '.eslintrc',
        '.eslintrc.js',
        '.eslintrc.cjs'
    ];
    const importantFiles = [];
    for (const name of importantNames) {
        const found = files.find((file) => (0, fs_utils_1.rel)(file).toLowerCase() === name.toLowerCase());
        if (found && !(0, fs_utils_1.isProtectedFile)((0, fs_utils_1.rel)(found)))
            importantFiles.push(found);
    }
    const codeFiles = files.filter((file) => {
        const relative = (0, fs_utils_1.rel)(file);
        if ((0, fs_utils_1.isProtectedFile)(relative))
            return false;
        return /src\/|app\/|server\/|routes\/|controllers\/|services\/|components\/|pages\/|lib\/|utils\//i.test(relative);
    });
    const merged = (0, text_1.unique)([...importantFiles, ...codeFiles.slice(0, config_1.CONFIG.MAX_CONTEXT_FILES)]);
    return {
        files,
        rels,
        importantFiles: merged.slice(0, config_1.CONFIG.MAX_CONTEXT_FILES),
        repoHash: (0, text_1.sha1)(rels.join('\n'))
    };
}
function readFileContext(filePath, maxChars = config_1.CONFIG.MAX_FILE_CHARS) {
    const content = (0, fs_utils_1.safeRead)(filePath, '');
    return `FILE: ${(0, fs_utils_1.rel)(filePath)}\n-----\n${(0, text_1.truncate)(content, maxChars)}\n`;
}
function loadBlueprint() {
    const blueprintPath = path_1.default.join(config_1.CONFIG.REPO_PATH, config_1.CONFIG.BLUEPRINT_FILE);
    if (!(0, fs_utils_1.exists)(blueprintPath)) {
        throw new Error(`BLUEPRINT obrigatório não encontrado: ${config_1.CONFIG.BLUEPRINT_FILE}`);
    }
    const blueprint = (0, fs_utils_1.safeRead)(blueprintPath, '').trim();
    if (!blueprint || blueprint.length < 30) {
        throw new Error(`BLUEPRINT inválido ou vazio: ${config_1.CONFIG.BLUEPRINT_FILE}`);
    }
    return {
        path: blueprintPath,
        content: (0, text_1.truncate)(blueprint, config_1.CONFIG.MAX_BLUEPRINT_CHARS),
        hash: (0, text_1.sha1)(blueprint)
    };
}
function readPackageJsonSafe() {
    const packageJsonPath = path_1.default.join(config_1.CONFIG.REPO_PATH, 'package.json');
    if (!(0, fs_utils_1.exists)(packageJsonPath))
        return null;
    try {
        return JSON.parse((0, fs_utils_1.safeRead)(packageJsonPath, '{}'));
    }
    catch {
        return null;
    }
}
function buildRepoSnapshot(index) {
    const pkg = readPackageJsonSafe();
    let packageSummary = 'package.json não encontrado';
    let dependencySummary = [];
    if (pkg) {
        const dependencies = Object.keys(pkg.dependencies || {});
        const devDependencies = Object.keys(pkg.devDependencies || {});
        dependencySummary = [...dependencies, ...devDependencies];
        packageSummary = JSON.stringify({
            name: pkg.name || null,
            version: pkg.version || null,
            type: pkg.type || null,
            scripts: pkg.scripts || {},
            dependencies: dependencies.slice(0, 100),
            devDependencies: devDependencies.slice(0, 100)
        }, null, 2);
    }
    else if ((0, fs_utils_1.exists)((0, fs_utils_1.abs)('package.json'))) {
        packageSummary = (0, text_1.truncate)((0, fs_utils_1.safeRead)((0, fs_utils_1.abs)('package.json'), ''));
    }
    const fileContexts = index.importantFiles.map((file) => readFileContext(file)).join('\n\n');
    const evolutionDocPath = (0, fs_utils_1.abs)(config_1.CONFIG.MAIN_EVOLUTION_DOC);
    const evolutionDocSummary = (0, fs_utils_1.exists)(evolutionDocPath)
        ? (0, text_1.truncate)((0, fs_utils_1.safeRead)(evolutionDocPath, ''), config_1.CONFIG.EVOLUTION_DOC_CONTEXT_CHARS)
        : '';
    return {
        packageSummary,
        dependencySummary,
        fileList: index.rels.slice(0, 1500).join('\n'),
        fileContexts,
        evolutionDocSummary
    };
}
function collectFileContents(paths) {
    return (0, text_1.unique)(paths)
        .slice(0, config_1.CONFIG.MAX_CONTEXT_FILES)
        .map((relativePath) => {
        const full = (0, fs_utils_1.abs)(relativePath);
        const content = (0, fs_utils_1.exists)(full) ? (0, fs_utils_1.safeRead)(full, '') : '';
        return `FILE: ${relativePath}\n-----\n${(0, text_1.truncate)(content, config_1.CONFIG.MAX_FILE_CHARS)}\n`;
    })
        .join('\n\n');
}
