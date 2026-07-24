/**
 * Task-class playbooks — shared by the agent benchmark harness (P-4) and
 * ChatEngine REPL path.
 *
 * Playbooks inject phase guidance and optional plan-first warnings into the
 * system prompt so weaker models get task-shaped scaffolds without hardcoding
 * SWE-only steps in the engine.
 *
 * Resolution: prefer JSON beside this module (src or dist after copy:playbooks).
 * Fall back to babel-cli/src/services/playbooks so production `node dist/` still
 * finds playbooks when tsc did not copy assets.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveChatTaskClass } from '../../config/chatTaskClass.js';

export interface PlaybookDefinition {
  id: string;
  description: string;
  select: {
    skills?: string[];
  };
  phaseGuidance?: {
    explore?: string;
    diagnose?: string;
    fix?: string;
    verify?: string;
  };
  requireTodoPlan?: boolean;
  planFirstWarning?: string;
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

let _playbooksCache: PlaybookDefinition[] | null = null;
/** Resolved default directory used for cache keying (may be src fallback). */
let _resolvedDefaultDir: string | null = null;

function dirHasPlaybookJson(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir).some((n) => n.endsWith('.json'));
  } catch {
    return false;
  }
}

/**
 * Resolve the directory that contains multi-file.json / single-file.json.
 * Exported for tests (dist fallback smoke).
 */
export function resolvePlaybooksDir(): string {
  const candidates: string[] = [MODULE_DIR];

  // dist/services/playbooks → ../../src/services/playbooks (babel-cli package root)
  // MODULE_DIR/../.. = babel-cli/{src|dist}
  const packageRoot = join(MODULE_DIR, '..', '..');
  candidates.push(join(packageRoot, 'src', 'services', 'playbooks'));
  // When packageRoot is already src or dist:
  candidates.push(join(packageRoot, '..', 'src', 'services', 'playbooks'));

  const envRoot = process.env['BABEL_ROOT'];
  if (envRoot) {
    candidates.push(join(envRoot, 'babel-cli', 'src', 'services', 'playbooks'));
    candidates.push(join(envRoot, 'src', 'services', 'playbooks'));
  }

  for (const dir of candidates) {
    if (dirHasPlaybookJson(dir)) return dir;
  }
  // Last resort: module dir (empty load → [] with exists check)
  return MODULE_DIR;
}

function defaultPlaybooksDir(): string {
  if (_resolvedDefaultDir == null) {
    _resolvedDefaultDir = resolvePlaybooksDir();
  }
  return _resolvedDefaultDir;
}

/** Clear cache (tests). */
export function clearPlaybookCache(): void {
  _playbooksCache = null;
  _resolvedDefaultDir = null;
}

export function loadPlaybooks(dir?: string): PlaybookDefinition[] {
  const resolved = dir ?? defaultPlaybooksDir();
  const useCache = dir == null || dir === defaultPlaybooksDir();

  if (useCache && _playbooksCache !== null) return _playbooksCache;

  if (!existsSync(resolved)) {
    if (useCache) _playbooksCache = [];
    return [];
  }

  const playbooks: PlaybookDefinition[] = [];
  for (const name of readdirSync(resolved)) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = readFileSync(join(resolved, name), 'utf8');
      const pb = JSON.parse(raw) as PlaybookDefinition;
      if (pb && pb.id && Array.isArray(pb.select?.skills)) {
        playbooks.push(pb);
      }
    } catch {
      // skip malformed
    }
  }

  if (useCache) _playbooksCache = playbooks;
  return playbooks;
}

/** Select best playbook by skill tag overlap (benchmark path). */
export function selectPlaybookBySkills(
  skills: string[],
  playbooks?: PlaybookDefinition[],
): PlaybookDefinition | undefined {
  const list = playbooks ?? loadPlaybooks();
  if (list.length === 0) return undefined;

  let best: PlaybookDefinition | undefined;
  let bestScore = -1;
  const taskSkills = new Set(skills);

  for (const pb of list) {
    let score = 0;
    const sel = pb.select;
    if (sel.skills && sel.skills.length > 0) {
      const matchCount = sel.skills.filter((s) => taskSkills.has(s)).length;
      if (matchCount === 0) continue;
      score += matchCount;
    }
    if (score > bestScore) {
      bestScore = score;
      best = pb;
    }
  }
  return best;
}

/**
 * Infer skill tags from free-form chat task text for REPL playbook selection.
 *
 * Chat only auto-tags multi-file signals. Single-file/Python SWE playbooks stay
 * on the benchmark path (explicit skills) — they are too language-specific for
 * general REPL inject.
 */
export function inferChatTaskSkills(task: string): string[] {
  const skills: string[] = [];

  if (
    /\b(multi[- ]?file|across\s+files|several\s+files|multiple\s+files|callers?\s+and\s+callees?|refactor\s+across)\b/i.test(
      task,
    ) ||
    (task.match(/\b[\w./-]+\.(ts|tsx|js|jsx|py|go|rs|java|kt)\b/g) ?? []).length >= 3
  ) {
    skills.push('multi_file', 'multi_hunk');
  }

  return skills;
}

/**
 * Select a playbook for the interactive chat / REPL path.
 *
 * U1.4: Only inject playbooks for general_swe tasks. Default/quick_fix/investigate
 * tasks get no heavy playbook scaffold — the slim compiled stack is sufficient.
 * Returns undefined when task class is not general_swe or no multi-file signal matches.
 */
export function selectPlaybookForChatTask(
  task: string,
  playbooks?: PlaybookDefinition[],
): PlaybookDefinition | undefined {
  if (process.env['BABEL_CHAT_PLAYBOOKS'] === '0') return undefined;

  // U1.4: Only inject playbooks for general_swe class tasks.
  const taskClass = resolveChatTaskClass({ taskText: task, autoClassify: true });
  if (taskClass !== 'general_swe') return undefined;

  const skills = inferChatTaskSkills(task);
  if (!skills.includes('multi_file')) return undefined;
  return selectPlaybookBySkills(skills, playbooks);
}

export function buildPlaybookPrompt(playbook: PlaybookDefinition): string {
  const sections: string[] = [];

  if (playbook.phaseGuidance) {
    sections.push('## Task Guidance');
    const pg = playbook.phaseGuidance;
    if (pg.explore) sections.push(`EXPLORE: ${pg.explore}`);
    if (pg.diagnose) sections.push(`DIAGNOSE: ${pg.diagnose}`);
    if (pg.fix) sections.push(`FIX: ${pg.fix}`);
    if (pg.verify) sections.push(`VERIFY: ${pg.verify}`);
    sections.push('');
  }

  if (playbook.requireTodoPlan && playbook.planFirstWarning) {
    sections.push(`${playbook.planFirstWarning}\n`);
  }

  return sections.join('\n');
}
