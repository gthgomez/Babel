import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyExecutionRisk,
  COMMAND_SPECS,
  normalizeExecutionBase,
} from './commandSpec.js';
import { ALLOWED_COMMANDS } from '../sandbox.js';
import { EXECUTION_PROFILE_NAMES, getExecutionProfileCommandAdditions } from '../config/executionProfiles.js';
import { parseGitCommand } from './gitCommand.js';
import { decideActionRequest } from './pdp.js';
import { parseLeaseJson } from './lease.js';
import { decideWithLease } from './wire.js';
import { executeActionWithPolicy, createToolExecutor } from '../agent/toolExecutor.js';
import { establishAuthoritySession } from './sessionContext.js';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { after } from 'node:test';
import { validateDockerIsolationArgs } from '../config/dockerIsolationArgs.js';
import { SafeExecutor, validateExecutorShellCommand } from '../sandbox.js';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

test('completeness: every allowlisted and profile-added base is registered', () => {
  const bases = new Set<string>();
  for (const cmd of ALLOWED_COMMANDS) bases.add(normalizeExecutionBase(cmd));
  for (const profile of EXECUTION_PROFILE_NAMES) {
    for (const cmd of getExecutionProfileCommandAdditions(profile)) {
      bases.add(normalizeExecutionBase(cmd));
    }
  }
  const missing = [...bases].filter((b) => COMMAND_SPECS[b] === undefined);
  assert.deepEqual(missing, [], `unregistered command bases: ${missing.join(', ')}`);
  assert.ok(COMMAND_SPECS.sed);
});

test('normalizeExecutionBase strips path and windows suffixes', () => {
  assert.equal(normalizeExecutionBase('C:\\\\repo\\\\gradlew.bat'), 'gradlew');
  assert.equal(normalizeExecutionBase('./gradlew'), 'gradlew');
  assert.equal(normalizeExecutionBase('adb.exe'), 'adb');
});

test('project-relative executables are project_code', () => {
  assert.equal(classifyExecutionRisk('./cli_tool').executionRisk, 'project_code');
  assert.equal(classifyExecutionRisk('/app/bin/tool').executionRisk, 'project_code');
  assert.equal(classifyExecutionRisk('/project/bin/tool').executionRisk, 'project_code');
});

test('jvm and language run/build carriers require isolation', () => {
  for (const command of [
    'gradlew test',
    './gradlew assembleDebug',
    'java Attack.java',
    'cargo run',
    'go run main.go',
    'dotnet run',
    'mvn test',
    'cmake --build .',
  ]) {
    const p = parseGitCommand(command);
    assert.equal(p.requiresIsolation, true, command);
  }
});

test('host-safe inspection does not require isolation', () => {
  assert.equal(parseGitCommand('git status').requiresIsolation, undefined);
  assert.equal(parseGitCommand('rg foo').capability, 'run_local_command');
  assert.equal(parseGitCommand('rg foo').requiresIsolation, undefined);
});

test('git global options that change execution fail closed', () => {
  assert.equal(parseGitCommand('git -c protocol.ext.allow=always fetch ext::calc').capability, 'unknown');
  assert.equal(parseGitCommand('git --git-dir /tmp/other fetch').capability, 'unknown');
  assert.equal(parseGitCommand('git --work-tree /tmp status').capability, 'unknown');
  assert.equal(parseGitCommand('git --config-env foo=BAR status').capability, 'unknown');
});

test('git -C inside repo is allowed', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-git-c-'));
  roots.push(root);
  const p = parseGitCommand(`git -C ${root} status`, { repoRoot: root });
  assert.equal(p.capability, 'inspect_repository');
});

test('git fetch/pull/stash are not inspect_repository', () => {
  assert.notEqual(parseGitCommand('git fetch').capability, 'inspect_repository');
  assert.equal(parseGitCommand('git pull').requiresIsolation, true);
  assert.notEqual(parseGitCommand('git stash push').capability, 'inspect_repository');
});

test('git commit -S is unknown', () => {
  assert.equal(parseGitCommand('git commit -S -m x').capability, 'unknown');
});

test('heterogeneous effectful chains fail closed', () => {
  const p = parseGitCommand('npm test && git commit -m x');
  assert.equal(p.capability, 'unknown');
  assert.equal(p.ambiguous, true);
});

test('winget/adb verb split', () => {
  assert.equal(parseGitCommand('winget list').capability, 'inspect_host_environment');
  assert.equal(parseGitCommand('winget install Git.Git').capability, 'unknown');
  assert.equal(parseGitCommand('adb devices').capability, 'inspect_external_device');
  assert.equal(parseGitCommand('adb logcat').capability, 'unknown');
  assert.equal(parseGitCommand('adb install app.apk').capability, 'unknown');
});

test('PDP: merge+eval without isolation denies even when merge is leased', () => {
  const parsed = parseLeaseJson(
    JSON.stringify({
      version: 2,
      leaseId: 'merge-iso',
      scope: { repository: 'babel', remote: 'origin' },
      allowedCapabilities: ['merge', 'run_arbitrary_code'],
      constraints: { allowedPullRequests: [88] },
    }),
  );
  assert.ok(parsed.ok);
  const decoded = parseGitCommand('node -e "/* gh pr merge 88 */ console.log(1)"');
  assert.equal(decoded.capability, 'merge');
  const denied = decideActionRequest(
    { capability: 'merge', target: '88', requiresIsolation: true },
    parsed.lease,
  );
  assert.equal(denied.outcome, 'deny');
  assert.ok(denied.rulesTriggered.includes('pdp.project_code_requires_isolation'));
});

test('PDP: missing merge membership wins over isolation', () => {
  const parsed = parseLeaseJson(
    JSON.stringify({
      version: 2,
      leaseId: 'no-merge',
      scope: { repository: 'babel', remote: 'origin' },
      allowedCapabilities: ['run_tests'],
      constraints: { allowedPullRequests: [88] },
    }),
  );
  assert.ok(parsed.ok);
  const missing = decideActionRequest(
    { capability: 'merge', target: '88', requiresIsolation: true, isolationAvailable: true },
    parsed.lease,
  );
  assert.equal(missing.outcome, 'deny');
  assert.equal(missing.reasonCode, 'DENY_MISSING_AUTHORITY');
});

test('wire+executor: merge+eval without isolation never invokes executeTool', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-merge-iso-'));
  roots.push(root);
  const persistPath = join(root, 'runs/s1/authority-session.json');
  mkdirSync(dirname(persistPath), { recursive: true });
  const parsed = parseLeaseJson(
    JSON.stringify({
      version: 2,
      leaseId: 'merge-iso-e2e',
      scope: { repository: 'babel', remote: 'origin' },
      allowedCapabilities: ['merge', 'run_arbitrary_code'],
      constraints: { allowedPullRequests: [88] },
    }),
  );
  assert.ok(parsed.ok);
  const session = establishAuthoritySession({ repoRoot: root, lease: parsed.lease, persistPath });
  let executed = false;
  const executor = createToolExecutor({
    executeTool: async () => {
      executed = true;
      return { exit_code: 0, stdout: 'nope', stderr: '' };
    },
  });
  const run = await executeActionWithPolicy(
    { type: 'run_command', command: 'node -e "/* gh pr merge 88 */ console.log(1)"' },
    'workspace_write',
    { agentId: 'iso', runId: 'iso-1', babelRoot: root },
    { authoritySession: session, executor },
  );
  assert.equal(run.policyBlocked, true);
  assert.equal(executed, false);
  const wire = decideWithLease(
    { type: 'run_command', command: 'node -e "/* gh pr merge 88 */ console.log(1)"' },
    'workspace_write',
    { lease: parsed.lease, baseline: { repoRoot: root, manifest: { schemaVersion: 1, entries: [], capturedAt: '' } } },
  );
  assert.equal(wire.decision, 'deny');
});

test('SafeExecutor denies gradlew test on host profile without authority stack', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-se-gradle-'));
  roots.push(root);
  const prev = process.env['BABEL_EXECUTION_PROFILE'];
  process.env['BABEL_EXECUTION_PROFILE'] = 'dev_local';
  try {
    const se = new SafeExecutor(root);
    const result = se.shellExec('gradlew test', root, 5_000);
    assert.notEqual(result.exit_code, 0);
    assert.match(result.stderr, /isolation_required|project or container-only/i);
  } finally {
    if (prev === undefined) delete process.env['BABEL_EXECUTION_PROFILE'];
    else process.env['BABEL_EXECUTION_PROFILE'] = prev;
  }
});

test('validateExecutorShellCommand denies git -c execution config', () => {
  const issue = validateExecutorShellCommand(
    'git -c protocol.ext.allow=always fetch ext::echo',
    process.platform,
    'dev_local',
  );
  assert.ok(issue);
});

test('docker extra args fail closed for host networking forms', () => {
  assert.equal(validateDockerIsolationArgs('--network host').ok, false);
  assert.equal(validateDockerIsolationArgs('--network=host').ok, false);
  assert.equal(validateDockerIsolationArgs('--cap-add SYS_ADMIN').ok, false);
  assert.equal(validateDockerIsolationArgs('--cap-add=SYS_ADMIN').ok, false);
  assert.equal(validateDockerIsolationArgs('--read-only --user 1000:1000').ok, true);
});

describe('hostProcessSurface', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const srcRoot = resolveSrcRoot(here);

  test('direct child-process call sites match the checked manifest', () => {
    const found = collectSpawnFiles(srcRoot).sort();
    const missing = found.filter((f) => !HOST_PROCESS_SURFACE.has(f));
    const extra = [...HOST_PROCESS_SURFACE].filter((f) => !found.includes(f));
    assert.deepEqual(missing, [], `unregistered spawn sites: ${missing.join(', ')}`);
    assert.deepEqual(extra, [], `stale manifest entries: ${extra.join(', ')}`);
  });
});

function resolveSrcRoot(fromAuthority: string): string {
  return join(fromAuthority, '..');
}

const SPAWN_RE = /\b(spawn|spawnSync|execFile|execFileSync)\s*\(/;

function collectSpawnFiles(srcRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir)) {
      const full = join(dir, ent);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (ent === 'node_modules' || ent === 'dist') continue;
        walk(full);
        continue;
      }
      if (!ent.endsWith('.ts') && !ent.endsWith('.js')) continue;
      if (ent.endsWith('.test.ts') || ent.endsWith('.test.js')) continue;
      const text = readFileSync(full, 'utf8');
      if (SPAWN_RE.test(text)) out.push(relative(srcRoot, full).replace(/\\/g, '/'));
    }
  };
  walk(srcRoot);
  return out;
}

/** Production (non-test) files that spawn child processes. Update when adding a site. */
const HOST_PROCESS_SURFACE = new Set([
  'agent/backgroundShell.ts',
  'agent/capabilityBroker.ts',
  'agent/chatEngineSupport.ts',
  'agent/diffCritic.ts',
  'agent/implementWorktreeAgent.ts',
  'bridge/sessionRunner.ts',
  'cli/helpers.ts',
  'config/benchmarkContainer.ts',
  'daemon/client.ts',
  'doctor.ts',
  'evidence/independentVerifier.ts',
  'evidence/revisionBoundReceipt.ts',
  'interactive/openEditor.ts',
  'localTools.ts',
  'pipeline/bootstrapLanes.ts',
  'pipeline/liveSessionParity.ts',
  'runners/cliBase.ts',
  'runners/transportConformance.fixture.ts',
  'sandbox.ts',
  'services/agentBenchmark.ts',
  'services/agentBenchmarkHarness.ts',
  'services/agentTeams.ts',
  'services/benchmarkImprovementLoop.ts',
  'services/benchmarkRepairLoop.ts',
  'services/causalCampaignContract.ts',
  'services/checkpoints.ts',
  'services/cliSmokeBenchmark.ts',
  'services/contextInjection.ts',
  'services/dogfoodSandbox.ts',
  'services/evidenceProduct.ts',
  'stages/runtimePreflight.ts',
  'stages/runtimeVerificationRunner.ts',
  'utils/gitExec.ts',
  'agent/agentRunCoordinator.ts',
  'services/gitMutations.ts',
  'services/governanceBenchmark.ts',
  'services/knowledgeGraphIndexer.ts',
  'services/learning.ts',
  'services/liteParallelReview.ts',
  'services/liteTrustDemo.ts',
  'services/liteWorkerLoop.ts',
  'services/liveCliReliabilityMatrix.ts',
  'services/lsp/client.ts',
  'services/maintenanceAudit.ts',
  'services/parityCorpus.ts',
  'services/productBenchmark.ts',
  'services/realTaskPilot.ts',
  'services/releaseReadinessBenchmark.ts',
  'services/shadowDiff.ts',
  'services/ship.ts',
  'services/smallFix.ts',
  'services/swebenchProCampaign.ts',
  'services/verifierOverlay.ts',
  'services/workspaceDepPreflight.ts',
  'services/worktreeIsolation.ts',
  'services/worktreeSafety.ts',
  'tools/auditUiTool.ts',
  'tools/gitContext.ts',
  'tools/mcpTransport.ts',
  'tools/ripgrep.ts',
]);
