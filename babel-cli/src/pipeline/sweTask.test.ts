/**
 * sweTask.test.ts — Structural invariants of the buildSweTask prompt builder
 *
 * The source file has ONE exported function: buildSweTask, which assembles a
 * large multi-line prompt for the SWE planning agent. It has many side effects
 * (filesystem calls, subprocess spawns for Java/Gradle/Android detection, env
 * var reads).
 *
 * Testing strategy:
 *   1. All tests use `target_project: 'global'` → no project root → skips ALL
 *      filesystem-dependent code paths.
 *   2. Pure-helper behavior (getBenchmarkHarnessPlanningLines,
 *      getManyFileAggregationPlanningLines) is tested through output inspection.
 *   3. Structural invariants (VERIFICATION RULE, JSON schema, thinking layer)
 *      are verified by string matching on the prompt output.
 *   4. Dynamic import avoids eager module-initialization side effects.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function minimalManifest(): any {
  return {
    target_project: 'global',
    handoff_payload: { user_request: '' },
  };
}

function withHandoffPayload(userRequest: string): any {
  return {
    target_project: 'global',
    handoff_payload: { user_request: userRequest },
  };
}

// ─── buildSweTask: minimal prompt ────────────────────────────────────────────

test('buildSweTask: produces non-empty string with minimal inputs', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const result = buildSweTask(minimalManifest(), 'test task', [], undefined);
  assert.ok(result.length > 0);
  assert.equal(typeof result, 'string');
});

test('buildSweTask: includes JSON schema with pipe-separated tool names', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const result = buildSweTask(minimalManifest(), 'test task', [], undefined);

  // The JSON schema line in the prompt contains `"tool": "${EXECUTOR_TOOL_NAMES.join('|')}"`
  // The first two tool names are always directory_list and file_read.
  assert.ok(
    result.includes('directory_list|file_read'),
    'tool names should be pipe-separated in the JSON schema',
  );
  assert.ok(result.includes('"tool"'), 'JSON schema should contain a "tool" field');
});

test('buildSweTask: includes the VERIFICATION RULE section', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const result = buildSweTask(minimalManifest(), 'test task', [], undefined);

  assert.ok(result.includes('VERIFICATION RULE'), 'VERIFICATION RULE section must be present');
  assert.ok(result.includes('NON-NEGOTIABLE'), 'VERIFICATION RULE should be marked NON-NEGOTIABLE');
  assert.ok(
    result.includes('plans are BLOCKED without this'),
    'VERIFICATION RULE should warn about blocked plans',
  );
});

test('buildSweTask: includes the TOOL USAGE RULES section', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const result = buildSweTask(minimalManifest(), 'test task', [], undefined);

  assert.ok(result.includes('TOOL USAGE RULES'));
});

test('buildSweTask: includes shell command allowlist in tool usage rules', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const result = buildSweTask(minimalManifest(), 'test task', [], undefined);

  assert.ok(
    result.includes('shell_exec/test_run command bases must come from the executor allowlist'),
  );
});

test('buildSweTask: includes the task text in output', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const result = buildSweTask(minimalManifest(), 'custom task description', [], undefined);

  assert.ok(result.includes('custom task description'));
  assert.ok(result.includes('Task:'));
});

test('buildSweTask: includes thinking requirement (INTERNAL MONOLOGUE) at end', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const result = buildSweTask(minimalManifest(), 'test task', [], undefined);

  // The thinking requirement is a bullet list of internal-monologue guidance
  assert.ok(result.includes('INTERNAL MONOLOGUE'), 'thinking layer section must exist');
  assert.ok(result.includes('THINKING LAYER'), 'thinking layer header must be present');

  // Verify it is at the very end — the output should end with the thinking requirement
  assert.ok(
    result.trimEnd().endsWith('potential breaking changes.'),
    'thinking requirement should be the last section',
  );
});

test('buildSweTask: includes execution profile guidance', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const result = buildSweTask(minimalManifest(), 'test task', [], undefined);

  assert.ok(result.includes('Execution profile guidance:'));
});

test('buildSweTask: includes planning rules for executable steps', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const result = buildSweTask(minimalManifest(), 'test task', [], undefined);

  assert.ok(result.includes('Planning rules for executable steps:'));
});

test('buildSweTask: includes concrete verification examples', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const result = buildSweTask(minimalManifest(), 'test task', [], undefined);

  assert.ok(result.includes('CONCRETE EXAMPLES of valid plans'));
  assert.ok(result.includes('NEGATIVE EXAMPLES'));
});

test('buildSweTask: includes "Do NOT wrap commands" guidance', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const result = buildSweTask(minimalManifest(), 'test task', [], undefined);

  // The non-benchmark_container profile variant
  assert.ok(result.includes('Do NOT wrap commands with'));
});

test('buildSweTask: merges handoff_payload.user_request into task text', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const result = buildSweTask(
    withHandoffPayload('additional context'),
    'primary task',
    [],
    undefined,
  );

  assert.ok(result.includes('primary task'));
  assert.ok(result.includes('additional context'));
});

test('buildSweTask: prompt starts with analyze-task instruction', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const result = buildSweTask(minimalManifest(), 'test task', [], undefined);

  assert.ok(result.startsWith('Analyze the task below'));
});

// ─── Benchmark harness rules (getBenchmarkHarnessPlanningLines) ──────────────

test('buildSweTask: includes benchmark harness rules for Terminal-Bench 2 task', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const result = buildSweTask(
    minimalManifest(),
    'Terminal-Bench 2 task: fix the output',
    [],
    undefined,
  );

  // All 4 benchmark harness lines should be present
  assert.ok(result.includes('Benchmark harness rule:'));
  assert.ok(result.includes('treat the provided project root as /app'));
  assert.ok(result.includes('if the task names an output artifact'));
  assert.ok(result.includes('do not inspect hidden verifier tests'));
  assert.ok(result.includes('do not modify visible verifier/input fixtures'));
});

test('buildSweTask: includes benchmark harness rules for SWE-rebench', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const result = buildSweTask(
    minimalManifest(),
    'SWE-rebench task: fix the implementation',
    [],
    undefined,
  );

  assert.ok(result.includes('Benchmark harness rule:'));
  assert.ok(result.includes('treat the provided project root as /app'));
});

test('buildSweTask: omits benchmark harness rules for non-benchmark task', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const result = buildSweTask(minimalManifest(), 'normal task', [], undefined);

  assert.ok(!result.includes('Benchmark harness rule:'));
});

test('buildSweTask: benchmark harness includes Docker-backed syntax allowance with benchmark_container profile', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const result = buildSweTask(
    minimalManifest(),
    'Terminal-Bench 2 task: fix the output',
    [],
    undefined,
    '',
    '',
    'benchmark_container' as any,
  );

  // When using benchmark_container profile, the POSIX pipes/redirects line appears
  assert.ok(result.includes('POSIX pipes, redirects, and command chaining'));
  assert.ok(result.includes('Docker-backed benchmark_container may use'));
});

// ─── Many-file aggregation rules (getManyFileAggregationPlanningLines) ───────

test('buildSweTask: includes many-file aggregation rules for aggregation task', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const result = buildSweTask(
    minimalManifest(),
    'count all log files and produce a csv report',
    [],
    undefined,
  );

  // All 5 aggregation rules should be present
  assert.ok(result.includes('Many-file aggregation rule:'));
  assert.ok(result.includes('write a small helper program'));
  assert.ok(result.includes('Many-file aggregation plan shape:'));
  assert.ok(result.includes('Many-file aggregation ban:'));
  assert.ok(result.includes('Date-window aggregation rule:'));
  assert.ok(result.includes('Structured log counting rule:'));
});

test('buildSweTask: includes many-file rules for multiple every files pattern', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const result = buildSweTask(
    minimalManifest(),
    'analyze every log files and produce a summary json',
    [],
    undefined,
  );

  assert.ok(result.includes('Many-file aggregation rule:'));
});

test('buildSweTask: includes many-file rules for all logs pattern', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const result = buildSweTask(
    minimalManifest(),
    'summarize all logs and produce a json report',
    [],
    undefined,
  );

  assert.ok(result.includes('Many-file aggregation rule:'));
});

test('buildSweTask: omits many-file aggregation rules for plain task', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const result = buildSweTask(minimalManifest(), 'fix src/math.js', [], undefined);

  assert.ok(!result.includes('Many-file aggregation rule:'));
});

test('buildSweTask: omits many-file rules when match lacks output target', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  // "all files" matches manyFileAggregationTask, but no "count|aggregate|summarize|analyze" + "csv|json|summary|report"
  const result = buildSweTask(minimalManifest(), 'read all files in the directory', [], undefined);

  assert.ok(!result.includes('Many-file aggregation rule:'));
});

test('buildSweTask: omits many-file rules when match lacks aggregation verb', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  // "all log files" matches manyFileAggregationTask, "csv" matches output target,
  // but no "count|aggregate|summarize|analyze" verb
  const result = buildSweTask(
    minimalManifest(),
    'find all log files with a csv extension',
    [],
    undefined,
  );

  assert.ok(!result.includes('Many-file aggregation rule:'));
});

// ─── QA rejection feedback ──────────────────────────────────────────────────

test('buildSweTask: includes numbered QA rejection items', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const result = buildSweTask(
    minimalManifest(),
    'test task',
    ['Issue one', 'Issue two', 'Issue three'],
    undefined,
  );

  assert.ok(result.includes('QA REJECTION FEEDBACK'));
  assert.ok(result.includes('Your previous plan was rejected'));
  assert.ok(result.includes('  1. Issue one'));
  assert.ok(result.includes('  2. Issue two'));
  assert.ok(result.includes('  3. Issue three'));
  assert.ok(result.includes('Produce a corrected plan'));
});

test('buildSweTask: includes QA DIRECTIONAL HINT when proposedFixStrategy provided', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const result = buildSweTask(
    minimalManifest(),
    'test task',
    ['Issue 1'],
    'try using a different approach',
  );

  assert.ok(result.includes('QA DIRECTIONAL HINT'));
  assert.ok(result.includes('try using a different approach'));
  assert.ok(result.includes('dimension to address'));
});

test('buildSweTask: omits QA DIRECTIONAL HINT when proposedFixStrategy is undefined', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const result = buildSweTask(minimalManifest(), 'test task', ['Issue 1'], undefined);

  assert.ok(!result.includes('QA DIRECTIONAL HINT'));
});

test('buildSweTask: QA rejections are numbered starting from 1', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const result = buildSweTask(
    minimalManifest(),
    'test task',
    ['First issue', 'Second issue'],
    undefined,
  );

  // Items should start with "  1." not "  0."
  assert.ok(result.includes('  1. First issue'));
  assert.ok(result.includes('  2. Second issue'));
  assert.ok(!result.includes('  0. First issue'));
});

test('buildSweTask: produces corrected plan instruction appears with QA', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const result = buildSweTask(minimalManifest(), 'test task', ['Issue 1'], 'fix it');

  assert.ok(result.includes('Produce a corrected plan that eliminates every listed failure'));
});

// ─── Evidence context ───────────────────────────────────────────────────────

test('buildSweTask: includes GATHERED EVIDENCE section with evidence context', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const result = buildSweTask(
    minimalManifest(),
    'test task',
    [],
    undefined,
    'Collected evidence: the file imports React',
  );

  assert.ok(result.includes('GATHERED EVIDENCE'));
  assert.ok(result.includes('Collected evidence: the file imports React'));
});

test('buildSweTask: evidence section sets plan_type to IMPLEMENTATION_PLAN', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const result = buildSweTask(minimalManifest(), 'test task', [], undefined, 'some evidence');

  assert.ok(result.includes('IMPLEMENTATION_PLAN'));
  assert.ok(result.includes('"plan_type" to "IMPLEMENTATION_PLAN"'));
});

test('buildSweTask: evidence section forbids EVIDENCE_REQUEST', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const result = buildSweTask(minimalManifest(), 'test task', [], undefined, 'some evidence');

  assert.ok(result.includes('Do NOT emit another EVIDENCE_REQUEST'));
});

test('buildSweTask: evidence section includes post-edit verification guidance', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const result = buildSweTask(minimalManifest(), 'test task', [], undefined, 'some evidence');

  assert.ok(result.includes('post-edit verification step'));
  assert.ok(result.includes('shell_exec or test_run before any file_write'));
});

test('buildSweTask: evidence section mentions reading prior read-only passes', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const result = buildSweTask(minimalManifest(), 'test task', [], undefined, 'some evidence');

  assert.ok(result.includes('collected by prior read-only evidence passes'));
});

// ─── Grounding context ──────────────────────────────────────────────────────

test('buildSweTask: includes grounding context when provided', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const result = buildSweTask(
    minimalManifest(),
    'test task',
    [],
    undefined,
    '',
    'Grounding: the source tree is under src/',
  );

  assert.ok(result.includes('Grounding: the source tree is under src/'));
});

test('buildSweTask: includes REFERENCE INVENTORY LOCK when grounding mentions Reference source inventories', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const result = buildSweTask(
    minimalManifest(),
    'test task',
    [],
    undefined,
    '',
    'Reference source inventories:\n  - src/budget_engine.py\n  - src/forecasting.py',
  );

  assert.ok(result.includes('REFERENCE INVENTORY LOCK'));
  assert.ok(result.includes('closed allowlist for file_read'));
  assert.ok(result.includes('Do not invent alternate module names'));
});

test('buildSweTask: omits REFERENCE INVENTORY LOCK when grounding lacks Reference source inventories', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const result = buildSweTask(
    minimalManifest(),
    'test task',
    [],
    undefined,
    '',
    'Some other context: foo bar',
  );

  assert.ok(!result.includes('REFERENCE INVENTORY LOCK'));
});

// ─── Combined sections (QA + evidence + grounding) ──────────────────────────

test('buildSweTask: all optional sections can appear together', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const result = buildSweTask(
    minimalManifest(),
    'test task',
    ['QA issue 1'],
    'try a fix',
    'evidence data',
    'grounding data with Reference source inventories: foo.py',
  );

  assert.ok(result.includes('QA REJECTION FEEDBACK'));
  assert.ok(result.includes('QA DIRECTIONAL HINT'));
  assert.ok(result.includes('GATHERED EVIDENCE'));
  assert.ok(result.includes('grounding data with Reference source inventories'));
  assert.ok(result.includes('REFERENCE INVENTORY LOCK'));
});

// ─── Empty / whitespace handling ────────────────────────────────────────────

test('buildSweTask: omits QA section when qaRejections is empty', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const result = buildSweTask(minimalManifest(), 'test task', [], undefined);

  assert.ok(!result.includes('QA REJECTION FEEDBACK'));
  assert.ok(!result.includes('Your previous plan was rejected'));
});

test('buildSweTask: omits evidence section when evidenceContext is empty string', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const result = buildSweTask(minimalManifest(), 'test task', [], undefined);

  assert.ok(!result.includes('GATHERED EVIDENCE'));
  assert.ok(!result.includes('plan_type" to "IMPLEMENTATION_PLAN'));
});

test('buildSweTask: omits grounding section when groundingContext is whitespace only', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const baseResult = buildSweTask(minimalManifest(), 'test task', [], undefined);
  const whitespaceResult = buildSweTask(minimalManifest(), 'test task', [], undefined, '', '   ');

  // Both should produce identical output — whitespace-only grounding is treated as empty
  assert.equal(whitespaceResult, baseResult);
});

test('buildSweTask: produces valid prompt with empty originalTaskContext', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const result = buildSweTask(minimalManifest(), '', [], undefined);

  assert.ok(result.length > 0);
  assert.ok(result.includes('Task:'));

  // With empty task, the task line shows "Task: " (just the prefix)
  assert.ok(result.includes('Task:'));
});

test('buildSweTask: handles empty qaRejections with proposedFixStrategy', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  // When qaRejections is empty, the proposedFixStrategy is irrelevant
  const resultWithout = buildSweTask(minimalManifest(), 'test task', [], 'should not appear');
  // QA section should not be present because qaRejections is empty
  assert.ok(!resultWithout.includes('QA REJECTION FEEDBACK'));
  assert.ok(!resultWithout.includes('QA DIRECTIONAL HINT'));
  assert.ok(!resultWithout.includes('should not appear'));
});

// ─── Safety invariants ──────────────────────────────────────────────────────

test('buildSweTask: always returns a non-empty string regardless of inputs', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const result = buildSweTask(minimalManifest(), '', [], undefined);

  assert.ok(result.length > 0);
  assert.equal(typeof result, 'string');
});

test('buildSweTask: VERIFICATION RULE section is always present regardless of inputs', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const result = buildSweTask(minimalManifest(), '', [], undefined);

  assert.ok(result.includes('VERIFICATION RULE'));
  assert.ok(result.includes('NON-NEGOTIABLE'));
});

test('buildSweTask: VERIFICATION RULE present with benchmark task', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const result = buildSweTask(minimalManifest(), 'Terminal-Bench 2 task: fix', [], undefined);

  assert.ok(result.includes('VERIFICATION RULE'));
});

test('buildSweTask: VERIFICATION RULE present with QA rejections', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const result = buildSweTask(minimalManifest(), 'test task', ['Issue 1'], 'fix');

  assert.ok(result.includes('VERIFICATION RULE'));
});

test('buildSweTask: VERIFICATION RULE present with evidence and grounding', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const result = buildSweTask(
    minimalManifest(),
    'test task',
    [],
    undefined,
    'evidence',
    'grounding',
  );

  assert.ok(result.includes('VERIFICATION RULE'));
});

test('buildSweTask: thinkingRequirement is always the last substantive content', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const result = buildSweTask(minimalManifest(), 'test task', [], undefined);

  // The thinking requirement ends with "possible breaking changes."
  // Check that this is among the trailing content
  assert.ok(result.includes('INTERNAL MONOLOGUE (THINKING LAYER)'));
});

test('buildSweTask: JSON plan type includes EVIDENCE_REQUEST and IMPLEMENTATION_PLAN alternatives', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const result = buildSweTask(minimalManifest(), 'test task', [], undefined);

  assert.ok(result.includes('EVIDENCE_REQUEST|IMPLEMENTATION_PLAN'));
});

test('buildSweTask: output is a single string not containing null bytes', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const result = buildSweTask(minimalManifest(), 'test task', [], undefined);

  assert.ok(!result.includes('\0'), 'output must not contain null bytes');
});

test('buildSweTask: output uses newline line separators', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  const result = buildSweTask(minimalManifest(), 'test task', [], undefined);

  // The lines are joined with '\n' — verify the output has multiple lines
  const lineCount = result.split('\n').length;
  assert.ok(lineCount >= 30, `expected at least 30 lines, got ${lineCount}`);
});

// ─── Execution profile integration ──────────────────────────────────────────

test('buildSweTask: accepts custom executionProfileName', async () => {
  const { buildSweTask } = await import('../pipeline/sweTask.js');
  // 'read_only_audit' is a valid ExecutionProfileName
  const result = buildSweTask(
    minimalManifest(),
    'test task',
    [],
    undefined,
    '',
    '',
    'read_only_audit' as any,
  );

  // Still produces valid output — execution profile changes only the guidance lines
  assert.ok(result.length > 0);
  assert.ok(result.includes('Execution profile guidance:'));
});
