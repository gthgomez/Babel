import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashLabValue } from '../../claude-babel-astra-lab/receipt.js';

export type FixtureTaskId = 'T1' | 'T2' | 'T4';

export interface FixtureInstance {
  taskId: FixtureTaskId;
  root: string;
  baseSha: string;
  hiddenVerifierRoot: string;
}

const FILES: Readonly<Record<FixtureTaskId, Readonly<Record<string, string>>>> = {
  T1: {
    'notes/launch.txt': 'The launch color is BLUE.\n',
    'notes/orbit.txt': 'The orbit sequence is 42.\n',
    'docs/README.md': '# Navigation fixture\nRead the notes to assemble the answer.\n',
  },
  T2: {
    'package.json': '{"type":"module","scripts":{"test":"node --test test/math.test.js"}}\n',
    'src/math.js': 'export function add(left, right) { return left - right; }\n',
    'test/math.test.js': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\ntest('add sums two numbers', () => assert.equal(add(2, 3), 5));\n",
  },
  T4: {
    'package.json': '{"type":"module","scripts":{"test":"node --test test/format.test.js"}}\n',
    'src/format.js': 'export function formatName(first, last) { return `${first} ${last}`; }\n',
    'test/format.test.js': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { formatName } from '../src/format.js';\ntest('formats a name for a directory', () => assert.equal(formatName('Ada', 'Lovelace'), 'Lovelace, Ada'));\n",
  },
};

const TASK_PROMPTS: Readonly<Record<FixtureTaskId, string>> = {
  T1: 'Locate the launch color and orbit sequence across the repository. Write exactly BLUE-ORBIT-42 followed by a newline to answer.txt. Do not modify any other file.',
  T2: 'Repair the add function so the existing test passes. Do not modify the test.',
  T4: 'Run the existing test first, diagnose the failure, then repair formatName so the test passes. Do not modify the test.',
};

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'astra-lab', GIT_AUTHOR_EMAIL: 'astra-lab@local',
      GIT_COMMITTER_NAME: 'astra-lab', GIT_COMMITTER_EMAIL: 'astra-lab@local',
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
    },
    windowsHide: true,
  }).trim();
}

export function fixturePrompt(taskId: FixtureTaskId): string {
  return TASK_PROMPTS[taskId];
}

export function createFixture(taskId: FixtureTaskId): FixtureInstance {
  const root = mkdtempSync(join(tmpdir(), `astra-lab-${taskId.toLowerCase()}-`));
  for (const [relative, contents] of Object.entries(FILES[taskId])) {
    const path = join(root, relative);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, contents, 'utf8');
  }
  git(root, ['init', '--quiet']);
  git(root, ['add', '.']);
  git(root, ['commit', '--quiet', '-m', `fixture-${taskId}`]);
  const baseSha = git(root, ['rev-parse', 'HEAD']);
  return {
    taskId,
    root,
    baseSha,
    // Deliberately outside the contestant repository; only the verifier uses it.
    hiddenVerifierRoot: mkdtempSync(join(tmpdir(), `astra-hidden-verifier-${taskId.toLowerCase()}-`)),
  };
}

export function resetFixture(fixture: FixtureInstance): string {
  git(fixture.root, ['reset', '--hard', '--quiet', fixture.baseSha]);
  git(fixture.root, ['clean', '-fdx', '--quiet']);
  const actual = git(fixture.root, ['rev-parse', 'HEAD']);
  if (actual !== fixture.baseSha) throw new Error(`fixture reset drifted: expected ${fixture.baseSha}, got ${actual}`);
  return actual;
}

export function runHiddenVerifier(fixture: FixtureInstance): { result: 'PASS' | 'FAIL'; detail: string; verifierHash: string } {
  const verifierHash = hashLabValue({ taskId: fixture.taskId, verifier: 'astra-hidden-v1' });
  if (fixture.taskId === 'T1') {
    try {
      return readFileSync(join(fixture.root, 'answer.txt'), 'utf8') === 'BLUE-ORBIT-42\n'
        ? { result: 'PASS', detail: 'answer_exact', verifierHash }
        : { result: 'FAIL', detail: 'answer_mismatch', verifierHash };
    } catch {
      return { result: 'FAIL', detail: 'answer_missing', verifierHash };
    }
  }
  try {
    execFileSync('npm.cmd', ['test', '--silent'], { cwd: fixture.root, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
    return { result: 'PASS', detail: 'tests_passed', verifierHash };
  } catch {
    return { result: 'FAIL', detail: 'tests_failed', verifierHash };
  }
}

export function assertSameFixtureSha(left: FixtureInstance, right: FixtureInstance): void {
  if (left.baseSha !== right.baseSha) throw new Error(`PAIR_INVALID: fixture SHA mismatch ${left.baseSha} != ${right.baseSha}`);
}
