import assert from 'node:assert/strict';
import test from 'node:test';

import {
  inferDoExecutionVerb,
  inferIntentContract,
  isRoutineBabelCliMaintenanceTask,
  resolveDailyProfile,
  routeLiteOrFull,
  shouldSpawnSparkReview,
} from './liteFullRouter.js';

test('Lite/Full router keeps simple daily work in Lite lanes', () => {
  assert.equal(routeLiteOrFull('Explain this failure without editing').selected_lane, 'lite_ask');
  assert.equal(routeLiteOrFull('Plan the safest parser cleanup').selected_lane, 'lite_plan');
  assert.equal(
    routeLiteOrFull('Propose a patch for the README wording').selected_lane,
    'lite_patch',
  );
  assert.equal(routeLiteOrFull('Fix the failing parser test').selected_lane, 'lite_fix');
});

test('Lite/Full router keeps proposal-only fix wording in lite_patch', () => {
  const decision = routeLiteOrFull(
    'propose the smallest diff to fix the math test without applying',
    { requestedVerb: 'do' },
  );
  assert.equal(decision.selected_lane, 'lite_patch');
  assert.equal(decision.intent.task_kind, 'proposal');
  assert.equal(decision.intent.mutation_allowed, false);
});

test('Lite/Full router escalates complex or risky work to visible Babel Deep', () => {
  const decision = routeLiteOrFull(
    'Use Spark agents to harden a repo-wide migration plan for the Babel pipeline',
  );

  assert.equal(decision.selected_lane, 'deep_lane');
  assert.equal(decision.complexity, 'high');
  assert.equal(decision.model_tier_recommendation, 'escalation');
  assert.equal(
    decision.risk_signals.some((signal) => signal.code === 'explicit_full_or_agents'),
    true,
  );
  assert.equal(
    decision.risk_signals.some((signal) => signal.code === 'repo_wide_or_architecture'),
    true,
  );
  assert.match(decision.full_babel_equivalent, /^babel deep /);
});

test('Lite/Full router recommends escalation tier for protected control-plane failures', () => {
  const decision = routeLiteOrFull(
    'Fix repeated Zod schema failures in pipeline.ts and agentContracts',
  );

  assert.equal(decision.selected_lane, 'deep_lane');
  assert.equal(decision.model_tier_recommendation, 'escalation');
  assert.equal(
    decision.risk_signals.some((signal) => signal.code === 'protected_babel_control_plane'),
    true,
  );
  assert.equal(
    decision.risk_signals.some((signal) => signal.code === 'repeated_failure_or_recovery'),
    true,
  );
});

test('Lite/Full router keeps read-only plugin/MCP/public-export audits in report lane', () => {
  const decision = routeLiteOrFull(
    'Audit public-export plugin registry changes in MCP integration',
  );

  assert.equal(decision.selected_lane, 'lite_report');
  assert.equal(
    decision.risk_signals.some((signal) => signal.code === 'plugin_mcp_public_export'),
    true,
  );
  assert.equal(decision.intent.task_kind, 'report');
  assert.equal(decision.intent.mutation_allowed, false);
  assert.equal(decision.model_tier_recommendation, 'standard');
});

test('Lite/Full router routes performance and security tasks to full with escalation', () => {
  const decision = routeLiteOrFull('Benchmark this pipeline for timeout and performance hotspots');

  assert.equal(decision.selected_lane, 'deep_lane');
  assert.equal(
    decision.risk_signals.some((signal) => signal.code === 'performance_or_security'),
    true,
  );
  assert.equal(decision.complexity, 'high');
  assert.equal(decision.model_tier_recommendation, 'escalation');
});

test('shouldSpawnSparkReview gates complex bl do on agents mode', () => {
  const decision = routeLiteOrFull(
    'Plan a repo-wide migration for the authentication module without editing files',
    { requestedVerb: 'do' },
  );
  assert.equal(decision.selected_lane, 'lite_plan');
  assert.equal(
    shouldSpawnSparkReview(decision, { requestedVerb: 'do', agentsMode: 'read-only' }),
    true,
  );
  assert.equal(shouldSpawnSparkReview(decision, { requestedVerb: 'do', agentsMode: 'off' }), false);
});

test('inferDoExecutionVerb keeps read-only plan tasks on plan lane', () => {
  assert.equal(inferDoExecutionVerb('Plan a repo-wide migration without editing files'), 'plan');
});

test('Lite/Full router sends read-only analysis tasks to report lane', () => {
  const decision = routeLiteOrFull(
    'compare implementation paths for target drift, latest pointers, and output review reliability across the CLI',
    { requestedVerb: 'do' },
  );

  assert.equal(decision.selected_lane, 'lite_report');
  assert.equal(inferDoExecutionVerb('compare implementation paths for target drift'), 'report');
  assert.equal(
    routeLiteOrFull('plan a comparison of implementation paths', { requestedVerb: 'do' })
      .selected_lane,
    'lite_plan',
  );
});

test('intent contract separates recommendations from implementation wording', () => {
  const recommendation = inferIntentContract('What features should we implement next?');
  assert.equal(recommendation.task_kind, 'report');
  assert.equal(recommendation.write_intent, false);
  assert.equal(recommendation.mutation_allowed, false);

  const implementation = inferIntentContract('Implement the smallest safe first step');
  assert.equal(implementation.task_kind, 'implementation');
  assert.equal(implementation.write_intent, true);
  assert.equal(implementation.write_confidence, 'high');
  assert.equal(implementation.mutation_allowed, true);

  const noWrite = inferIntentContract('Do not edit files; implement a cleanup plan');
  assert.notEqual(noWrite.task_kind, 'implementation');
  assert.equal(noWrite.write_intent, false);
  assert.equal(noWrite.mutation_allowed, false);
});

test('Lite/Full router keeps do recommendations read-only but routes direct implementation to fix lane', () => {
  const recommendation = routeLiteOrFull('What features should we implement next?', {
    requestedVerb: 'do',
  });
  assert.equal(recommendation.selected_lane, 'lite_report');
  assert.equal(inferDoExecutionVerb('What features should we implement next?'), 'report');

  const implementation = routeLiteOrFull('Implement the smallest safe first step', {
    requestedVerb: 'do',
  });
  assert.equal(implementation.selected_lane, 'lite_fix');
  assert.equal(implementation.intent.task_kind, 'implementation');
});

test('Lite/Full router respects explicit full verb', () => {
  const decision = routeLiteOrFull('Rename README title', { requestedVerb: 'full' });

  assert.equal(decision.selected_lane, 'deep_lane');
  assert.equal(decision.route_reason, 'Full lane was requested explicitly.');
});

test('Lite/Full router keeps requested read-only repo-wide planning in Lite', () => {
  const decision = routeLiteOrFull('a documentation pass for the repo', { requestedVerb: 'plan' });

  assert.equal(decision.selected_lane, 'lite_plan');
  assert.equal(decision.model_tier_recommendation, 'standard');
});

test('Lite/Full router keeps requested ask questions read-only', () => {
  const decision = routeLiteOrFull('what is this repo about?', { requestedVerb: 'ask' });

  assert.equal(decision.selected_lane, 'lite_ask');
});

test('Lite/Full router still escalates explicit Full wording for read-only verbs', () => {
  const decision = routeLiteOrFull('run the Full governed lane for an architecture review', {
    requestedVerb: 'plan',
  });

  assert.equal(decision.selected_lane, 'deep_lane');
  assert.equal(
    decision.risk_signals.some((signal) => signal.code === 'explicit_full_or_agents'),
    true,
  );
});

test('Lite/Full router de-escalates routine babel-cli maintenance outside hot zones', () => {
  const task =
    'Edit babel-cli/src/pipeline/runPointers.ts and babel-cli/src/evidence/runEvidence.test.ts. Run npm --prefix ./babel-cli run typecheck before completing.';
  assert.equal(isRoutineBabelCliMaintenanceTask(task), true);
  const decision = routeLiteOrFull(task, { requestedVerb: 'fix' });
  assert.equal(decision.selected_lane, 'lite_fix');
  assert.equal(
    decision.risk_signals.some((signal) => signal.code === 'protected_babel_control_plane'),
    false,
  );
});

test('terminal daily profile keeps fix and performance tasks on lite lanes', () => {
  const controlPlaneFix = routeLiteOrFull(
    'Fix repeated Zod schema failures in pipeline.ts and agentContracts',
    { requestedVerb: 'fix', dailyProfile: 'terminal' },
  );
  assert.equal(controlPlaneFix.selected_lane, 'lite_fix');

  const performance = routeLiteOrFull(
    'Benchmark this pipeline for timeout and performance hotspots',
    { dailyProfile: 'terminal' },
  );
  assert.equal(performance.selected_lane, 'lite_plan');
  assert.notEqual(performance.selected_lane, 'deep_lane');

  const repoWideMutation = routeLiteOrFull(
    'Implement a repo-wide migration across the authentication module',
    { dailyProfile: 'terminal' },
  );
  assert.equal(repoWideMutation.selected_lane, 'deep_lane');
});

test('resolveDailyProfile honors BABEL_DAILY_PROFILE=terminal', () => {
  const previous = process.env['BABEL_DAILY_PROFILE'];
  process.env['BABEL_DAILY_PROFILE'] = 'terminal';
  try {
    assert.equal(resolveDailyProfile(), 'terminal');
  } finally {
    if (previous === undefined) {
      delete process.env['BABEL_DAILY_PROFILE'];
    } else {
      process.env['BABEL_DAILY_PROFILE'] = previous;
    }
  }
});
test('inferIntentContract: a determinate artifact prohibition does not suppress an implementation task', () => {
  const scoped = inferIntentContract(
    'The test in math.test.js fails because add() returns the wrong value. Fix the implementation in math.js so every test passes. Do not modify the test file.',
  );
  assert.equal(scoped.no_write_requested, false);
  assert.equal(scoped.task_kind, 'implementation');
  assert.equal(scoped.write_intent, true);
});

test('inferIntentContract: a standalone determinate prohibition stays read-only', () => {
  const standalone = inferIntentContract('Do not modify the test file.');
  assert.equal(standalone.no_write_requested, true);
  assert.equal(standalone.write_intent, false);
});

test('inferIntentContract: prohibited artifact names and report nouns never authorize writes', () => {
  for (const task of [
    'Do not modify the update script.',
    'Do not modify the repair module.',
    'Do not modify the file for the update.',
    'Do not modify the script in config.update.js.',
    'Report the fix. Do not modify the test file.',
    'Explain the repair. Do not modify the test file.',
    'Do not modify the file system. Fix the bug.',
    'Do not modify the file-system. Fix src/main.js.',
    'Do not modify the file_system. Fix src/main.js.',
    'Do not modify the entire file system. Fix src/main.js.',
    'Do not modify the test file or implement the update.',
    'Do not modify src/update.js.',
  ]) {
    const intent = inferIntentContract(task);
    assert.equal(intent.no_write_requested, true, task);
    assert.equal(intent.write_intent, false, task);
  }
});

test('inferIntentContract: independent implementation survives scoped prohibitions in either order', () => {
  for (const task of [
    'Do not modify the update script. Fix src/main.js.',
    'Fix src/main.js. Do not modify the update script.',
    'Do not modify the script in config.update.js. Please fix src/main.js.',
    'Do not modify src/update.js. Fix src/main.js.',
    'Fix src/main.js. Do not modify src/config.js. Do not modify the test file.',
    'Do not modify the test file. Fix src/main.js. Do not modify src/config.js.',
  ]) {
    const intent = inferIntentContract(task);
    assert.equal(intent.no_write_requested, false, task);
    assert.equal(intent.write_intent, true, task);
  }
});

test('inferIntentContract: fenced examples cannot supply repair intent outside a scoped prohibition', () => {
  for (const object of ['permissions', 'verification gates', 'provider accounting', 'regression tests', 'the test file']) {
    for (const [open, close] of [['```', '```'], ['~~~', '~~~'], ['```', ''], ['~~~', '']]) {
      const task = `Inspect the source. Do not modify ${object}.\n${open}\nfix the implementation\n${close}`;
      const intent = inferIntentContract(task);
      assert.equal(intent.no_write_requested, true, task);
      assert.equal(intent.mutation_allowed, false, task);
      const repair = inferIntentContract(`Fix the implementation. ${task}`);
      assert.equal(repair.no_write_requested, false, task);
      assert.equal(repair.mutation_allowed, true, task);
    }
  }
  assert.equal(inferIntentContract('Explain the source.\n```\nfix the implementation\n```').mutation_allowed, false);
  assert.equal(inferIntentContract('Fix the implementation. Do not modify files.\n```\nwrite code\n```').mutation_allowed, false);
  for (const example of ['````text\n```\nfix the implementation\n```\n````',
    '~~~text~~~\nfix the implementation\n~~~',
    '~~~~text\n~~~\nfix the implementation\n~~~\n~~~~',
    '```text\nliteral ``` marker\nfix the implementation\n```']) {
    const task = `Inspect the source. Do not modify permissions.\n${example}`;
    assert.equal(inferIntentContract(task).mutation_allowed, false, task);
    assert.equal(inferIntentContract(`Fix src/main.js. ${task}`).mutation_allowed, true, task);
  }
});

test('inferIntentContract: Markdown boundaries preserve denials and outside repairs', () => {
  for (const example of ['```text\n\t```\nfix the implementation\n```',
    '```text\n> ```\nfix the implementation\n```',
    '> ```text\n> fix the implementation\n> ```',
    '- ```text\n  fix the implementation\n  ```',
    '```text\rliteral ``` marker\rfix the implementation\r```']) {
    assert.equal(inferIntentContract(`Inspect source. Do not modify permissions.\n${example}`).mutation_allowed, false, example);
  }
  assert.equal(inferIntentContract('Fix main.js. Example: ```\nsample\n``` Do not edit files.').mutation_allowed, false);
  assert.equal(inferIntentContract('Explain this example.\n> ```text\n> sample\n> ```\nFix main.js.').mutation_allowed, true);
});

test('inferIntentContract: HTML wrappers preserve fenced evidence and prose denials', () => {
  for (const [open, close] of [['<pre>', '</pre>'], ['<!--', '-->'], ['<div>', '</div>']]) {
    const example = `${open}\n\`\`\`text\nfix the implementation\n\`\`\`\n${close}`;
    assert.equal(inferIntentContract(`Inspect source. Do not modify permissions.\n\n${example}`).mutation_allowed, false, open);
    assert.equal(inferIntentContract(`Fix main.js.\n${example}\n${open}Do not edit files.${close}`).mutation_allowed, false, open);
  }
});

test('inferIntentContract: formatting cannot manufacture a fence hiding a denial', () => {
  assert.equal(inferIntentContract('Fix main.js. ~**~**~ Do not edit files.\n```text\nsample\n```').mutation_allowed, false);
});
