import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

import { countTextTokens } from '../services/tokenCounter.js';
import { LiteError } from './config.js';

export type LiteRiskLane = 'Lite' | 'Review' | 'Governed';
export type LitePromptMode = 'plan' | 'ask' | 'patch';

export interface LiteRepoFacts {
  path: string;
  name: string;
  markers: string[];
  packageManager: string | null;
  packageScripts: string[];
  fileCountScanned: number;
  scanTruncated: boolean;
}

export interface LiteTaskContract {
  schema_version: 1;
  mode: 'babel-lite-plan';
  created_at: string;
  task: string;
  warnings: string[];
  risk_lane: LiteRiskLane;
  risk_reasons: string[];
  repo: LiteRepoFacts;
  likely_files: string[];
  suspected_files: string[];
  required_reads: string[];
  verification_candidates: string[];
  stop_conditions: string[];
  non_goals: string[];
  handoff: {
    preferred_worker: string;
    instructions: string[];
  };
  budget: {
    max_prompt_tokens: number;
    estimated_prompt_tokens: number;
    truncated: boolean;
  };
}

export interface BuildLiteContractOptions {
  repoPath: string;
  task: string;
  now?: Date;
  maxPromptTokens: number;
  fileScanLimit?: number;
}

const SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  '.venv',
  '.cache',
  '.babel',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'runs',
  'artifacts',
  'runtime',
]);

const TASK_STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'this',
  'that',
  'into',
  'only',
  'after',
  'before',
  'current',
  'actual',
  'repo',
  'task',
  'babel',
  'plan',
  'ask',
  'patch',
  'create',
  'implement',
  'mode',
]);

const FILE_TARGET_GENERIC_TERMS = new Set([
  'adapter',
  'adapters',
  'codex',
  'design',
  'external',
  'hardening',
  'integration',
  'mcp',
  'privacy',
  'provider',
  'providers',
  'risk',
  'security',
]);

const GOVERNED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b(auth|oauth|session|jwt|cookie)\b/i, reason: 'auth/session surface' },
  { pattern: /\b(rls|row level security|policy|permissions?)\b/i, reason: 'authorization or policy surface' },
  { pattern: /\b(migration|schema|database|postgres|supabase|sql)\b/i, reason: 'database/schema surface' },
  { pattern: /\b(stripe|billing|payment|subscription|entitlement)\b/i, reason: 'billing surface' },
  { pattern: /\b(secret|api key|token|credential|private key)\b/i, reason: 'secret handling surface' },
  { pattern: /\b(production|deploy|release|publish|public)\b/i, reason: 'release or production surface' },
  { pattern: /\b(commit|push|pull request|pr create|remote)\b/i, reason: 'remote git or publication action' },
  { pattern: /\b(autonomous|auto-apply|act mode|full-auto)\b/i, reason: 'autonomous action request' },
];

const REVIEW_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b(refactor|multi-file|architecture|pipeline|providers?|adapters?)\b/i, reason: 'multi-file or architecture change' },
  { pattern: /\b(apis?|integrations?|mcp|codex|risks?|security|privacy|redaction)\b/i, reason: 'protected integration, privacy, or agent surface' },
  { pattern: /\b(config|cli|command|runner|model)\b/i, reason: 'shared interface or CLI surface' },
  { pattern: /\b(test|verify|mock|fixture|fallback)\b/i, reason: 'verification-sensitive change' },
  { pattern: /\b(edit|modify|fix|implement|patch)\b/i, reason: 'code-changing task' },
];

function assertUsableTask(task: string): string {
  const normalized = task.trim();
  if (!normalized) {
    throw new LiteError('TASK_REQUIRED', 'Babel Lite requires a non-empty --task value.');
  }
  return normalized;
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function readPackageScripts(path: string): string[] {
  const parsed = readJsonObject(path);
  const scripts = parsed?.['scripts'];
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) {
    return [];
  }
  return Object.keys(scripts).sort();
}

function detectPackageManager(repoPath: string): string | null {
  if (existsSync(join(repoPath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(repoPath, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(repoPath, 'package-lock.json'))) return 'npm';
  if (existsSync(join(repoPath, 'package.json'))) return 'npm';
  return null;
}

function detectRepoMarkers(repoPath: string): string[] {
  const markers = [
    '.git',
    'AGENTS.md',
    'PROJECT_CONTEXT.md',
    'BABEL_BIBLE.md',
    'prompt_catalog.yaml',
    'package.json',
    'babel-cli/package.json',
    'tsconfig.json',
    'src',
    'tests',
    'docs',
  ];
  return markers.filter(marker => existsSync(join(repoPath, marker)));
}

function collectRepoFiles(repoPath: string, limit: number): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  let truncated = false;

  const visit = (dir: string): void => {
    if (files.length >= limit) {
      truncated = true;
      return;
    }

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= limit) {
        truncated = true;
        return;
      }
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          visit(join(dir, entry.name));
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const fullPath = join(dir, entry.name);
      files.push(normalizeRelativePath(relative(repoPath, fullPath)));
    }
  };

  visit(repoPath);
  files.sort((left, right) => left.localeCompare(right));
  return { files, truncated };
}

function taskTokens(task: string): string[] {
  const matches = task.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [];
  const tokens: string[] = [];
  for (const match of matches) {
    if (!TASK_STOP_WORDS.has(match) && !tokens.includes(match)) {
      tokens.push(match);
    }
  }
  return tokens.slice(0, 24);
}

function pathTerms(file: string): string[] {
  const camelSeparated = file.replace(/([a-z0-9])([A-Z])/g, '$1-$2');
  const matches = camelSeparated.toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? [];
  return [...new Set(matches.flatMap(term => term.split(/[_-]+/u)).filter(term => term.length > 1))];
}

function scoreFileForWeakTaskMatch(file: string, tokens: string[]): number {
  const lower = file.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (lower.includes(token)) {
      score += token.length;
    }
  }
  if (score === 0) {
    return 0;
  }
  if (/^(src|babel-cli\/src|tools|config|docs)\//.test(lower)) score += 2;
  if (/\.(ts|tsx|js|mjs|json|md|ps1|yaml|yml)$/.test(lower)) score += 1;
  return score;
}

function scoreFileForExactEvidence(file: string, tokens: string[]): number {
  const terms = pathTerms(file);
  let score = 0;
  for (const token of tokens) {
    if (FILE_TARGET_GENERIC_TERMS.has(token)) {
      continue;
    }
    if (terms.includes(token)) {
      score += token.length;
    }
  }
  if (score === 0) {
    return 0;
  }
  const lower = file.toLowerCase();
  if (/^(src|babel-cli\/src|tools|config|docs)\//.test(lower)) score += 2;
  if (/\.(ts|tsx|js|mjs|json|md|ps1|yaml|yml)$/.test(lower)) score += 1;
  return score;
}

function configEvidenceScore(file: string, tokens: string[], scriptSurface: boolean): number {
  const lower = file.toLowerCase();
  if (lower.endsWith('package.json') && (
    scriptSurface || tokens.some(token => ['package', 'script', 'scripts', 'cli', 'command', 'commands', 'build', 'test', 'typecheck'].includes(token))
  )) {
    return 8;
  }
  if (lower.endsWith('model-policy.json') && tokens.some(token => ['model', 'models', 'provider', 'providers', 'fallback'].includes(token))) {
    return 8;
  }
  if (lower.endsWith('prompt_catalog.yaml') && tokens.some(token => ['prompt', 'catalog', 'router', 'stack', 'layer'].includes(token))) {
    return 8;
  }
  if (/(^|\/)tsconfig\.json$/.test(lower) && tokens.some(token => ['typescript', 'typecheck', 'build'].includes(token))) {
    return 8;
  }
  return 0;
}

function packageScriptMatchesTask(packageScripts: string[], tokens: string[]): boolean {
  return packageScripts.some((script) => {
    const normalized = script.toLowerCase();
    return tokens.includes(normalized) || normalized.split(/[^a-z0-9]+/).some(part => tokens.includes(part));
  });
}

function selectTaskFiles(
  repoPath: string,
  files: string[],
  task: string,
  packageScripts: string[],
): { likelyFiles: string[]; suspectedFiles: string[] } {
  const tokens = taskTokens(task);
  const scriptSurface = packageScriptMatchesTask(packageScripts, tokens);

  const scored = files
    .map(file => ({
      file,
      exactScore: scoreFileForExactEvidence(file, tokens),
      weakScore: scoreFileForWeakTaskMatch(file, tokens),
      configScore: configEvidenceScore(file, tokens, scriptSurface),
      packageScriptEvidence: scriptSurface && file.endsWith('package.json'),
    }))
    .filter(item => item.exactScore > 0 || item.weakScore > 0 || item.configScore > 0 || item.packageScriptEvidence);

  const likely = scored
    .filter(item => item.exactScore >= 5 || item.configScore >= 8 || item.packageScriptEvidence)
    .sort((left, right) => {
      const leftScore = left.exactScore + left.configScore + (left.packageScriptEvidence ? 3 : 0);
      const rightScore = right.exactScore + right.configScore + (right.packageScriptEvidence ? 3 : 0);
      return rightScore - leftScore || left.file.localeCompare(right.file);
    })
    .map(item => item.file);

  const anchors = [
    'AGENTS.md',
    'PROJECT_CONTEXT.md',
    'README.md',
    'package.json',
    'babel-cli/package.json',
    'babel-cli/src/index.ts',
  ].filter(path => existsSync(join(repoPath, path)));

  const likelyFiles = [...new Set(likely)].slice(0, 12);
  const weakSuspects = scored
    .filter(item => !likelyFiles.includes(item.file))
    .sort((left, right) => right.weakScore - left.weakScore || left.file.localeCompare(right.file))
    .map(item => item.file);
  const suspectedFiles = [...new Set([
    ...weakSuspects,
    ...anchors.filter(path => !likelyFiles.includes(path)),
  ])].slice(0, 8);

  return { likelyFiles, suspectedFiles };
}

function classifyRiskLane(task: string): { lane: LiteRiskLane; reasons: string[] } {
  const governedReasons = GOVERNED_PATTERNS
    .filter(entry => entry.pattern.test(task))
    .map(entry => entry.reason);
  if (governedReasons.length > 0) {
    return { lane: 'Governed', reasons: [...new Set(governedReasons)] };
  }

  const reviewReasons = REVIEW_PATTERNS
    .filter(entry => entry.pattern.test(task))
    .map(entry => entry.reason);
  if (reviewReasons.length > 0) {
    return { lane: 'Review', reasons: [...new Set(reviewReasons)] };
  }

  return { lane: 'Lite', reasons: ['low-risk compact planning or question-answering task'] };
}

function buildVerificationCandidates(repoPath: string, packageManager: string | null, packageScripts: string[]): string[] {
  const commands: string[] = [];
  const runner = packageManager ?? 'npm';
  for (const script of ['typecheck', 'test', 'build', 'lint']) {
    if (packageScripts.includes(script)) {
      commands.push(`${runner} run ${script}`);
    }
  }

  const cliPackagePath = join(repoPath, 'babel-cli', 'package.json');
  if (existsSync(cliPackagePath)) {
    const cliScripts = readPackageScripts(cliPackagePath);
    for (const script of ['typecheck', 'test:unit', 'build']) {
      if (cliScripts.includes(script)) {
        commands.push(`npm --prefix ./babel-cli run ${script}`);
      }
    }
  }

  if (existsSync(join(repoPath, 'pytest.ini')) || existsSync(join(repoPath, 'pyproject.toml'))) {
    commands.push('pytest');
  }
  if (existsSync(join(repoPath, 'gradlew.bat'))) {
    commands.push('.\\gradlew.bat test');
  } else if (existsSync(join(repoPath, 'gradlew'))) {
    commands.push('./gradlew test');
  }

  return [...new Set(commands)].slice(0, 8);
}

function buildRequiredReads(
  repoPath: string,
  likelyFiles: string[],
  suspectedFiles: string[],
  lane: LiteRiskLane,
): string[] {
  const required = [
    'AGENTS.md',
    'PROJECT_CONTEXT.md',
    ...likelyFiles,
    ...suspectedFiles,
  ].filter(path => existsSync(join(repoPath, path)) || likelyFiles.includes(path) || suspectedFiles.includes(path));

  if (lane === 'Governed' && existsSync(join(repoPath, 'docs/status/claims-matrix.md'))) {
    required.push('docs/status/claims-matrix.md');
  }

  return [...new Set(required)].slice(0, 10);
}

function buildStopConditions(lane: LiteRiskLane): string[] {
  const common = [
    'Stop if required files are not inspected before implementation.',
    'Stop if verifier commands are unavailable or fail.',
    'Stop if the requested change needs secrets or remote mutation.',
  ];
  if (lane === 'Governed') {
    return [
      ...common,
      'Do not auto-apply changes in Lite for governed surfaces.',
      'Escalate to a governed workflow before editing auth, billing, schema, release, or production paths.',
    ];
  }
  if (lane === 'Review') {
    return [
      ...common,
      'Do not treat a patch proposal as applied work.',
    ];
  }
  return common;
}

function createRepoFacts(repoPath: string, files: string[], truncated: boolean): LiteRepoFacts {
  const packageScripts = existsSync(join(repoPath, 'package.json'))
    ? readPackageScripts(join(repoPath, 'package.json'))
    : [];
  return {
    path: repoPath,
    name: basename(repoPath),
    markers: detectRepoMarkers(repoPath),
    packageManager: detectPackageManager(repoPath),
    packageScripts,
    fileCountScanned: files.length,
    scanTruncated: truncated,
  };
}

function cloneContract(contract: LiteTaskContract): LiteTaskContract {
  return JSON.parse(JSON.stringify(contract)) as LiteTaskContract;
}

function renderContractPrompt(contract: LiteTaskContract, mode: LitePromptMode): string {
  const modeInstruction = mode === 'patch'
    ? 'Return a patch proposal or unified diff only. Do not claim it was applied.'
    : mode === 'ask'
      ? 'Answer the task using the compact contract. Do not edit files or claim edits.'
      : 'Use this as a compact no-API task contract.';

  return [
    'Babel Lite compact governance contract.',
    `Mode: ${mode}`,
    modeInstruction,
    'Respect the non-goals and stop conditions.',
    '',
    JSON.stringify(contract, null, 2),
  ].join('\n');
}

function estimateContractPromptTokens(contract: LiteTaskContract, mode: LitePromptMode): number {
  return countTextTokens(renderContractPrompt(contract, mode));
}

function trimContractForBudget(
  contract: LiteTaskContract,
  mode: LitePromptMode,
  maxPromptTokens: number,
): LiteTaskContract {
  const next = cloneContract(contract);
  let estimated = estimateContractPromptTokens(next, mode);

  while (estimated > maxPromptTokens && next.likely_files.length > 6) {
    next.likely_files.pop();
    next.budget.truncated = true;
    estimated = estimateContractPromptTokens(next, mode);
  }
  while (estimated > maxPromptTokens && next.suspected_files.length > 3) {
    next.suspected_files.pop();
    next.budget.truncated = true;
    estimated = estimateContractPromptTokens(next, mode);
  }
  while (estimated > maxPromptTokens && next.required_reads.length > 6) {
    next.required_reads.pop();
    next.budget.truncated = true;
    estimated = estimateContractPromptTokens(next, mode);
  }
  while (estimated > maxPromptTokens && next.verification_candidates.length > 4) {
    next.verification_candidates.pop();
    next.budget.truncated = true;
    estimated = estimateContractPromptTokens(next, mode);
  }

  next.budget.estimated_prompt_tokens = estimated;
  if (estimated > maxPromptTokens) {
    throw new LiteError(
      'PROMPT_BUDGET_EXCEEDED',
      `Babel Lite prompt budget exceeded (${estimated} > ${maxPromptTokens}). Shorten --task or reduce repo scan context.`,
    );
  }
  return next;
}

export function buildLiteTaskContract(options: BuildLiteContractOptions): LiteTaskContract {
  const task = assertUsableTask(options.task);
  const repoPath = resolve(options.repoPath);
  if (!existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
    throw new LiteError('REPO_NOT_FOUND', `Repo path is not a directory: ${repoPath}`);
  }

  const scanned = collectRepoFiles(repoPath, options.fileScanLimit ?? 600);
  const risk = classifyRiskLane(task);
  const packageManager = detectPackageManager(repoPath);
  const packageScripts = existsSync(join(repoPath, 'package.json'))
    ? readPackageScripts(join(repoPath, 'package.json'))
    : [];
  const { likelyFiles, suspectedFiles } = selectTaskFiles(repoPath, scanned.files, task, packageScripts);
  const warnings = scanned.truncated
    ? [`Repo scan truncated after ${scanned.files.length} files; inspect likely and suspected files before implementation.`]
    : [];
  const contract: LiteTaskContract = {
    schema_version: 1,
    mode: 'babel-lite-plan',
    created_at: (options.now ?? new Date()).toISOString(),
    task,
    warnings,
    risk_lane: risk.lane,
    risk_reasons: risk.reasons,
    repo: {
      ...createRepoFacts(repoPath, scanned.files, scanned.truncated),
      packageManager,
      packageScripts,
    },
    likely_files: likelyFiles,
    suspected_files: suspectedFiles,
    required_reads: buildRequiredReads(repoPath, likelyFiles, suspectedFiles, risk.lane),
    verification_candidates: buildVerificationCandidates(repoPath, packageManager, packageScripts),
    stop_conditions: buildStopConditions(risk.lane),
    non_goals: [
      'Do not rebuild a full Codex replacement.',
      'Do not load broad overlays by default.',
      'Do not apply patches automatically.',
      'Do not store provider secrets in repo artifacts.',
    ],
    handoff: {
      preferred_worker: 'Codex when available; DeepSeek or DeepInfra only for ask/patch text generation.',
      instructions: [
        'Inspect required reads before implementation.',
        'Keep edits scoped to likely files unless evidence expands scope.',
        'Run verifier commands before success claims.',
      ],
    },
    budget: {
      max_prompt_tokens: options.maxPromptTokens,
      estimated_prompt_tokens: 0,
      truncated: false,
    },
  };

  return trimContractForBudget(contract, 'plan', options.maxPromptTokens);
}

export function buildLiteProviderPrompt(
  contract: LiteTaskContract,
  mode: Exclude<LitePromptMode, 'plan'>,
): { contract: LiteTaskContract; prompt: string; estimatedPromptTokens: number } {
  const budgeted = trimContractForBudget(contract, mode, contract.budget.max_prompt_tokens);
  const prompt = renderContractPrompt(budgeted, mode);
  return {
    contract: budgeted,
    prompt,
    estimatedPromptTokens: budgeted.budget.estimated_prompt_tokens,
  };
}

export function formatLiteContractText(contract: LiteTaskContract): string {
  return [
    'Babel Lite Task Contract',
    `Status: ok`,
    `Risk lane: ${contract.risk_lane}`,
    `Prompt tokens: ${contract.budget.estimated_prompt_tokens}/${contract.budget.max_prompt_tokens}`,
    `Repo: ${contract.repo.path}`,
    `Task: ${contract.task}`,
    '',
    ...(contract.warnings.length > 0
      ? ['Warnings:', ...contract.warnings.map(warning => `  - ${warning}`), '']
      : []),
    'Required reads:',
    ...(contract.required_reads.length > 0 ? contract.required_reads.map(file => `  - ${file}`) : ['  - (none detected)']),
    '',
    'Likely files:',
    ...(contract.likely_files.length > 0 ? contract.likely_files.map(file => `  - ${file}`) : ['  - (none detected)']),
    '',
    'Suspected files:',
    ...(contract.suspected_files.length > 0 ? contract.suspected_files.map(file => `  - ${file}`) : ['  - (none detected)']),
    '',
    'Verification candidates:',
    ...(contract.verification_candidates.length > 0 ? contract.verification_candidates.map(command => `  - ${command}`) : ['  - (none detected)']),
    '',
    'Stop conditions:',
    ...contract.stop_conditions.map(condition => `  - ${condition}`),
    '',
    'Non-goals:',
    ...contract.non_goals.map(goal => `  - ${goal}`),
  ].join('\n');
}
