/**
 * Episode replay consumers + live golden validation (H6).
 *
 * Deterministic terminal-decision replay without model calls. Cross-surface
 * fact agreement. Does not invent events missing from durable evidence.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TerminalOutcome } from '../schemas/agentContracts.js';
import {
  projectLiveSession,
  reconstructTerminalFromSession,
  type LiveSessionV1,
} from './liveSession.js';
import {
  createSessionEventLog,
  parseSessionEventLog,
  serializeSessionEventLog,
  type SessionEventLog,
} from './sessionEvents.js';
import {
  loadOrQuarantineEpisodeLog,
  type EpisodeEventLog,
} from '../evidence/episodeStream.js';

export interface ReplayTerminalResult {
  outcome: TerminalOutcome | string | null;
  source: 'session_completion_decision' | 'session_turn_ended' | 'none';
  invented: false;
  live_session: LiveSessionV1;
}

/**
 * Deterministic terminal replay from durable session events only (no model).
 */
export function replayTerminalDecision(sessionLog: SessionEventLog): ReplayTerminalResult {
  const live = projectLiveSession({ sessionLog });
  const term = reconstructTerminalFromSession(sessionLog);
  if (!term) {
    return {
      outcome: null,
      source: 'none',
      invented: false,
      live_session: live,
    };
  }
  const hasCompletion = sessionLog.events.some((e) => e.kind === 'completion_decision');
  return {
    outcome: term.outcome,
    source: hasCompletion ? 'session_completion_decision' : 'session_turn_ended',
    invented: false,
    live_session: live,
  };
}

export interface CrossSurfaceFacts {
  outcome: string | null;
  session_id: string;
  compaction_count: number;
  completed_idempotency_keys: string[];
  degraded: boolean;
  exit_code: number | null;
}

/**
 * Cross-surface fact projection (TUI / headless JSON / persistence / CLI status).
 * All four views must agree on these fields when built from the same log.
 */
export function projectCrossSurfaceFacts(
  sessionLog: SessionEventLog,
  mappers?: {
    exitCodeForOutcome?: (o: string) => number;
    userFacingStatus?: (o: string) => string;
  },
): {
  tui: CrossSurfaceFacts;
  headless_json: CrossSurfaceFacts;
  persistence: CrossSurfaceFacts;
  cli_status: CrossSurfaceFacts;
  agree: boolean;
} {
  const replay = replayTerminalDecision(sessionLog);
  const outcome = replay.outcome === null ? null : String(replay.outcome);
  const exit =
    outcome && mappers?.exitCodeForOutcome
      ? mappers.exitCodeForOutcome(outcome)
      : outcome === 'VERIFIED_COMPLETE' || outcome === 'NO_CHANGE_REQUIRED'
        ? 0
        : outcome
          ? 1
          : null;
  const tuiStatus =
    outcome && mappers?.userFacingStatus
      ? mappers.userFacingStatus(outcome)
      : outcome;
  // Headless/persistence keep canonical outcome; TUI may use user-facing label.
  // Agreement requires same session facts + exit code; TUI status may differ in label.
  const shared = {
    session_id: sessionLog.session_id,
    compaction_count: replay.live_session.compaction_count,
    completed_idempotency_keys: [
      ...replay.live_session.tools.completed_idempotency_keys,
    ].sort(),
    degraded: replay.live_session.degraded,
    exit_code: exit,
  };
  const tui: CrossSurfaceFacts = { ...shared, outcome: tuiStatus };
  const headless_json: CrossSurfaceFacts = { ...shared, outcome };
  const persistence: CrossSurfaceFacts = { ...shared, outcome };
  const cli_status: CrossSurfaceFacts = { ...shared, outcome };
  const agree =
    headless_json.outcome === persistence.outcome &&
    persistence.outcome === cli_status.outcome &&
    tui.exit_code === headless_json.exit_code &&
    tui.session_id === headless_json.session_id &&
    tui.compaction_count === headless_json.compaction_count &&
    JSON.stringify(tui.completed_idempotency_keys) ===
      JSON.stringify(headless_json.completed_idempotency_keys);
  return { tui, headless_json, persistence, cli_status, agree };
}

export interface GoldenEpisodeArtifact {
  schema_version: 1;
  generated_at: string;
  /** True only when provenance is a real controller run — never hard-coded true by default. */
  live_runtime: boolean;
  controller: 'chat' | 'plan' | 'deep' | 'simulated_controller';
  workspace_path: string;
  session_events_jsonl: string;
  expected_terminal: string;
  expected_exit_code: number;
  content_hash: string;
}

/**
 * Build a runtime-generated golden episode artifact from a real session log.
 * Marks live_runtime: true (distinct from simulated contract-only fixtures).
 */
export function buildLiveGoldenEpisode(input: {
  sessionLog: SessionEventLog;
  workspace_path: string;
  controller?: GoldenEpisodeArtifact['controller'];
  expected_exit_code?: number;
  /**
   * Provenance: set true only when sessionLog was produced by a real controller
   * run (not a hand-built fixture). Defaults false to avoid hard-coded theater.
   */
  live_runtime?: boolean;
}): GoldenEpisodeArtifact {
  const jsonl = serializeSessionEventLog(input.sessionLog);
  const replay = replayTerminalDecision(input.sessionLog);
  const expected_terminal = replay.outcome === null ? 'NONE' : String(replay.outcome);
  const content_hash = createHash('sha256').update(jsonl).digest('hex').slice(0, 32);
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    live_runtime: input.live_runtime === true,
    controller: input.controller ?? 'chat',
    workspace_path: input.workspace_path,
    session_events_jsonl: jsonl,
    expected_terminal,
    expected_exit_code: input.expected_exit_code ?? (expected_terminal === 'VERIFIED_COMPLETE' ? 0 : 1),
    content_hash,
  };
}

/**
 * Validate a golden episode: reload events, replay terminal, compare expected.
 */
export function validateGoldenEpisode(artifact: GoldenEpisodeArtifact): {
  ok: boolean;
  errors: string[];
  replayed_terminal: string | null;
} {
  const errors: string[] = [];
  // live_runtime is provenance metadata; validation still checks replay integrity.
  // Callers that require live controller provenance must pass live_runtime: true
  // when building the artifact — it is never invented here.
  let log: SessionEventLog;
  try {
    log = parseSessionEventLog(artifact.session_events_jsonl);
  } catch (e) {
    return {
      ok: false,
      errors: [`parse_failed: ${e instanceof Error ? e.message : String(e)}`],
      replayed_terminal: null,
    };
  }
  const hash = createHash('sha256')
    .update(artifact.session_events_jsonl)
    .digest('hex')
    .slice(0, 32);
  if (hash !== artifact.content_hash) {
    errors.push('content_hash_mismatch');
  }
  const replay = replayTerminalDecision(log);
  const replayed = replay.outcome === null ? 'NONE' : String(replay.outcome);
  if (replayed !== artifact.expected_terminal) {
    errors.push(
      `terminal_mismatch: expected ${artifact.expected_terminal} got ${replayed}`,
    );
  }
  if (replay.invented) {
    errors.push('replay_invented_events');
  }
  return { ok: errors.length === 0, errors, replayed_terminal: replayed };
}

/**
 * Write + validate golden episode under a workspace path (one-command path).
 */
export function runAndValidateLiveGolden(input: {
  sessionLog: SessionEventLog;
  workspace_path: string;
  out_dir?: string;
  /** Set true only when sessionLog was produced by a real controller run. */
  live_runtime?: boolean;
  controller?: GoldenEpisodeArtifact['controller'];
}): {
  ok: boolean;
  artifact_path: string;
  validation: ReturnType<typeof validateGoldenEpisode>;
  artifact: GoldenEpisodeArtifact;
} {
  const outDir = input.out_dir ?? join(input.workspace_path, '.babel-golden');
  mkdirSync(outDir, { recursive: true });
  const artifact = buildLiveGoldenEpisode({
    sessionLog: input.sessionLog,
    workspace_path: input.workspace_path,
    controller: input.controller ?? 'chat',
    live_runtime: input.live_runtime === true,
  });
  const artifact_path = join(outDir, 'live-golden-episode.json');
  writeFileSync(artifact_path, JSON.stringify(artifact, null, 2), 'utf-8');
  const validation = validateGoldenEpisode(artifact);
  return { ok: validation.ok, artifact_path, validation, artifact };
}

export interface LiveControllerGoldenResult {
  ok: boolean;
  workspace_path: string;
  run_dir: string;
  artifact_path: string;
  live_runtime: true;
  controller: 'chat';
  terminal_outcome: string | null;
  session_event_kinds: string[];
  thread_event_kinds: string[];
  replay_matches: boolean;
  cross_surface_agree: boolean;
  validation: ReturnType<typeof validateGoldenEpisode>;
  errors: string[];
}

/**
 * H6 exit-gate path: drive ChatEngine on a real workspace with a mock model runner
 * (no external API), harvest durable session events the controller produced, build
 * and validate a live_runtime golden, and prove model-free terminal replay.
 *
 * This is not a hand-built SessionEventLog restore — submitMessage runs the live
 * monomorphic loop (parity dual-write, tool execution, finalize).
 */
export async function runLiveControllerGoldenEpisode(input: {
  workspace_path: string;
  task?: string;
  user_message?: string;
  out_dir?: string;
  /** Mock runner sequence: complete | tools_then_complete */
  sequence?: 'complete' | 'tools_then_complete';
}): Promise<LiveControllerGoldenResult> {
  const errors: string[] = [];
  // Lazy import avoids circular load with chatEngine at module init.
  const { ChatEngine } = await import('./chatEngine.js');
  const { terminalOutcomeExitCode } = await import('../schemas/agentContracts.js');
  const { userFacingStatusFromOutcome } = await import('../cli/userFacingStatus.js');

  const task = input.task ?? 'Read the workspace file and answer briefly';
  const userMessage = input.user_message ?? 'Complete the task.';
  const sequence = input.sequence ?? 'tools_then_complete';

  // Mock native-tools runner (same contract as harnessParityLivePath tests).
  let call = 0;
  const mockRunner = {
    executeWithToolsStream: async function* (
      _messages: unknown,
      _tools: unknown,
      _sys?: string,
      _signal?: AbortSignal,
    ): AsyncGenerator<
      | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
      | { type: 'text_delta'; text: string }
      | { type: 'done'; finishReason: string },
      void,
      undefined
    > {
      call += 1;
      if (sequence === 'tools_then_complete' && call === 1) {
        yield {
          type: 'tool_use',
          id: 'golden-c1',
          name: 'read_file',
          input: { path: 'hello.txt' },
        };
        yield { type: 'done', finishReason: 'tool_calls' };
        return;
      }
      yield { type: 'text_delta', text: 'Task complete. File contents observed.' };
      yield { type: 'done', finishReason: 'stop' };
    },
    execute: async () => ({ type: 'completion' as const, answer: 'Task complete.' }),
    getLastInvocationMetadata: () => null,
  };

  const priorAutoApprove = process.env['BABEL_BENCHMARK_AUTO_APPROVE'];
  // P0-B: benchmark auto-approval is valid only inside an explicitly marked
  // benchmark execution mode.
  process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = '1';
  process.env['BABEL_BENCHMARK_MODE'] = '1';
  try {
    const engine = new ChatEngine({
      task,
      projectRoot: input.workspace_path,
      model: 'deepseek-v4-flash',
      maxTurns: 6,
    });
    const anyEngine = engine as unknown as {
      deliberationRunner: unknown;
      synthesisRunner: unknown;
      shouldUseNativeTools: () => boolean;
    };
    anyEngine.deliberationRunner = mockRunner;
    anyEngine.synthesisRunner = mockRunner;
    anyEngine.shouldUseNativeTools = () => true;

    try {
      await engine.submitMessage(userMessage, { onThought: () => {} });
    } catch (e) {
      errors.push(`submitMessage_failed: ${e instanceof Error ? e.message : String(e)}`);
    }

  const runDir = (engine as unknown as { engineRunDir: string }).engineRunDir;
  const sessionLog = engine.getParityRuntime().sessionEvents;
  const threadLog = engine.getParityEventLog();
  const session_event_kinds = sessionLog.events.map((e) => e.kind);
  const thread_event_kinds = threadLog.events.map((e) => e.kind);

  // Controller-produced durable events must exist (not empty hand-built log).
  if (!session_event_kinds.includes('user_submitted')) {
    errors.push('missing_user_submitted_from_controller');
  }
  if (
    !session_event_kinds.includes('turn_ended') &&
    !session_event_kinds.includes('completion_decision')
  ) {
    errors.push('missing_terminal_session_events_from_controller');
  }
  if (sequence === 'tools_then_complete') {
    if (!thread_event_kinds.includes('assistant_tool_calls')) {
      errors.push('missing_assistant_tool_calls_from_controller');
    }
    if (!thread_event_kinds.includes('tool_result')) {
      errors.push('missing_tool_result_from_controller');
    }
  }

  const golden = runAndValidateLiveGolden({
    sessionLog,
    workspace_path: input.workspace_path,
    ...(input.out_dir !== undefined ? { out_dir: input.out_dir } : {}),
    live_runtime: true,
    controller: 'chat',
  });
  if (!golden.artifact.live_runtime) {
    errors.push('live_runtime_not_true');
  }
  if (!golden.ok) {
    errors.push(...golden.validation.errors.map((e) => `golden_validation:${e}`));
  }

  const replay = replayTerminalDecision(sessionLog);
  const replay_matches =
    replay.outcome !== null &&
    String(replay.outcome) === golden.artifact.expected_terminal &&
    replay.invented === false;
  if (!replay_matches) {
    errors.push(
      `replay_mismatch: expected=${golden.artifact.expected_terminal} got=${String(replay.outcome)} invented=${replay.invented}`,
    );
  }

  const facts = projectCrossSurfaceFacts(sessionLog, {
    exitCodeForOutcome: (o) => terminalOutcomeExitCode(o as import('../schemas/agentContracts.js').TerminalOutcome),
    userFacingStatus: (o) =>
      userFacingStatusFromOutcome(o as import('../schemas/agentContracts.js').TerminalOutcome),
  });
  if (!facts.agree) {
    errors.push('cross_surface_disagree');
  }

    return {
    ok: errors.length === 0 && golden.ok && replay_matches && facts.agree,
    workspace_path: input.workspace_path,
    run_dir: runDir,
    artifact_path: golden.artifact_path,
    live_runtime: true,
    controller: 'chat',
    terminal_outcome: replay.outcome === null ? null : String(replay.outcome),
    session_event_kinds,
    thread_event_kinds,
    replay_matches,
    cross_surface_agree: facts.agree,
    validation: golden.validation,
      errors,
    };
  } finally {
    if (priorAutoApprove === undefined) delete process.env['BABEL_BENCHMARK_AUTO_APPROVE'];
    else process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = priorAutoApprove;
  }
}

/**
 * Operator inspection projection for policy/compaction/tool/mutation/verifier history.
 */
export function inspectSessionHistory(sessionLog: SessionEventLog): {
  policy: number;
  compaction: number;
  tools: number;
  mutations: number;
  verifiers: number;
  repairs: number;
  completions: number;
} {
  let policy = 0;
  let compaction = 0;
  let tools = 0;
  let mutations = 0;
  let verifiers = 0;
  let repairs = 0;
  let completions = 0;
  for (const e of sessionLog.events) {
    switch (e.kind) {
      case 'policy_intervened':
        policy++;
        break;
      case 'compaction_created':
        compaction++;
        break;
      case 'tool_proposed':
      case 'tool_started':
      case 'tool_completed':
      case 'tool_failed':
      case 'tool_cancelled':
        tools++;
        break;
      case 'mutation_batch':
        mutations++;
        break;
      case 'verifier_attempt':
        verifiers++;
        break;
      case 'repair_attempt':
      case 'progress_recovery':
        repairs++;
        break;
      case 'completion_decision':
      case 'turn_ended':
        completions++;
        break;
      default:
        break;
    }
  }
  return { policy, compaction, tools, mutations, verifiers, repairs, completions };
}

/**
 * Quarantine-consistent corrupt stream handling for episodes.
 */
export function loadEpisodeOrQuarantine(
  runDir: string,
  sessionId: string,
): { status: 'ok' | 'quarantined' | 'missing'; log?: EpisodeEventLog } {
  if (!existsSync(join(runDir, 'episode-events.jsonl'))) {
    return { status: 'missing' };
  }
  try {
    const log = loadOrQuarantineEpisodeLog(runDir, sessionId);
    return { status: 'ok', log };
  } catch {
    return { status: 'quarantined' };
  }
}
