/**
 * Bring the smallest compiled Babel stack into daily chat.
 *
 * Compile only: identity, closest project instructions, relevant domain/skill,
 * safety/permission adapter, provider/model adapter, task verifier guidance.
 * Emit the same manifest shape as deep mode without planner/QA machinery.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface ChatStackEntry {
  id: string;
  layer:
    | 'identity'
    | 'project'
    | 'domain'
    | 'skill'
    | 'safety'
    | 'provider'
    | 'verifier';
  path: string;
  /** Present when file was loaded. */
  contentPreview?: string;
}

export interface ChatCompiledStack {
  selected_entries: ChatStackEntry[];
  /** sha256 of sorted entry ids + paths — stable across identical selection. */
  manifest_hash: string;
  /** Concatenated instruction text (budget-trimmed). */
  system_context: string;
  /** True when planner/QA deep stages were NOT included (default). */
  deep_stages_excluded: true;
  /** Token-ish estimate (chars/4). */
  estimated_tokens: number;
  project_root: string;
}

export interface CompileChatStackOptions {
  projectRoot: string;
  /** Repo root that holds AGENTS.md / CLAUDE.md when different from project. */
  babelRoot?: string;
  task?: string;
  modelId?: string;
  /** Max characters of system_context. Default 24_000. */
  promptBudgetChars?: number;
  /** Include domain/skill hints from task keywords. Default true. */
  includeDomainSkill?: boolean;
  /** Gap-2: Pre-fetched memory context (typed memory search results).
   *  Injected as a project-memory entry before safety/provider layers. */
  memoryContext?: string | null;
}

/** Budget for general interactive chat (non-SWE classes). */
export const INTERACTIVE_STACK_BUDGET = 12_000;

/** Budget for SWE-class tasks (general_swe). */
export const SWE_STACK_BUDGET = 24_000;

/**
 * Resolve the prompt budget for a given task class.
 * Interactive classes (default/quick_fix/investigate/governance) get a slim budget;
 * general_swe keeps the larger budget for complex multi-file reasoning.
 */
export function resolveStackBudgetForClass(taskClass?: string): number {
  if (taskClass === 'general_swe') return SWE_STACK_BUDGET;
  return INTERACTIVE_STACK_BUDGET;
}

const IDENTITY_CANDIDATES = ['AGENTS.md', 'Claude.md', 'CLAUDE.md'];
const PROJECT_CANDIDATES = [
  'PROJECT_CONTEXT.md',
  'babel-cli/CLAUDE.md',
  'CLAUDE.md',
];
const SAFETY_SNIPPET = [
  '# Chat safety adapter',
  '- Prefer workspace-scoped tools; never escape the project root.',
  '- Do not exfiltrate secrets; do not disable safety checks.',
  '- Mutations go through governed tools (write_file / str_replace / apply_patch).',
].join('\n');

const VERIFIER_SNIPPET = [
  '# Task verifier guidance',
  '- After mutations, run the project test/lint command when known.',
  '- Do not claim completion without verification evidence when required.',
  '- "No discovered verifier" is not the same as verification passing.',
].join('\n');

function tryRead(path: string, maxChars: number): string | null {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf-8');
    return raw.length > maxChars ? raw.slice(0, maxChars) + '\n/* truncated */' : raw;
  } catch {
    return null;
  }
}

function firstExisting(root: string, names: string[]): { path: string; content: string } | null {
  for (const name of names) {
    const p = resolve(root, name);
    const content = tryRead(p, 12_000);
    if (content) return { path: p, content };
  }
  return null;
}

function inferDomainSkill(task: string): { id: string; content: string } | null {
  const t = task.toLowerCase();
  if (/\b(react|tsx|jsx|frontend|css|ui)\b/.test(t)) {
    return {
      id: 'domain:frontend',
      content:
        '# Domain: frontend\n- Prefer small component edits; preserve accessibility.\n- Match existing styling patterns.\n',
    };
  }
  if (/\b(test|jest|vitest|pytest|mocha)\b/.test(t)) {
    return {
      id: 'skill:testing',
      content:
        '# Skill: testing\n- Prefer existing test runners; do not invent flaky e2e when unit tests suffice.\n',
    };
  }
  if (/\b(api|express|fastify|http|backend|sql|prisma)\b/.test(t)) {
    return {
      id: 'domain:backend',
      content:
        '# Domain: backend\n- Preserve request contracts; validate inputs; avoid silent schema drift.\n',
    };
  }
  if (/\b(cli|commander|yargs|shell|powershell)\b/.test(t)) {
    return {
      id: 'domain:cli',
      content:
        '# Domain: CLI\n- Keep stdout/stderr contracts; exit codes must be meaningful.\n',
    };
  }
  return null;
}

function providerAdapterSnippet(modelId?: string): string {
  const model = modelId ?? 'auto';
  return [
    '# Provider / model adapter',
    `Effective model: ${model}`,
    '- Use native tool calling when the provider supports it.',
    '- Do not flatten tool results into prose when structured results are available.',
  ].join('\n');
}

function hashManifest(entries: ChatStackEntry[]): string {
  const h = createHash('sha256');
  for (const e of [...entries].sort((a, b) => a.id.localeCompare(b.id))) {
    h.update(e.id);
    h.update('\0');
    h.update(e.layer);
    h.update('\0');
    h.update(e.path);
    h.update('\n');
  }
  return h.digest('hex').slice(0, 24);
}

/**
 * Compile the smallest correct chat instruction stack.
 * Does not load planner or QA deep stages.
 */
export function compileChatStack(options: CompileChatStackOptions): ChatCompiledStack {
  const projectRoot = resolve(options.projectRoot);
  const babelRoot = options.babelRoot ? resolve(options.babelRoot) : projectRoot;
  const budget = options.promptBudgetChars ?? 24_000;
  const entries: ChatStackEntry[] = [];
  const chunks: string[] = [];

  const push = (
    entry: ChatStackEntry,
    content: string,
  ) => {
    entries.push({
      ...entry,
      contentPreview: content.slice(0, 200),
    });
    chunks.push(content);
  };

  // Identity
  const identity =
    firstExisting(babelRoot, IDENTITY_CANDIDATES) ??
    firstExisting(projectRoot, IDENTITY_CANDIDATES);
  if (identity) {
    push(
      { id: 'identity:agents', layer: 'identity', path: identity.path },
      identity.content,
    );
  } else {
    push(
      { id: 'identity:default', layer: 'identity', path: '(builtin)' },
      '# Identity\nYou are Babel — a collaborative senior engineer.\n',
    );
  }

  // Closest project instructions
  const project =
    firstExisting(projectRoot, PROJECT_CANDIDATES) ??
    firstExisting(babelRoot, ['PROJECT_CONTEXT.md']);
  if (project) {
    push(
      { id: 'project:context', layer: 'project', path: project.path },
      project.content,
    );
  }

  // Gap-2: Inject memory context if provided (pre-fetched structured memory)
  if (options.memoryContext && options.memoryContext.trim().length > 0) {
    push(
      { id: 'project:memory', layer: 'project', path: '(memory_directory)' },
      options.memoryContext,
    );
  }

  // Domain / skill (task-scoped, not full deep catalog)
  if (options.includeDomainSkill !== false && options.task) {
    const domain = inferDomainSkill(options.task);
    if (domain) {
      push(
        { id: domain.id, layer: domain.id.startsWith('skill') ? 'skill' : 'domain', path: '(inferred)' },
        domain.content,
      );
    }
  }

  // Safety
  push(
    { id: 'safety:chat-adapter', layer: 'safety', path: '(builtin)' },
    SAFETY_SNIPPET,
  );

  // Provider
  push(
    { id: 'provider:adapter', layer: 'provider', path: '(builtin)' },
    providerAdapterSnippet(options.modelId),
  );

  // Verifier guidance
  push(
    { id: 'verifier:guidance', layer: 'verifier', path: '(builtin)' },
    VERIFIER_SNIPPET,
  );

  // Budget-trim from the end of large identity/project chunks while keeping all entry records.
  let system_context = chunks.join('\n\n');
  if (system_context.length > budget) {
    system_context = system_context.slice(0, budget) + '\n\n/* chat stack budget trim */';
  }

  return {
    selected_entries: entries,
    manifest_hash: hashManifest(entries),
    system_context,
    deep_stages_excluded: true,
    estimated_tokens: Math.ceil(system_context.length / 4),
    project_root: projectRoot,
  };
}

/** True when compiled stack does not include deep planner/QA stage markers. */
export function chatStackExcludesDeepStages(stack: ChatCompiledStack): boolean {
  if (!stack.deep_stages_excluded) return false;
  const banned = /planner|qa.?reviewer|orchestrator.?stage|ols-v9/i;
  return !stack.selected_entries.some(
    (e) => banned.test(e.id) || banned.test(e.path),
  ) && !banned.test(stack.system_context.slice(0, 500));
}

/**
 * Detect whether a catalog path change would affect chat selection.
 * Used by integration tests: touch a known identity file id and re-hash.
 */
export function chatManifestHashForPaths(
  entries: Array<{ id: string; layer: ChatStackEntry['layer']; path: string }>,
): string {
  return hashManifest(entries.map((e) => ({ ...e })));
}

/** Locate repo-root AGENTS for tests. */
export function resolveIdentityPath(babelRoot: string): string | null {
  for (const name of IDENTITY_CANDIDATES) {
    const p = join(resolve(babelRoot), name);
    if (existsSync(p)) return p;
  }
  return null;
}
