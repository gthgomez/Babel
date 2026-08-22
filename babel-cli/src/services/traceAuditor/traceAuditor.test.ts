/**
 * traceAuditor/traceAuditor.test.ts — contract + detector tests for the
 * offline harness trace auditor (heuristic v1). Synthetic fixtures only.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join as joinPath } from 'node:path';
import test from 'node:test';

import { parseAuditFinding, type AuditFinding } from '../harnessAudit/findings.js';
import {
  runTraceAudit,
  TRACE_AUDIT_SIGNATURES,
  TraceAuditReportSchema,
} from './traceAuditor.js';
import * as fixtures from './fixtures.js';
import type { FixtureFiles } from './fixtures.js';

const FIXED_NOW = '2026-08-21T00:00:00.000Z';

function writeFixture(files: FixtureFiles): string {
  const dir = mkdtempSync(joinPath(tmpdir(), 'babel-trace-auditor-'));
  for (const [relPath, content] of Object.entries(files)) {
    const full = joinPath(dir, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  return dir;
}

type OkResult = Extract<ReturnType<typeof runTraceAudit>, { ok: true }>;

function audit(dir: string): { ok: true; findings: AuditFinding[] } | { ok: false; reason: string } {
  const result = runTraceAudit({
    runDir: dir,
    task_id: 'task-fix',
    arm: 'babel_enforce',
    model: 'model-fix',
    attempt_id: null,
    campaign_id: null,
    now: FIXED_NOW,
  });
  if (result.ok) return { ok: true, findings: result.findings };
  return { ok: false, reason: result.reason };
}

function findBySignature(findings: AuditFinding[], signature: string): AuditFinding[] {
  return findings.filter((f) => f.finding_id.startsWith(`TA-${signature}-`));
}

function assertContractValid(finding: unknown): void {
  const parsed = parseAuditFinding(finding);
  assert.equal(parsed.ok, true, `finding must parse: ${JSON.stringify(parsed.ok === false ? parsed.errors : {})}`);
  if (parsed.ok) {
    const sum = parsed.finding.hypotheses.reduce((acc, h) => acc + h.weight, 0);
    assert.ok(Math.abs(sum - 1) <= 0.005, `weights must sum to 1; got ${sum}`);
    assert.ok(parsed.finding.hypotheses.length >= 2);
  }
}

test('VERIFICATION_BLOCKED fires on post-mutation policy denial of a test command', () => {
  const dir = writeFixture(fixtures.verificationBlockedFiles());
  try {
    const result = audit(dir);
    assert.equal(result.ok, true, result.ok ? '' : result.reason ?? '');
    if (!result.ok) return;
    const findings = findBySignature(result.findings, 'VERIFICATION_BLOCKED');
    assert.equal(findings.length, 1);
    const finding = findings[0]!;
    assertContractValid(finding);
    assert.equal(finding.stage, 'verification');
    const labels = finding.hypotheses.map((h) => h.label).sort();
    assert.deepEqual(labels, ['MODEL', 'POLICY', 'TASK']);
    const policy = finding.hypotheses.find((h) => h.label === 'POLICY');
    assert.equal(policy?.weight, 0.6);
    // Evidence refs cite real ids from fixture lines.
    const refIds = finding.evidence_refs.map((r) => r.id);
    assert.ok(refIds.includes('policy:L1'), `expected policy:L1 in ${JSON.stringify(refIds)}`);
    assert.ok(refIds.some((id) => id.startsWith('se-')), 'mutation session event id expected');
    assert.ok(refIds.every((r) => r.length > 0));
    assert.equal(finding.succeeded_despite_harness, false);
    assert.equal(finding.near_miss, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('UNVERIFIED_COMPLETION fires with near_miss on failing verifier', () => {
  const dir = writeFixture(fixtures.unverifiedCompletionFiles());
  try {
    const result = audit(dir);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const findings = findBySignature(result.findings, 'UNVERIFIED_COMPLETION');
    assert.equal(findings.length, 1);
    const finding = findings[0]!;
    assertContractValid(finding);
    assert.equal(finding.stage, 'completion');
    assert.equal(finding.near_miss, true);
    const labels = finding.hypotheses.map((h) => h.label);
    assert.ok(labels.includes('MODEL'));
    // Session refs must be REAL fixture ids: decision (se-03) + failing verifier (se-02).
    const sessionRefIds = finding.evidence_refs
      .filter((r) => r.source === 'session_event')
      .map((r) => r.id);
    assert.deepEqual(sessionRefIds.sort(), ['se-02', 'se-03']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SUCCEEDED_DESPITE_HARNESS fires when passing outcome follows friction', () => {
  const dir = writeFixture(fixtures.succeededDespiteHarnessFiles());
  try {
    const result = audit(dir);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const findings = findBySignature(result.findings, 'SUCCEEDED_DESPITE_HARNESS');
    assert.equal(findings.length, 1);
    const finding = findings[0]!;
    assertContractValid(finding);
    assert.equal(finding.stage, 'completion');
    assert.equal(finding.succeeded_despite_harness, true);
    assert.ok(finding.claim.includes("passing outcome 'VERIFIED_COMPLETE'"));
    assert.ok(finding.evidence_refs.some((r) => r.id === 'policy:L1'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('RETRY_STORM concludes probably-not-Babel with MODEL dominant', () => {
  const dir = writeFixture(fixtures.retryStormModelDominatedFiles());
  try {
    const result = audit(dir);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const findings = findBySignature(result.findings, 'RETRY_STORM');
    assert.equal(findings.length, 1);
    const finding = findings[0]!;
    assertContractValid(finding);
    assert.equal(finding.stage, 'orchestration');
    const top = [...finding.hypotheses].sort((a, b) => b.weight - a.weight)[0]!;
    assert.equal(top.label, 'MODEL', `top hypothesis should be MODEL; got ${top.label}`);
    assert.equal(top.weight, 0.5);
    assert.ok(finding.claim.includes('stream_idle=4'));
    // Evidence refs are real durable event ids from the fixture stream.
    const refIds = finding.evidence_refs.map((r) => r.id);
    assert.ok(refIds.includes('se-01') && refIds.includes('se-07'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CONTEXT_PRESSURE fires on repeated re-read after compaction (nested session dir)', () => {
  const dir = writeFixture(fixtures.contextPressureFiles());
  try {
    const result = audit(dir);
    assert.equal(result.ok, true, 'nested chat-session layout must be discovered');
    if (!result.ok) return;
    const findings = findBySignature(result.findings, 'CONTEXT_PRESSURE');
    assert.equal(findings.length, 1);
    const finding = findings[0]!;
    assertContractValid(finding);
    assert.equal(finding.stage, 'context');
    const labels = finding.hypotheses.map((h) => h.label).sort();
    assert.deepEqual(labels, ['HARNESS_CONTEXT', 'MODEL', 'TASK']);
    assert.ok(finding.claim.includes('src/big-module.ts'));
    assert.ok(finding.claim.includes('3 times'));
    assert.ok(finding.evidence_refs.length >= 3); // compaction + 2+ reads
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TOOL_MALFORMAT fires at two schema/arg failures', () => {
  const dir = writeFixture(fixtures.toolMalformatFiles());
  try {
    const result = audit(dir);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const findings = findBySignature(result.findings, 'TOOL_MALFORMAT');
    assert.equal(findings.length, 1);
    const finding = findings[0]!;
    assertContractValid(finding);
    assert.equal(finding.stage, 'tool_use');
    const labels = finding.hypotheses.map((h) => h.label);
    assert.ok(labels.includes('HARNESS_TOOL'));
    assert.ok(labels.includes('MODEL'));
    const refIds = finding.evidence_refs.map((r) => r.id);
    assert.deepEqual(refIds.sort(), ['policy:L1', 'policy:L2']);
    assert.ok(finding.counterfactual.includes('edit_file'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fail-closed: one corrupt JSONL line aborts with count and line number', () => {
  const dir = writeFixture(fixtures.corruptStreamFiles());
  try {
    const result = audit(dir);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /malformed harness streams/);
    assert.match(result.reason, /1 unparseable line\(s\)/);
    assert.match(result.reason, /line 3/);
    assert.match(result.reason, /session-events\.jsonl/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cap enforcement: 10 distinct denials yield max 5 findings for the signature', () => {
  const dir = writeFixture(fixtures.tenVerificationDenialsFiles());
  try {
    const result = audit(dir);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const findings = findBySignature(result.findings, 'VERIFICATION_BLOCKED');
    assert.equal(findings.length, 5);
    for (const finding of findings) assertContractValid(finding);
    // Ranking: evidence count desc then id asc — lexicographic id order,
    // so policy:L10 precedes policy:L2.
    const firstIds = findings.map((f) => f.evidence_refs[0]?.id);
    assert.deepEqual(firstIds, ['policy:L1', 'policy:L10', 'policy:L2', 'policy:L3', 'policy:L4']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('empty directory without recognizable streams fails closed', () => {
  const dir = mkdtempSync(joinPath(tmpdir(), 'babel-trace-auditor-empty-'));
  try {
    const result = audit(dir);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /no recognizable harness streams/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('determinism: identical fixtures plus injected clock produce deep-equal output', () => {
  const files = fixtures.verificationBlockedFiles();
  const dirA = writeFixture(files);
  const dirB = writeFixture(files);
  try {
    const a = runTraceAudit({ runDir: dirA, task_id: 't', arm: 'a', model: null, now: FIXED_NOW });
    const b = runTraceAudit({ runDir: dirB, task_id: 't', arm: 'a', model: null, now: FIXED_NOW });
    assert.equal(a.ok && b.ok, true);
    if (!a.ok || !b.ok) return;
    // Normalize run_dir so only content matters.
    const norm = (r: Extract<typeof a, { ok: true }>) =>
      JSON.stringify({ findings: r.findings.map((f) => ({ ...f, episode_run_dir: null })), report: { ...r.report, run_dir: null } });
    assert.equal(norm(a), norm(b));
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test('report artifact validates against exported zod schema and counts match', () => {
  const dir = writeFixture(fixtures.toolMalformatFiles());
  try {
    const result = runTraceAudit({ runDir: dir, task_id: 't2', arm: 'babel_shadow', model: 'm', now: FIXED_NOW });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const reportParse = TraceAuditReportSchema.safeParse(result.report);
    assert.equal(reportParse.success, true);
    assert.equal(result.report.kind, 'babel_trace_audit_report');
    assert.equal(result.report.schema_version, 1);
    assert.deepEqual(result.report.signatures_run, [...TRACE_AUDIT_SIGNATURES]);
    assert.equal(result.report.findings_count, result.findings.length);
    assert.equal(result.report.generated_at, FIXED_NOW);
    for (const finding of result.findings) {
      assert.equal(finding.produced_at, FIXED_NOW);
      assert.match(finding.task_id, /^t\d*$/);
      assert.equal(finding.arm, 'babel_shadow');
      assert.equal(finding.worker_friction_agreement, 'no_worker_report');
      assert.equal(finding.schema_version, 1);
      assert.equal(finding.kind, 'babel_harness_audit_finding');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clean verified run produces zero findings (no false positives)', () => {
  const dir = writeFixture(fixtures.cleanRunFiles());
  try {
    const result = runTraceAudit({ runDir: dir, task_id: 't3', arm: 'babel_enforce', model: null, now: FIXED_NOW });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.findings.length, 0);
    assert.equal(result.report.findings_count, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
