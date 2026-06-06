import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBenchmarkVerificationPromptLines,
  collectBenchmarkRiskPlanViolations,
  verifyBenchmarkPreCompleteContract,
} from './benchmarkVerification.js';
import type { ToolCallLog } from '../schemas/agentContracts.js';
import type { SwePlan } from '../schemas/agentContracts.js';

function successfulCommand(target: string, stdout = ''): ToolCallLog {
  return {
    step: 1,
    tool: 'shell_exec',
    target,
    exit_code: 0,
    stdout,
    stderr: '',
    verified: true,
  };
}

test('write-compressor contract requires decompressor comparison before completion', () => {
  const rawTask = 'Terminal-Bench 2 task: write-compressor\nWrite data.comp.';
  assert.match(
    verifyBenchmarkPreCompleteContract(rawTask, [successfulCommand('gzip data.txt')])?.message ?? '',
    /decompressor/,
  );

  const passed = verifyBenchmarkPreCompleteContract(rawTask, [
    successfulCommand('cat data.comp | ./decomp > out.txt && diff data.txt out.txt'),
  ]);
  assert.equal(passed?.passed, true);
});

test('gpt2-codegolf contract requires running the real checkpoint inputs', () => {
  const rawTask = 'Terminal-Bench 2 task: gpt2-codegolf\nWrite gpt2.c.';

  const compileOnly = verifyBenchmarkPreCompleteContract(rawTask, [
    successfulCommand('gcc -O3 -lm gpt2.c -o a.out'),
  ]);
  assert.equal(compileOnly?.passed, false);
  assert.match(compileOnly?.message ?? '', /gpt2-124M\.ckpt/);

  const passed = verifyBenchmarkPreCompleteContract(rawTask, [
    successfulCommand(
      './a.out gpt2-124M.ckpt vocab.bpe "THIS SOFTWARE IS PROVIDED"',
      'WARRANTY OF ANY KIND, EXPRESS OR IMPLIED',
    ),
  ]);
  assert.equal(passed?.passed, true);

  const placeholder = verifyBenchmarkPreCompleteContract(rawTask, [
    successfulCommand(
      './a.out gpt2-124M.ckpt vocab.bpe "THIS SOFTWARE IS PROVIDED"',
      'token_0 token_1 token_2',
    ),
  ]);
  assert.equal(placeholder?.passed, false);

  const emptyOutput = verifyBenchmarkPreCompleteContract(rawTask, [
    successfulCommand('./a.out gpt2-124M.ckpt vocab.bpe "THIS SOFTWARE IS PROVIDED"', ''),
  ]);
  assert.equal(emptyOutput?.passed, false);
});

test('gpt2-codegolf prompt warns against toy checkpoint handling', () => {
  const lines = buildBenchmarkVerificationPromptLines(
    'Terminal-Bench 2 task: gpt2-codegolf',
  ).join('\n');

  assert.match(lines, /hundreds of megabytes/);
  assert.match(lines, /token_0\/token_1/);
});

test('merge-diff contract accepts git-native bundle inspection', () => {
  const rawTask = 'Terminal-Bench 2 task: merge-diff-arc-agi-task';
  const failed = verifyBenchmarkPreCompleteContract(rawTask, [
    successfulCommand('file bundle1.bundle'),
  ]);
  assert.equal(failed?.passed, false);

  const passed = verifyBenchmarkPreCompleteContract(rawTask, [
    successfulCommand('git bundle verify bundle1.bundle'),
  ]);
  assert.equal(passed?.passed, true);
});

test('merge-diff prompt forbids archive fallback for git bundles', () => {
  const lines = buildBenchmarkVerificationPromptLines(
    'Terminal-Bench 2 task: merge-diff-arc-agi-task',
  ).join('\n');

  assert.match(lines, /not tar\/gzip archives/);
  assert.match(lines, /halt with missing required runtime capability/);
});

test('winning-avg-corewars contract requires pMARS batch evidence', () => {
  const rawTask = 'Terminal-Bench 2 task: winning-avg-corewars\nWrite my_warrior.red.';
  const failed = verifyBenchmarkPreCompleteContract(rawTask, [
    successfulCommand('cat my_warrior.red'),
  ]);
  assert.equal(failed?.passed, false);
  assert.match(failed?.message ?? '', /pMARS batch/);

  const passed = verifyBenchmarkPreCompleteContract(rawTask, [
    successfulCommand('pmars -b -r 100 -f my_warrior.red warriors/stone.red'),
  ]);
  assert.equal(passed?.passed, true);
});

test('break-filter contract rejects plain Python no-op verifier and accepts pytest evidence', () => {
  const rawTask = 'Terminal-Bench 2 task: break-filter-js-from-html\nCreate out.html.';

  const noOpVerifier = verifyBenchmarkPreCompleteContract(rawTask, [
    successfulCommand('python test_outputs.py'),
  ]);
  assert.equal(noOpVerifier?.passed, false);
  assert.match(noOpVerifier?.message ?? '', /filtered output still triggers/);

  const pytestVerifier = verifyBenchmarkPreCompleteContract(rawTask, [
    successfulCommand('python -m pytest -q test_outputs.py'),
  ]);
  assert.equal(pytestVerifier?.passed, true);
});

test('break-filter prompt warns that plain Python does not run pytest-style tests', () => {
  const lines = buildBenchmarkVerificationPromptLines(
    'Terminal-Bench 2 task: break-filter-js-from-html',
  ).join('\n');

  assert.match(lines, /python -m pytest -q test_outputs\.py/);
  assert.match(lines, /plain `python test_outputs\.py`/);
  assert.match(lines, /Only plan test_outputs\.py when pytest is available/);
  assert.match(lines, /Read filter\.py before choosing a payload/);
  assert.match(lines, /script tags, on\* event handlers/);
  assert.match(lines, /custom executable verifier step/);
});

test('benchmark verification prompt lines are task-specific', () => {
  assert.match(
    buildBenchmarkVerificationPromptLines('Terminal-Bench 2 task: log-summary-date-ranges').join('\n'),
    /Generic external benchmark/,
  );
  assert.match(
    buildBenchmarkVerificationPromptLines('Terminal-Bench 2 task: largest-eigenval').join('\n'),
    /correctness and speed/,
  );
  assert.match(
    buildBenchmarkVerificationPromptLines('Terminal-Bench 2 task: winning-avg-corewars').join('\n'),
    /pmars -b -r 100 -f my_warrior\.red/,
  );
  assert.match(
    buildBenchmarkVerificationPromptLines('Terminal-Bench 2 task: llm-inference-batching-scheduler').join('\n'),
    /plan_b1\.jsonl/,
  );
  assert.match(
    buildBenchmarkVerificationPromptLines('Terminal-Bench 2 task: llm-inference-batching-scheduler').join('\n'),
    /optimized_packer\.py` with no arguments/,
  );
});

test('generic external benchmark contract blocks file-only completion', () => {
  const rawTask = 'Terminal-Bench 2 task: unseen-benchmark\nWrite answer.txt.';
  const failed = verifyBenchmarkPreCompleteContract(rawTask, [
    {
      step: 1,
      tool: 'file_write',
      target: 'answer.txt',
      exit_code: 0,
      stdout: '',
      stderr: '',
      verified: true,
    },
  ]);
  assert.equal(failed?.passed, false);
  assert.equal(failed?.failureCategory, 'missing_verifier_evidence');

  const passed = verifyBenchmarkPreCompleteContract(rawTask, [
    successfulCommand('python check_answer.py'),
  ]);
  assert.equal(passed?.passed, true);
});

function plan(steps: SwePlan['minimal_action_set']): SwePlan {
  return {
    plan_version: '1.0',
    thinking: '',
    plan_type: 'IMPLEMENTATION_PLAN',
    task_summary: 'OBJECTIVE: test plan',
    known_facts: ['test'],
    assumptions: [],
    risks: [],
    minimal_action_set: steps,
    root_cause: 'N/A',
    out_of_scope: [],
  };
}

test('benchmark risk QA rejects weak largest-eigenval plan', () => {
  const rawTask = 'Terminal-Bench 2 task: largest-eigenval';
  const failures = collectBenchmarkRiskPlanViolations(plan([
    {
      step: 1,
      description: 'Patch eigen.py with power iteration',
      tool: 'file_write',
      target: 'eigen.py',
      rationale: 'Use power iteration and Rayleigh quotient',
      reversible: true,
      verification: 'Run python eval.py',
    },
    {
      step: 2,
      description: 'Run eval',
      tool: 'shell_exec',
      target: 'python eval.py',
      rationale: 'Check result',
      reversible: true,
      verification: 'Exit 0',
    },
  ]), rawTask);

  assert.equal(failures.some(failure => failure.condition.includes('BENCHMARK_WEAK_NUMERICAL_STRATEGY')), true);
});

test('benchmark risk QA rejects artifact plans without round-trip or executable checks', () => {
  const compressorFailures = collectBenchmarkRiskPlanViolations(plan([
    {
      step: 1,
      description: 'Write compressed data',
      tool: 'file_write',
      target: 'data.comp',
      rationale: 'Create artifact',
      reversible: true,
      verification: 'File exists',
    },
  ]), 'Terminal-Bench 2 task: write-compressor');
  const pytorchFailures = collectBenchmarkRiskPlanViolations(plan([
    {
      step: 1,
      description: 'Write files',
      tool: 'file_write',
      target: 'prediction.txt',
      rationale: 'Create prediction',
      reversible: true,
      verification: 'File exists',
    },
  ]), 'Terminal-Bench 2 task: pytorch-model-cli');

  assert.equal(compressorFailures.some(failure => failure.condition.includes('BENCHMARK_ARTIFACT_ROUNDTRIP_REQUIRED')), true);
  assert.equal(pytorchFailures.some(failure => failure.condition.includes('BENCHMARK_CLI_ARTIFACT_VERIFIER_REQUIRED')), true);
});

test('benchmark risk QA rejects merge-diff source-only git bypass', () => {
  const failures = collectBenchmarkRiskPlanViolations(plan([
    {
      step: 1,
      description: 'Write algo directly',
      tool: 'file_write',
      target: 'repo/algo.py',
      rationale: 'Create solution',
      reversible: true,
      verification: 'Run examples',
    },
  ]), 'Terminal-Bench 2 task: merge-diff-arc-agi-task');

  assert.equal(failures.some(failure => failure.condition.includes('BENCHMARK_GIT_NATIVE_PLAN_REQUIRED')), true);
});

test('llm batching contract requires both output plans and cost verification', () => {
  const rawTask = 'Terminal-Bench 2 task: llm-inference-batching-scheduler';

  const noArgHelper = verifyBenchmarkPreCompleteContract(rawTask, [
    successfulCommand('python task_file/scripts/optimized_packer.py'),
  ]);
  assert.equal(noArgHelper?.passed, false);
  assert.match(noArgHelper?.message ?? '', /plan_b1\.jsonl/);

  const passed = verifyBenchmarkPreCompleteContract(rawTask, [
    successfulCommand(
      'python verify_llm_batching_plan.py task_file/output_data/plan_b1.jsonl task_file/output_data/plan_b2.jsonl',
      'plan_b1.jsonl ok\nplan_b2.jsonl ok\ncost and latency passed',
    ),
  ]);
  assert.equal(passed?.passed, true);
});

test('llm batching QA rejects no-arg helper plan that omits final artifacts', () => {
  const failures = collectBenchmarkRiskPlanViolations(plan([
    {
      step: 1,
      description: 'Write helper',
      tool: 'file_write',
      target: 'task_file/scripts/optimized_packer.py',
      rationale: 'Create helper',
      reversible: true,
      verification: 'Helper exists',
    },
    {
      step: 2,
      description: 'Run helper',
      tool: 'shell_exec',
      target: 'python task_file/scripts/optimized_packer.py',
      rationale: 'Generate plans',
      reversible: true,
      verification: 'Exit 0',
    },
    {
      step: 3,
      description: 'Run cost model',
      tool: 'shell_exec',
      target: 'python task_file/scripts/cost_model.py',
      rationale: 'Validate cost',
      reversible: true,
      verification: 'Exit 0',
    },
  ]), 'Terminal-Bench 2 task: llm-inference-batching-scheduler');

  assert.equal(failures.some(failure => failure.condition.includes('BENCHMARK_LLM_BATCHING_OUTPUTS_REQUIRED')), true);
});

test('benchmark QA rejects evidence requests that contain final artifact mutation', () => {
  const failures = collectBenchmarkRiskPlanViolations({
    ...plan([
      {
        step: 1,
        description: 'Read bucket 1',
        tool: 'file_read',
        target: 'task_file/input_data/requests_bucket_1.jsonl',
        rationale: 'Gather evidence',
        reversible: true,
        verification: 'Read succeeds',
      },
      {
        step: 2,
        description: 'Write final output during evidence request',
        tool: 'file_write',
        target: 'task_file/output_data/plan_b1.jsonl',
        rationale: 'Create artifact',
        reversible: true,
        verification: 'File exists',
      },
    ]),
    plan_type: 'EVIDENCE_REQUEST',
  }, 'Terminal-Bench 2 task: llm-inference-batching-scheduler');

  assert.equal(failures.some(failure => failure.condition.includes('BENCHMARK_EVIDENCE_REQUEST_MUTATION')), true);
});

test('llm batching QA accepts explicit bucket generation and verifier plan', () => {
  const failures = collectBenchmarkRiskPlanViolations(plan([
    {
      step: 1,
      description: 'Write helper',
      tool: 'file_write',
      target: 'task_file/scripts/optimized_packer.py',
      rationale: 'Create helper',
      reversible: true,
      verification: 'Helper exists',
    },
    {
      step: 2,
      description: 'Generate bucket 1 plan',
      tool: 'shell_exec',
      target: 'python task_file/scripts/optimized_packer.py task_file/input_data/requests_bucket_1.jsonl task_file/output_data/plan_b1.jsonl',
      rationale: 'Generate plan_b1.jsonl',
      reversible: true,
      verification: 'plan_b1.jsonl exists',
    },
    {
      step: 3,
      description: 'Generate bucket 2 plan',
      tool: 'shell_exec',
      target: 'python task_file/scripts/optimized_packer.py task_file/input_data/requests_bucket_2.jsonl task_file/output_data/plan_b2.jsonl',
      rationale: 'Generate plan_b2.jsonl',
      reversible: true,
      verification: 'plan_b2.jsonl exists',
    },
    {
      step: 4,
      description: 'Validate both plans',
      tool: 'shell_exec',
      target: 'python verify_llm_batching_plan.py task_file/output_data/plan_b1.jsonl task_file/output_data/plan_b2.jsonl',
      rationale: 'Check coverage, shape, and cost thresholds',
      reversible: true,
      verification: 'Verifier exits 0',
    },
  ]), 'Terminal-Bench 2 task: llm-inference-batching-scheduler');

  assert.equal(failures.some(failure => failure.condition.includes('BENCHMARK_LLM_BATCHING_OUTPUTS_REQUIRED')), false);
});
