import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRepositorySlug,
  determineRiskTier,
  determineTrustMode,
  computeNumstatDigest,
  collectCandidateEnvelope,
} from './candidateCollector.js';

test('candidateCollector: parseRepositorySlug handles https, ssh and local urls', () => {
  assert.equal(parseRepositorySlug('https://github.com/gthgomez/Babel.git'), 'gthgomez/Babel');
  assert.equal(parseRepositorySlug('git@github.com:gthgomez/Babel.git'), 'gthgomez/Babel');
  assert.equal(parseRepositorySlug('https://github.com/gthgomez/Project_Games.git'), 'gthgomez/Project_Games');
  assert.equal(parseRepositorySlug('D:/MockProjects/DragonWake'), 'MockProjects/DragonWake');
});

test('candidateCollector: determineRiskTier correctly categorizes surfaces', () => {
  assert.equal(determineRiskTier([]), 'TRIVIAL');
  assert.equal(determineRiskTier(['README.md', 'docs/overview.md']), 'TRIVIAL');
  assert.equal(determineRiskTier(['src/game/player.ts', 'src/game/physics.ts']), 'NORMAL');
  assert.equal(determineRiskTier(['babel-cli/src/commands/dogfood.ts']), 'ELEVATED');
  assert.equal(determineRiskTier(['scripts/agent-pr-gate.ps1']), 'CRITICAL');
  assert.equal(determineRiskTier(['tools/babel-pr-review.mts']), 'CRITICAL');
  assert.equal(determineRiskTier(['docs/AUTONOMY_POLICY.md']), 'CRITICAL');
});

test('candidateCollector: determineTrustMode separates self from external repos', () => {
  assert.equal(determineTrustMode('gthgomez/Babel'), 'SELF_REVIEW');
  assert.equal(determineTrustMode('gthgomez/babel'), 'SELF_REVIEW');
  assert.equal(determineTrustMode('gthgomez/Project_Games'), 'EXTERNAL_REPO_REVIEW');
  assert.equal(determineTrustMode('owner/dragonwake'), 'EXTERNAL_REPO_REVIEW');
});

test('candidateCollector: computeNumstatDigest is ordinally sorted and deterministic', () => {
  const lines1 = ['10\t5\tfileB.ts', '1\t2\tfileA.ts', '-\t-\tasset.png'];
  const lines2 = ['1\t2\tfileA.ts', '-\t-\tasset.png', '10\t5\tfileB.ts'];
  assert.equal(computeNumstatDigest(lines1), computeNumstatDigest(lines2));
});

test('candidateCollector: collectCandidateEnvelope builds valid CandidateEnvelope with mocked commands', async () => {
  const gitMock = (args: string[]) => {
    if (args.includes('--show-toplevel')) return 'D:/MockProjects/DragonWake';
    if (args.includes('--git-common-dir')) return 'D:/MockProjects/DragonWake/.git';
    if (args.includes('get-url')) return 'https://github.com/gthgomez/DragonWake.git';
    if (args.includes('HEAD')) return '1111111111111111111111111111111111111111';
    if (args.includes('origin/main')) return '0000000000000000000000000000000000000000';
    if (args.includes('merge-base')) return '0000000000000000000000000000000000000000';
    if (args.includes('--name-only')) return 'src/player.ts\0assets/sprite.png\0';
    if (args.includes('--numstat')) return '15\t3\tsrc/player.ts\n-\t-\tassets/sprite.png\n';
    return '';
  };

  const ghMock = (args: string[]) => {
    return JSON.stringify({
      number: 42,
      baseRefOid: '0000000000000000000000000000000000000000',
      headRefOid: '1111111111111111111111111111111111111111',
    });
  };

  const envelope = await collectCandidateEnvelope({
    repoRoot: 'D:/MockProjects/DragonWake',
    pr: 42,
    gitExec: gitMock,
    ghExec: ghMock,
  });

  assert.equal(envelope.schema_version, 2);
  assert.equal(envelope.repository, 'gthgomez/DragonWake');
  assert.equal(envelope.pr_number, 42);
  assert.equal(envelope.base_sha, '0000000000000000000000000000000000000000');
  assert.equal(envelope.head_sha, '1111111111111111111111111111111111111111');
  assert.equal(envelope.trust_mode, 'EXTERNAL_REPO_REVIEW');
  assert.equal(envelope.risk_tier, 'NORMAL');
  assert.deepEqual(envelope.scope, ['assets/sprite.png', 'src/player.ts']);
  assert.ok(envelope.omitted_files?.some((o) => o.path === 'assets/sprite.png' && o.reason === 'binary'));
  assert.match(envelope.candidate_digest, /^[a-f0-9]{64}$/);
});
