/**
 * W2.2 — Explore as feeder agent
 *
 * Explore returns an **evidence pack** (paths, symbols, hypothesized edits).
 * Budget-capped; **cannot write**. Optional handoff text for implement worktree.
 *
 * Pure helpers + offline seed synthesis + optional live path via readOnlyAgentLoop.
 */

import { join } from 'node:path';
import type { ToolContext } from '../localTools.js';
import { isDirectMutationTool } from './mutationTools.js';
import {
  runReadOnlyAgentLoop,
  type ReadOnlyAgentLoopResult,
} from './lanes/readOnlyAgentLoop.js';
import type { ToolExecutor } from './toolExecutor.js';

// ─── Evidence pack schema ─────────────────────────────────────────────────────

export const EXPLORE_EVIDENCE_PACK_SCHEMA_VERSION = 1 as const;

/** Default max tool rounds for explore feeder (C-SA-06 budget). */
export const DEFAULT_EXPLORE_FEEDER_MAX_ROUNDS = 6;

/** Default max successful explore tools before soft budget stop. */
export const DEFAULT_EXPLORE_FEEDER_MAX_TOOLS = 12;

export interface ExploreEvidenceSymbol {
  name: string;
  path?: string;
  kind?: string;
}

export interface ExploreHypothesizedEdit {
  /** Project-relative path the implement agent should mutate. */
  path: string;
  /** Short description of the edit intent. */
  summary: string;
  rationale?: string;
}

export interface ExploreEvidenceBudget {
  max_rounds: number;
  max_tools: number;
  rounds_used: number;
  tools_used: number;
  budget_exhausted: boolean;
}

/**
 * Evidence pack returned by the explore feeder (Wave 2 exit: explore never mutates).
 */
export interface ExploreEvidencePack {
  schema_version: typeof EXPLORE_EVIDENCE_PACK_SCHEMA_VERSION;
  agent_id: string;
  task: string;
  /** Localized file/dir paths (project-relative preferred). */
  paths: string[];
  symbols: ExploreEvidenceSymbol[];
  hypothesized_edits: ExploreHypothesizedEdit[];
  notes: string[];
  budget: ExploreEvidenceBudget;
  /** Count of mutation attempts that were blocked (must be ≥ attempts; never 0 writes applied). */
  write_attempts_blocked: number;
  /** Always 0 for a valid explore feeder run. */
  write_count: number;
  created_at: string;
}

export interface ExploreFeederAgentSpec {
  id: string;
  task: string;
  /** Optional seed paths to prime the pack (e.g. from plan). */
  seedPaths?: string[];
  /** Optional symbols known a priori. */
  seedSymbols?: ExploreEvidenceSymbol[];
  maxRounds?: number;
  maxTools?: number;
}

export interface ExploreFeederAgentResult {
  agentId: string;
  success: boolean;
  summary: string;
  evidencePack: ExploreEvidencePack;
  /** Optional implement handoff body derived from the pack. */
  implementHandoff: string | null;
  error: string | null;
  diagnostics: Array<{ code: string; message: string }>;
}

export interface ExploreWriteGateResult {
  blocked: boolean;
  observation?: string;
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

export function createEmptyEvidencePack(input: {
  agentId: string;
  task: string;
  maxRounds?: number;
  maxTools?: number;
  now?: Date;
}): ExploreEvidencePack {
  const max_rounds = input.maxRounds ?? DEFAULT_EXPLORE_FEEDER_MAX_ROUNDS;
  const max_tools = input.maxTools ?? DEFAULT_EXPLORE_FEEDER_MAX_TOOLS;
  return {
    schema_version: EXPLORE_EVIDENCE_PACK_SCHEMA_VERSION,
    agent_id: input.agentId,
    task: input.task,
    paths: [],
    symbols: [],
    hypothesized_edits: [],
    notes: [],
    budget: {
      max_rounds,
      max_tools,
      rounds_used: 0,
      tools_used: 0,
      budget_exhausted: false,
    },
    write_attempts_blocked: 0,
    write_count: 0,
    created_at: (input.now ?? new Date()).toISOString(),
  };
}

export function normalizeExplorePath(entry: string): string {
  return entry.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
}

/** Explore feeder must never execute mutations — hard block. */
export function evaluateExploreWriteAttempt(toolName: string): ExploreWriteGateResult {
  // sub_agent is a write surface for mutation children — block with direct mutation tools.
  if (!isDirectMutationTool(toolName) && toolName !== 'sub_agent') {
    return { blocked: false };
  }
  return {
    blocked: true,
    observation:
      `### ${toolName}\nexit_code: 1\n` +
      `Error: explore feeder is read-only — writes are forbidden. ` +
      `Return an evidence pack (paths, symbols, hypothesized_edits) for the implement agent.`,
  };
}

export function evaluateExploreFeederBudget(input: {
  roundsUsed: number;
  toolsUsed: number;
  maxRounds: number;
  maxTools: number;
}): { exhausted: boolean; reason: string | null } {
  if (input.maxRounds > 0 && input.roundsUsed >= input.maxRounds) {
    return { exhausted: true, reason: `explore budget: max_rounds=${input.maxRounds}` };
  }
  if (input.maxTools > 0 && input.toolsUsed >= input.maxTools) {
    return { exhausted: true, reason: `explore budget: max_tools=${input.maxTools}` };
  }
  return { exhausted: false, reason: null };
}

export function validateEvidencePack(pack: ExploreEvidencePack): {
  ok: boolean;
  diagnostics: Array<{ code: string; message: string }>;
} {
  const diagnostics: Array<{ code: string; message: string }> = [];
  if (pack.schema_version !== EXPLORE_EVIDENCE_PACK_SCHEMA_VERSION) {
    diagnostics.push({
      code: 'schema_version',
      message: `Expected schema_version ${EXPLORE_EVIDENCE_PACK_SCHEMA_VERSION}, got ${pack.schema_version}`,
    });
  }
  if (!pack.agent_id?.trim()) {
    diagnostics.push({ code: 'agent_id_required', message: 'agent_id is required' });
  }
  if (!pack.task?.trim()) {
    diagnostics.push({ code: 'task_required', message: 'task is required' });
  }
  if (pack.write_count !== 0) {
    diagnostics.push({
      code: 'explore_must_not_write',
      message: `Explore feeder write_count must be 0 (got ${pack.write_count})`,
    });
  }
  if (!Array.isArray(pack.paths) || !Array.isArray(pack.symbols) || !Array.isArray(pack.hypothesized_edits)) {
    diagnostics.push({
      code: 'pack_shape',
      message: 'paths, symbols, and hypothesized_edits must be arrays',
    });
  }
  for (const edit of pack.hypothesized_edits ?? []) {
    if (!edit.path?.trim() || !edit.summary?.trim()) {
      diagnostics.push({
        code: 'hypothesized_edit_incomplete',
        message: 'Each hypothesized_edit needs path + summary',
      });
    }
  }
  return { ok: diagnostics.length === 0, diagnostics };
}

/**
 * Merge tool-log localization targets into an evidence pack (read-only tools only).
 * Mutation tools increment write_attempts_blocked and never add writes.
 */
export function absorbExploreToolCalls(
  pack: ExploreEvidencePack,
  toolCalls: Array<{ tool: string; target?: string; error?: string }>,
): ExploreEvidencePack {
  const next: ExploreEvidencePack = {
    ...pack,
    paths: [...pack.paths],
    symbols: [...pack.symbols],
    hypothesized_edits: [...pack.hypothesized_edits],
    notes: [...pack.notes],
    budget: { ...pack.budget },
  };

  for (const tc of toolCalls) {
    const writeGate = evaluateExploreWriteAttempt(tc.tool);
    if (writeGate.blocked) {
      next.write_attempts_blocked += 1;
      continue;
    }
    next.budget.tools_used += 1;
    const target = tc.target?.trim();
    if (!target) continue;

    // File-like localize tools contribute paths
    if (
      tc.tool === 'read_file' ||
      tc.tool === 'read_range' ||
      tc.tool === 'list_dir' ||
      tc.tool === 'glob'
    ) {
      const p = normalizeExplorePath(target);
      if (p && !next.paths.includes(p)) next.paths.push(p);
    } else if (tc.tool === 'grep' || tc.tool === 'semantic_search' || tc.tool === 'workspace_symbol_search') {
      // Query-ish: keep as note; path after @ if present
      const at = target.indexOf('@');
      if (at >= 0) {
        const pathPart = normalizeExplorePath(target.slice(at + 1).trim());
        if (pathPart && !next.paths.includes(pathPart)) next.paths.push(pathPart);
      }
      if (tc.tool === 'workspace_symbol_search' || tc.tool === 'semantic_search') {
        const name = target.slice(0, 80);
        if (name && !next.symbols.some((s) => s.name === name)) {
          next.symbols.push({ name, kind: tc.tool });
        }
      }
    }
  }

  const budget = evaluateExploreFeederBudget({
    roundsUsed: next.budget.rounds_used,
    toolsUsed: next.budget.tools_used,
    maxRounds: next.budget.max_rounds,
    maxTools: next.budget.max_tools,
  });
  next.budget.budget_exhausted = budget.exhausted;
  if (budget.exhausted && budget.reason) {
    next.notes.push(budget.reason);
  }
  // Invariant: explore never records successful writes
  next.write_count = 0;
  return next;
}

/**
 * Format evidence pack as implement-agent intent (optional auto-handoff to W2.1).
 */
export function formatEvidencePackForImplementHandoff(pack: ExploreEvidencePack): string {
  const pathList =
    pack.paths.length > 0
      ? pack.paths.map((p) => `- ${p}`).join('\n')
      : '- (no paths localized — implement must re-localize)';
  const symbols =
    pack.symbols.length > 0
      ? pack.symbols
          .map((s) => `- ${s.name}${s.path ? ` @ ${s.path}` : ''}${s.kind ? ` (${s.kind})` : ''}`)
          .join('\n')
      : '- (none)';
  const edits =
    pack.hypothesized_edits.length > 0
      ? pack.hypothesized_edits
          .map(
            (e) =>
              `- \`${e.path}\`: ${e.summary}${e.rationale ? ` — ${e.rationale}` : ''}`,
          )
          .join('\n')
      : '- (none proposed — implement from task + paths)';

  const writeScopeHint =
    pack.hypothesized_edits.length > 0
      ? pack.hypothesized_edits.map((e) => normalizeExplorePath(e.path)).filter(Boolean)
      : pack.paths.filter((p) => p.includes('.')); // files over dirs when possible

  return [
    '[Explore → Implement handoff]',
    `explore_agent_id: ${pack.agent_id}`,
    `created: ${pack.created_at}`,
    `write_attempts_blocked_during_explore: ${pack.write_attempts_blocked}`,
    '',
    'You are the IMPLEMENT agent. Explore already localized context; do not re-explore the whole repo.',
    'Prefer str_replace/write_file on the hypothesized paths. Run a targeted verifier after mutations.',
    '',
    '## Original task',
    pack.task,
    '',
    '## Localized paths',
    pathList,
    '',
    '## Symbols',
    symbols,
    '',
    '## Hypothesized edits',
    edits,
    '',
    '## Suggested write_scope (for implement worktree)',
    writeScopeHint.length > 0
      ? writeScopeHint.map((p) => `- ${p}`).join('\n')
      : '- (declare write_scope from plan)',
    '',
    ...(pack.notes.length > 0 ? ['## Explore notes', ...pack.notes.map((n) => `- ${n}`), ''] : []),
  ].join('\n');
}

/** Derive suggested write_scope paths from pack (for W2.1). */
export function suggestWriteScopeFromEvidencePack(pack: ExploreEvidencePack): string[] {
  const fromEdits = pack.hypothesized_edits.map((e) => normalizeExplorePath(e.path));
  const fromPaths = pack.paths.map(normalizeExplorePath).filter((p) => p.includes('.'));
  return [...new Set([...fromEdits, ...fromPaths].filter(Boolean))];
}

/**
 * Deterministic offline explore: seed paths + light heuristics from the task text.
 * Used by unit tests and as a zero-LLM feeder when seeds are known.
 */
export function synthesizeEvidencePackFromSeeds(spec: ExploreFeederAgentSpec, opts?: {
  now?: Date;
  /** Simulated tool calls (optional). Mutations are blocked and counted. */
  toolCalls?: Array<{ tool: string; target?: string; error?: string }>;
  hypothesizedEdits?: ExploreHypothesizedEdit[];
}): ExploreEvidencePack {
  let pack = createEmptyEvidencePack({
    agentId: spec.id,
    task: spec.task,
    ...(spec.maxRounds !== undefined ? { maxRounds: spec.maxRounds } : {}),
    ...(spec.maxTools !== undefined ? { maxTools: spec.maxTools } : {}),
    ...(opts?.now !== undefined ? { now: opts.now } : {}),
  });

  for (const raw of spec.seedPaths ?? []) {
    const p = normalizeExplorePath(raw);
    if (p && !pack.paths.includes(p)) pack.paths.push(p);
  }
  for (const sym of spec.seedSymbols ?? []) {
    if (sym.name && !pack.symbols.some((s) => s.name === sym.name)) {
      pack.symbols.push({ ...sym });
    }
  }

  // Heuristic: mention of path-like tokens in task
  const pathLike = spec.task.match(/[\w./\\-]+\.(ts|tsx|js|jsx|py|md|json)/gi) ?? [];
  for (const m of pathLike) {
    const p = normalizeExplorePath(m);
    if (p && !pack.paths.includes(p)) pack.paths.push(p);
  }

  if (opts?.toolCalls?.length) {
    pack = absorbExploreToolCalls(pack, opts.toolCalls);
    pack.budget.rounds_used = Math.min(
      pack.budget.max_rounds,
      Math.max(1, Math.ceil(opts.toolCalls.length / 3)),
    );
  } else {
    pack.budget.rounds_used = 1;
    pack.budget.tools_used = pack.paths.length;
  }

  if (opts?.hypothesizedEdits?.length) {
    pack.hypothesized_edits = opts.hypothesizedEdits.map((e) => ({
      path: normalizeExplorePath(e.path),
      summary: e.summary,
      ...(e.rationale ? { rationale: e.rationale } : {}),
    }));
  } else if (pack.paths.length > 0) {
    // Default hypothesis: fix the first file path
    const firstFile = pack.paths.find((p) => p.includes('.')) ?? pack.paths[0]!;
    pack.hypothesized_edits = [
      {
        path: firstFile,
        summary: 'Apply the task fix here after reading surrounding context',
        rationale: 'Seed/localized path from explore feeder',
      },
    ];
  }

  pack.write_count = 0;
  return pack;
}

/**
 * Run explore feeder agent (offline/deterministic path).
 * Acceptance: evidence pack schema valid; write_count === 0; budget fields present.
 */
export function runExploreFeederAgent(
  spec: ExploreFeederAgentSpec,
  options?: {
    now?: Date;
    toolCalls?: Array<{ tool: string; target?: string; error?: string }>;
    hypothesizedEdits?: ExploreHypothesizedEdit[];
    /** When true, build implement handoff text from the pack. */
    withImplementHandoff?: boolean;
  },
): ExploreFeederAgentResult {
  const diagnostics: Array<{ code: string; message: string }> = [];
  if (!spec.id?.trim()) {
    diagnostics.push({ code: 'id_required', message: 'Explore feeder requires a non-empty id' });
  }
  if (!spec.task?.trim()) {
    diagnostics.push({ code: 'task_required', message: 'Explore feeder requires a non-empty task' });
  }
  if (diagnostics.length > 0) {
    const empty = createEmptyEvidencePack({
      agentId: spec.id || 'explore-unknown',
      task: spec.task || '',
      ...(options?.now !== undefined ? { now: options.now } : {}),
    });
    return {
      agentId: spec.id || 'explore-unknown',
      success: false,
      summary: `Explore feeder rejected: ${diagnostics.map((d) => d.message).join('; ')}`,
      evidencePack: empty,
      implementHandoff: null,
      error: diagnostics.map((d) => d.message).join('; '),
      diagnostics,
    };
  }

  const pack = synthesizeEvidencePackFromSeeds(spec, {
    ...(options?.now !== undefined ? { now: options.now } : {}),
    ...(options?.toolCalls !== undefined ? { toolCalls: options.toolCalls } : {}),
    ...(options?.hypothesizedEdits !== undefined
      ? { hypothesizedEdits: options.hypothesizedEdits }
      : {}),
  });
  const validation = validateEvidencePack(pack);
  diagnostics.push(...validation.diagnostics);

  const success = validation.ok && pack.write_count === 0;
  const handoff =
    success && options?.withImplementHandoff !== false
      ? formatEvidencePackForImplementHandoff(pack)
      : null;

  return {
    agentId: spec.id,
    success,
    summary: success
      ? `Explore feeder ${spec.id}: ${pack.paths.length} path(s), ${pack.hypothesized_edits.length} hypothesized edit(s), write_count=0.`
      : `Explore feeder ${spec.id} failed validation`,
    evidencePack: pack,
    implementHandoff: handoff,
    error: success ? null : diagnostics.map((d) => d.message).join('; '),
    diagnostics,
  };
}

export interface ExploreFeederLiveOptions {
  projectRoot: string;
  runDir?: string;
  /** Prefer true in unit tests / offline CI. */
  useDeterministicMock?: boolean;
  executor?: ToolExecutor;
  now?: Date;
  withImplementHandoff?: boolean;
  abortSignal?: AbortSignal;
  model?: string;
}

export interface ExploreFeederLiveResult extends ExploreFeederAgentResult {
  /** Read-only loop telemetry when live path ran. */
  readOnly: {
    stepsExecuted: number;
    policyBlocked: boolean;
    blockedReason: string | null;
    toolCallCount: number;
  } | null;
}

/**
 * Live / mock explore feeder: runs read-only discovery then builds an evidence pack.
 * Mutations never apply (read-only preset + absorbExploreToolCalls write gate).
 */
export async function runExploreFeederAgentLive(
  spec: ExploreFeederAgentSpec,
  options: ExploreFeederLiveOptions,
): Promise<ExploreFeederLiveResult> {
  const base = runExploreFeederAgent(spec, {
    ...(options.now !== undefined ? { now: options.now } : {}),
    withImplementHandoff: false,
  });
  if (!base.success && base.error?.includes('requires')) {
    return { ...base, readOnly: null };
  }

  const runDir =
    options.runDir ?? join(options.projectRoot, '.babel', 'runs', 'explore-feeder', spec.id);
  const toolContext: ToolContext = {
    agentId: spec.id,
    runId: `explore-feeder-${spec.id}`,
    runDir: join(runDir, 'tools'),
    babelRoot: process.env['BABEL_ROOT'] ?? options.projectRoot,
    ...(options.abortSignal ? { signal: options.abortSignal } : {}),
  };

  let loopResult: ReadOnlyAgentLoopResult;
  try {
    loopResult = await runReadOnlyAgentLoop({
      verb: 'ask',
      task: spec.task,
      projectRoot: options.projectRoot,
      seedPaths: spec.seedPaths ?? [],
      toolContext,
      maxRounds: spec.maxRounds ?? DEFAULT_EXPLORE_FEEDER_MAX_ROUNDS,
      useDeterministicMock: options.useDeterministicMock ?? true,
      ...(options.executor ? { executor: options.executor } : {}),
      ...(options.model ? { model: options.model } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ...base,
      success: false,
      summary: `Explore feeder live failed: ${message}`,
      error: message,
      diagnostics: [...base.diagnostics, { code: 'read_only_loop_failed', message }],
      implementHandoff: null,
      readOnly: null,
    };
  }

  const toolCalls = loopResult.toolCallLog.map((tc) => ({
    tool: String(tc.tool),
    target: tc.target,
    ...(tc.exit_code !== 0 && tc.stderr
      ? { error: tc.stderr.slice(0, 200) }
      : tc.exit_code !== 0
        ? { error: `exit ${tc.exit_code}` }
        : {}),
  }));

  // Count any mutation-shaped tools in the log (should be none under read-only preset)
  let writeBlocked = 0;
  for (const tc of toolCalls) {
    if (evaluateExploreWriteAttempt(tc.tool).blocked) writeBlocked += 1;
  }

  let pack = synthesizeEvidencePackFromSeeds(spec, {
    ...(options.now !== undefined ? { now: options.now } : {}),
    toolCalls,
  });
  pack = absorbExploreToolCalls(pack, toolCalls);
  pack.write_attempts_blocked = Math.max(pack.write_attempts_blocked, writeBlocked);
  pack.write_count = 0;
  pack.budget.rounds_used = Math.min(
    pack.budget.max_rounds,
    Math.max(pack.budget.rounds_used, loopResult.stepsExecuted > 0 ? 1 : 0),
  );
  pack.budget.tools_used = Math.min(
    pack.budget.max_tools,
    Math.max(pack.budget.tools_used, toolCalls.length),
  );
  const budget = evaluateExploreFeederBudget({
    roundsUsed: pack.budget.rounds_used,
    toolsUsed: pack.budget.tools_used,
    maxRounds: pack.budget.max_rounds,
    maxTools: pack.budget.max_tools,
  });
  pack.budget.budget_exhausted = budget.exhausted;
  if (loopResult.policyBlocked && loopResult.blockedReason) {
    pack.notes.push(`read_only_policy: ${loopResult.blockedReason}`);
  }

  const validation = validateEvidencePack(pack);
  const diagnostics = [...validation.diagnostics];
  if (pack.write_count !== 0) {
    diagnostics.push({
      code: 'explore_must_not_write',
      message: 'Live explore path recorded writes — invalid for feeder',
    });
  }

  const success = validation.ok && pack.write_count === 0;
  const handoff =
    success && options.withImplementHandoff !== false
      ? formatEvidencePackForImplementHandoff(pack)
      : null;

  return {
    agentId: spec.id,
    success,
    summary: success
      ? `Explore feeder live ${spec.id}: ${pack.paths.length} path(s), ${toolCalls.length} tool(s), write_count=0.`
      : `Explore feeder live ${spec.id} failed validation`,
    evidencePack: pack,
    implementHandoff: handoff,
    error: success ? null : diagnostics.map((d) => d.message).join('; '),
    diagnostics,
    readOnly: {
      stepsExecuted: loopResult.stepsExecuted,
      policyBlocked: loopResult.policyBlocked,
      blockedReason: loopResult.blockedReason,
      toolCallCount: toolCalls.length,
    },
  };
}
