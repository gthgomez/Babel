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

test('candidateCollector: fails closed on trust mode downgrade for Babel', async () => {
  const gitMock = (args: string[]) => {
    if (args.includes('--show-toplevel')) return 'C:/Mock/Babel';
    if (args.includes('--git-common-dir')) return 'C:/Mock/Babel/.git';
    if (args.includes('get-url')) return 'https://github.com/gthgomez/Babel.git';
    return '';
  };

  await assert.rejects(
    () =>
      collectCandidateEnvelope({
        repoRoot: 'C:/Mock/Babel',
        trustMode: 'EXTERNAL_REPO_REVIEW',
        gitExec: gitMock,
      }),
    /TRUST_MODE_DOWNGRADE_DENIED/
  );
});

test('candidateCollector: fails closed on repository identity mismatch', async () => {
  const gitMock = (args: string[]) => {
    if (args.includes('--show-toplevel')) return 'C:/Mock/DragonWake';
    if (args.includes('--git-common-dir')) return 'C:/Mock/DragonWake/.git';
    if (args.includes('get-url')) return 'https://github.com/gthgomez/DragonWake.git';
    return '';
  };

  await assert.rejects(
    () =>
      collectCandidateEnvelope({
        repoRoot: 'C:/Mock/DragonWake',
        repository: 'attacker/spoofed-repo',
        gitExec: gitMock,
      }),
    /REPOSITORY_IDENTITY_MISMATCH/
  );
});

test('candidateCollector: resolves custom default branch via refs/remotes/origin/HEAD', async () => {
  const gitMock = (args: string[]) => {
    if (args.includes('--show-toplevel')) return 'C:/Mock/CustomRepo';
    if (args.includes('--git-common-dir')) return 'C:/Mock/CustomRepo/.git';
    if (args.includes('get-url')) return 'https://github.com/gthgomez/CustomRepo.git';
    if (args.includes('symbolic-ref') && args.includes('refs/remotes/origin/HEAD')) return 'refs/remotes/origin/develop';
    if (args.includes('--abbrev-ref') && args.includes('HEAD')) return 'feature-123';
    if (args.includes('rev-parse') && args.length === 2 && args[1] === 'HEAD') return 'head-sha-123';
    if (args.includes('--verify') && args.includes('refs/remotes/origin/develop')) return 'develop-sha';
    if (args.includes('merge-base')) return 'base-sha-develop';
    if (args.includes('--name-only')) return 'src/app.ts\0';
    if (args.includes('--numstat')) return '10\t2\tsrc/app.ts\n';
    if (args.includes('^{tree}')) return 'tree-sha';
    throw new Error(`git ref not found: ${args.join(' ')}`);
  };

  const envelope = await collectCandidateEnvelope({
    repoRoot: 'C:/Mock/CustomRepo',
    gitExec: gitMock,
  });

  assert.equal(envelope.base_sha, 'base-sha-develop');
  assert.deepEqual(envelope.scope, ['src/app.ts']);
});

test('candidateCollector: fails closed with UNABLE_TO_RESOLVE_CANDIDATE_BASE when base is indeterminate', async () => {
  const gitMock = (args: string[]) => {
    if (args.includes('--show-toplevel')) return 'C:/Mock/OrphanRepo';
    if (args.includes('--git-common-dir')) return 'C:/Mock/OrphanRepo/.git';
    if (args.includes('get-url')) return 'https://github.com/gthgomez/OrphanRepo.git';
    if (args.includes('--abbrev-ref') && args.includes('HEAD')) return 'feature-isolated';
    if (args.includes('rev-parse') && args.length === 2 && args[1] === 'HEAD') return 'head-sha-orphan';
    // All other git calls (symbolic-ref, verify, upstream, etc.) throw non-zero exit code
    throw new Error(`git ref not found: ${args.join(' ')}`);
  };

  await assert.rejects(
    () =>
      collectCandidateEnvelope({
        repoRoot: 'C:/Mock/OrphanRepo',
        gitExec: gitMock,
        ghExec: () => { throw new Error('gh offline'); },
      }),
    /UNABLE_TO_RESOLVE_CANDIDATE_BASE/
  );
});

test('candidateCollector: Section F - does not guess from feature branch @{upstream} or unverified origin/main', async () => {
  const gitMock = (args: string[]) => {
    if (args.includes('--show-toplevel')) return 'C:/Mock/FeatureRepo';
    if (args.includes('--git-common-dir')) return 'C:/Mock/FeatureRepo/.git';
    if (args.includes('get-url')) return 'https://github.com/gthgomez/FeatureRepo.git';
    if (args.includes('--abbrev-ref') && args.includes('HEAD')) return 'feature-x';
    if (args.includes('rev-parse') && args.length === 2 && args[1] === 'HEAD') return 'head-sha-feat';
    if (args.includes('@{upstream}')) return 'origin/feature-x'; // tracking own feature branch!
    if (args.includes('--verify') && args.includes('origin/main')) return 'main-sha'; // origin/main exists on remote
    // Neither origin/HEAD nor gh defaultBranchRef exists
    throw new Error(`git ref not found: ${args.join(' ')}`);
  };

  // Must NOT guess origin/main or @{upstream}; must fail closed!
  await assert.rejects(
    () =>
      collectCandidateEnvelope({
        repoRoot: 'C:/Mock/FeatureRepo',
        gitExec: gitMock,
        ghExec: () => { throw new Error('gh offline'); },
      }),
    /UNABLE_TO_RESOLVE_CANDIDATE_BASE/
  );
});

test('candidateCollector: Section F - fails closed when multiple plausible branch names exist without authoritative metadata', async () => {
  const gitMock = (args: string[]) => {
    if (args.includes('--show-toplevel')) return 'C:/Mock/MultiBranchRepo';
    if (args.includes('--git-common-dir')) return 'C:/Mock/MultiBranchRepo/.git';
    if (args.includes('get-url')) return 'https://github.com/gthgomez/MultiBranchRepo.git';
    if (args.includes('--abbrev-ref') && args.includes('HEAD')) return 'feature-branch';
    if (args.includes('rev-parse') && args.length === 2 && args[1] === 'HEAD') return 'head-sha-feat';
    // Both origin/main and origin/master exist, but no origin/HEAD or defaultBranchRef
    if (args.includes('--verify') && (args.includes('origin/main') || args.includes('origin/master') || args.includes('origin/trunk'))) {
      return 'plausible-sha';
    }
    throw new Error(`git ref not found: ${args.join(' ')}`);
  };

  await assert.rejects(
    () =>
      collectCandidateEnvelope({
        repoRoot: 'C:/Mock/MultiBranchRepo',
        gitExec: gitMock,
        ghExec: () => { throw new Error('gh offline'); },
      }),
    /UNABLE_TO_RESOLVE_CANDIDATE_BASE/
  );
});



