import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { FakeResearchProvider, type FakeRepository } from '../fakeProvider.js';
import { createResearchMission } from '../missionPlanner.js';
import { runHuntDiscovery } from '../hunt.js';
import { analyzeApplicability, isApplicabilityStale } from '../analysis/applicability.js';
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

function gitInit(dir: string): string {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  writeFileSync(join(dir, 'worker.ts'), 'export class Worker {\n  async run(): Promise<void> {}\n}\n');
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
  gitInit(root);
  const { hunt } = await huntWithCard(root);

  assert.ok(existsSync(`${hunt.paths.researchDir}/report/RESEARCH_REPORT.md`));
  assert.ok(existsSync(`${hunt.paths.researchDir}/report/candidate-experiments.json`));
  assert.ok(existsSync(`${hunt.paths.researchDir}/patterns/review.jsonl`));

  const artifacts = loadRunArtifacts(hunt.paths);
  assert.equal(artifacts.mission.mission_id, 'mission_slice_d');
  assert.ok(artifacts.patterns.length >= 1);
  assert.equal(artifacts.reviews[0]!.grants_merge_authority, false);
  assert.equal(artifacts.proposals.length, artifacts.reviews.length);

  const markdown = JSON.parse(readFileSync(`${hunt.paths.researchDir}/report/RESEARCH_REPORT.md`, 'utf8')).markdown as string;
  assert.match(markdown, /# Research Report — mission_slice_d/);
  assert.match(markdown, /## Governance boundary/);
  assert.match(markdown, /SOURCE_CONFIRMED/);
  assert.match(markdown, /ACCEPT_RESEARCH_FINDING|NEEDS_MORE_EVIDENCE|REJECT_RESEARCH_FINDING/);

  const metrics = JSON.parse(readFileSync(hunt.paths.metricsJson, 'utf8'));
  assert.equal(typeof metrics.reviews_accepted, 'number');
  assert.equal(metrics.status, 'COMPLETE');
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
