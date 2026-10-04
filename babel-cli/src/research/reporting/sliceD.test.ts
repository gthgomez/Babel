import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { FakeResearchProvider, type FakeRepository } from '../fakeProvider.js';
import { createResearchMission } from '../missionPlanner.js';
import { runHuntDiscovery } from '../hunt.js';
import { analyzeApplicability, createLocalScanBudget, isApplicabilityStale, scanTargetProject } from '../analysis/applicability.js';
import { buildExperimentProposal, NotFalsifiableError } from './experiments.js';
import { reviewPatternCard } from './review.js';
import { loadRunArtifacts } from './report.js';
import { openReaderSession } from '../analysis/repoReader.js';

const COMMIT = 'a'.repeat(40);
const FIXED_NOW = new Date('2026-10-03T12:00:00.000Z');

function repo(): FakeRepository {
  return {
    providerRepoId: '1001',
    fullName: 'acme/durable-runner',
    defaultBranch: 'main',
    commitSha: COMMIT,
    description: 'Durable agent workflow runner with crash recovery and journal checkpoints',
    language: 'TypeScript',
    topics: ['durable-execution'],
    archived: false,
    stars: 120,
    forks: 9,
    pushedAt: '2026-09-01T00:00:00Z',
    licenseSpdxId: 'MIT',
    isFork: false,
    files: {
      'README.md': 'durable execution with journal replay after crash',
      'LICENSE': 'MIT License\n\nCopyright (c) 2026',
      'src/journal.ts': 'export class TaskJournal {\n  append(entry: string): void {}\n}\n',
    },
  };
}

function gitInit(dir: string, extraFiles: Record<string, string> = {}): string {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  writeFileSync(join(dir, 'worker.ts'), 'export class Worker {\n  async run(): Promise<void> {}\n}\n');
  for (const [path, content] of Object.entries(extraFiles)) writeFileSync(join(dir, path), content);
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

async function huntWithCard(root: string) {
  const mission = createResearchMission({
    problem: 'How can we make long-running agent work crash-resilient?',
    projectRoot: root,
    budgetPreset: 'low',
    now: FIXED_NOW,
    missionId: 'mission_slice_d',
  });
  const provider = new FakeResearchProvider({ repositories: [repo()] });
  const hunt = await runHuntDiscovery(mission, provider, { runsRoot: root, now: FIXED_NOW });
  return { mission, hunt };
}

test('applicability is grounded in local evidence and bound to target HEAD', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-sd-'));
  const head = gitInit(root);
  const { mission, hunt } = await huntWithCard(root);

  const card = hunt.deep!.patterns[0]!;
  assert.equal(card.evidence_state, 'SOURCE_CONFIRMED');
  const finding = analyzeApplicability(mission, card, { now: FIXED_NOW });

  assert.equal(finding.head_sha, head);
  // worker.ts contains no journal/resume content; gaps name what is missing.
  assert.ok(finding.attach_points.length === 0 || finding.attach_points.every((a: { path: string }) => a.path.length > 0));
  assert.ok(finding.smallest_experiment.length > 20);
  assert.ok(finding.gaps.length > 0, 'a plain worker.ts project lacks journal/replay mechanisms');

  assert.equal(isApplicabilityStale(finding, head), false);
  assert.equal(isApplicabilityStale(finding, 'b'.repeat(40)), true);
  assert.equal(isApplicabilityStale({ ...finding, head_sha: null }, null), true);
});

test('experiment proposals are falsifiable and bound to target HEAD', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-sd-'));
  gitInit(root);
  const { mission, hunt } = await huntWithCard(root);
  const card = hunt.deep!.patterns[0]!;
  const finding = analyzeApplicability(mission, card, { now: FIXED_NOW });

  const proposal = buildExperimentProposal({ mission, card, finding, now: FIXED_NOW });
  assert.equal(proposal.target_head_sha, finding.head_sha);
  assert.ok(proposal.metrics.length >= 1);
  assert.ok(proposal.hypothesis.length > 20);
  assert.ok(proposal.baseline.includes('HEAD'));

  assert.throws(
    () =>
      buildExperimentProposal({
        mission,
        card,
        finding,
        now: FIXED_NOW,
        overrides: { hypothesis: '', metrics: [] },
      }),
    NotFalsifiableError,
  );
});

test('research review re-checks artifacts and cannot grant merge authority', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-sd-'));
  gitInit(root);
  const { mission, hunt } = await huntWithCard(root);
  const card = hunt.deep!.patterns[0]!;
  const finding = analyzeApplicability(mission, card, { now: FIXED_NOW });
  const snapshot = hunt.deep!.snapshots[0]!;
  const refs = hunt.deep!.sessions[0]!.finished.evidenceRefs;

  const review = reviewPatternCard({
    mission,
    card,
    evidenceRefs: refs,
    validEvidenceIds: new Set(refs.map((r) => r.evidence_id)),
    snapshot: snapshot.manifest,
    finding,
    currentTargetHeadSha: finding.head_sha,
    now: FIXED_NOW,
  });
  assert.equal(review.verdict, 'ACCEPT_RESEARCH_FINDING');
  assert.equal(review.grants_merge_authority, false, 'research review never grants merge authority');
  assert.ok(review.checked.length >= 5);

  // A stale-target or fabricated-citation card cannot be accepted.
  const staleReview = reviewPatternCard({
    mission,
    card,
    evidenceRefs: refs,
    validEvidenceIds: new Set(refs.map((r) => r.evidence_id)),
    snapshot: snapshot.manifest,
    finding,
    currentTargetHeadSha: 'b'.repeat(40),
    now: FIXED_NOW,
  });
  assert.notEqual(staleReview.verdict, 'ACCEPT_RESEARCH_FINDING');

  const forgedReview = reviewPatternCard({
    mission,
    card: { ...card, evidence_refs: ['ev_nonexistent'] },
    evidenceRefs: refs,
    validEvidenceIds: new Set(refs.map((r) => r.evidence_id)),
    snapshot: snapshot.manifest,
    finding,
    currentTargetHeadSha: finding.head_sha,
    now: FIXED_NOW,
  });
  assert.equal(forgedReview.verdict, 'REJECT_RESEARCH_FINDING');
  assert.match(forgedReview.rationale, /concern/);
});

test('hunt persists report artifacts readable by loadRunArtifacts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-sd-'));
  gitInit(root, { 'recovery.ts': 'export const recovery = "journal crash resilience";\n' });
  const { hunt } = await huntWithCard(root);

  assert.ok(existsSync(`${hunt.paths.researchDir}/report/RESEARCH_REPORT.md`));
  assert.ok(existsSync(`${hunt.paths.researchDir}/report/candidate-experiments.json`));
  assert.ok(existsSync(`${hunt.paths.researchDir}/patterns/review.jsonl`));
  assert.ok(existsSync(`${hunt.paths.researchDir}/patterns/applicability.jsonl`));

  const artifacts = loadRunArtifacts(hunt.paths);
  assert.equal(artifacts.mission.mission_id, 'mission_slice_d');
  assert.ok(artifacts.patterns.length >= 1);
  assert.equal(artifacts.reviews[0]!.grants_merge_authority, false);
  assert.equal(artifacts.proposals.length, artifacts.reviews.length);
  assert.ok(artifacts.applicability.length > 0);
  const savedFinding = artifacts.applicability[0]!;
  const savedCard = artifacts.patterns.find((item) => item.pattern_id === savedFinding.pattern_id)!;
  assert.equal(savedCard.applicability.target_head_sha, savedFinding.finding.head_sha);
  const localRef = [...savedFinding.finding.attach_points, ...savedFinding.finding.existing_mechanisms]
    .find((ref) => ref.path === 'recovery.ts');
  assert.ok(localRef, `the real local source line should be persisted as applicability evidence; finding=${JSON.stringify(savedFinding.finding)}`);
  assert.equal(
    localRef.content_hash,
    createHash('sha256').update('export const recovery = "journal crash resilience";').digest('hex'),
  );
  assert.ok(savedCard.applicability.local_evidence_refs.includes(localRef.local_ref_id));

  const markdown = readFileSync(`${hunt.paths.researchDir}/report/RESEARCH_REPORT.md`, 'utf8');
  assert.match(markdown, /# Research Report — mission_slice_d/);
  assert.match(markdown, /## Governance boundary/);
  assert.match(markdown, /SOURCE_CONFIRMED/);
  assert.match(markdown, /ACCEPT_RESEARCH_FINDING|NEEDS_MORE_EVIDENCE|REJECT_RESEARCH_FINDING/);
  assert.match(markdown, new RegExp(localRef.content_hash));

  const metrics = JSON.parse(readFileSync(hunt.paths.metricsJson, 'utf8'));
  assert.equal(typeof metrics.reviews_accepted, 'number');
  assert.equal(metrics.status, 'COMPLETE');
  assert.equal(metrics.candidate_count_after_dedup, hunt.metrics.candidate_count_after_dedup);
  assert.ok(metrics.discovery.queries_executed > 0);
});

test('artifact loader rejects malformed V1 artifacts and JSONL records', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-sd-invalid-'));
  gitInit(root, { 'recovery.ts': 'journal crash resilience\n' });
  const { hunt } = await huntWithCard(root);
  const missionText = readFileSync(hunt.paths.missionJson, 'utf8');
  writeFileSync(hunt.paths.missionJson, '{}');
  assert.throws(() => loadRunArtifacts(hunt.paths));
  writeFileSync(hunt.paths.missionJson, missionText);
  const evidenceText = readFileSync(hunt.paths.evidenceJsonl, 'utf8');
  writeFileSync(hunt.paths.evidenceJsonl, '{}\n');
  assert.throws(() => loadRunArtifacts(hunt.paths));
  writeFileSync(hunt.paths.evidenceJsonl, evidenceText);
  const applicabilityPath = `${hunt.paths.researchDir}/patterns/applicability.jsonl`;
  const applicabilityText = readFileSync(applicabilityPath, 'utf8');
  unlinkSync(applicabilityPath);
  assert.throws(() => loadRunArtifacts(hunt.paths), /Applicability artifact is missing/);
  writeFileSync(applicabilityPath, '');
  assert.throws(() => loadRunArtifacts(hunt.paths), /Applicability record is missing/);
  writeFileSync(applicabilityPath, applicabilityText);
  writeFileSync(applicabilityPath, '{}\n');
  assert.throws(() => loadRunArtifacts(hunt.paths));
  writeFileSync(applicabilityPath, applicabilityText);
  const record = JSON.parse(applicabilityText.split('\n')[0]!);
  const ref = [...record.finding.attach_points, ...record.finding.existing_mechanisms][0];
  assert.ok(ref, 'fixture must persist a real local source ref');
  ref.content_hash = 'f'.repeat(64);
  writeFileSync(applicabilityPath, `${JSON.stringify(record)}\n`);
  assert.throws(() => loadRunArtifacts(hunt.paths), /content hash mismatch/);
  writeFileSync(applicabilityPath, applicabilityText);
  const proposalsPath = `${hunt.paths.researchDir}/report/candidate-experiments.json`;
  writeFileSync(proposalsPath, '{"mission_id":"m","proposals":[{}]}');
  assert.throws(() => loadRunArtifacts(hunt.paths));
});

test('applicability scan is sorted and shares a finite file and byte budget', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-app-budget-'));
  writeFileSync(join(root, 'z.ts'), 'hit z');
  writeFileSync(join(root, 'a.ts'), 'hit a');
  writeFileSync(join(root, 'm.ts'), 'hit m');
  const budget = createLocalScanBudget();
  budget.maxFiles = 2;
  const found = scanTargetProject(root, ['hit'], 40, budget);
  assert.deepEqual(found.map((entry) => entry.path.split(/[\\/]/).pop()), ['a.ts', 'm.ts']);
  assert.equal(budget.filesScanned, 2);
  assert.equal(budget.exhausted, true);
  assert.equal(budget.occurrencesTruncated, false);

  const cappedBudget = createLocalScanBudget();
  const capped = scanTargetProject(root, ['hit'], 1, cappedBudget);
  assert.equal(capped.length, 1);
  assert.equal(cappedBudget.occurrencesTruncated, true);
});

test('hunt reports occurrence-capped applicability as incomplete and partial', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-app-occurrence-cap-'));
  const repeatedEvidence = `${Array.from({ length: 41 }, () => 'journal crash resilience').join('\n')}\n`;
  gitInit(root, { 'recovery.ts': repeatedEvidence });
  const { hunt } = await huntWithCard(root);

  assert.equal(hunt.status, 'INCOMPLETE', `unexpected completion; reason=${hunt.reason}; finding=${JSON.stringify(hunt.findings[0]?.finding)}`);
  assert.match(hunt.reason ?? '', /truncated occurrence evidence/);
  assert.equal(hunt.findings[0]!.finding.occurrences_truncated, true);
  assert.ok(hunt.reviews[0]!.concerns.some((concern) => concern.includes('scan limit')));
  const metrics = JSON.parse(readFileSync(hunt.paths.metricsJson, 'utf8'));
  assert.equal(metrics.status, 'INCOMPLETE');
  assert.equal(metrics.local_scan_budget.occurrencesTruncated, true);
});

test('applicability scanner does not follow a symlink outside the target tree', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'babel-app-symlink-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'babel-app-symlink-outside-'));
  try {
    const outsideFile = join(outside, 'external.ts');
    writeFileSync(outsideFile, 'outside_only_marker');
    try {
      symlinkSync(outsideFile, join(root, 'linked.ts'), 'file');
    } catch {
      t.skip('the current Windows profile cannot create a test symlink');
      return;
    }
    assert.deepEqual(scanTargetProject(root, ['outside_only_marker']), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('evidence refs issued by the reader session validate for review input', async () => {
  const provider = new FakeResearchProvider({ repositories: [repo()] });
  const page = await provider.searchRepositories('durable');
  const identity = page.repositories[0]!.identity;
  const { buildRepositorySnapshot } = await import('../acquisition/snapshot.js');
  const snapshot = await buildRepositorySnapshot(provider, identity, {
    missionId: 'm',
    now: FIXED_NOW,
    byteBudget: 100_000,
    maxFiles: 10,
    interestTerms: ['journal'],
  });
  const session = openReaderSession(identity, snapshot);
  const read = session.repo_read('src/journal.ts');
  assert.ok(read);
  const finished = session.finish({
    schema_version: 1,
    problem_match: '',
    observations: [{ claim: 'journal class present', evidence_ref_ids: [read!.evidence_ref_id], kind: 'source_observed' }],
    patterns: [{ name: 'journal', mechanism: 'append-only', tradeoffs: [] }],
    missing_evidence: [],
  });
  assert.equal(finished.evidenceRefs.length, 1);
  assert.equal(finished.evidenceRefs[0]!.commit_sha, COMMIT);
});

test('research review uses validated evidence from the pattern source repository', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-sd-sources-'));
  gitInit(root);
  const first = repo();
  const second = repo();
  second.providerRepoId = '2002';
  second.fullName = 'beta/replay-runner';
  second.topics = ['replay-runner'];
  second.files = { 'README.md': 'agent workflow replay and crash recovery', 'src/replay.ts': 'export class ReplayJournal { replay(): void {} }' };
  const mission = createResearchMission({ problem: 'How can we make long-running agent work crash-resilient?', projectRoot: root, budgetPreset: 'low', now: FIXED_NOW, missionId: 'mission_two_sources' });
  const hunt = await runHuntDiscovery(mission, new FakeResearchProvider({ repositories: [first, second] }), { runsRoot: root, now: FIXED_NOW });
  const secondSourceCard = hunt.deep!.patterns.find((card) => card.sources.some((source) => source.repository_id === '2002'));
  assert.ok(secondSourceCard, 'second source should produce a pattern card');
  const review = hunt.reviews.find((item) => item.pattern_id === secondSourceCard.pattern_id);
  assert.ok(review);
  assert.equal(review.grants_merge_authority, false);
  assert.notEqual(review.verdict, 'REJECT_RESEARCH_FINDING');
});
