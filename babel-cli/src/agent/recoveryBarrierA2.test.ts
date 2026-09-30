import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parseLeaseJson } from '../authority/lease.js';
import { ChatEngine } from './chatEngine.js';
import { createWorkingState, type RecoveryCandidateBinding } from './codingLoop/workingState.js';

const AUTHORIZED_CAPABILITIES = [
  'inspect_repository',
  'search_repository',
  'edit_task_files',
  'run_tests',
  'run_local_command',
] as const;

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'babel-recovery-barrier-a2-'));
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git(['init']);
  git(['config', 'user.email', 'babel-test@example.com']);
  git(['config', 'user.name', 'Babel Test']);
  writeFileSync(join(root, 'README.md'), 'original\n');
  git(['add', 'README.md']);
  git(['commit', '-m', 'fixture']);
  return root;
}

async function withExecutionAuthority<T>(run: () => Promise<T>): Promise<T> {
  const keys = [
    'BABEL_RUNS_DIR',
    'BABEL_CHAT_MAX_COST',
    'BABEL_AUTONOMY_LEASE',
    'BABEL_EXECUTION_PROFILE',
    'BABEL_ALLOW_HOST_FALLBACK',
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key] ?? null]));
  const runsDir = mkdtempSync(join(tmpdir(), 'babel-a2-runs-'));
  const lease = parseLeaseJson(JSON.stringify({
    version: 2,
    leaseId: 'a2-recovery-barrier',
    scope: { repository: 'babel-fixture', objective: 'recovery barrier regression' },
    allowedCapabilities: [...AUTHORIZED_CAPABILITIES],
  }));
  assert.ok(lease.ok);
  process.env['BABEL_RUNS_DIR'] = runsDir;
  process.env['BABEL_CHAT_MAX_COST'] = 'unlimited';
  process.env['BABEL_AUTONOMY_LEASE'] = JSON.stringify(lease.lease);
  process.env['BABEL_EXECUTION_PROFILE'] = 'dev_local';
  process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1';
  try {
    return await run();
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === null) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(runsDir, { recursive: true, force: true });
  }
}

function makeEngine(root: string) {
  const runner = {
    async *executeWithToolsStream() {
      yield { type: 'text_delta', text: 'fixture answer' };
      yield { type: 'done', finishReason: 'stop' };
    },
    async execute() { return { type: 'completion', answer: 'fixture answer' }; },
    async executeRaw() { return 'fixture answer'; },
    getLastInvocationMetadata() { return null; },
  };
  const engine = new ChatEngine({
    task: 'fixture task', projectRoot: root, runId: `a2-${process.pid}-${Math.random()}`,
    model: 'deepseek-v4-flash', providerRunner: runner as never,
  });
  (engine as unknown as { shouldUseNativeTools: () => boolean }).shouldUseNativeTools = () => true;
  return engine;
}

function recoveryGate(engine: ChatEngine) {
  const internal = engine as unknown as {
    workingState: ReturnType<typeof createWorkingState>;
    currentRecoveryBinding: () => RecoveryCandidateBinding | null;
  };
  internal.workingState = createWorkingState('authorized test operation');
  const binding = internal.currentRecoveryBinding();
  assert.ok(binding, 'fixture has a current physical candidate binding');
  internal.workingState.recoveryGate = {
    failureSignature: 'fixture-red', binding,
    requiredEvidence: 'inspect the failing source',
    hypothesisAtFailure: 'unknown', satisfied: false, strategyChanged: false,
  };
  return internal;
}

async function executeAction(engine: ChatEngine, action: unknown) {
  const internal = engine as unknown as {
    executeOneAction: (
      action: unknown,
      context: unknown,
      callbacks: unknown,
      meta: { index: number; ownerGeneration: number },
    ) => Promise<{ observation: string }>;
    engineRunDir: string;
    activeSubmissionGeneration: number;
    abortController: AbortController;
  };
  return internal.executeOneAction(action, {
    agentId: 'a2-recovery-barrier', runId: 'a2-recovery-barrier',
    runDir: internal.engineRunDir, babelRoot: process.cwd(),
    projectRoot: (engine as unknown as { options: { projectRoot: string } }).options.projectRoot,
    sessionId: 'a2-recovery-barrier', signal: internal.abortController.signal,
  }, {}, { index: 0, ownerGeneration: internal.activeSubmissionGeneration });
}

test('T08: identical authorized shell action reaches execution only when recovery is open', async () => {
  const root = makeProject();
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      private: true,
      scripts: { test: 'node effect.mjs' },
    }));
    writeFileSync(join(root, 'effect.mjs'), "import { writeFileSync } from 'node:fs';\nwriteFileSync('effect.txt', 'ran\\n');\n");
    await withExecutionAuthority(async () => {
      const engine = makeEngine(root);
      const closed = recoveryGate(engine);
      const action = { type: 'run_command', command: 'npm test' };

      const denied = await executeAction(engine, action);
      assert.match(denied.observation, /\[RECOVERY_EVIDENCE_REQUIRED\]/);
      assert.equal(readFileSync(join(root, 'README.md'), 'utf8'), 'original\n');
      assert.equal(existsSync(join(root, 'effect.txt')), false);

      delete closed.workingState.recoveryGate;
      const allowed = await executeAction(engine, action);
      assert.match(allowed.observation, /exit_code: 0/);
      assert.equal(readFileSync(join(root, 'effect.txt'), 'utf8'), 'ran\n');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T09: registered verifier cannot mutate source with recovery closed; scratch output remains usable', async () => {
  const root = makeProject();
  try {
    mkdirSync(join(root, 'scratch'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      private: true,
      scripts: { test: 'node verifier.mjs' },
    }));
    writeFileSync(join(root, 'verifier.mjs'), [
      "import { writeFileSync } from 'node:fs';",
      "if (process.env.BABEL_FIXTURE_MUTATE_SOURCE === '1') writeFileSync('README.md', 'changed\\n');",
      "writeFileSync('scratch/result.txt', 'verified\\n');",
    ].join('\n'));

    const priorMutationFlag = process.env['BABEL_FIXTURE_MUTATE_SOURCE'];
    await withExecutionAuthority(async () => {
      const engine = makeEngine(root);
      const closed = recoveryGate(engine);
      process.env['BABEL_FIXTURE_MUTATE_SOURCE'] = '1';
      const denied = await executeAction(engine, { type: 'test_run', command: 'npm test' });
      assert.match(denied.observation, /\[RECOVERY_EVIDENCE_REQUIRED\]/);
      assert.equal(readFileSync(join(root, 'README.md'), 'utf8'), 'original\n');
      assert.equal(existsSync(join(root, 'scratch/result.txt')), false);

      process.env['BABEL_FIXTURE_MUTATE_SOURCE'] = '0';
      const consumedGate = closed.workingState.recoveryGate!;
      consumedGate.permitConsumed = true;
      consumedGate.admittedPlan = {} as NonNullable<typeof consumedGate.admittedPlan>;
      const positive = await executeAction(engine, { type: 'test_run', command: 'npm test' });
      assert.match(positive.observation, /exit_code: 0/);
      assert.equal(readFileSync(join(root, 'README.md'), 'utf8'), 'original\n');
      assert.equal(readFileSync(join(root, 'scratch/result.txt'), 'utf8'), 'verified\n');
    }).finally(() => {
      if (priorMutationFlag === undefined) delete process.env['BABEL_FIXTURE_MUTATE_SOURCE'];
      else process.env['BABEL_FIXTURE_MUTATE_SOURCE'] = priorMutationFlag;
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
