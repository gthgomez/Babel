/**
 * Bring the smallest compiled Babel stack into daily chat.
 *
 * Compile only: identity, closest project instructions, relevant domain/skill,
 * safety/permission adapter, provider/model adapter, task verifier guidance.
 * Emit the same manifest shape as deep mode without planner/QA machinery.
 */

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { resolveRuntimeUserStateRoot } from '../config/runtimePaths.js';

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
  /** Digest of the selected entry content before budget packing. */
  content_digest?: string;
  /** UTF-16 code units in the selected entry content before budget packing. */
  content_length?: number;
  /** Digest of the complete source content before the pre-read cap. */
  source_digest?: string;
  /** UTF-16 code units in the complete source content before the pre-read cap. */
  source_length?: number;
  /** True when the source was capped before budget packing. */
  source_truncated?: boolean;
}

export interface ChatStackContentDisposition {
  id: string;
  status: 'included' | 'truncated' | 'omitted';
  included_chars: number;
  /** Digest of the exact fragment delivered for this entry, or the empty string when omitted. */
  delivered_content_digest: string;
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
  /** The prompt budget is measured in JavaScript UTF-16 code units. */
  budget_unit: 'utf16_code_units';
  project_root: string;
}

export interface CompileChatStackOptions {
  projectRoot: string;
  /** Repo root that holds AGENTS.md / ENGINEERING.md when different from project. */
  babelRoot?: string;
  task?: string;
  modelId?: string;
  /** Maximum UTF-16 units of complete system_context. Default 24_000. */
  promptBudgetChars?: number;
  /** Include domain/skill hints from task keywords. Default false. */
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

const IDENTITY_CANDIDATES = ['AGENTS.md'];
const ENGINEERING_CANDIDATES = ['ENGINEERING.md'];
interface ReadContent {
  path: string;
  content: string;
  source_digest: string;
  source_length: number;
  source_truncated: boolean;
}

function pathEscapesRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '..' || isAbsolute(rel) || rel.startsWith('../') || rel.startsWith('..\\');
}

/** Roots that may supply automatic instruction files. Stops at the git root. */
export function instructionIntakeRoots(projectRoot: string, babelRoot: string): string[] {
  const project = resolve(projectRoot);
  const babel = resolve(babelRoot);
  const walked: string[] = [];
  let dir = project;
  let sawGit = false;
  for (let i = 0; i < 8; i++) {
    if (!walked.includes(dir)) walked.push(dir);
    if (existsSync(join(dir, '.git'))) {
      sawGit = true;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!sawGit) {
    const parent = dirname(project);
    const legacy = [project];
    if (babel !== project) legacy.push(babel);
    if (parent !== project && !legacy.includes(parent)) legacy.push(parent);
    return legacy;
  }
  if (!walked.includes(babel)) walked.push(babel);
  return walked;
}

/**
 * Automatic instruction files must stay inside the approved intake roots.
 * A symlink whose real path leaves those roots is refused before content I/O.
 * Deliberately selected user context does not use this gate.
 */
function admitAutomaticInstruction(path: string, roots: readonly string[]): boolean {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT';
  }
  if (!stat.isSymbolicLink()) return true;
  let realTarget: string;
  let realRoots: string[];
  try {
    realTarget = realpathSync(path);
    realRoots = roots.map((root) => {
      try {
        return realpathSync(root);
      } catch {
        return resolve(root);
      }
    });
  } catch {
    return false;
  }
  return realRoots.some((root) => !pathEscapesRoot(root, realTarget));
}

function tryRead(path: string, required: boolean, intakeRoots?: readonly string[]): ReadContent | null {
  if (intakeRoots && !admitAutomaticInstruction(path, intakeRoots)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    if (required) throw new Error('required_instruction_read_failed', { cause: error });
    return null;
  }
  return {
    path,
    content: raw,
    source_digest: hashContent(raw),
    source_length: raw.length,
    source_truncated: false,
  };
}

function firstExisting(
  root: string,
  names: string[],
  required: boolean,
  intakeRoots: readonly string[],
): ReadContent | null {
  for (const name of names) {
    const p = resolve(root, name);
    const content = tryRead(p, required, intakeRoots);
    if (content) return content;
  }
  return null;
}

/**
 * Project instruction file. Walk from the project up to the git root so a
 * nested package still sees repository AGENTS.md. Do not scan above that root
 * or sibling repositories. When there is no git root, keep the historical
 * project / babel-root / one-parent set.
 */
function readInstructionFile(
  projectRoot: string,
  babelRoot: string,
  names: readonly string[],
  required = false,
): ReadContent | null {
  const roots = instructionIntakeRoots(projectRoot, babelRoot);
  for (const root of roots) {
    const found = firstExisting(root, [...names], required, roots);
    if (found) return found;
  }
  return null;
}

/** User-wide context. Override with BABEL_USER_CONTEXT in tests. */
export function resolveUserContextPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['BABEL_USER_CONTEXT']?.trim();
  if (override) return resolve(override);
  return join(resolveRuntimeUserStateRoot(env), 'context.md');
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

  const push = (entry: ChatStackEntry, content: string, source?: ReadContent) => {
    entries.push({
      ...entry,
      contentPreview: content.slice(0, 200),
      content_digest: hashContent(content),
      content_length: content.length,
      source_digest: source?.source_digest ?? hashContent(content),
      source_length: source?.source_length ?? content.length,
      source_truncated: source?.source_truncated ?? false,
    });
    sections.push({ entry: entries[entries.length - 1]!, content });
  };

  // Repository authority is atomic: a selected AGENTS.md is read completely or
  // stack construction fails. CLAUDE.md is not an instruction source.
  const identity = readInstructionFile(projectRoot, babelRoot, IDENTITY_CANDIDATES, true);
  if (identity) {
    push(
      { id: 'identity:agents', layer: 'identity', path: identity.path },
      identity.content,
      identity,
    );
  } else {
    push(
      { id: 'identity:default', layer: 'identity', path: '(builtin)' },
      '# Identity\nYou are Babel — a collaborative senior engineer.\n',
    );
  }

  const engineering = readInstructionFile(projectRoot, babelRoot, ENGINEERING_CANDIDATES);
  if (engineering) {
    push(
      { id: 'project:engineering', layer: 'project', path: engineering.path },
      engineering.content,
      engineering,
    );
  }

  const userContext = tryRead(resolveUserContextPath(), false);
  if (userContext) {
    push(
      { id: 'user:context', layer: 'project', path: userContext.path },
      `# User context\n${userContext.content}`,
      userContext,
    );
  }

  // Gap-2: Inject memory context if provided (pre-fetched structured memory)
  if (options.memoryContext && options.memoryContext.trim().length > 0) {
    push(
      { id: 'project:memory', layer: 'project', path: '(memory_directory)' },
      options.memoryContext,
    );
  }

  // Domain / skill only when a caller asks. Keyword inference is not the default.
  if (options.includeDomainSkill === true && options.task) {
    const domain = inferDomainSkill(options.task);
    if (domain) {
      push(
        { id: domain.id, layer: domain.id.startsWith('skill') ? 'skill' : 'domain', path: '(inferred)' },
        domain.content,
      );
    }
  }

  const requiredSections = sections.filter(({ entry }) => entry.id.startsWith('identity:'));
  const requiredText = requiredSections.map(({ content }) => content).join('\n\n');
  // Required AGENTS policy is never prefix-packed. Optional sources are each
  // admitted whole or omitted; continue after an omission to try later inputs.
  const optionalSections = sections
    .filter(({ entry }) => !entry.id.startsWith('identity:'))
    .sort((left, right) => {
      const priority = (id: string): number =>
        id.startsWith('identity:') ? 0 :
          id === 'project:engineering' ? 1 :
            id === 'user:context' ? 2 :
              id === 'project:memory' ? 3 : 4;
      return priority(left.entry.id) - priority(right.entry.id);
    });
  const content_disposition: ChatStackContentDisposition[] = [];
  let system_context = '';
  let context_error: string | undefined;

  if (requiredText.length > budget) {
    throw new Error('required_instruction_exceeds_prompt_budget');
  } else {
    const includedOptional: string[] = [];
    let usedChars = requiredText.length;
    for (const { entry, content } of optionalSections) {
      const separator = usedChars > 0 ? 2 : 0;
      if (content.length + separator <= budget - usedChars) {
        includedOptional.push(content);
        usedChars += separator + content.length;
        content_disposition.push({
          id: entry.id,
          status: 'included',
          included_chars: content.length,
          delivered_content_digest: hashContent(content),
        });
      } else {
        content_disposition.push({
          id: entry.id,
          status: 'omitted',
          included_chars: 0,
          delivered_content_digest: hashContent(''),
        });
        continue;
      }
    }
    const includedIds = new Set(content_disposition.map((item) => item.id));
    for (const { entry } of optionalSections) {
      if (!includedIds.has(entry.id)) {
        content_disposition.push({
          id: entry.id,
          status: 'omitted',
          included_chars: 0,
          delivered_content_digest: hashContent(''),
        });
      }
    }
    system_context = [requiredText, ...includedOptional].filter(Boolean).join('\n\n');
    for (const { entry, content } of requiredSections) {
      content_disposition.push({
        id: entry.id,
        status: 'included',
        included_chars: content.length,
        delivered_content_digest: hashContent(content),
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
    budget_unit: 'utf16_code_units',
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
