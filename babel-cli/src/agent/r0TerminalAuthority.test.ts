/**
 * R0-A — terminal authority: model prose is not blocking authority.
 *
 * Invariant under test:
 *   - MODEL PROSE != BLOCKED AUTHORITY
 *   - INVESTIGATION ACTIVITY != PROOF OF A BLOCKING CONDITION
 *
 * A model may say BLOCKED; that alone cannot upgrade status / terminal_outcome /
 * reason_code / cause_class. Only a trusted origin (controller/tool/policy/
 * verifier/provider) may establish a block. A *successful* read-only inspection
 * is not evidence of a blocking condition, and — R0-5 — neither is a *generic*
 * failure (non-zero exit, red verifier, compile error, lint failure, failed
 * search, missing project file). Only a TYPED origin that semantically
 * establishes inability to continue (permission denial, unsupported operation,
 * unreachable external dependency, provider failure, exhausted budget) may.
 *
 * These tests drive the real production engine (streaming + non-stream) and the
 * real reason resolvers, with exact terminal assertions.
 */

import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatEngine, type ChatEvent } from './chatEngine.js';
import { detectAndBuildBlockedReport } from './chatEngineSupport.js';
import { BlockedReportSchema } from '../schemas/agentContracts.js';
import { runChatEngineOnce } from '../interactive/execution/chatCore.js';
import { computeTerminalOutcome } from './chatEngineObservability.js';
import { projectChatTerminal } from './chatFailureClassification.js';
import {
  classifyPolicySource,
  terminalReasonFromFailureText,
  terminalReasonFromOutcome,
  terminalReasonFromVerifierFailure,
} from './chatTerminalReason.js';

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'babel-r0-authority-'));
  roots.push(root);
  return root;
}

type MockRunner = Record<string, unknown>;

function stubNativeRunner(engine: ChatEngine, runner: MockRunner): void {
  const box = engine as unknown as Record<string, unknown>;
  box['deliberationRunner'] = runner;
  box['shouldUseNativeTools'] = () => true;
}

async function collect(
  engine: ChatEngine,
  input: string,
  taskIntent?: 'execute' | 'explain',
): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const ev of engine.submitMessageStream(input, taskIntent)) {
    events.push(ev);
  }
  return events;
}

function doneEvent(events: ChatEvent[]): Extract<ChatEvent, { type: 'done' }> {
  const done = events.filter((e): e is Extract<ChatEvent, { type: 'done' }> => e.type === 'done');
  assert.equal(done.length, 1, `expected exactly one done event, got ${done.length}`);
  return done[0]!;
}

/** Scripted runner: a tool round, then a text-only BLOCKED completion. */
function readThenBlockedRunner(toolPath: string, blockedAnswer: string): MockRunner {
  let calls = 0;
  return {
    executeWithToolsStream: async function* () {
      calls += 1;
      if (calls === 1) {
        yield {
          type: 'tool_use' as const,
          id: 't1',
          name: 'read_file',
          input: { path: toolPath },
        };
        yield { type: 'done' as const, finishReason: 'tool_calls' };
        return;
      }
      yield { type: 'text_delta' as const, text: blockedAnswer };
      yield { type: 'done' as const, finishReason: 'stop' };
    },
    getLastInvocationMetadata: () => null,
  };
}

// ── Unit: detectAndBuildBlockedReport evidence gate ─────────────────────────

describe('R0-A: detectAndBuildBlockedReport requires a genuine blocking condition', () => {
  test('a successful read plus a line-anchored BLOCKED answer is NOT a blocked report', () => {
    assert.equal(
      detectAndBuildBlockedReport('BLOCKED: external service unreachable.', [
        { tool: 'read_file', target: 'src/service.ts', exit_code: 0, stdout: 'contents' },
      ]),
      null,
      'successful inspection is not proof of a blocking condition',
    );
  });

  test('an entry with no failure signal (no exit_code/error/stderr) is NOT evidence', () => {
    assert.equal(
      detectAndBuildBlockedReport('BLOCKED: permission denied by policy', [
        { tool: 'read_file', target: 'a.ts' },
      ]),
      null,
    );
  });

  test('R0-5: a generic failed read (ENOENT) plus BLOCKED is NOT terminal blocking authority', () => {
    // A missing project file is repairable localization (wrong path / optional
    // file), not an external dependency the agent cannot provision. The model's
    // BLOCKED prose cannot promote it into terminal authority.
    assert.equal(
      detectAndBuildBlockedReport('BLOCKED: cannot read the config.', [
        {
          tool: 'read_file',
          target: 'config.json',
          exit_code: 2,
          stdout: '',
          stderr: 'ENOENT: no such file or directory',
          error: 'read failed',
        },
      ]),
      null,
      'a repairable failed read is failure evidence, not blocking authority',
    );
  });

  test('R0-5: a red verifier plus BLOCKED is verification_failed recovery, not terminal blocking', () => {
    assert.equal(
      detectAndBuildBlockedReport('BLOCKED: tests still fail.', [
        {
          tool: 'run_command',
          target: 'npm test',
          exit_code: 1,
          stdout: '1 failing',
          stderr: 'AssertionError: expected 3, got -1',
        },
      ]),
      null,
      'a red verifier must drive repair/recovery, never a terminal block',
    );
    assert.equal(
      detectAndBuildBlockedReport('BLOCKED: the compiler rejects it.', [
        { tool: 'run_command', target: 'tsc --noEmit', exit_code: 2, stderr: 'TS2345: argument not assignable' },
      ]),
      null,
      'a compile error is repairable failure evidence',
    );
    assert.equal(
      detectAndBuildBlockedReport('BLOCKED: the search found nothing.', [
        { tool: 'grep', target: 'needle', exit_code: 1, stdout: '', stderr: '' },
      ]),
      null,
      'a failed search is a repairable miss, not a block',
    );
  });

  test('R0-5: ordinary test/lint/compiler prose is not a blocking origin', () => {
    // Adversarial over-match controls: these phrases routinely appear in a red
    // test or compiler run and must not become terminal blocking authority.
    const cases: Array<{ name: string; entry: Parameters<typeof detectAndBuildBlockedReport>[1][number] }> = [
      { name: 'test asserts "not supported"', entry: { tool: 'run_command', target: 'npm test', exit_code: 1, stdout: '1 failing', stderr: 'TypeError: option is not supported' } },
      { name: 'test expects 429', entry: { tool: 'run_command', target: 'npm test', exit_code: 1, stdout: 'expected 429 to equal 200', stderr: '' } },
      { name: 'test asserts "forbidden"', entry: { tool: 'run_command', target: 'npm test', exit_code: 1, stdout: 'test: forbidden word rejected', stderr: '' } },
      { name: 'compiler "Unsupported syntax"', entry: { tool: 'run_command', target: 'tsc --noEmit', exit_code: 2, stderr: 'error TS1005: Unsupported syntax' } },
      { name: 'compiler "not implemented"', entry: { tool: 'run_command', target: 'tsc --noEmit', exit_code: 2, stderr: 'Type is not implemented' } },
      { name: 'lint "Unauthorized use of any"', entry: { tool: 'run_command', target: 'eslint .', exit_code: 1, stderr: 'error Unauthorized use of any' } },
      { name: 'test prose "connection refused"', entry: { tool: 'run_command', target: 'npm test', exit_code: 1, stdout: 'mapping after connection refused', stderr: '' } },
      { name: 'test prose "service unavailable"', entry: { tool: 'run_command', target: 'npm test', exit_code: 1, stderr: 'expected service unavailable path' } },
    ];
    for (const c of cases) {
      assert.equal(
        detectAndBuildBlockedReport('BLOCKED: cannot continue.', [c.entry]),
        null,
        `${c.name} must not be blocking authority`,
      );
    }
  });

  test('R0-5: stdout content and test assertions are never blocking origins', () => {
    const cases: Array<{ name: string; entry: Parameters<typeof detectAndBuildBlockedReport>[1][number]; expected: boolean }> = [
      { name: 'successful grep whose output mentions ECONNREFUSED', entry: { tool: 'grep', target: 'client.ts', exit_code: 0, stdout: 'net.ts: throw new ECONNREFUSED();' }, expected: false },
      { name: 'successful read whose output contains EACCES', entry: { tool: 'read_file', target: 'codes.ts', exit_code: 0, stdout: "const code = 'EACCES';" }, expected: false },
      { name: 'missing dev executable', entry: { tool: 'run_command', target: 'npx vitest', exit_code: 127, stderr: 'sh: 1: vitest: command not found' }, expected: false },
      { name: 'test asserts a denial string', entry: { tool: 'run_command', target: 'npm test', exit_code: 1, stderr: "AssertionError: expected 'permission denied' to equal 'access ok'" }, expected: false },
      { name: 'test asserts certificate error', entry: { tool: 'run_command', target: 'npm test', exit_code: 1, stderr: 'AssertionError: expected self-signed certificate error' }, expected: false },
      { name: 'test asserts quota exceeded', entry: { tool: 'run_command', target: 'npm test', exit_code: 1, stderr: 'AssertionError: expected quota exceeded message' }, expected: false },
      { name: 'real OS denial (positive)', entry: { tool: 'run_command', target: 'cat /root/secret', exit_code: 1, stderr: 'cat: /root/secret: Permission denied' }, expected: true },
      { name: 'real network errno (positive)', entry: { tool: 'run_command', target: 'curl svc', exit_code: 7, stderr: 'curl: (7) connect: ECONNREFUSED' }, expected: true },
    ];
    for (const c of cases) {
      const report = detectAndBuildBlockedReport('BLOCKED: cannot continue.', [c.entry]);
      assert.equal(report !== null, c.expected, c.name);
    }
  });

  test('a typed denial with a zero exit code qualifies as evidence', () => {
    const report = detectAndBuildBlockedReport('BLOCKED: permission denied.', [
      { tool: 'read_file', target: 'secret.txt', exit_code: 0, error: 'permission denied' },
    ]);
    assert.ok(report, 'explicit denial is evidence even without a non-zero exit');
    assert.equal(report.reason_code, 'permission_denied');
    assert.equal(report.cause_class, 'environment');
  });

  test('R0-5: generic stderr does not qualify, but an explicit denial does', () => {
    assert.equal(
      detectAndBuildBlockedReport('BLOCKED: grep unavailable.', [
        { tool: 'grep', target: 'needle', exit_code: 0, stdout: '', stderr: 'grep: command failed' },
      ]),
      null,
      'a generic stderr failure message is not a typed blocking origin',
    );
    assert.equal(
      detectAndBuildBlockedReport('BLOCKED: seems fine.', [
        { tool: 'read_file', target: 'a.ts', exit_code: 0, stdout: 'contents', stderr: 'warning' },
      ]),
      null,
      'a warning on stderr alongside successful stdout is not a blocking condition',
    );
    assert.equal(
      detectAndBuildBlockedReport('BLOCKED: tests look green.', [
        { tool: 'test_run', target: 'npm test', exit_code: 0, stdout: 'ok', stderr: '0 failed' },
      ]),
      null,
      'a green run summary must not become evidence of a block',
    );
    assert.ok(
      detectAndBuildBlockedReport('BLOCKED: access denied.', [
        {
          tool: 'run_command',
          target: 'cat /root/secret',
          exit_code: 0,
          stdout: 'partial',
          stderr: 'cat: /root/secret: Permission denied',
        },
      ]),
      'an explicit denial is a blocking condition even with partial stdout',
    );
  });

  test('the line-anchored protocol detection is unchanged (stray prose stays null)', () => {
    assert.equal(
      detectAndBuildBlockedReport('The build is BLOCKED on I/O.', [
        { tool: 'read_file', target: 'a.ts', exit_code: 2, stderr: 'boom' },
      ]),
      null,
      'a stray mid-sentence word is not a protocol declaration',
    );
  });
});

// ── Streaming production path ───────────────────────────────────────────────

describe('R0-A: streaming terminal authority', () => {
  test('successful inspection + BLOCKED falls through to a truthful completed terminal', async () => {
    const wsRoot = makeRoot();
    mkdirSync(join(wsRoot, 'src'), { recursive: true });
    writeFileSync(join(wsRoot, 'src', 'service.ts'), 'export const ping = () => true\n', 'utf8');
    const engine = new ChatEngine({
      task: 'check the service status',
      projectRoot: wsRoot,
      maxTurns: 6,
    });
    stubNativeRunner(
      engine,
      readThenBlockedRunner('src/service.ts', 'BLOCKED: external service unreachable.'),
    );

    const events = await collect(engine, 'check the service status', 'explain');
    const done = doneEvent(events);

    assert.equal(done.status, 'completed');
    assert.equal(done.outcome, 'NO_CHANGE_REQUIRED');
    assert.equal(done.blockedReport ?? null, null);
    assert.equal(done.reason_code, undefined);
    assert.equal(done.cause_class, undefined);
  });

  test('R0-5: a missing file + BLOCKED is repairable, not a terminal block', async () => {
    const wsRoot = makeRoot();
    const engine = new ChatEngine({
      task: 'read the config file',
      projectRoot: wsRoot,
      maxTurns: 6,
    });
    // The path does not exist, so the real executor records a failed read. A
    // wrong/optional path is repairable localization, not blocking authority.
    stubNativeRunner(
      engine,
      readThenBlockedRunner('missing-config.json', 'BLOCKED: the config file cannot be read.'),
    );

    const events = await collect(engine, 'read the config file', 'explain');
    const done = doneEvent(events);

    assert.equal(done.status, 'completed', 'a repairable failure is not terminal blocking');
    assert.equal(done.outcome, 'NO_CHANGE_REQUIRED');
    assert.equal(done.blockedReport ?? null, null);
    assert.equal(done.reason_code, undefined);
    assert.equal(done.cause_class, undefined);
  });

  test('R0-5: a typed permission denial + BLOCKED is a truthful typed block', async () => {
    const wsRoot = makeRoot();
    const secret = join(wsRoot, 'secret.txt');
    writeFileSync(secret, 'top secret\n', 'utf8');
    chmodSync(secret, 0o000);
    const engine = new ChatEngine({
      task: 'read the secret file',
      projectRoot: wsRoot,
      maxTurns: 6,
    });
    stubNativeRunner(
      engine,
      readThenBlockedRunner('secret.txt', 'BLOCKED: the file cannot be read.'),
    );

    const events = await collect(engine, 'read the secret file', 'explain');
    const done = doneEvent(events);

    assert.equal(done.status, 'blocked');
    // permission_denied is the policy/permission bucket in the existing
    // TerminalOutcome taxonomy; the reason_code carries the precise cause.
    assert.equal(done.outcome, 'BLOCKED_POLICY');
    assert.ok(done.blockedReport, 'a typed denial backs a structured report');
    assert.equal(done.blockedReport.reason_code, 'permission_denied');
    assert.equal(done.blockedReport.cause_class, 'environment');
    assert.equal(done.reason_code, 'permission_denied');
    assert.equal(done.cause_class, 'environment');
  });

  test('R0-9: an unsupported_operation failed stream carries a coherent tuple', async () => {
    const wsRoot = makeRoot();
    const engine = new ChatEngine({
      task: 'run the unsupported operation',
      projectRoot: wsRoot,
      maxTurns: 3,
    });
    stubNativeRunner(engine, {
      executeWithToolsStream: async function* () {
        yield {
          type: 'error' as const,
          message: 'cannot execute unsupported operation: runtime-invariant',
        };
      },
      getLastInvocationMetadata: () => null,
    });

    const events = await collect(engine, 'run the unsupported operation', 'explain');
    const failed = events.filter(
      (e): e is Extract<ChatEvent, { type: 'failed' }> => e.type === 'failed',
    );
    assert.equal(failed.length, 1, 'exactly one failed terminal');
    const terminal = failed[0]!;
    // The reason is typed by the kernel/adapter text; the outcome must match it.
    assert.equal(terminal.reason_code, 'unsupported_operation');
    assert.equal(terminal.cause_class, 'harness');
    assert.equal(
      terminal.outcome,
      'BLOCKED_POLICY',
      'a typed reason without a classified outcome still projects its matching outcome',
    );
    assert.notEqual(terminal.outcome, undefined);
  });
});

// ── Callback / non-stream production path ───────────────────────────────────

describe('R0-A: callback/non-stream terminal authority', () => {
  test('successful inspection + BLOCKED does not synthesize a blocked result', async () => {
    const wsRoot = makeRoot();
    mkdirSync(join(wsRoot, 'src'), { recursive: true });
    writeFileSync(join(wsRoot, 'src', 'service.ts'), 'export const ping = () => true\n', 'utf8');
    const engine = new ChatEngine({
      task: 'check the service status',
      projectRoot: wsRoot,
      maxTurns: 6,
    });
    stubNativeRunner(
      engine,
      readThenBlockedRunner('src/service.ts', 'BLOCKED: external service unreachable.'),
    );

    const result = await runChatEngineOnce({
      task: 'check the service status',
      target: {
        targetRoot: wsRoot,
        workspaceRoot: null,
        project: null,
        source: 'cwd',
        cwd: wsRoot,
      },
      engine,
      convRenderer: null,
      useStreaming: false,
      taskIntent: 'explain',
      preflightContext: '',
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.outcome, 'NO_CHANGE_REQUIRED');
    assert.equal(result.blockedReport ?? null, null);
    assert.equal(result.reason_code, undefined);
    assert.equal(result.cause_class, undefined);
  });
});

// ── Verifier/harness-origin blocked report schema ───────────────────────────

describe('R0-A: buildVerifierBlockedReport emits a schema-valid, evidence-backed report', () => {
  function engineWith(overrides: Record<string, unknown> = {}): ChatEngine {
    const engine = new ChatEngine({ task: 'finish the task', projectRoot: makeRoot(), maxTurns: 2 });
    Object.assign(engine as unknown as Record<string, unknown>, overrides);
    return engine;
  }
  function build(engine: ChatEngine, reason: string): Record<string, unknown> {
    return (
      engine as unknown as { buildVerifierBlockedReport(r: string): Record<string, unknown> }
    ).buildVerifierBlockedReport(reason);
  }

  test('harness-origin gate block carries real checked evidence and harness cause', () => {
    const report = build(engineWith(), 'Gate blocked after 3 consecutive rejections.');
    const parsed = BlockedReportSchema.safeParse(report);
    assert.equal(parsed.success, true, JSON.stringify(parsed));
    assert.equal((report['checked'] as unknown[]).length >= 1, true);
    assert.equal(report['reason_code'], 'recovery_exhausted');
    assert.equal(report['cause_class'], 'harness');
    assert.equal(
      (report['checked'] as Array<{ action: string; finding: string }>)[0]!.action,
      'completion_gate',
    );
  });

  test('a red verifier receipt yields verification_failed with the real command', () => {
    const engine = engineWith({
      lastVerifierReceipt: {
        command: 'npm test',
        exit_code: 1,
        summary: '3 tests failed',
        stale: false,
      },
    });
    const report = build(engine, 'Gate blocked after 4 consecutive rejections.');
    const parsed = BlockedReportSchema.safeParse(report);
    assert.equal(parsed.success, true, JSON.stringify(parsed));
    assert.equal(report['reason_code'], 'verification_failed');
    assert.equal(report['cause_class'], 'verification');
    const checked = report['checked'] as Array<{ action: string; target: string; finding: string }>;
    assert.equal(checked[0]!.action, 'run_command');
    assert.equal(checked[0]!.target, 'npm test');
    assert.equal(checked[0]!.finding, '3 tests failed');
  });
});

// ── Typed origins: exact terminal assertions ────────────────────────────────
// These run the production reason resolvers + outcome projector that the engine
// uses. Exact values only — no tolerant disjunctions.

type ExactTerminal = {
  status: string;
  outcome: string;
  reason_code: string | undefined;
  cause_class: string | null | undefined;
};

function terminalForReason(reasonCode: string, causeClass: string | null): ExactTerminal {
  const outcome = computeTerminalOutcome({
    finalStatus: 'blocked',
    budgetExceeded: false,
    hasAnyWrites: false,
    blockedReport: {
      reason: 'diagnostic',
      missing: 'diagnostic',
      reason_code: reasonCode as never,
    },
  });
  const terminal = projectChatTerminal({ outcome });
  return { status: terminal.status, outcome, reason_code: reasonCode, cause_class: causeClass };
}

describe('R0-A: trusted-origin terminal reasons stay exact', () => {
  test('real permission denial (policy origin) is permission_denied/harness, blocked', () => {
    const reason = classifyPolicySource('explicit_deny');
    assert.ok(reason);
    const t = terminalForReason(reason.code, reason.cause_class);
    assert.equal(t.status, 'blocked');
    assert.equal(t.outcome, 'BLOCKED_POLICY');
    assert.equal(t.reason_code, 'permission_denied');
    assert.equal(t.cause_class, 'harness');
  });

  test('real unsupported operation is unsupported_operation/harness, blocked', () => {
    const reason = terminalReasonFromFailureText(
      'cannot execute unsupported tool request: mode not supported',
    );
    assert.ok(reason);
    const t = terminalForReason(reason.code, reason.cause_class);
    assert.equal(t.status, 'blocked');
    assert.equal(t.outcome, 'BLOCKED_POLICY');
    assert.equal(t.reason_code, 'unsupported_operation');
    assert.equal(t.cause_class, 'harness');
  });

  test('real external dependency (ENOSPC) is external_dependency/environment, blocked', () => {
    const reason = terminalReasonFromFailureText('ENOSPC: no space left on device');
    assert.ok(reason);
    const t = terminalForReason(reason.code, reason.cause_class);
    assert.equal(t.status, 'blocked');
    assert.equal(t.outcome, 'BLOCKED_EXTERNAL');
    assert.equal(t.reason_code, 'external_dependency');
    assert.equal(t.cause_class, 'environment');
  });

  test('real provider failure is provider_failure/provider, failed', () => {
    const reason = terminalReasonFromFailureText('ECONNRESET: socket hang up');
    assert.ok(reason);
    const t = terminalForReason(reason.code, reason.cause_class);
    assert.equal(t.status, 'failed');
    assert.equal(t.outcome, 'INFRA_FAILURE');
    assert.equal(t.reason_code, 'provider_failure');
    assert.equal(t.cause_class, 'provider');
  });

  test('real verifier failure is verification_failed/verification, failed', () => {
    const reason = terminalReasonFromVerifierFailure({
      hasMutation: true,
      outcome: 'UNVERIFIED_PATCH',
      receipt: { exit_code: 1, command: 'npm test' },
    });
    assert.ok(reason);
    const t = terminalForReason(reason.code, reason.cause_class);
    assert.equal(t.status, 'failed');
    assert.equal(t.outcome, 'AGENT_FAILURE');
    assert.equal(t.reason_code, 'verification_failed');
    assert.equal(t.cause_class, 'verification');
  });

  test('unknown harness/model inability stays unknown/null and needs a human', () => {
    const reason = terminalReasonFromOutcome('BLOCKED_POLICY');
    assert.ok(reason);
    const t = terminalForReason(reason.code, reason.cause_class);
    assert.equal(t.status, 'blocked');
    assert.equal(t.outcome, 'NEEDS_HUMAN_DECISION');
    assert.equal(t.reason_code, 'unknown');
    assert.equal(t.cause_class, null);
  });
});
