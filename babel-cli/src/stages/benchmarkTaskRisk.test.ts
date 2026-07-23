import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyBenchmarkTaskRisk } from './benchmarkTaskRisk.js';
import { buildBenchmarkVerifierSpec } from './benchmarkVerifierSpec.js';

function labels(task: string): string[] {
  return classifyBenchmarkTaskRisk(task).labels.map((label) => label.label);
}

test('largest-eigenval classifies as numerical performance and hidden generalization', () => {
  const report = classifyBenchmarkTaskRisk(
    'Terminal-Bench 2 task: largest-eigenval\nComplete dominant eigenvalue for non-symmetric matrices, optimize faster than reference, hidden tests will run.',
  );

  assert.equal(report.task_name, 'largest-eigenval');
  assert.equal(report.recommended_model_tier, 'escalation');
  assert.ok(
    labels(
      'Terminal-Bench 2 task: largest-eigenval non-symmetric complex faster benchmark',
    ).includes('numerical_performance'),
  );
  assert.ok(report.labels.some((label) => label.label === 'hidden_test_generalization'));
  assert.match(report.prompt_lines.join('\n'), /complex eigenpairs/);
});

test('benchmark risk classifier covers diverse canary tasks', () => {
  assert.ok(
    labels(
      'Terminal-Bench 2 task: merge-diff-arc-agi-task bundle1.bundle branch1 branch2',
    ).includes('git_stateful_merge'),
  );
  assert.ok(
    labels('Terminal-Bench 2 task: write-compressor create data.comp with decomp').includes(
      'artifact_generation',
    ),
  );
  assert.ok(
    labels('Terminal-Bench 2 task: write-compressor compile decomp').includes('binary_or_compiler'),
  );
  assert.ok(
    labels(
      'Terminal-Bench 2 task: pytorch-model-cli binary executable cli_tool weights.json prediction.txt',
    ).includes('dependency_sensitive'),
  );
  assert.ok(
    labels(
      'Terminal-Bench 2 task: break-filter-js-from-html filter.py out.html alert bypass',
    ).includes('browser_or_security_adversarial'),
  );
  assert.ok(
    labels(
      'Terminal-Bench 2 task: log-summary-date-ranges summary.csv period,severity,count',
    ).includes('exact_output_schema'),
  );
});

test('benchmark verifier specs include task-specific checks', () => {
  const eigen = buildBenchmarkVerifierSpec('Terminal-Bench 2 task: largest-eigenval');
  assert.equal(eigen?.suggestedHelperName, 'verify_eigen_candidate.py');
  assert.match(eigen?.requiredChecks.join('\n') ?? '', /candidate median runtime/);

  const compressor = buildBenchmarkVerifierSpec('Terminal-Bench 2 task: write-compressor');
  assert.match(compressor?.requiredChecks.join('\n') ?? '', /2500 bytes/);
  assert.match(compressor?.successCriteria.join('\n') ?? '', /byte-for-byte/);
});

test('llm-inference-batching-scheduler classifies as artifact and exact schema task', () => {
  const report = classifyBenchmarkTaskRisk(
    'Terminal-Bench 2 task: llm-inference-batching-scheduler',
  );
  const reportLabels = report.labels.map((label) => label.label);

  assert.equal(report.task_name, 'llm-inference-batching-scheduler');
  assert.ok(reportLabels.includes('artifact_generation'));
  assert.ok(reportLabels.includes('exact_output_schema'));

  const spec = buildBenchmarkVerifierSpec(
    'Terminal-Bench 2 task: llm-inference-batching-scheduler',
  );
  assert.match(spec?.requiredChecks.join('\n') ?? '', /plan_b1\.jsonl/);
  assert.match(spec?.requiredChecks.join('\n') ?? '', /cost_model/);
});
