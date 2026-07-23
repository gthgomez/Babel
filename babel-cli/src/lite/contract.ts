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
  '.compiled',
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
  // Generic terms that cause false-positive file matches (R2)
  'state',
  'system',
  'manager',
  'management',
  'service',
  'services',
  'handler',
  'handlers',
  'utils',
  'utility',
  'common',
  'shared',
  'base',
  'core',
  'config',
  'configuration',
  'helper',
  'helpers',
  'controller',
  'controllers',
  'middleware',
]);

const GOVERNED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b(auth|oauth|session|jwt|cookie)\b/i, reason: 'auth/session surface' },
  {
    pattern: /\b(rls|row level security|policy|permissions?)\b/i,
    reason: 'authorization or policy surface',
  },
  {
    pattern: /\b(migration|schema|database|postgres|supabase|sql)\b/i,
    reason: 'database/schema surface',
  },
  { pattern: /\b(stripe|billing|payment|subscription|entitlement)\b/i, reason: 'billing surface' },
  {
    pattern: /\b(secret|api key|token|credential|private key)\b/i,
    reason: 'secret handling surface',
  },
  {
    pattern: /\b(production|deploy|release|publish|public)\b/i,
    reason: 'release or production surface',
  },
  {
    pattern: /\b(commit|push|pull request|pr create|remote)\b/i,
    reason: 'remote git or publication action',
  },
  {
    pattern: /\b(autonomous|auto-apply|act mode|full-auto)\b/i,
    reason: 'autonomous action request',
  },
];

const REVIEW_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\b(refactor|multi-file|architecture|pipeline|providers?|adapters?)\b/i,
    reason: 'multi-file or architecture change',
  },
  {
    pattern: /\b(apis?|integrations?|mcp|codex|risks?|security|privacy|redaction)\b/i,
    reason: 'protected integration, privacy, or agent surface',
  },
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
      ? (parsed as Record<string, unknown>)
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
  return markers.filter((marker) => existsSync(join(repoPath, marker)));
}

function collectRepoFiles(
  repoPath: string,
  limit: number,
): { files: string[]; truncated: boolean } {
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
  return [
    ...new Set(matches.flatMap((term) => term.split(/[_-]+/u)).filter((term) => term.length > 1)),
  ];
}

// R6: fzf-style fuzzy character matching — handles partial names, typos, boundaries
function fzfScore(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let score = 0;
  let prevIdx = -1;
  let consecutive = 0;

  for (let qi = 0; qi < q.length; qi++) {
    const qc = q.charAt(qi);
    const idx = t.indexOf(qc, prevIdx + 1);
    if (idx === -1) return 0; // character missing — no match

    let charScore = 1;

    // Consecutive character match bonus
    if (idx === prevIdx + 1) {
      consecutive++;
      charScore += consecutive * 2;
    } else {
      consecutive = 0;
    }

    // Word boundary bonus (path separators, dots, hyphens, underscores)
    if (idx > 0 && /[-_\/.]/.test(target.charAt(idx - 1))) {
      charScore += 3;
    }

    // CamelCase boundary bonus
    if (idx > 0 && /[a-z]/.test(target.charAt(idx - 1)) && /[A-Z]/.test(target.charAt(idx))) {
      charScore += 3;
    }

    // Start of target bonus
    if (idx === 0) {
      charScore += 5;
    }

    // First query char matches start of target (strongest signal)
    if (qi === 0 && idx === 0) {
      charScore += 5;
    }

    score += charScore;
    prevIdx = idx;
  }

  return score;
}

function scoreFileForWeakTaskMatch(file: string, tokens: string[]): number {
  const lower = file.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    const tokenScore = fzfScore(token, file);
    if (tokenScore > 0) {
      // Weight by token length so longer (more specific) tokens contribute more
      score += tokenScore + token.length;
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
  if (
    lower.endsWith('package.json') &&
    (scriptSurface ||
      tokens.some((token) =>
        [
          'package',
          'script',
          'scripts',
          'cli',
          'command',
          'commands',
          'build',
          'test',
          'typecheck',
        ].includes(token),
      ))
  ) {
    return 8;
  }
  if (
    lower.endsWith('model-policy.json') &&
    tokens.some((token) => ['model', 'models', 'provider', 'providers', 'fallback'].includes(token))
  ) {
    return 8;
  }
  if (
    lower.endsWith('prompt_catalog.yaml') &&
    tokens.some((token) => ['prompt', 'catalog', 'router', 'stack', 'layer'].includes(token))
  ) {
    return 8;
  }
  if (
    /(^|\/)tsconfig\.json$/.test(lower) &&
    tokens.some((token) => ['typescript', 'typecheck', 'build'].includes(token))
  ) {
    return 8;
  }
  return 0;
}

function packageScriptMatchesTask(packageScripts: string[], tokens: string[]): boolean {
  return packageScripts.some((script) => {
    const normalized = script.toLowerCase();
    return (
      tokens.includes(normalized) ||
      normalized.split(/[^a-z0-9]+/).some((part) => tokens.includes(part))
    );
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
    .map((file) => ({
      file,
      exactScore: scoreFileForExactEvidence(file, tokens),
      weakScore: scoreFileForWeakTaskMatch(file, tokens),
      configScore: configEvidenceScore(file, tokens, scriptSurface),
      packageScriptEvidence: scriptSurface && file.endsWith('package.json'),
    }))
    .filter(
      (item) =>
        item.exactScore > 0 ||
        item.weakScore > 0 ||
        item.configScore > 0 ||
        item.packageScriptEvidence,
    );

  const likely = scored
    .filter((item) => item.exactScore >= 5 || item.configScore >= 8 || item.packageScriptEvidence)
    .sort((left, right) => {
      const leftScore = left.exactScore + left.configScore + (left.packageScriptEvidence ? 3 : 0);
      const rightScore =
        right.exactScore + right.configScore + (right.packageScriptEvidence ? 3 : 0);
      return rightScore - leftScore || left.file.localeCompare(right.file);
    })
    .map((item) => item.file);

  // R9: Dynamic anchors — detect repo structure instead of hardcoding Babel-specific paths
  const anchorCandidates = ['AGENTS.md', 'PROJECT_CONTEXT.md', 'README.md', 'package.json'];
  // Add the first-found src/index file and nested package.json if they exist
  for (const candidate of [
    'src/index.ts',
    'src/index.js',
    'src/main.ts',
    'src/main.js',
    'src/cli.ts',
    'src/cli.js',
    'lib/index.js',
    'app/index.ts',
  ]) {
    if (existsSync(join(repoPath, candidate))) {
      anchorCandidates.push(candidate);
      break;
    }
  }
  const nestedPkgCandidates = files
    .filter((f) => /^[^/]+\/package\.json$/.test(f) && f !== 'package.json')
    .slice(0, 2);
  const anchors = anchorCandidates
    .concat(nestedPkgCandidates)
    .filter((path) => existsSync(join(repoPath, path)));

  const likelyFiles = [...new Set(likely)].slice(0, 12);
  const weakSuspects = scored
    .filter((item) => !likelyFiles.includes(item.file))
    .sort((left, right) => right.weakScore - left.weakScore || left.file.localeCompare(right.file))
    .map((item) => item.file);
  const suspectedFiles = [
    ...new Set([...weakSuspects, ...anchors.filter((path) => !likelyFiles.includes(path))]),
  ].slice(0, 8);

  return { likelyFiles, suspectedFiles };
}

function classifyRiskLane(task: string): { lane: LiteRiskLane; reasons: string[] } {
  const governedReasons = GOVERNED_PATTERNS.filter((entry) => entry.pattern.test(task)).map(
    (entry) => entry.reason,
  );
  if (governedReasons.length > 0) {
    return { lane: 'Governed', reasons: [...new Set(governedReasons)] };
  }

  const reviewReasons = REVIEW_PATTERNS.filter((entry) => entry.pattern.test(task)).map(
    (entry) => entry.reason,
  );
  if (reviewReasons.length > 0) {
    return { lane: 'Review', reasons: [...new Set(reviewReasons)] };
  }

  return { lane: 'Lite', reasons: ['low-risk compact planning or question-answering task'] };
}

function buildVerificationCandidates(
  repoPath: string,
  packageManager: string | null,
  packageScripts: string[],
): string[] {
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
  const required = ['AGENTS.md', 'PROJECT_CONTEXT.md', ...likelyFiles, ...suspectedFiles].filter(
    (path) =>
      existsSync(join(repoPath, path)) ||
      likelyFiles.includes(path) ||
      suspectedFiles.includes(path),
  );

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
    return [...common, 'Do not treat a patch proposal as applied work.'];
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
  const modeInstruction =
    mode === 'patch'
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

  if (estimated <= maxPromptTokens) {
    next.budget.estimated_prompt_tokens = estimated;
    return next;
  }

  // R3: Score/size ratio — value-density-based trimming instead of sequential popping
  const mins = { likely: 3, suspected: 1, required: 4, verifier: 2 };
  const estTokens = (path: string) => Math.max(1, Math.ceil(path.length / 3));

  while (estimated > maxPromptTokens) {
    interface PopCandidate {
      source: string;
      path: string;
      valueDensity: number;
    }
    const candidates: PopCandidate[] = [];

    if (next.likely_files.length > mins.likely) {
      const p = next.likely_files[next.likely_files.length - 1]!;
      candidates.push({ source: 'likely', path: p, valueDensity: 1.0 / estTokens(p) });
    }
    if (next.suspected_files.length > mins.suspected) {
      const p = next.suspected_files[next.suspected_files.length - 1]!;
      candidates.push({ source: 'suspected', path: p, valueDensity: 0.5 / estTokens(p) });
    }
    if (next.required_reads.length > mins.required) {
      const p = next.required_reads[next.required_reads.length - 1]!;
      candidates.push({ source: 'required', path: p, valueDensity: 2.0 / estTokens(p) });
    }
    if (next.verification_candidates.length > mins.verifier) {
      candidates.push({ source: 'verifier', path: '', valueDensity: 1.5 / 15 });
    }

    if (candidates.length === 0) break;

    // Pop lowest value-density (worst value per estimated token)
    candidates.sort((a, b) => a.valueDensity - b.valueDensity);
    const toPop = candidates[0]!;

    switch (toPop.source) {
      case 'likely':
        next.likely_files.pop();
        break;
      case 'suspected':
        next.suspected_files.pop();
        break;
      case 'required':
        next.required_reads.pop();
        break;
      case 'verifier':
        next.verification_candidates.pop();
        break;
    }
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
  const { likelyFiles, suspectedFiles } = selectTaskFiles(
    repoPath,
    scanned.files,
    task,
    packageScripts,
  );
  const warnings = scanned.truncated
    ? [
        `Repo scan truncated after ${scanned.files.length} files; inspect likely and suspected files before implementation.`,
      ]
    : [];

  // Surface unresolvable directory-like tokens in the task
  const FOLDER_TOKEN_EXTRA_STOP = new Set([
    'its',
    'his',
    'her',
    'our',
    'your',
    'their',
    'some',
    'many',
    'more',
    'most',
    'does',
    'have',
    'been',
    'will',
    'would',
    'could',
    'should',
    'make',
    'made',
    'need',
    'find',
    'look',
    'want',
    'here',
    'there',
    'just',
    'like',
    // QW3: Common investigation/action verbs — not directory names
    'investigate',
    'search',
    'check',
    'look',
    'find',
    'explore',
    'examine',
    'inspect',
    'review',
    'audit',
    'analyze',
    'assess',
    'evaluate',
    'diagnose',
    'test',
    'build',
    'deploy',
    'configure',
  ]);
  const folderTokens = task
    .split(/[\s,;:"'`()[\]{}\\|\/?!.]+/)
    .map((t) => t.trim())
    .filter(
      (t) =>
        t.length >= 3 &&
        !TASK_STOP_WORDS.has(t) &&
        !FOLDER_TOKEN_EXTRA_STOP.has(t) &&
        !/^\d+$/.test(t),
    );
  const unmatchedDirs = folderTokens.filter(
    (token) => !scanned.files.some((f) => f.toLowerCase().includes(token.toLowerCase())),
  );
  if (unmatchedDirs.length > 0) {
    // QW2: Try workspace search fallback for unmatched terms
    const workspaceHints: string[] = [];
    try {
      const workspaceRoot =
        process.env['BABEL_OPENCLAW_APPROVED_ROOTS']
          ?.split(',')
          .map((s) => s.trim())
          .filter(Boolean)?.[0] ??
        (process.platform === 'win32'
          ? '/tmp'
          : process.env['HOME']
            ? join(process.env['HOME'], 'Workspace')
            : null);
      if (workspaceRoot && existsSync(workspaceRoot)) {
        const topDirs = readdirSync(workspaceRoot, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);
        for (const token of unmatchedDirs) {
          const matches = topDirs.filter((d) => d.toLowerCase().includes(token.toLowerCase()));
          for (const m of matches) workspaceHints.push(join(workspaceRoot, m));
        }
      }
    } catch {
      // workspace scan unavailable; silently skip
    }
    // Scan one level deeper if no top-level match (e.g., Workspace/example_game_suite/relicRun)
    if (workspaceHints.length === 0) {
      try {
        const wsRoot =
          process.env['BABEL_OPENCLAW_APPROVED_ROOTS']
            ?.split(',')
            .map((s) => s.trim())
            .filter(Boolean)?.[0] ?? (process.platform === 'win32' ? '/tmp' : null);
        if (wsRoot && existsSync(wsRoot)) {
          const topDirs = readdirSync(wsRoot, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name);
          for (const top of topDirs.slice(0, 50)) {
            try {
              const subPath = join(wsRoot, top);
              const subDirs = readdirSync(subPath, { withFileTypes: true })
                .filter((d) => d.isDirectory())
                .map((d) => d.name);
              for (const token of unmatchedDirs) {
                for (const m of subDirs.filter((d) =>
                  d.toLowerCase().includes(token.toLowerCase()),
                )) {
                  workspaceHints.push(join(subPath, m));
                }
              }
            } catch {
              /* skip unreadable subdirs */
            }
          }
        }
      } catch {
        /* skip */
      }
    }
    if (workspaceHints.length > 0) {
      warnings.push(
        `Task mentions terms not found in the current repo: "${unmatchedDirs.join('", "')}". Similar workspace directories found: ${workspaceHints.slice(0, 3).join(', ')}. Use --project to target one.`,
      );
    } else {
      warnings.push(
        `Task mentions terms not found in the current repo files: "${unmatchedDirs.join('", "')}". Verify you are in the correct project directory.`,
      );
    }
  }
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
      preferred_worker:
        'Codex when available; DeepSeek or DeepInfra only for ask/patch text generation.',
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
      ? ['Warnings:', ...contract.warnings.map((warning) => `  - ${warning}`), '']
      : []),
    'Required reads:',
    ...(contract.required_reads.length > 0
      ? contract.required_reads.map((file) => `  - ${file}`)
      : ['  - (none detected)']),
    '',
    'Likely files:',
    ...(contract.likely_files.length > 0
      ? contract.likely_files.map((file) => `  - ${file}`)
      : ['  - (none detected)']),
    '',
    'Suspected files:',
    ...(contract.suspected_files.length > 0
      ? contract.suspected_files.map((file) => `  - ${file}`)
      : ['  - (none detected)']),
    '',
    'Verification candidates:',
    ...(contract.verification_candidates.length > 0
      ? contract.verification_candidates.map((command) => `  - ${command}`)
      : ['  - (none detected)']),
    '',
    'Stop conditions:',
    ...contract.stop_conditions.map((condition) => `  - ${condition}`),
    '',
    'Non-goals:',
    ...contract.non_goals.map((goal) => `  - ${goal}`),
  ].join('\n');
}
