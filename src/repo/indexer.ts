import path from 'path';
import { CONFIG } from '../config';
import { abs, exists, isProtectedFile, rel, safeRead, walkFiles } from '../core/fs-utils';
import { sha1, truncate, unique } from '../core/text';
import type { Blueprint, RepoIndex, RepoSnapshot } from '../types';

export function buildRepoIndex(): RepoIndex {
  const files = walkFiles(CONFIG.REPO_PATH);
  const rels = files.map(rel).filter((item) => !isProtectedFile(item)).sort();

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

  const importantFiles: string[] = [];
  for (const name of importantNames) {
    const found = files.find((file) => rel(file).toLowerCase() === name.toLowerCase());
    if (found && !isProtectedFile(rel(found))) importantFiles.push(found);
  }

  const codeFiles = files.filter((file) => {
    const relative = rel(file);
    if (isProtectedFile(relative)) return false;
    return /src\/|app\/|server\/|routes\/|controllers\/|services\/|components\/|pages\/|lib\/|utils\//i.test(relative);
  });

  const merged = unique([...importantFiles, ...codeFiles.slice(0, CONFIG.MAX_CONTEXT_FILES)]);

  return {
    files,
    rels,
    importantFiles: merged.slice(0, CONFIG.MAX_CONTEXT_FILES),
    repoHash: sha1(rels.join('\n'))
  };
}

export function readFileContext(filePath: string, maxChars = CONFIG.MAX_FILE_CHARS): string {
  const content = safeRead(filePath, '');
  return `FILE: ${rel(filePath)}\n-----\n${truncate(content, maxChars)}\n`;
}

export function loadBlueprint(): Blueprint {
  const blueprintPath = path.join(CONFIG.REPO_PATH, CONFIG.BLUEPRINT_FILE);
  if (!exists(blueprintPath)) {
    throw new Error(`BLUEPRINT obrigatório não encontrado: ${CONFIG.BLUEPRINT_FILE}`);
  }

  const blueprint = safeRead(blueprintPath, '').trim();
  if (!blueprint || blueprint.length < 30) {
    throw new Error(`BLUEPRINT inválido ou vazio: ${CONFIG.BLUEPRINT_FILE}`);
  }

  return {
    path: blueprintPath,
    content: truncate(blueprint, CONFIG.MAX_BLUEPRINT_CHARS),
    hash: sha1(blueprint)
  };
}

export function readPackageJsonSafe(): Record<string, unknown> | null {
  const packageJsonPath = path.join(CONFIG.REPO_PATH, 'package.json');
  if (!exists(packageJsonPath)) return null;
  try {
    return JSON.parse(safeRead(packageJsonPath, '{}')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function buildRepoSnapshot(index: RepoIndex): RepoSnapshot {
  const pkg = readPackageJsonSafe();
  let packageSummary = 'package.json não encontrado';
  let dependencySummary: string[] = [];

  if (pkg) {
    const dependencies = Object.keys((pkg.dependencies as Record<string, unknown>) || {});
    const devDependencies = Object.keys((pkg.devDependencies as Record<string, unknown>) || {});

    dependencySummary = [...dependencies, ...devDependencies];
    packageSummary = JSON.stringify(
      {
        name: (pkg.name as string | undefined) || null,
        version: (pkg.version as string | undefined) || null,
        type: (pkg.type as string | undefined) || null,
        scripts: (pkg.scripts as Record<string, string>) || {},
        dependencies: dependencies.slice(0, 100),
        devDependencies: devDependencies.slice(0, 100)
      },
      null,
      2
    );
  } else if (exists(abs('package.json'))) {
    packageSummary = truncate(safeRead(abs('package.json'), ''));
  }

  const fileContexts = index.importantFiles.map((file) => readFileContext(file)).join('\n\n');
  const evolutionDocPath = abs(CONFIG.MAIN_EVOLUTION_DOC);
  const evolutionDocSummary = exists(evolutionDocPath)
    ? truncate(safeRead(evolutionDocPath, ''), CONFIG.EVOLUTION_DOC_CONTEXT_CHARS)
    : '';

  return {
    packageSummary,
    dependencySummary,
    fileList: index.rels.slice(0, 1500).join('\n'),
    fileContexts,
    evolutionDocSummary
  };
}

export function collectFileContents(paths: string[]): string {
  return unique(paths)
    .slice(0, CONFIG.MAX_CONTEXT_FILES)
    .map((relativePath) => {
      const full = abs(relativePath);
      const content = exists(full) ? safeRead(full, '') : '';
      return `FILE: ${relativePath}\n-----\n${truncate(content, CONFIG.MAX_FILE_CHARS)}\n`;
    })
    .join('\n\n');
}
