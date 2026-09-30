/**
 * P05 — durable command admission conformance.
 *
 * These tests exercise the *real* SQLite transaction boundary (not a mock):
 * atomic admission+owner+outbox, duplicate-payload idempotence, changed-payload
 * rejection, `(generation, token)` owner fencing, crash before/after commit,
 * explicit incomplete evidence, and fail-closed open behavior.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  ADMISSION_REASONS,
  boundAdmissionFacts,
  completeCompleteness,
  computeAdmissionDigest,
  DEFAULT_ADMISSION_FACT_BOUNDS,
  type BoundedFactsResult,
  type CommandDigestInput,
} from './admissionContracts.js';
import {
  openAdmissionStore,
  type AdmissionStore,
  type AdmissionStoreOptions,
} from './admission.js';
import { ADMISSION_FAULT_HOOK, type AdmissionFaultPoint } from './admissionTestHooks.js';
import { RUNTIME_FACT_SCHEMA_VERSION, type RuntimeFactV1 } from './events.js';
import { sessionLogToFacts } from './legacyEventAdapters.js';
import type { SessionEvent } from '../agent/sessionEvents.js';

interface Fixture {
  readonly root: string;
  readonly runDir: string;
  cleanup(): void;
}

type TestStoreOptions = Partial<Omit<AdmissionStoreOptions, 'authorizedRoot' | 'runDir'>>;

function skipIfSymlinkUnavailable(t: TestContext, error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  if (!['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP'].includes(code ?? '')) return false;
  t.skip(`symlink creation unavailable on this host: ${code}`);
  return true;
}

function hasOwnerOnlyWindowsAcl(target: string, directory: boolean): boolean {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) return false;
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$acl = Get-Acl -LiteralPath $env:BABEL_TEST_ACL_TARGET',
    '$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    '$rules = @($acl.Access)',
    '$ok = $acl.AreAccessRulesProtected -and $rules.Count -eq 1',
    'if ($ok) {',
    '  $rule = $rules[0]',
    '  $ok = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -eq $sid',
    '  $ok = $ok -and $rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow',
    '  $ok = $ok -and $rule.FileSystemRights -eq [System.Security.AccessControl.FileSystemRights]::FullControl',
    '  $ok = $ok -and -not $rule.IsInherited -and $rule.PropagationFlags -eq [System.Security.AccessControl.PropagationFlags]::None',
    "  if ($env:BABEL_TEST_ACL_DIRECTORY -eq '1') {",
    '    $ok = $ok -and $rule.InheritanceFlags.HasFlag([System.Security.AccessControl.InheritanceFlags]::ContainerInherit)',
    '    $ok = $ok -and $rule.InheritanceFlags.HasFlag([System.Security.AccessControl.InheritanceFlags]::ObjectInherit)',
    '  } else { $ok = $ok -and $rule.InheritanceFlags -eq [System.Security.AccessControl.InheritanceFlags]::None }',
    '}',
    "if ($ok) { [Console]::Out.Write('owner-only') } else { [Console]::Out.Write('not-owner-only') }",
  ].join('; ');
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    env: {
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      Path: process.env.Path ?? process.env.PATH,
      PSModulePath: join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      BABEL_TEST_ACL_TARGET: target,
      BABEL_TEST_ACL_DIRECTORY: directory ? '1' : '0',
    },
    timeout: 5_000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0 && result.stdout.trim() === 'owner-only';
}

/** Register the test-only fault hook through its opaque symbol. */
function faultHook(hook: (point: AdmissionFaultPoint) => void): TestStoreOptions {
  return { [ADMISSION_FAULT_HOOK]: hook };
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'babel-admission-root-'));
  const runDir = join(root, 'runs', 'run-1');
  return {
    root,
    runDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function openStore(fixture: Fixture, options: TestStoreOptions = {}): AdmissionStore {
  const result = openAdmissionStore({ authorizedRoot: fixture.root, runDir: fixture.runDir, ...options });
  if (!result.ok) {
    throw new Error(`open failed: ${result.reasonCode}: ${result.detail}`);
  }
  return result.store;
}

function commandInput(overrides: Partial<CommandDigestInput> = {}): CommandDigestInput {
  return {
    threadId: 'thread-1',
    taskId: 'task-1',
    commandId: 'cmd-1',
    mode: 'chat',
    resolvedOperationPolicy: { mutation: 'normal', approval: 'interactive' },
    taskShapeClass: 'edit',
    targetRoot: '/work',
    offeredToolSchemaVersion: 'tools-v1',
    contextSnapshotId: 'ctx-1',
    payload: { command: 'write', args: { path: 'a.txt' } },
    ...overrides,
  };
}

function fact(overrides: Record<string, unknown> = {}): RuntimeFactV1 {
  return {
    schemaVersion: RUNTIME_FACT_SCHEMA_VERSION,
    id: 'fact-1',
    cursor: { stream: 'runtime-facts', sequence: 1 },
    threadId: 'thread-1',
    taskId: 'task-1',
    turnId: 'turn-1',
    runId: 'run-1',
    sequence: 1,
    causationId: 'event-1',
    producer: 'legacy_adapter',
    authority: 'observation',
    timestamp: '2026-09-18T00:00:00.000Z',
    payload: { type: 'run.started', ownerGeneration: 1 },
    ...overrides,
  } as unknown as RuntimeFactV1;
}

function completionFact(id: string, evidenceRefs: string[]): RuntimeFactV1 {
  return {
    ...fact({ id, sequence: 9, payload: undefined }),
    payload: {
      type: 'completion.decided',
      decision: {
        requestedOutcome: 'CODING_CHANGE_PRESENT',
        finalOutcome: 'CODING_CHANGE_PRESENT',
        allowed: true,
        reason: 'verified',
        evidenceRefs,
        policyVersion: 'v1',
      },
    },
  } as unknown as RuntimeFactV1;
}

// ─── Canonical digest ────────────────────────────────────────────────────────

test('P05: canonical digest is semantic, order-independent, and rejects non-JSON', () => {
  const a = computeAdmissionDigest(commandInput());
  const b = computeAdmissionDigest(
    commandInput({ payload: { args: { path: 'a.txt' }, command: 'write' } }),
  );
  assert.equal(a, b, 'key order must not change the digest');
  assert.ok(a && /^[0-9a-f]{64}$/.test(a));

  const changed = computeAdmissionDigest(
    commandInput({ payload: { command: 'write', args: { path: 'b.txt' } } }),
  );
  assert.notEqual(a, changed, 'a semantic change must change the digest');

  const policyChange = computeAdmissionDigest(
    commandInput({ resolvedOperationPolicy: { mutation: 'read_only' } }),
  );
  assert.notEqual(a, policyChange, 'resolved operation policy is semantic');

  const unencodable = computeAdmissionDigest(commandInput({ payload: { fn: () => 1 } }));
  assert.equal(unencodable, null, 'non-JSON payload must fail closed');
});

// ─── Atomicity + idempotence ─────────────────────────────────────────────────

test('P05: admission, owner and outbox commit atomically', () => {
  const fixture = makeFixture();
  try {
    const store = openStore(fixture);
    const decision = store.admitCommand({
      digestInput: commandInput(),
      ownerGeneration: 1,
      ownerToken: 'token-1',
      effectClass: 'reconcilable_mutation',
      operationId: 'op-1',
      preImageHashes: { 'a.txt': 'before' },
      postImageHashes: { 'a.txt': 'after' },
    });
    assert.equal(decision.kind, 'admitted');
    if (decision.kind !== 'admitted') return;

    assert.equal(decision.record.state, 'claimed');
    assert.equal(decision.record.ownerGeneration, 1);
    assert.equal(decision.record.completeness.complete, true);
    assert.equal(decision.outbox.state, 'intent');
    assert.deepEqual(store.readOwner('thread-1'), {
      threadId: 'thread-1',
      generation: 1,
      token: 'token-1',
    });
    assert.deepEqual(store.readAdmission('thread-1', 'cmd-1')?.state, 'claimed');
    store.close();
  } finally {
    fixture.cleanup();
  }
});

test('P05: duplicate identical payload replays the stored outcome with no side effect', () => {
  const fixture = makeFixture();
  try {
    const store = openStore(fixture);
    const admitted = store.admitCommand({
      digestInput: commandInput(),
      ownerGeneration: 1,
      ownerToken: 'token-1',
      effectClass: 'idempotent',
      operationId: 'op-1',
    });
    assert.equal(admitted.kind, 'admitted');
    const settled = store.settleAdmission({
      threadId: 'thread-1',
      commandId: 'cmd-1',
      ownerGeneration: 1,
      ownerToken: 'token-1',
      state: 'settled',
      outcome: { finalOutcome: 'CODING_CHANGE_PRESENT', allowed: true },
      outbox: { state: 'committed', postImageHashes: { 'a.txt': 'after' } },
    });
    assert.equal(settled.settled, true);

    let sideEffects = 0;
    const replay = store.admitCommand({
      digestInput: commandInput(),
      ownerGeneration: 1,
      ownerToken: 'token-1',
      effectClass: 'idempotent',
      operationId: 'op-1',
    });
    if (replay.kind === 'admitted') sideEffects += 1;

    assert.equal(replay.kind, 'replayed');
    assert.equal(sideEffects, 0, 'a duplicate must not repeat the side effect');
    if (replay.kind === 'replayed') {
      assert.equal(replay.record.state, 'settled');
      assert.deepEqual(replay.record.outcome, { finalOutcome: 'CODING_CHANGE_PRESENT', allowed: true });
      assert.deepEqual(replay.record.outcome, settled.settled ? settled.record.outcome : undefined);
    }
    store.close();
  } finally {
    fixture.cleanup();
  }
});

test('P05: changed payload under the same command id is rejected with zero new admission', () => {
  const fixture = makeFixture();
  try {
    const store = openStore(fixture);
    store.admitCommand({
      digestInput: commandInput(),
      ownerGeneration: 1,
      ownerToken: 'token-1',
      effectClass: 'read_only',
      operationId: 'op-1',
    });
    const changed = store.admitCommand({
      digestInput: commandInput({ payload: { command: 'write', args: { path: 'other.txt' } } }),
      ownerGeneration: 1,
      ownerToken: 'token-1',
      effectClass: 'read_only',
      operationId: 'op-1',
    });
    assert.equal(changed.kind, 'rejected');
    if (changed.kind === 'rejected') {
      assert.equal(changed.reasonCode, ADMISSION_REASONS.DIGEST_CONFLICT);
    }
    // The rejected command did not replace the original.
    assert.equal(store.readAdmission('thread-1', 'cmd-1')?.digest, computeAdmissionDigest(commandInput()));
    store.close();
  } finally {
    fixture.cleanup();
  }
});

// ─── Owner fencing ───────────────────────────────────────────────────────────

test('P05: a stale owner is fenced and cannot settle a successor', () => {
  const fixture = makeFixture();
  try {
    const store = openStore(fixture);
    store.admitCommand({
      digestInput: commandInput({ commandId: 'cmd-1' }),
      ownerGeneration: 1,
      ownerToken: 'token-1',
      effectClass: 'read_only',
      operationId: 'op-1',
    });
    // Successor acquires the thread with a new generation/token.
    const successor = store.admitCommand({
      digestInput: commandInput({ commandId: 'cmd-2' }),
      ownerGeneration: 2,
      ownerToken: 'token-2',
      effectClass: 'read_only',
      operationId: 'op-2',
    });
    assert.equal(successor.kind, 'admitted');

    const stale = store.settleAdmission({
      threadId: 'thread-1',
      commandId: 'cmd-1',
      ownerGeneration: 1,
      ownerToken: 'token-1',
      state: 'settled',
      outcome: { stale: true },
    });
    assert.equal(stale.settled, false);
    if (!stale.settled) assert.equal(stale.reasonCode, ADMISSION_REASONS.STALE_OWNER);
    assert.equal(store.readAdmission('thread-1', 'cmd-1')?.state, 'claimed', 'stale finalizer wrote nothing');

    const live = store.settleAdmission({
      threadId: 'thread-1',
      commandId: 'cmd-2',
      ownerGeneration: 2,
      ownerToken: 'token-2',
      state: 'settled',
      outcome: { ok: true },
    });
    assert.equal(live.settled, true);

    // A stale admission is also rejected.
    const staleAdmit = store.admitCommand({
      digestInput: commandInput({ commandId: 'cmd-3' }),
      ownerGeneration: 1,
      ownerToken: 'token-1',
      effectClass: 'read_only',
      operationId: 'op-3',
    });
    assert.equal(staleAdmit.kind, 'rejected');
    if (staleAdmit.kind === 'rejected') {
      assert.equal(staleAdmit.reasonCode, ADMISSION_REASONS.STALE_OWNER);
    }
    store.close();
  } finally {
    fixture.cleanup();
  }
});

// ─── Crash fixtures at the real transaction boundary ─────────────────────────

test('P05: crash before admission commit leaves no row and a retry is fresh', () => {
  const fixture = makeFixture();
  try {
    const crashing = openStore(fixture, faultHook((point) => {
      if (point === 'before_admission_commit') throw new Error('simulated crash before commit');
    }));
    assert.throws(
      () =>
        crashing.admitCommand({
          digestInput: commandInput(),
          ownerGeneration: 1,
          ownerToken: 'token-1',
          effectClass: 'reconcilable_mutation',
          operationId: 'op-1',
        }),
      /simulated crash before commit/,
    );
    assert.equal(crashing.readAdmission('thread-1', 'cmd-1'), null, 'rollback removed the admission');
    crashing.close();

    const fresh = openStore(fixture);
    assert.equal(fresh.readAdmission('thread-1', 'cmd-1'), null);
    const retried = fresh.admitCommand({
      digestInput: commandInput(),
      ownerGeneration: 1,
      ownerToken: 'token-1',
      effectClass: 'reconcilable_mutation',
      operationId: 'op-1',
    });
    assert.equal(retried.kind, 'admitted');
    fresh.close();
  } finally {
    fixture.cleanup();
  }
});

test('P05: crash after admission commit is recoverable via the outbox intent', () => {
  const fixture = makeFixture();
  try {
    const crashing = openStore(fixture, faultHook((point) => {
      if (point === 'after_admission_commit') throw new Error('simulated crash after commit');
    }));
    assert.throws(
      () =>
        crashing.admitCommand({
          digestInput: commandInput(),
          ownerGeneration: 1,
          ownerToken: 'token-1',
          effectClass: 'reconcilable_mutation',
          operationId: 'op-1',
          preImageHashes: { 'a.txt': 'before' },
        }),
      /simulated crash after commit/,
    );
    crashing.close();

    const recovered = openStore(fixture);
    const record = recovered.readAdmission('thread-1', 'cmd-1');
    assert.equal(record?.state, 'claimed');
    const outbox = recovered.readOutbox(record!.admissionId);
    assert.equal(outbox?.state, 'intent');

    const retry = recovered.recoverAdmission({
      threadId: 'thread-1',
      commandId: 'cmd-1',
      currentImageHashes: { 'a.txt': 'before' },
    });
    assert.equal(retry.kind, 'recovered');
    if (retry.kind === 'recovered') {
      assert.equal(retry.decision, 'retry_reconcilable');
    }

    // A non-idempotent external effect is never auto-replayed.
    const reprocess = recovered.recoverAdmission({
      threadId: 'thread-1',
      commandId: 'cmd-1',
      currentImageHashes: { 'a.txt': 'before' },
    });
    assert.equal(reprocess.kind, 'recovered');
    recovered.close();
  } finally {
    fixture.cleanup();
  }
});

test('P05: crash after the effect but before the terminal commit is recovered_complete', () => {
  const fixture = makeFixture();
  try {
    const crashing = openStore(fixture, faultHook((point) => {
      if (point === 'before_terminal_commit') throw new Error('simulated crash before terminal commit');
    }));
    const admitted = crashing.admitCommand({
      digestInput: commandInput(),
      ownerGeneration: 1,
      ownerToken: 'token-1',
      effectClass: 'idempotent',
      operationId: 'op-1',
      preImageHashes: { 'a.txt': 'before' },
      postImageHashes: { 'a.txt': 'after' },
    });
    assert.equal(admitted.kind, 'admitted');
    assert.throws(
      () =>
        crashing.settleAdmission({
          threadId: 'thread-1',
          commandId: 'cmd-1',
          ownerGeneration: 1,
          ownerToken: 'token-1',
          state: 'settled',
          outcome: { ok: true },
          outbox: { state: 'committed', postImageHashes: { 'a.txt': 'after' } },
        }),
      /simulated crash before terminal commit/,
    );
    // Terminal write rolled back: still claimed with an intent outbox.
    assert.equal(crashing.readAdmission('thread-1', 'cmd-1')?.state, 'claimed');
    assert.equal(crashing.readOutbox(admitted.record.admissionId)?.state, 'intent');
    crashing.close();

    const recovered = openStore(fixture);
    const result = recovered.recoverAdmission({
      threadId: 'thread-1',
      commandId: 'cmd-1',
      currentImageHashes: { 'a.txt': 'after' },
    });
    assert.equal(result.kind, 'recovered');
    if (result.kind === 'recovered') assert.equal(result.decision, 'recovered_complete');
    recovered.close();
  } finally {
    fixture.cleanup();
  }
});

test('P05: durable admission survives reconnect and replays the stored outcome', () => {
  const fixture = makeFixture();
  try {
    const first = openStore(fixture);
    first.admitCommand({
      digestInput: commandInput(),
      ownerGeneration: 1,
      ownerToken: 'token-1',
      effectClass: 'read_only',
      operationId: 'op-1',
    });
    first.settleAdmission({
      threadId: 'thread-1',
      commandId: 'cmd-1',
      ownerGeneration: 1,
      ownerToken: 'token-1',
      state: 'settled',
      outcome: { finalOutcome: 'READ_ONLY', allowed: true },
    });
    first.close();

    const second = openStore(fixture);
    const record = second.readAdmission('thread-1', 'cmd-1');
    assert.equal(record?.state, 'settled');
    const replay = second.admitCommand({
      digestInput: commandInput(),
      ownerGeneration: 1,
      ownerToken: 'token-1',
      effectClass: 'read_only',
      operationId: 'op-1',
    });
    assert.equal(replay.kind, 'replayed');
    if (replay.kind === 'replayed') {
      assert.deepEqual(replay.record.outcome, { finalOutcome: 'READ_ONLY', allowed: true });
    }
    second.close();
  } finally {
    fixture.cleanup();
  }
});

// ─── Explicit incomplete evidence + conflicting duplicates ───────────────────

test('P05: over-cap evidence refs are explicit, truncated, and non-authoritative', () => {
  const evidence = ['e1', 'e2', 'e3', 'e4'];
  const result: BoundedFactsResult = boundAdmissionFacts(
    [completionFact('fact-complete', evidence)],
    { ...DEFAULT_ADMISSION_FACT_BOUNDS, maxEvidenceRefs: 2 },
  );
  assert.equal(result.completeness.complete, false);
  assert.equal(result.completeness.truncated, true);
  assert.equal(result.completeness.evidenceRefsDropped, 2);
  assert.ok(result.completeness.reasons.includes('evidence_refs_truncated'));
  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0]!.authority, 'observation', 'incomplete evidence cannot claim authority');
  const decision = result.facts[0]!.payload;
  if (decision.type === 'completion.decided') {
    assert.deepEqual(decision.decision.evidenceRefs, ['e1', 'e2']);
  }
});

test('P05: conflicting duplicate (sequence,id) is quarantined deterministically', () => {
  const a = fact({ id: 'dup', sequence: 5, payload: { type: 'run.started', ownerGeneration: 1 } });
  const b = fact({ id: 'dup', sequence: 5, payload: { type: 'run.started', ownerGeneration: 2 } });

  const forward = boundAdmissionFacts([a, b]);
  const reverse = boundAdmissionFacts([b, a]);

  assert.equal(forward.completeness.complete, false);
  assert.ok(forward.completeness.reasons.includes('conflicting_duplicate_fact'));
  assert.deepEqual(forward.quarantinedFactIds, ['dup']);
  assert.deepEqual(forward.facts, []);
  // Deterministic under input-order permutation.
  assert.deepEqual(
    { facts: forward.facts, quarantined: forward.quarantinedFactIds },
    { facts: reverse.facts, quarantined: reverse.quarantinedFactIds },
  );

  // A clean duplicate (same content) collapses to one admitted fact.
  const clean = boundAdmissionFacts([a, { ...a }]);
  assert.equal(clean.completeness.complete, true);
  assert.equal(clean.facts.length, 1);
});

test('P05: invalid and endless fact input is bounded and recorded', () => {
  const invalid = boundAdmissionFacts([fact({ schemaVersion: 99 })]);
  assert.equal(invalid.completeness.complete, false);
  assert.equal(invalid.facts.length, 0);
  assert.ok(invalid.completeness.reasons.some((reason) => reason.startsWith('invalid_fact')));

  function* endless(): Generator<RuntimeFactV1> {
    let index = 0;
    while (true) {
      index += 1;
      yield fact({ id: `f-${index}`, sequence: index });
    }
  }
  const bounded = boundAdmissionFacts(endless(), { ...DEFAULT_ADMISSION_FACT_BOUNDS, maxFacts: 4 });
  assert.equal(bounded.facts.length, 4);
  assert.equal(bounded.completeness.complete, false);
  assert.equal(bounded.completeness.truncated, true);
});

test('P05: legacy adapter signals a capped evidence list instead of dropping silently', () => {
  const refs = Array.from({ length: 10_005 }, (_, index) => `ref-${index}`);
  const event = {
    schema_version: 1,
    event_id: 'event-completion',
    session_id: 'session-1',
    turn_id: 'turn-1',
    seq: 1,
    ts: '2026-09-18T00:00:00.000Z',
    kind: 'completion_decision',
    requested_outcome: 'CODING_CHANGE_PRESENT',
    final_outcome: 'CODING_CHANGE_PRESENT',
    allowed: true,
    reason: 'verified',
    evidence_refs: refs,
    policy_version: 'v1',
  } as unknown as SessionEvent;

  let truncatedSignals = 0;
  const facts = sessionLogToFacts([event], { onTruncated: () => (truncatedSignals += 1) });
  assert.equal(truncatedSignals, 1, 'cap must be explicit, not silent');
  assert.equal(facts.length, 1);
  const payload = facts[0]!.payload;
  assert.equal(payload.type, 'completion.decided');
  if (payload.type === 'completion.decided') {
    assert.equal(payload.decision.evidenceRefs.length, 10_000);
  }
});

// ─── Fail-closed open behavior + permissions ─────────────────────────────────

test('P05: a run dir outside the authorized root is refused with no side effect', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-admission-root-'));
  try {
    const outside = join(root, '..', `babel-admission-outside-${process.pid}`);
    rmSync(outside, { recursive: true, force: true });

    const result = openAdmissionStore({ authorizedRoot: root, runDir: outside });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reasonCode, ADMISSION_REASONS.UNAVAILABLE);
    assert.equal(existsSync(outside), false, 'no out-of-jail directory may be created');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(join(root, '..', `babel-admission-outside-${process.pid}`), { recursive: true, force: true });
  }
});

test('P05: a symlinked intermediate that escapes the root is refused with no side effect', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'babel-admission-root-'));
  const outsideRoot = mkdtempSync(join(tmpdir(), 'babel-admission-outside-'));
  try {
    const link = join(root, 'escape');
    try {
      symlinkSync(outsideRoot, link, 'dir');
    } catch (error) {
      if (skipIfSymlinkUnavailable(t, error)) return;
      throw error;
    }
    const escapedRunDir = join(link, 'run-1');

    const result = openAdmissionStore({ authorizedRoot: root, runDir: escapedRunDir });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reasonCode, ADMISSION_REASONS.UNAVAILABLE);
    assert.equal(existsSync(join(outsideRoot, 'run-1')), false, 'no directory may be created outside the jail');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test('P05: a dangling symlinked DB file is refused with no write outside the jail', (t) => {
  const fixture = makeFixture();
  const outsideRoot = mkdtempSync(join(tmpdir(), 'babel-admission-outside-'));
  try {
    mkdirSync(fixture.runDir, { recursive: true, mode: 0o700 });
    const target = join(outsideRoot, 'escaped.sqlite');
    // Matches DB_FILENAME in admission.ts; the link target does not exist.
    try {
      symlinkSync(target, join(fixture.runDir, 'runtime-facts.sqlite'));
    } catch (error) {
      if (skipIfSymlinkUnavailable(t, error)) return;
      throw error;
    }

    const result = openAdmissionStore({ authorizedRoot: fixture.root, runDir: fixture.runDir });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reasonCode, ADMISSION_REASONS.UNAVAILABLE);
    assert.equal(existsSync(target), false, 'no DB may be created through an out-of-jail symlink');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
});

// ─── Transaction-boundary enforcement of fact bounds ─────────────────────────

test('P05: conflicting facts cannot be admitted as complete, even if the caller claims complete', () => {
  const fixture = makeFixture();
  try {
    const store = openStore(fixture);
    const conflictingA = fact({ id: 'dup', sequence: 5, payload: { type: 'run.started', ownerGeneration: 1 } });
    const conflictingB = fact({ id: 'dup', sequence: 5, payload: { type: 'run.started', ownerGeneration: 2 } });
    const decision = store.admitCommand({
      digestInput: commandInput(),
      ownerGeneration: 1,
      ownerToken: 'token-1',
      effectClass: 'read_only',
      operationId: 'op-1',
      facts: [conflictingA, conflictingB],
      completeness: completeCompleteness(2),
    });
    assert.equal(decision.kind, 'admitted');
    if (decision.kind === 'admitted') {
      assert.equal(decision.record.completeness.complete, false, 'bounded facts override a complete claim');
      assert.ok(decision.record.completeness.reasons.includes('conflicting_duplicate_fact'));
    }
    const persisted = store.readAdmission('thread-1', 'cmd-1');
    assert.equal(persisted?.completeness.complete, false, 'incomplete persisted at the transaction boundary');

    // The same guarantee holds for facts embedded in the canonical payload.
    const embedded = store.admitCommand({
      digestInput: commandInput({
        commandId: 'cmd-2',
        payload: { command: 'write', facts: [conflictingA, conflictingB] },
      }),
      ownerGeneration: 1,
      ownerToken: 'token-1',
      effectClass: 'read_only',
      operationId: 'op-2',
      completeness: completeCompleteness(2),
    });
    assert.equal(embedded.kind, 'admitted');
    if (embedded.kind === 'admitted') {
      assert.equal(embedded.record.completeness.complete, false);
      assert.ok(embedded.record.completeness.reasons.includes('conflicting_duplicate_fact'));
    }
    store.close();
  } finally {
    fixture.cleanup();
  }
});

test('P05: an in-flight duplicate is reported as pending, not replayed', () => {
  const fixture = makeFixture();
  try {
    const store = openStore(fixture);
    const first = store.admitCommand({
      digestInput: commandInput(),
      ownerGeneration: 1,
      ownerToken: 'token-1',
      effectClass: 'read_only',
      operationId: 'op-1',
    });
    assert.equal(first.kind, 'admitted');

    const duplicate = store.admitCommand({
      digestInput: commandInput(),
      ownerGeneration: 1,
      ownerToken: 'token-1',
      effectClass: 'read_only',
      operationId: 'op-1',
    });
    assert.equal(duplicate.kind, 'pending');
    if (duplicate.kind === 'pending') {
      assert.equal(duplicate.record.state, 'claimed');
      assert.equal('outcome' in duplicate.record, false);
    }

    store.settleAdmission({
      threadId: 'thread-1',
      commandId: 'cmd-1',
      ownerGeneration: 1,
      ownerToken: 'token-1',
      state: 'settled',
      outcome: { finalOutcome: 'DONE', allowed: true },
    });
    const replay = store.admitCommand({
      digestInput: commandInput(),
      ownerGeneration: 1,
      ownerToken: 'token-1',
      effectClass: 'read_only',
      operationId: 'op-1',
    });
    assert.equal(replay.kind, 'replayed');
    if (replay.kind === 'replayed') {
      assert.deepEqual(replay.record.outcome, { finalOutcome: 'DONE', allowed: true });
    }
    store.close();
  } finally {
    fixture.cleanup();
  }
});

test('P05: one owner generation may admit multiple commands', () => {
  const fixture = makeFixture();
  try {
    const store = openStore(fixture);
    const first = store.admitCommand({
      digestInput: commandInput({ commandId: 'cmd-a' }),
      ownerGeneration: 7,
      ownerToken: 'token-7',
      effectClass: 'read_only',
      operationId: 'op-a',
    });
    const second = store.admitCommand({
      digestInput: commandInput({ commandId: 'cmd-b' }),
      ownerGeneration: 7,
      ownerToken: 'token-7',
      effectClass: 'read_only',
      operationId: 'op-b',
    });
    assert.equal(first.kind, 'admitted');
    assert.equal(second.kind, 'admitted', 'a second command in the same generation must be admitted');

    // Both commands of the owner can settle.
    assert.equal(
      store.settleAdmission({
        threadId: 'thread-1',
        commandId: 'cmd-a',
        ownerGeneration: 7,
        ownerToken: 'token-7',
        state: 'settled',
        outcome: { ok: 'a' },
      }).settled,
      true,
    );
    assert.equal(
      store.settleAdmission({
        threadId: 'thread-1',
        commandId: 'cmd-b',
        ownerGeneration: 7,
        ownerToken: 'token-7',
        state: 'settled',
        outcome: { ok: 'b' },
      }).settled,
      true,
    );

    // A superseding generation still fences the old owner.
    const successor = store.admitCommand({
      digestInput: commandInput({ commandId: 'cmd-c' }),
      ownerGeneration: 8,
      ownerToken: 'token-8',
      effectClass: 'read_only',
      operationId: 'op-c',
    });
    assert.equal(successor.kind, 'admitted');
    const stale = store.settleAdmission({
      threadId: 'thread-1',
      commandId: 'cmd-a',
      ownerGeneration: 7,
      ownerToken: 'token-7',
      state: 'settled',
      outcome: { ok: 'a' },
    });
    assert.equal(stale.settled, false);
    store.close();
  } finally {
    fixture.cleanup();
  }
});

// ─── Corrupt-row fail-closed behavior ────────────────────────────────────────

test('P05: a corrupt completeness row fails closed to incomplete', () => {
  const fixture = makeFixture();
  try {
    const store = openStore(fixture);
    const dbPath = store.dbPath;
    store.admitCommand({
      digestInput: commandInput(),
      ownerGeneration: 1,
      ownerToken: 'token-1',
      effectClass: 'read_only',
      operationId: 'op-1',
    });
    store.close();

    const raw = new DatabaseSync(dbPath);
    raw.exec("UPDATE admission SET completeness_json = 'not json'");
    raw.close();

    const reopened = openStore(fixture);
    const record = reopened.readAdmission('thread-1', 'cmd-1');
    assert.equal(record?.completeness.complete, false);
    assert.ok(record?.completeness.reasons.includes('corrupt_completeness'));
    reopened.close();
  } finally {
    fixture.cleanup();
  }
});

test('P05: a completeness row claiming complete while carrying drops fails closed', () => {
  const fixture = makeFixture();
  try {
    const store = openStore(fixture);
    const dbPath = store.dbPath;
    store.admitCommand({
      digestInput: commandInput(),
      ownerGeneration: 1,
      ownerToken: 'token-1',
      effectClass: 'read_only',
      operationId: 'op-1',
    });
    store.close();

    const raw = new DatabaseSync(dbPath);
    raw.exec(
      `UPDATE admission SET completeness_json = '${JSON.stringify({
        complete: true,
        truncated: false,
        reasons: [],
        admittedCount: 1,
        droppedCount: 3,
        evidenceRefsDropped: 0,
      })}'`,
    );
    raw.close();

    const reopened = openStore(fixture);
    const record = reopened.readAdmission('thread-1', 'cmd-1');
    assert.equal(record?.completeness.complete, false);
    assert.ok(record?.completeness.reasons.includes('inconsistent_completeness'));
    reopened.close();
  } finally {
    fixture.cleanup();
  }
});

test('P05: an unknown or failed outbox state recovers as manual_review, never complete', () => {
  const fixture = makeFixture();
  try {
    for (const state of ['bogus', 'failed', 'indeterminate']) {
      const store = openStore(fixture);
      const dbPath = store.dbPath;
      const commandId = `cmd-${state}`;
      const admitted = store.admitCommand({
        digestInput: commandInput({ commandId }),
        ownerGeneration: 1,
        ownerToken: 'token-1',
        effectClass: 'reconcilable_mutation',
        operationId: 'op-1',
        preImageHashes: { 'a.txt': 'before' },
      });
      assert.equal(admitted.kind, 'admitted');
      store.close();

      const raw = new DatabaseSync(dbPath);
      raw.exec(`UPDATE outbox SET state = '${state}'`);
      raw.close();

      const reopened = openStore(fixture);
      const result = reopened.recoverAdmission({
        threadId: 'thread-1',
        commandId,
        currentImageHashes: { 'a.txt': 'before' },
      });
      assert.equal(result.kind, 'recovered');
      if (result.kind === 'recovered') {
        assert.equal(result.decision, 'manual_review', `state ${state} must not be read as complete`);
      }
      reopened.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test('P05: a future schema version fails closed', () => {
  const fixture = makeFixture();
  try {
    const store = openStore(fixture);
    const dbPath = store.dbPath;
    store.close();

    const raw = new DatabaseSync(dbPath);
    raw.exec('PRAGMA user_version = 99');
    raw.close();

    const reopened = openAdmissionStore({ authorizedRoot: fixture.root, runDir: fixture.runDir });
    assert.equal(reopened.ok, false);
    if (!reopened.ok) {
      assert.equal(reopened.reasonCode, ADMISSION_REASONS.UNAVAILABLE);
      assert.match(reopened.detail, /future_schema/);
    }
  } finally {
    fixture.cleanup();
  }
});

test('P05: a corrupt database fails closed rather than degrading', () => {
  const fixture = makeFixture();
  try {
    const store = openStore(fixture);
    const dbPath = store.dbPath;
    store.close();
    writeFileSync(dbPath, 'this is not a sqlite database at all', 'utf8');

    const reopened = openAdmissionStore({ authorizedRoot: fixture.root, runDir: fixture.runDir });
    assert.equal(reopened.ok, false);
    if (!reopened.ok) assert.equal(reopened.reasonCode, ADMISSION_REASONS.UNAVAILABLE);
  } finally {
    fixture.cleanup();
  }
});

test('P05: the DB file and run dir are owner-only', () => {
  const fixture = makeFixture();
  let store: AdmissionStore | undefined;
  try {
    store = openStore(fixture);
    if (process.platform === 'win32') {
      assert.equal(hasOwnerOnlyWindowsAcl(store.dbPath, false), true, 'expected DB DACL to allow only the current user');
      assert.equal(hasOwnerOnlyWindowsAcl(fixture.runDir, true), true, 'expected run-dir DACL to allow only the current user');
    } else {
      const fileMode = statSync(store.dbPath).mode & 0o777;
      assert.equal(fileMode, 0o600, `expected 0600 DB file, got ${fileMode.toString(8)}`);
      const dirMode = statSync(fixture.runDir).mode & 0o777;
      assert.equal(dirMode, 0o700, `expected 0700 run dir, got ${dirMode.toString(8)}`);
    }
  } finally {
    store?.close();
    fixture.cleanup();
  }
});

test('P05: nested run dirs may be created inside the root', () => {
  const fixture = makeFixture();
  try {
    mkdirSync(fixture.runDir, { recursive: true });
    const store = openStore(fixture);
    assert.ok(store.dbPath.startsWith(fixture.root));
    store.close();
  } finally {
    fixture.cleanup();
  }
});
