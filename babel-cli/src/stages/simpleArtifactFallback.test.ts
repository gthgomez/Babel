import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDeterministicSimpleFileContent,
  getDeterministicSimpleRepairWrite,
  getDirectBoundedWritePlan,
  getNextDeterministicSimpleWrite,
} from './simpleArtifactFallback.js';
import type { SwePlan } from '../schemas/agentContracts.js';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const basePlan = {
  plan_version: '1.0',
  thinking: 'test',
  plan_type: 'IMPLEMENTATION_PLAN',
  task_summary: 'test',
  known_facts: [],
  assumptions: [],
  risks: [],
  minimal_action_set: [
    {
      step: 1,
      description: 'Create note',
      tool: 'file_write',
      target: 'notes/prompt-budget-observations.md',
      rationale: 'test',
      reversible: true,
      verification: 'test',
    },
    {
      step: 2,
      description: 'Create report',
      tool: 'file_write',
      target: 'WRITE_REPORT.md',
      rationale: 'test',
      reversible: true,
      verification: 'test',
    },
  ],
  root_cause: 'N/A',
  out_of_scope: [],
} satisfies SwePlan;

test('deterministic fallback selects the next unwritten bounded file_write target', () => {
  const rawTask =
    'Create notes/prompt-budget-observations.md summarizing likely causes of prompt bloat. Also create WRITE_REPORT.md summarizing what was created.';

  const first = getNextDeterministicSimpleWrite(basePlan, rawTask, []);
  assert.equal(first?.target, 'notes/prompt-budget-observations.md');

  const second = getNextDeterministicSimpleWrite(basePlan, rawTask, [{
    step: 1,
    tool: 'file_write',
    target: 'notes/prompt-budget-observations.md',
    exit_code: 0,
    stdout: 'Written',
    stderr: '',
    verified: true,
  }]);
  assert.equal(second?.target, 'WRITE_REPORT.md');
});

test('deterministic fallback emits Kotlin object content for filename sanitizers', () => {
  const content = buildDeterministicSimpleFileContent(
    'app/src/main/java/com/example/live/SanitizeFilename.kt',
    'Create app/src/main/java/com/example/live/SanitizeFilename.kt with a Kotlin object named SanitizeFilename exposing fun from(input: String): String that trims the input, replaces spaces with underscores, removes characters other than letters, digits, underscore, dash, and dot, and returns "untitled" if the result is blank.',
  );

  assert.match(content, /object SanitizeFilename/);
  assert.match(content, /fun from\(input: String\): String/);
  assert.match(content, /\.replace\(Regex\("\\\\s\+"\), "_"\)/);
  assert.match(content, /"untitled"/);
});

test('deterministic fallback emits display-name helper content for exact signature tasks', () => {
  const content = buildDeterministicSimpleFileContent(
    'src/formatDisplayName.ts',
    'Add src/formatDisplayName.ts exporting formatDisplayName(firstName: string, lastName: string, email: string): string. It should trim names and fall back to email when both names are blank.',
  );

  assert.match(content, /formatDisplayName\(firstName: string, lastName: string, email: string\): string/);
  assert.match(content, /firstName\.trim\(\)/);
  assert.match(content, /lastName\.trim\(\)/);
  assert.match(content, /email/);
});

test('deterministic fallback emits accessible renderToggle content', () => {
  const content = buildDeterministicSimpleFileContent(
    'src/toggleWidget.js',
    'Update src/toggleWidget.js so renderToggle(label, enabled) returns an accessible button string with aria-pressed, toggle-widget--enabled, and toggle-widget--disabled classes.',
  );

  assert.match(content, /renderToggle\(label, enabled\)/);
  assert.match(content, /aria-pressed/);
  assert.match(content, /toggle-widget--enabled/);
  assert.match(content, /toggle-widget--disabled/);
});

test('deterministic fallback emits renderToggle CSS content', () => {
  const content = buildDeterministicSimpleFileContent(
    'src/toggleWidget.css',
    'Update src/toggleWidget.css so renderToggle(label, enabled) has matching CSS styles for toggle-widget, toggle-widget--enabled, and toggle-widget--disabled classes.',
  );

  assert.match(content, /\.toggle-widget/);
  assert.match(content, /\.toggle-widget--enabled/);
  assert.match(content, /\.toggle-widget--disabled/);
});

test('deterministic fallback emits bill mapper Kotlin content', () => {
  const mapper = buildDeterministicSimpleFileContent(
    'app/src/main/java/com/example/live/BillMapper.kt',
    'Add app/src/main/java/com/example/live/BillMapper.kt with object BillMapper exposing fun displayAmount(cents: Long): String that formats integer cents as dollars with two decimals.',
  );
  const entity = buildDeterministicSimpleFileContent(
    'app/src/main/java/com/example/live/BillEntity.kt',
    'Update app/src/main/java/com/example/live/BillEntity.kt to include a displayAmount(): String method that delegates to BillMapper.displayAmount(amountCents).',
  );

  assert.match(mapper, /object BillMapper/);
  assert.match(mapper, /fun displayAmount\(cents: Long\): String/);
  assert.match(mapper, /String\.format\("\$%\.2f", cents \/ 100\.0\)/);
  assert.match(entity, /fun displayAmount\(\): String = BillMapper\.displayAmount\(amountCents\)/);
});

test('deterministic fallback writes bound exact literal instead of generic content', () => {
  const content = buildDeterministicSimpleFileContent(
    'exact-status.txt',
    'Create exact-status.txt containing the exact string "autonomous exact ok". The final file name must be exactly exact-status.txt.',
  );

  assert.equal(content, 'autonomous exact ok');
  assert.doesNotMatch(content, /Created for the requested bounded task/);
});

test('deterministic repair only rewrites planned bounded targets', () => {
  const rawTask =
    'Create notes/prompt-budget-observations.md summarizing likely causes of prompt bloat. Also create WRITE_REPORT.md summarizing what was created.';

  assert.equal(
    getDeterministicSimpleRepairWrite(basePlan, rawTask, 'notes/prompt-budget-observations.md')?.target,
    'notes/prompt-budget-observations.md',
  );
  assert.equal(
    getDeterministicSimpleRepairWrite(basePlan, rawTask, 'notes/unrequested.md'),
    null,
  );
});

test('direct bounded write plan accepts greenfield file-only bounded work', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-direct-plan-'));
  try {
    const rawTask =
      'Create notes/prompt-budget-observations.md summarizing likely causes of prompt bloat. Also create WRITE_REPORT.md summarizing what was created.';
    const directPlan = getDirectBoundedWritePlan(basePlan, rawTask, root);

    assert.equal(directPlan?.writes.length, 2);
    assert.deepEqual(directPlan?.writes.map(write => write.target), [
      'notes/prompt-budget-observations.md',
      'WRITE_REPORT.md',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('direct bounded write plan creates greenfield exact string with bound literal', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-direct-plan-exact-'));
  try {
    const rawTask =
      'Create exact-status.txt containing the exact string "autonomous exact ok". The final file name must be exactly exact-status.txt.';
    const exactPlan: SwePlan = {
      ...basePlan,
      minimal_action_set: [
        {
          step: 1,
          description: 'Create exact status file',
          tool: 'file_write',
          target: 'exact-status.txt',
          rationale: 'Exact requested artifact.',
          reversible: true,
          verification: 'File contains exact literal.',
        },
      ],
    };

    const directPlan = getDirectBoundedWritePlan(exactPlan, rawTask, root);

    assert.equal(directPlan?.writes.length, 1);
    assert.equal(directPlan?.writes[0]?.target, 'exact-status.txt');
    assert.equal(directPlan?.writes[0]?.content, 'autonomous exact ok');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('direct bounded write plan updates existing entire-file exact string', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-direct-plan-exact-update-'));
  try {
    writeFileSync(join(root, 'exact-status.txt'), 'old value', 'utf-8');
    const rawTask =
      'Update exact-status.txt so its entire contents are the exact string autonomous exact ok. The final file name must remain exactly exact-status.txt.';
    const exactPlan: SwePlan = {
      ...basePlan,
      minimal_action_set: [
        {
          step: 1,
          description: 'Update exact status file',
          tool: 'file_write',
          target: 'exact-status.txt',
          rationale: 'Exact entire-file artifact.',
          reversible: true,
          verification: 'File equals exact literal.',
        },
      ],
    };

    const directPlan = getDirectBoundedWritePlan(exactPlan, rawTask, root);

    assert.equal(directPlan?.writes.length, 1);
    assert.equal(directPlan?.writes[0]?.content, 'autonomous exact ok');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('direct bounded write plan refuses existing-file overwrites', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-direct-plan-existing-'));
  try {
    mkdirSync(join(root, 'notes'), { recursive: true });
    writeFileSync(join(root, 'notes', 'prompt-budget-observations.md'), 'existing', 'utf-8');
    const rawTask =
      'Create notes/prompt-budget-observations.md summarizing likely causes of prompt bloat. Also create WRITE_REPORT.md summarizing what was created.';

    assert.equal(getDirectBoundedWritePlan(basePlan, rawTask, root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('direct bounded write plan refuses ambiguous file/literal bindings', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-direct-plan-ambiguous-'));
  try {
    const rawTask =
      'Create a.txt and b.txt containing the exact strings alpha and beta.';
    const ambiguousPlan: SwePlan = {
      ...basePlan,
      minimal_action_set: [
        {
          step: 1,
          description: 'Create first file',
          tool: 'file_write',
          target: 'a.txt',
          rationale: 'test',
          reversible: true,
          verification: 'test',
        },
        {
          step: 2,
          description: 'Create second file',
          tool: 'file_write',
          target: 'b.txt',
          rationale: 'test',
          reversible: true,
          verification: 'test',
        },
      ],
    };

    assert.equal(getDirectBoundedWritePlan(ambiguousPlan, rawTask, root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('direct bounded write plan refuses shell plans and unrequested outputs', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-direct-plan-refuse-'));
  try {
    const rawTask =
      'Create notes/prompt-budget-observations.md summarizing likely causes of prompt bloat. Also create WRITE_REPORT.md summarizing what was created.';
    const shellPlan: SwePlan = {
      ...basePlan,
      minimal_action_set: [
        ...basePlan.minimal_action_set,
        {
          step: 3,
          description: 'run tests',
          tool: 'test_run',
          target: 'npm test',
          rationale: 'test',
          reversible: true,
          verification: 'test',
        },
      ],
    };
    const extraTargetPlan: SwePlan = {
      ...basePlan,
      minimal_action_set: [
        ...basePlan.minimal_action_set,
        {
          step: 3,
          description: 'extra',
          tool: 'file_write',
          target: 'notes/extra.md',
          rationale: 'test',
          reversible: true,
          verification: 'test',
        },
      ],
    };

    assert.equal(getDirectBoundedWritePlan(shellPlan, rawTask, root), null);
    assert.equal(getDirectBoundedWritePlan(extraTargetPlan, rawTask, root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
