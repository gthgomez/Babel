import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import test from 'node:test';

import type { OrchestratorManifest, QaVerdictReject, SwePlan } from '../schemas/agentContracts.js';
import type { CommandRuntimeStatus, JavaRuntimeStatus } from '../stages/runtimePreflight.js';
import {
  assertBoundedPlanActivationContract,
  collectAndroidVerificationCoverageViolations,
  collectExecutorSafetyViolations,
  collectGradleBootstrapSequencingViolations,
  collectReferenceSourceShapeViolations,
  collectRuntimePrerequisiteViolations,
} from './executorSafety.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeStep(
  overrides: Partial<SwePlan['minimal_action_set'][number]> = {},
): SwePlan['minimal_action_set'][number] {
  return {
    step: 1,
    description: 'test step',
    tool: 'file_read',
    target: 'test.txt',
    rationale: 'testing',
    reversible: true,
    verification: 'exists',
    ...overrides,
  };
}

function makePlan(overrides: Partial<SwePlan> = {}): SwePlan {
  return {
    plan_version: '1.0',
    thinking: '',
    plan_type: 'IMPLEMENTATION_PLAN',
    task_summary: 'OBJECTIVE: test',
    known_facts: [],
    assumptions: [],
    risks: [],
    minimal_action_set: [],
    root_cause: 'N/A',
    out_of_scope: [],
    ...overrides,
  } satisfies SwePlan;
}

function assertRejectShape(
  actual: unknown,
  expectedFailureCount: number,
  expectedTag: string,
  expectedConditionPattern?: RegExp,
): asserts actual is QaVerdictReject {
  assert(actual !== null, 'expected a QaVerdictReject but got null');
  const reject = actual as QaVerdictReject;
  assert.equal(reject.verdict, 'REJECT');
  assert.equal(reject.failure_count, expectedFailureCount);
  assert.equal(reject.failures.length, expectedFailureCount);
  assert.equal(reject.overall_confidence, 5);
  if (expectedTag) {
    assert.equal(reject.failures[0]?.tag, expectedTag);
  }
  if (expectedConditionPattern) {
    assert.match(reject.failures[0]?.condition ?? '', expectedConditionPattern);
  }
}

// ─── assertBoundedPlanActivationContract ──────────────────────────────────────

test('assertBoundedPlanActivationContract: returns null for benchmark task (bypasses gate)', () => {
  const plan = makePlan({ minimal_action_set: [makeStep()] });
  const result = assertBoundedPlanActivationContract(
    plan,
    'Terminal-Bench 2 task: write something',
  );
  assert.equal(result, null);
});

test('assertBoundedPlanActivationContract: returns null when rawTask has no bounded contract', () => {
  const plan = makePlan({
    minimal_action_set: [makeStep({ tool: 'file_write', target: 'output.txt' })],
  });
  const result = assertBoundedPlanActivationContract(
    plan,
    'Look at the codebase and tell me what it does',
  );
  assert.equal(result, null);
});

test('assertBoundedPlanActivationContract: returns null when all requested targets are written', () => {
  const plan = makePlan({
    minimal_action_set: [makeStep({ step: 1, tool: 'file_write', target: 'output.txt' })],
  });
  const rawTask = 'Create a file called output.txt with the summary data';
  const result = assertBoundedPlanActivationContract(plan, rawTask);
  assert.equal(result, null);
});

test('assertBoundedPlanActivationContract: returns null when all requested targets match with different casing', () => {
  const plan = makePlan({
    minimal_action_set: [makeStep({ step: 1, tool: 'file_write', target: 'OUTPUT.TXT' })],
  });
  const rawTask = 'Create a file called output.txt with the summary data';
  const result = assertBoundedPlanActivationContract(plan, rawTask);
  assert.equal(result, null);
});

test('assertBoundedPlanActivationContract: returns reject string when a requested target is missing', () => {
  const plan = makePlan({
    minimal_action_set: [makeStep({ step: 1, tool: 'file_read', target: 'README.md' })],
  });
  const rawTask = 'Create a file called output.txt with the summary data';
  const result = assertBoundedPlanActivationContract(plan, rawTask);
  assert(result !== null, 'expected a rejection string');
  assert.match(result, /BOUNDED_CONTRACT_ACTIVATION_GATE/);
  assert.match(result, /missing required write targets/);
  assert.match(result, /output\.txt/);
});

test('assertBoundedPlanActivationContract: returns reject string when extra unrequested writes exist', () => {
  const plan = makePlan({
    minimal_action_set: [
      makeStep({ step: 1, tool: 'file_write', target: 'output.txt' }),
      makeStep({ step: 2, tool: 'file_write', target: 'extra.txt' }),
    ],
  });
  const rawTask = 'Create a file called output.txt with the summary data';
  const result = assertBoundedPlanActivationContract(plan, rawTask);
  assert(result !== null, 'expected a rejection string');
  assert.match(result, /BOUNDED_CONTRACT_ACTIVATION_GATE/);
  assert.match(result, /unrequested write targets/);
  assert.match(result, /extra\.txt/);
});

test('assertBoundedPlanActivationContract: reports both missing and extra when applicable', () => {
  const plan = makePlan({
    minimal_action_set: [makeStep({ step: 1, tool: 'file_write', target: 'extra.txt' })],
  });
  const rawTask = 'Create files called output.txt and report.md with the data';
  const result = assertBoundedPlanActivationContract(plan, rawTask);
  assert(result !== null, 'expected a rejection string');
  assert.match(result, /missing required write targets/);
  assert.match(result, /unrequested write targets/);
  assert.match(result, /output\.txt/);
  assert.match(result, /report\.md/);
  assert.match(result, /extra\.txt/);
});

test('assertBoundedPlanActivationContract: returns null for many requested targets (bounded=false)', () => {
  const rawTask = 'Create files called a.txt b.txt c.txt d.txt e.txt with data';
  const plan = makePlan({
    minimal_action_set: [makeStep({ step: 1, tool: 'file_write', target: 'a.txt' })],
  });
  const result = assertBoundedPlanActivationContract(plan, rawTask);
  assert.equal(result, null);
});

test('assertBoundedPlanActivationContract: returns null for empty plan minimal_action_set', () => {
  const rawTask = 'Create a file called output.txt with the summary data';
  const result = assertBoundedPlanActivationContract(makePlan(), rawTask);
  assert(result !== null, 'expected a rejection string for missing target');
});

// ─── collectRuntimePrerequisiteViolations ─────────────────────────────────────

const javaAvailable: JavaRuntimeStatus = {
  available: true,
  source: 'java_home',
  summary: 'Java 17.0.1',
};

const javaUnavailable: JavaRuntimeStatus = {
  available: false,
  source: 'missing',
  summary: 'not found',
};

const gradleAvailable: CommandRuntimeStatus = {
  available: true,
  source: 'path',
  summary: 'Gradle 8.5',
  command: 'gradle',
  resolvedPath: '/usr/bin/gradle',
};

const gradleUnavailable: CommandRuntimeStatus = {
  available: false,
  source: 'missing',
  summary: 'not found',
  command: 'gradle',
  resolvedPath: null,
};

test('collectRuntimePrerequisiteViolations: returns null when plan has no Gradle-like step', () => {
  const plan = makePlan({
    minimal_action_set: [makeStep({ step: 1, tool: 'shell_exec', target: 'npm test' })],
  });
  const result = collectRuntimePrerequisiteViolations(plan, javaAvailable, gradleAvailable);
  assert.equal(result, null);
});

test('collectRuntimePrerequisiteViolations: returns null when Java is available and Gradle not needed globally', () => {
  const plan = makePlan({
    minimal_action_set: [makeStep({ step: 1, tool: 'shell_exec', target: './gradlew test' })],
  });
  const result = collectRuntimePrerequisiteViolations(plan, javaAvailable, gradleUnavailable);
  assert.equal(result, null);
});

test('collectRuntimePrerequisiteViolations: returns reject when Java is unavailable without provisioning', () => {
  const plan = makePlan({
    minimal_action_set: [
      makeStep({ step: 1, tool: 'shell_exec', target: './gradlew assembleDebug' }),
    ],
  });
  const result = collectRuntimePrerequisiteViolations(plan, javaUnavailable, gradleUnavailable);
  assertRejectShape(result, 1, 'SFDIPOT-P', /RUNTIME_PREFLIGHT/);
  assert.match(result.failures[0]?.condition ?? '', /Java is currently unavailable/);
});

test('collectRuntimePrerequisiteViolations: returns reject when global Gradle is used without provisioning', () => {
  const plan = makePlan({
    minimal_action_set: [makeStep({ step: 1, tool: 'shell_exec', target: 'gradle build' })],
  });
  const result = collectRuntimePrerequisiteViolations(plan, javaAvailable, gradleUnavailable);
  assertRejectShape(result, 1, 'SFDIPOT-P', /RUNTIME_PREFLIGHT/);
  assert.match(
    result.failures[0]?.condition ?? '',
    /invokes global Gradle.*but gradle is not available/,
  );
});

test('collectRuntimePrerequisiteViolations: returns reject with both failures when Java and Gradle are both missing', () => {
  const plan = makePlan({
    minimal_action_set: [makeStep({ step: 1, tool: 'shell_exec', target: 'gradle build' })],
  });
  const result = collectRuntimePrerequisiteViolations(plan, javaUnavailable, gradleUnavailable);
  assertRejectShape(result, 2, 'SFDIPOT-P', /RUNTIME_PREFLIGHT/);
});

test('collectRuntimePrerequisiteViolations: no violation when Java provisioning step exists before Gradle', () => {
  const plan = makePlan({
    minimal_action_set: [
      makeStep({
        step: 1,
        tool: 'shell_exec',
        target: 'winget install EclipseAdoptium.Temurin.17.JDK',
      }),
      makeStep({ step: 2, tool: 'shell_exec', target: './gradlew assembleDebug' }),
    ],
  });
  const result = collectRuntimePrerequisiteViolations(plan, javaUnavailable, gradleUnavailable);
  assert.equal(result, null);
});

test('collectRuntimePrerequisiteViolations: gradlew command does not trigger global Gradle violation', () => {
  const plan = makePlan({
    minimal_action_set: [
      makeStep({ step: 1, tool: 'shell_exec', target: 'gradlew.bat assembleDebug' }),
    ],
  });
  const result = collectRuntimePrerequisiteViolations(plan, javaAvailable, gradleUnavailable);
  assert.equal(result, null);
});

test('collectRuntimePrerequisiteViolations: returns null when empty minimal_action_set', () => {
  const result = collectRuntimePrerequisiteViolations(makePlan(), javaAvailable, gradleAvailable);
  assert.equal(result, null);
});

// ─── collectGradleBootstrapSequencingViolations ───────────────────────────────

test('collectGradleBootstrapSequencingViolations: returns null when manifest has no project root', () => {
  const plan = makePlan({
    minimal_action_set: [
      makeStep({
        step: 1,
        tool: 'file_read',
        target: './reference-montecarlo-ledger/build.gradle.kts',
      }),
    ],
  });
  const result = collectGradleBootstrapSequencingViolations(
    plan,
    { target_project: 'global' } as never,
    gradleUnavailable,
  );
  assert.equal(result, null);
});

test('collectGradleBootstrapSequencingViolations: returns null when Gradle runtime is available', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-gradle-bootstrap-'));
  try {
    const manifest = { target_project: 'test', target_project_path: root } as never;
    const plan = makePlan({
      minimal_action_set: [makeStep({ step: 1, tool: 'shell_exec', target: 'gradle build' })],
    });
    const result = collectGradleBootstrapSequencingViolations(plan, manifest, gradleAvailable);
    assert.equal(result, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collectGradleBootstrapSequencingViolations: returns null when gradle-wrapper.jar exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-gradle-wrapper-'));
  try {
    mkdirSync(join(root, 'gradle', 'wrapper'), { recursive: true });
    writeFileSync(join(root, 'gradle', 'wrapper', 'gradle-wrapper.jar'), 'fake jar');
    const manifest = { target_project: 'test', target_project_path: root } as never;
    const plan = makePlan({
      minimal_action_set: [makeStep({ step: 1, tool: 'shell_exec', target: './gradlew build' })],
    });
    const result = collectGradleBootstrapSequencingViolations(plan, manifest, gradleUnavailable);
    assert.equal(result, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collectGradleBootstrapSequencingViolations: rejects mirrored Gradle reads during bootstrap', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-gradle-mirror-'));
  try {
    const manifest = { target_project: 'test', target_project_path: root } as never;
    const plan = makePlan({
      minimal_action_set: [
        makeStep({
          step: 1,
          tool: 'file_read',
          target: './reference-montecarlo-ledger/build.gradle.kts',
        }),
      ],
    });
    const result = collectGradleBootstrapSequencingViolations(plan, manifest, gradleUnavailable);
    assertRejectShape(result, 1, 'SFDIPOT-P', /GRADLE_BOOTSTRAP/);
    assert.match(result.failures[0]?.condition ?? '', /probes mirrored Gradle files/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collectGradleBootstrapSequencingViolations: shell_exec steps are not checked by file_read-only loop', () => {
  // The source loop only processes file_read steps (skips shell_exec/test_run),
  // so a shell_exec gradle step is never checked for global Gradle usage in this function.
  const root = mkdtempSync(join(tmpdir(), 'babel-gradle-shellskip-'));
  try {
    const manifest = { target_project: 'test', target_project_path: root } as never;
    const plan = makePlan({
      minimal_action_set: [makeStep({ step: 1, tool: 'shell_exec', target: 'gradle wrapper' })],
    });
    const result = collectGradleBootstrapSequencingViolations(plan, manifest, gradleUnavailable);
    assert.equal(result, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collectGradleBootstrapSequencingViolations: allows global Gradle when provisioning step exists first', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-gradle-provisioned-'));
  try {
    const manifest = { target_project: 'test', target_project_path: root } as never;
    const plan = makePlan({
      minimal_action_set: [
        makeStep({ step: 1, tool: 'shell_exec', target: 'winget install Gradle.Gradle' }),
        makeStep({ step: 2, tool: 'shell_exec', target: 'gradle wrapper' }),
      ],
    });
    const result = collectGradleBootstrapSequencingViolations(plan, manifest, gradleUnavailable);
    assert.equal(result, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collectGradleBootstrapSequencingViolations: empty minimal_action_set returns null', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-gradle-empty-'));
  try {
    const manifest = { target_project: 'test', target_project_path: root } as never;
    const result = collectGradleBootstrapSequencingViolations(
      makePlan(),
      manifest,
      gradleUnavailable,
    );
    assert.equal(result, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── collectExecutorSafetyViolations ──────────────────────────────────────────

test('collectExecutorSafetyViolations: returns null when manifest has no project root', () => {
  const plan = makePlan({
    minimal_action_set: [makeStep({ tool: 'file_read', target: 'test.txt' })],
  });
  const result = collectExecutorSafetyViolations(
    plan,
    { target_project: 'global' } as never,
    'Look at the codebase',
  );
  assert.equal(result, null);
});

test('collectExecutorSafetyViolations: rejects angle placeholders in step targets', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-angle-placeholder-'));
  try {
    const manifest = { target_project: 'test', target_project_path: root } as never;
    const plan = makePlan({
      minimal_action_set: [makeStep({ step: 1, tool: 'file_read', target: '<filename>' })],
    });
    const result = collectExecutorSafetyViolations(plan, manifest, 'Look at the codebase');
    assertRejectShape(result, 1, 'INCOMPLETE_SUBMISSION', /unresolved placeholder/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collectExecutorSafetyViolations: rejects glob targets in file_read steps', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-glob-read-'));
  try {
    const manifest = { target_project: 'test', target_project_path: root } as never;
    const plan = makePlan({
      minimal_action_set: [makeStep({ step: 1, tool: 'file_read', target: 'src/*.ts' })],
    });
    const result = collectExecutorSafetyViolations(plan, manifest, 'Look at the codebase');
    assertRejectShape(result, 1, 'SFDIPOT-P', /uses a glob target/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collectExecutorSafetyViolations: rejects glob targets in file_write steps', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-glob-write-'));
  try {
    const manifest = { target_project: 'test', target_project_path: root } as never;
    const plan = makePlan({
      minimal_action_set: [makeStep({ step: 1, tool: 'file_write', target: 'dist/*.js' })],
    });
    const result = collectExecutorSafetyViolations(plan, manifest, 'Look at the codebase');
    assertRejectShape(result, 1, 'SFDIPOT-P', /uses a glob target/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collectExecutorSafetyViolations: allows glob targets in directory_list steps', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-glob-dirlist-'));
  try {
    const manifest = { target_project: 'test', target_project_path: root } as never;
    const plan = makePlan({
      minimal_action_set: [makeStep({ step: 1, tool: 'directory_list', target: 'src/*' })],
    });
    const result = collectExecutorSafetyViolations(plan, manifest, 'Look at the codebase');
    assert.equal(result, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collectExecutorSafetyViolations: rejects out-of-root file_read paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-outofroot-'));
  try {
    const manifest = { target_project: 'test', target_project_path: root } as never;
    const plan = makePlan({
      minimal_action_set: [
        makeStep({
          step: 1,
          tool: 'file_read',
          target: 'C:\\Windows\\system32\\drivers\\etc\\hosts',
        }),
      ],
    });
    const result = collectExecutorSafetyViolations(plan, manifest, 'Look at the codebase');
    assertRejectShape(result, 1, 'SFDIPOT-P', /targets a path outside target_project_path/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collectExecutorSafetyViolations: rejects shell wrapper syntax in shell_exec steps', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-shell-wrapper-'));
  try {
    const manifest = { target_project: 'test', target_project_path: root } as never;
    const plan = makePlan({
      minimal_action_set: [makeStep({ step: 1, tool: 'shell_exec', target: 'cmd /c dir' })],
    });
    const result = collectExecutorSafetyViolations(plan, manifest, 'Look at the codebase');
    assertRejectShape(result, 1, 'SFDIPOT-P', /shell-wrapped or chained command/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collectExecutorSafetyViolations: rejects powershell wrapper', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-powershell-wrapper-'));
  try {
    const manifest = { target_project: 'test', target_project_path: root } as never;
    const plan = makePlan({
      minimal_action_set: [
        makeStep({ step: 1, tool: 'shell_exec', target: 'powershell.exe Get-ChildItem' }),
      ],
    });
    const result = collectExecutorSafetyViolations(plan, manifest, 'Look at the codebase');
    assertRejectShape(result, 1, 'SFDIPOT-P', /shell-wrapped or chained command/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collectExecutorSafetyViolations: rejects shell chaining without container execution', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-chaining-'));
  try {
    const manifest = { target_project: 'test', target_project_path: root } as never;
    const plan = makePlan({
      minimal_action_set: [
        makeStep({ step: 1, tool: 'shell_exec', target: 'npx tsc --noEmit && npx jest' }),
      ],
    });
    const result = collectExecutorSafetyViolations(plan, manifest, 'Look at the codebase');
    assertRejectShape(result, 1, 'SFDIPOT-P', /shell-wrapped or chained command/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collectExecutorSafetyViolations: rejects Windows absolute paths in shell command that are out-of-root', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-winpath-'));
  try {
    const manifest = { target_project: 'test', target_project_path: root } as never;
    const plan = makePlan({
      minimal_action_set: [
        makeStep({ step: 1, tool: 'shell_exec', target: 'python "C:\\Tools\\deploy.py"' }),
      ],
    });
    const result = collectExecutorSafetyViolations(plan, manifest, 'Look at the codebase');
    assert(result !== null, 'expected rejection');
    assert.equal(result.verdict, 'REJECT');
    assert.equal(result.overall_confidence, 5);
    if (process.platform === 'win32') {
      // On Windows, only the out-of-root path check fires
      assertRejectShape(result, 1, 'SFDIPOT-P', /out-of-root path/);
    } else {
      // On Linux, the backslash in C:\Tools\ also triggers the shell
      // operator check, producing 2 failures instead of 1
      assert.ok(result.failure_count >= 1, 'expected at least 1 failure');
      assert.ok(
        result.failures.some((f) => /out-of-root path/.test(f.condition)),
        'expected at least one out-of-root path failure',
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collectExecutorSafetyViolations: returns null for a clean plan with simple steps', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-clean-'));
  try {
    const manifest = { target_project: 'test', target_project_path: root } as never;
    const plan = makePlan({
      minimal_action_set: [
        makeStep({ step: 1, tool: 'file_read', target: 'src/index.ts' }),
        makeStep({ step: 2, tool: 'shell_exec', target: 'node --version' }),
        makeStep({ step: 3, tool: 'file_write', target: 'dist/out.js' }),
      ],
    });
    const result = collectExecutorSafetyViolations(plan, manifest, 'Look at the codebase');
    assert.equal(result, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collectExecutorSafetyViolations: triggers bounded contract violation before step loop', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-bounded-violation-'));
  try {
    const manifest = { target_project: 'test', target_project_path: root } as never;
    const plan = makePlan({
      minimal_action_set: [makeStep({ step: 1, tool: 'file_read', target: 'README.md' })],
    });
    const rawTask = 'Create a file called output.txt with the summary data';
    const result = collectExecutorSafetyViolations(plan, manifest, rawTask);
    assertRejectShape(result, 1, 'INCOMPLETE_SUBMISSION', /BOUNDED_CONTRACT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collectExecutorSafetyViolations: triggers many-file aggregation violation', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-manyfile-'));
  try {
    const manifest = { target_project: 'test', target_project_path: root } as never;
    const plan = makePlan({
      minimal_action_set: [
        makeStep({ step: 1, tool: 'file_read', target: 'logs/error.log' }),
        makeStep({ step: 2, tool: 'file_read', target: 'logs/access.log' }),
        makeStep({ step: 3, tool: 'file_write', target: 'summary.csv' }),
      ],
    });
    const rawTask = 'count all log files produce csv report';
    const result = collectExecutorSafetyViolations(plan, manifest, rawTask);
    assertRejectShape(result, 2, 'SFDIPOT-P', /MANY_FILE_AGGREGATION/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collectExecutorSafetyViolations: aggregates multiple step-level violations', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-multi-violation-'));
  try {
    const manifest = { target_project: 'test', target_project_path: root } as never;
    const plan = makePlan({
      minimal_action_set: [
        makeStep({ step: 1, tool: 'file_read', target: '<placeholder>' }),
        makeStep({ step: 2, tool: 'shell_exec', target: 'cmd /c echo test' }),
        makeStep({ step: 3, tool: 'file_write', target: 'src/*.ts' }),
      ],
    });
    const result = collectExecutorSafetyViolations(plan, manifest, 'Look at the codebase');
    assert(result !== null, 'expected a rejection');
    assert.equal(result.verdict, 'REJECT');
    assert.ok(
      result.failure_count >= 3,
      `expected at least 3 failures but got ${result.failure_count}`,
    );
    assert.equal(result.overall_confidence, 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collectExecutorSafetyViolations: cd with Windows drive path is rejected (cd wrapper + out-of-root path)', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-cd-wrapper-'));
  try {
    const manifest = { target_project: 'test', target_project_path: root } as never;
    const plan = makePlan({
      minimal_action_set: [
        makeStep({ step: 1, tool: 'shell_exec', target: 'cd C:\\Project && dir' }),
      ],
    });
    const result = collectExecutorSafetyViolations(plan, manifest, 'Look at the codebase');
    assert(result !== null, 'expected rejection');
    assert.equal(result.verdict, 'REJECT');
    assert.ok(
      result.failure_count >= 2,
      `expected at least 2 failures (cd wrapper + out-of-root path) but got ${result.failure_count}`,
    );
    assert.equal(result.overall_confidence, 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collectExecutorSafetyViolations: empty manifest target_project_path falls back to env var', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-env-fallback-'));
  const prevRoot = process.env['BABEL_PROJECT_ROOT'];
  try {
    process.env['BABEL_PROJECT_ROOT'] = root;
    const manifest = { target_project: 'test' } as never;
    const plan = makePlan({
      minimal_action_set: [makeStep({ step: 1, tool: 'file_read', target: 'test.txt' })],
    });
    const result = collectExecutorSafetyViolations(plan, manifest, 'Look at the codebase');
    assert.equal(result, null);
  } finally {
    if (prevRoot === undefined) {
      delete process.env['BABEL_PROJECT_ROOT'];
    } else {
      process.env['BABEL_PROJECT_ROOT'] = prevRoot;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── collectAndroidVerificationCoverageViolations ─────────────────────────────

test('collectAndroidVerificationCoverageViolations: returns null when not a deep autonomous Android task', () => {
  const plan = makePlan({
    minimal_action_set: [
      makeStep({ step: 1, tool: 'shell_exec', target: './gradlew assembleDebug' }),
      makeStep({ step: 2, tool: 'shell_exec', target: './gradlew test' }),
    ],
  });
  const manifest = {
    target_project: 'test',
    target_project_path: '/tmp/test',
    analysis: { pipeline_mode: 'chat', task_category: 'mobile' },
  } as never;
  const result = collectAndroidVerificationCoverageViolations(plan, manifest);
  assert.equal(result, null);
});

test('collectAndroidVerificationCoverageViolations: returns null when domain does not match', () => {
  const plan = makePlan({
    minimal_action_set: [
      makeStep({ step: 1, tool: 'shell_exec', target: './gradlew assembleDebug' }),
      makeStep({ step: 2, tool: 'shell_exec', target: './gradlew test' }),
    ],
  });
  const manifest = {
    target_project: 'test',
    target_project_path: '/tmp/test',
    analysis: { pipeline_mode: 'deep', task_category: 'backend' },
    instruction_stack: { domain_id: 'domain_python_backend' },
  } as never;
  const result = collectAndroidVerificationCoverageViolations(plan, manifest);
  assert.equal(result, null);
});

test('collectAndroidVerificationCoverageViolations: returns null when both assembleDebug and test exist early', () => {
  const plan = makePlan({
    minimal_action_set: [
      makeStep({ step: 1, tool: 'shell_exec', target: './gradlew assembleDebug' }),
      makeStep({ step: 2, tool: 'shell_exec', target: './gradlew test' }),
    ],
  });
  const manifest = {
    target_project: 'test',
    target_project_path: '/tmp/test',
    analysis: { pipeline_mode: 'deep', task_category: 'mobile' },
    instruction_stack: { domain_id: 'domain_android_kotlin' },
    resolution_policy: { task_shape_profile: 'full' },
  } as never;
  const result = collectAndroidVerificationCoverageViolations(plan, manifest);
  assert.equal(result, null);
});

test('collectAndroidVerificationCoverageViolations: returns null for source-only workspace', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-android-srconly-'));
  try {
    mkdirSync(join(root, 'app', 'src', 'main', 'java'), { recursive: true });
    writeFileSync(join(root, 'app', 'src', 'main', 'java', 'MainActivity.kt'), '');
    const manifest = {
      target_project: 'test',
      target_project_path: root,
      analysis: { pipeline_mode: 'deep', task_category: 'mobile' },
      instruction_stack: { domain_id: 'domain_android_kotlin' },
      resolution_policy: { task_shape_profile: 'full' },
    } as never;
    const plan = makePlan({
      minimal_action_set: [
        makeStep({ step: 1, tool: 'file_write', target: 'app/src/main/java/Util.kt' }),
      ],
    });
    const result = collectAndroidVerificationCoverageViolations(plan, manifest);
    assert.equal(result, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collectAndroidVerificationCoverageViolations: returns null for utility file profile', () => {
  const manifest = {
    target_project: 'test',
    target_project_path: '/tmp/test',
    analysis: { pipeline_mode: 'deep', task_category: 'mobile' },
    instruction_stack: { domain_id: 'domain_android_kotlin' },
    resolution_policy: { task_shape_profile: 'android_utility_file' },
  } as never;
  const plan = makePlan({
    minimal_action_set: [
      makeStep({ step: 1, tool: 'file_write', target: 'app/src/main/java/Util.kt' }),
    ],
  });
  const result = collectAndroidVerificationCoverageViolations(plan, manifest);
  assert.equal(result, null);
});

test('collectAndroidVerificationCoverageViolations: rejects when assembleDebug is missing', () => {
  const manifest = {
    target_project: 'test',
    target_project_path: '/tmp/test',
    analysis: { pipeline_mode: 'deep', task_category: 'mobile' },
    instruction_stack: { domain_id: 'domain_android_kotlin' },
    resolution_policy: { task_shape_profile: 'full' },
  } as never;
  const plan = makePlan({
    minimal_action_set: [
      makeStep({ step: 1, tool: 'file_write', target: 'app/src/main/java/Foo.kt' }),
    ],
  });
  const result = collectAndroidVerificationCoverageViolations(plan, manifest);
  assertRejectShape(result, 1, 'EVIDENCE-GATE', /gradlew assembleDebug/);
});

test('collectAndroidVerificationCoverageViolations: rejects when test is missing', () => {
  const manifest = {
    target_project: 'test',
    target_project_path: '/tmp/test',
    analysis: { pipeline_mode: 'deep', task_category: 'mobile' },
    instruction_stack: { domain_id: 'domain_android_kotlin' },
    resolution_policy: { task_shape_profile: 'full' },
  } as never;
  const plan = makePlan({
    minimal_action_set: [
      makeStep({ step: 1, tool: 'shell_exec', target: './gradlew assembleDebug' }),
    ],
  });
  const result = collectAndroidVerificationCoverageViolations(plan, manifest);
  assertRejectShape(result, 1, 'EVIDENCE-GATE', /gradlew test/);
});

test('collectAndroidVerificationCoverageViolations: uses warning_cleanup message for that profile', () => {
  const manifest = {
    target_project: 'test',
    target_project_path: '/tmp/test',
    analysis: { pipeline_mode: 'deep', task_category: 'mobile' },
    instruction_stack: { domain_id: 'domain_android_kotlin' },
    resolution_policy: { task_shape_profile: 'android_warning_cleanup' },
  } as never;
  const plan = makePlan({
    minimal_action_set: [
      makeStep({ step: 1, tool: 'file_write', target: 'app/src/main/java/Foo.kt' }),
    ],
  });
  const result = collectAndroidVerificationCoverageViolations(plan, manifest);
  assertRejectShape(result, 1, 'EVIDENCE-GATE', /warning-cleanup plans must verify/);
});

test('collectAndroidVerificationCoverageViolations: early verification within limit passes for warning_cleanup', () => {
  const manifest = {
    target_project: 'test',
    target_project_path: '/tmp/test',
    analysis: { pipeline_mode: 'deep', task_category: 'mobile' },
    instruction_stack: { domain_id: 'domain_android_kotlin' },
    resolution_policy: { task_shape_profile: 'android_warning_cleanup' },
  } as never;
  const plan = makePlan({
    minimal_action_set: [
      makeStep({ step: 5, tool: 'shell_exec', target: './gradlew assembleDebug' }),
      makeStep({ step: 6, tool: 'shell_exec', target: './gradlew test' }),
    ],
  });
  const result = collectAndroidVerificationCoverageViolations(plan, manifest);
  assert.equal(result, null);
});

test('collectAndroidVerificationCoverageViolations: rejects when first verification step is too late', () => {
  const manifest = {
    target_project: 'test',
    target_project_path: '/tmp/test',
    analysis: { pipeline_mode: 'deep', task_category: 'mobile' },
    instruction_stack: { domain_id: 'domain_android_kotlin' },
    resolution_policy: { task_shape_profile: 'full' },
  } as never;
  const plan = makePlan({
    minimal_action_set: [
      makeStep({ step: 1, tool: 'file_write', target: 'src/Foo.java' }),
      makeStep({ step: 9, tool: 'shell_exec', target: './gradlew assembleDebug' }),
      makeStep({ step: 10, tool: 'shell_exec', target: './gradlew test' }),
    ],
  });
  const result = collectAndroidVerificationCoverageViolations(plan, manifest);
  assert(result !== null, 'expected rejection');
  // The verification exists but is too late (step 9 > 8 limit for full profile)
  assert.match(result.failures[0]?.condition ?? '', /first verification step is too late/);
});

test('collectAndroidVerificationCoverageViolations: rawTask with Android utility request returns null', () => {
  const manifest = {
    target_project: 'test',
    target_project_path: '/tmp/test',
    analysis: { pipeline_mode: 'deep', task_category: 'mobile' },
    instruction_stack: { domain_id: 'domain_android_kotlin' },
    resolution_policy: { task_shape_profile: 'full' },
  } as never;
  const plan = makePlan({
    minimal_action_set: [
      makeStep({
        step: 1,
        tool: 'file_write',
        target: 'app/src/main/java/com/example/BillingHelper.kt',
      }),
    ],
  });
  const rawTask = 'Create a new file called HelperUtil.kt with a utility function';
  const result = collectAndroidVerificationCoverageViolations(plan, manifest, rawTask);
  assert.equal(result, null);
});

test('collectAndroidVerificationCoverageViolations: empty minimal_action_set returns reject', () => {
  const manifest = {
    target_project: 'test',
    target_project_path: '/tmp/test',
    analysis: { pipeline_mode: 'deep', task_category: 'mobile' },
    instruction_stack: { domain_id: 'domain_android_kotlin' },
    resolution_policy: { task_shape_profile: 'full' },
  } as never;
  const result = collectAndroidVerificationCoverageViolations(makePlan(), manifest);
  assertRejectShape(result, 1, 'EVIDENCE-GATE', /no verification steps were scheduled/);
});

