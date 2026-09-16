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
  /** Digest of the complete selected entry content before budget packing. */
  content_digest?: string;
}

export interface ChatStackContentDisposition {
  id: string;
  status: 'included' | 'truncated' | 'omitted';
  included_chars: number;
}

export interface ChatCompiledStack {
  selected_entries: ChatStackEntry[];
  /** sha256 of sorted entry ids + paths — stable across identical selection. */
  manifest_hash: string;
  /** Concatenated instruction text after section-aware budget packing. */
  system_context: string;
  /** sha256 of the exact system_context delivered to the provider. */
  delivered_content_digest: string;
  /** Selection entries retained for audit even when their content was omitted. */
  content_disposition: ChatStackContentDisposition[];
  /** Explicit when mandatory safety/provider/verifier content cannot fit. */
  context_error?: string;
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

function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
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
  const sections: Array<{ entry: ChatStackEntry; content: string }> = [];

  const push = (
    entry: ChatStackEntry,
    content: string,
  ) => {
    entries.push({
      ...entry,
      contentPreview: content.slice(0, 200),
      content_digest: hashContent(content),
    });
    sections.push({ entry: entries[entries.length - 1]!, content });
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

  const mandatoryIds = new Set([
    'safety:chat-adapter',
    'provider:adapter',
    'verifier:guidance',
  ]);
  const mandatorySections = sections.filter(({ entry }) => mandatoryIds.has(entry.id));
  const optionalSections = sections.filter(({ entry }) => !mandatoryIds.has(entry.id));
  const mandatoryText = mandatorySections.map(({ content }) => content).join('\n\n');
  const content_disposition: ChatStackContentDisposition[] = [];
  let system_context = '';
  let context_error: string | undefined;

  if (mandatoryText.length > budget) {
    context_error = 'mandatory_instruction_core_exceeds_prompt_budget';
    for (const { entry } of sections) {
      content_disposition.push({
        id: entry.id,
        status: 'omitted',
        included_chars: 0,
      });
    }
  } else {
    const includedOptional: string[] = [];
    for (const { entry, content } of optionalSections) {
      const separatorBeforeMandatory = mandatoryText.length > 0 ? 2 : 0;
      const separatorBefore = includedOptional.length > 0 ? 2 : 0;
      const available = budget - mandatoryText.length - separatorBeforeMandatory -
        includedOptional.join('\n\n').length - separatorBefore;
      if (content.length <= available) {
        includedOptional.push(content);
        content_disposition.push({ id: entry.id, status: 'included', included_chars: content.length });
      } else if (available > 0) {
        const partial = Array.from(content).slice(0, available).join('');
        includedOptional.push(partial);
        content_disposition.push({ id: entry.id, status: 'truncated', included_chars: partial.length });
        break;
      } else {
        content_disposition.push({ id: entry.id, status: 'omitted', included_chars: 0 });
        continue;
      }
    }
    const includedIds = new Set(content_disposition.map((item) => item.id));
    for (const { entry } of optionalSections) {
      if (!includedIds.has(entry.id)) {
        content_disposition.push({ id: entry.id, status: 'omitted', included_chars: 0 });
      }
    }
    system_context = [...includedOptional, mandatoryText].filter(Boolean).join('\n\n');
    for (const { entry } of mandatorySections) {
      content_disposition.push({
        id: entry.id,
        status: 'included',
        included_chars:
          sections.find((section) => section.entry.id === entry.id)?.content.length ?? 0,
      });
    }
  }

  return {
    selected_entries: entries,
    manifest_hash: hashManifest(entries),
    system_context,
    delivered_content_digest: hashContent(system_context),
    content_disposition,
    ...(context_error ? { context_error } : {}),
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
