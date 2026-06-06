import type { QaFailure, SwePlan, ToolCallLog } from '../schemas/agentContracts.js';
import { buildBenchmarkRiskPromptLines } from './benchmarkTaskRisk.js';
import { buildBenchmarkVerifierPromptLines } from './benchmarkVerifierSpec.js';

export interface BenchmarkVerificationContract {
  readonly taskPattern: RegExp;
  readonly id: string;
  readonly title: string;
  readonly completionRequirement: string;
  readonly promptLines: readonly string[];
  readonly acceptsCommand: (command: string, entry: ToolCallLog) => boolean;
}

export interface BenchmarkVerificationResult {
  readonly contractId: string;
  readonly passed: boolean;
  readonly message: string;
  readonly failureCategory?: 'false_complete_risk' | 'missing_verifier_evidence' | 'task_specific_contract';
}

const BENCHMARK_VERIFICATION_CONTRACTS: readonly BenchmarkVerificationContract[] = [
  {
    id: 'verify.write_compressor.decompress_compare',
    taskPattern: /\bwrite-compressor\b/i,
    title: 'write-compressor decompressor compatibility check',
    completionRequirement:
      'Before COMPLETE, run the provided decompressor against data.comp and compare the output with data.txt.',
    promptLines: [
      'write-compressor verification: gzip compatibility is not enough.',
      'Before EXECUTION_COMPLETE, compile/use the provided decomp or decomp2 program and run a command equivalent to `cat data.comp | ./decomp` or `./decomp < data.comp`, then compare the decompressed output to data.txt.',
    ],
    acceptsCommand: command => {
      const normalized = command.toLowerCase();
      return /\bdata\.comp\b/.test(normalized) &&
        /\b(?:decomp|decomp2)\b/.test(normalized) &&
        /\b(?:diff|cmp|sha256sum|python|node|perl)\b/.test(normalized);
    },
  },
  {
    id: 'verify.gpt2_codegolf.compile_run',
    taskPattern: /\bgpt2-codegolf\b/i,
    title: 'gpt2-codegolf real checkpoint run check',
    completionRequirement:
      'Before COMPLETE, run the generated program against the real gpt2-124M.ckpt and vocab.bpe inputs, require exit 0, and reject placeholder token output.',
    promptLines: [
      'gpt2-codegolf verification: do not complete with only a source write.',
      'Before EXECUTION_COMPLETE, compile the generated program, then run the compiled a.out with gpt2-124M.ckpt, vocab.bpe, and an input string that includes spaces or quotes.',
      'The checkpoint is hundreds of megabytes; do not add artificial small file-size caps that reject the real ckpt.',
      'A placeholder continuation such as token_0/token_1 is not acceptable evidence; the local run must exit 0 and print continuation text.',
    ],
    acceptsCommand: (command, entry) => {
      const normalized = command.toLowerCase();
      const stdout = String(entry.stdout ?? '').toLowerCase();
      return /(?:^|\s)(?:\.\/|\/app\/)?a\.out\b/.test(normalized) &&
        /\bgpt2-124m\.ckpt\b/.test(normalized) &&
        /\bvocab\.bpe\b/.test(normalized) &&
        stdout.trim().length > 0 &&
        !/\btoken_\d+\b/.test(stdout) &&
        !/\bplaceholder\b/.test(stdout);
    },
  },
  {
    id: 'verify.break_filter_js_from_html.bypass_check',
    taskPattern: /\bbreak-filter-js-from-html\b/i,
    title: 'break-filter-js-from-html bypass check',
    completionRequirement:
      'Before COMPLETE, run a local check proving the filtered output still triggers the intended bypass.',
    promptLines: [
      'break-filter-js-from-html verification: the output must be tested against the filter, not just written.',
      'Read filter.py before choosing a payload. Do not assume event handlers, entities, tags, or URL schemes survive without inspecting the actual parser/removal logic.',
      'Do not pre-commit to script tags, on* event handlers, or entity-encoded JavaScript; those are common sanitizer targets and must be justified by the actual filter.py source if used.',
      'Before EXECUTION_COMPLETE, run the visible filter or an equivalent local browser/JS check and prove the filtered output still triggers the bypass condition.',
      'Do not modify filter.py or test_outputs.py; they are benchmark fixtures. Repair out.html or write a separate helper script instead.',
      'If the visible verifier is test_outputs.py and it contains pytest-style test functions, run `python -m pytest -q test_outputs.py`; plain `python test_outputs.py` can exit 0 without executing tests and does not satisfy this contract.',
      'Only plan test_outputs.py when pytest is available in the benchmark runtime inventory. If pytest is missing, do not use test_outputs.py or install pytest; run filter.py plus a separate custom check against out.html, or halt with the missing verification capability.',
      'When pytest is unavailable, a final file_read of out.html is insufficient; include a custom executable verifier step that exits nonzero unless the filtered artifact satisfies the intended alert/bypass postcondition.',
    ],
    acceptsCommand: (command) => {
      const normalized = command.toLowerCase();
      const pytestTestOutputs =
        /(?:^|\s)(?:python3?|py)\s+-m\s+pytest\b/.test(normalized) &&
        /\btest_outputs\.py\b/.test(normalized);
      const directPytestTestOutputs =
        /(?:^|\s)pytest\b/.test(normalized) &&
        /\btest_outputs\.py\b/.test(normalized);
      const customFilterBypassCheck =
        /\bfilter\.py\b/.test(normalized) &&
        /\b(?:alert|selenium|webdriver|switch_to\.alert|bypass)\b/.test(normalized) &&
        /\b(?:test|check|verify|run|assert|trigger)\b/.test(normalized);
      return pytestTestOutputs || directPytestTestOutputs || customFilterBypassCheck;
    },
  },
  {
    id: 'verify.largest_eigenval.correctness_and_speed',
    taskPattern: /\blargest-eigenval\b/i,
    title: 'largest-eigenval correctness and speed check',
    completionRequirement:
      'Before COMPLETE, run a check that covers both numerical correctness and speed/performance.',
    promptLines: [
      'largest-eigenval verification: correctness alone is insufficient.',
      'Before EXECUTION_COMPLETE, run a local correctness check and a timing/performance check, using the task verifier command if it is visible.',
    ],
    acceptsCommand: command => {
      const normalized = command.toLowerCase();
      return /\b(?:time|timeout|hyperfine|benchmark|perf|speed|seconds|largest|eigen)\b/.test(normalized) &&
        /\b(?:test|check|verify|run|python3?|node|make|\.[/\\])\b/.test(normalized);
    },
  },
  {
    id: 'verify.merge_diff_arc_agi.git_bundle',
    taskPattern: /\bmerge-diff-arc-agi-task\b/i,
    title: 'merge-diff git bundle verification',
    completionRequirement:
      'Before COMPLETE, inspect bundle artifacts with Git-native bundle commands, not generic file-type probing.',
    promptLines: [
      'merge-diff-arc-agi-task verification: replace `file *.bundle` with Git-native inspection.',
      'Before EXECUTION_COMPLETE, run `git bundle verify <bundle>` or `git bundle list-heads <bundle>` for visible bundle artifacts when git is available.',
      'Git .bundle files are not tar/gzip archives. Do not use tar/cp extraction as a substitute; if git is unavailable, halt with missing required runtime capability instead of completing.',
    ],
    acceptsCommand: command => /\bgit\s+bundle\s+(?:verify|list-heads)\b/i.test(command),
  },
  {
    id: 'verify.winning_avg_corewars.pmars_batch',
    taskPattern: /\bwinning-avg-corewars\b/i,
    title: 'winning-avg-corewars pMARS batch check',
    completionRequirement:
      'Before COMPLETE, run pMARS batch checks for my_warrior.red against the visible opponent warriors.',
    promptLines: [
      'winning-avg-corewars verification: writing my_warrior.red is not enough.',
      'Before EXECUTION_COMPLETE, run a command equivalent to `pmars -b -r 100 -f my_warrior.red warriors/<opponent>.red` against visible opponents and use the observed win rates to repair weak strategies.',
      'If pMARS is unavailable, halt with a missing runtime capability instead of completing.',
    ],
    acceptsCommand: command => {
      const normalized = command.toLowerCase();
      return /\bpmars\b/.test(normalized) &&
        /\bmy_warrior\.red\b/.test(normalized) &&
        /\bwarriors[/\\][a-z0-9_.-]+\.red\b/.test(normalized) &&
        /(?:^|\s)(?:-b|--batch)(?:\s|$)/.test(normalized);
    },
  },
  {
    id: 'verify.llm_batching_scheduler.outputs_and_cost',
    taskPattern: /\bllm-inference-batching-scheduler\b/i,
    title: 'llm-inference-batching-scheduler output and cost check',
    completionRequirement:
      'Before COMPLETE, generate both plan_b1.jsonl and plan_b2.jsonl, then run an executable verifier or cost model that proves schema, coverage, shape limits, and performance thresholds.',
    promptLines: [
      'llm-inference-batching-scheduler verification: helper creation is not enough.',
      'The final artifacts are `task_file/output_data/plan_b1.jsonl` and `task_file/output_data/plan_b2.jsonl`; both must exist before EXECUTION_COMPLETE.',
      'Do not run `optimized_packer.py` with no arguments if it expects `<input_file> <output_file>`. Invoke it separately for bucket 1 and bucket 2, or write it to generate both output files by default.',
      'Before EXECUTION_COMPLETE, run a command that validates both plan files for request coverage, schema, shape alignment, global unique-shape limit, and cost/latency thresholds using cost_model.py or the visible pytest verifier.',
    ],
    acceptsCommand: (command, entry) => {
      const normalized = command.toLowerCase();
      const stdout = String(entry.stdout ?? '').toLowerCase();
      const mentionsBothPlans = /\bplan_b1\.jsonl\b/.test(normalized) &&
        /\bplan_b2\.jsonl\b/.test(normalized);
      const validatesWithCostOrTests =
        /\bcost_model\.py\b/.test(normalized) ||
        /\btest_outputs\.py\b/.test(normalized) ||
        /\bpytest\b/.test(normalized) ||
        /\bverify_llm_batching_plan\.py\b/.test(normalized) ||
        /\b(?:coverage|shape|latency|pad_ratio|sequential_timecost)\b/.test(normalized);
      const outputSaysBothPlans =
        /\bplan_b1\.jsonl\b/.test(stdout) &&
        /\bplan_b2\.jsonl\b/.test(stdout) &&
        /\b(?:pass|passed|ok|valid|cost|latency|pad_ratio)\b/.test(stdout);
      return mentionsBothPlans && (validatesWithCostOrTests || outputSaysBothPlans);
    },
  },
];

function isExternalBenchmarkTask(rawTask: string): boolean {
  return /\bTerminal-Bench 2 task\b/i.test(rawTask) ||
    /\bSWE-rebench\b/i.test(rawTask);
}

function getBenchmarkVerificationContract(rawTask: string): BenchmarkVerificationContract | null {
  if (!isExternalBenchmarkTask(rawTask)) {
    return null;
  }
  return BENCHMARK_VERIFICATION_CONTRACTS.find(contract => contract.taskPattern.test(rawTask)) ?? null;
}

export function buildBenchmarkVerificationPromptLines(rawTask: string): string[] {
  const contract = getBenchmarkVerificationContract(rawTask);
  const riskLines = buildBenchmarkRiskPromptLines(rawTask);
  const verifierSpecLines = buildBenchmarkVerifierPromptLines(rawTask);
  if (!contract) {
    if (!isExternalBenchmarkTask(rawTask)) {
      return [];
    }
    return [
      ...riskLines,
      ...verifierSpecLines,
      'Benchmark pre-completion verification contract:',
      '  - Generic external benchmark: before EXECUTION_COMPLETE, run at least one local verifier, test, comparison, or artifact-inspection command that exits 0 after the final mutation.',
      '  - Do not mark COMPLETE after only file_write steps. If no local verifier exists, run the closest visible artifact postcondition check and record the limitation.',
      '  - If the requested artifact is missing or the verification command fails, repair and rerun before completing.',
    ];
  }
  return [
    ...riskLines,
    ...verifierSpecLines,
    'Benchmark pre-completion verification contract:',
    `  - ${contract.title}: ${contract.completionRequirement}`,
    ...contract.promptLines.map(line => `  - ${line}`),
  ];
}

export function collectBenchmarkRiskPlanViolations(
  swePlan: SwePlan,
  rawTask: string,
): QaFailure[] {
  if (!isExternalBenchmarkTask(rawTask)) {
    return [];
  }

  const failures: QaFailure[] = [];
  const planText = JSON.stringify(swePlan).toLowerCase();
  const shellSteps = swePlan.minimal_action_set
    .filter(step => step.tool === 'shell_exec' || step.tool === 'test_run')
    .map(step => String(step.target ?? '').toLowerCase());
  const fileWrites = swePlan.minimal_action_set
    .filter(step => step.tool === 'file_write')
    .map(step => String(step.target ?? '').replace(/\\/g, '/').toLowerCase());

  if (swePlan.plan_type === 'EVIDENCE_REQUEST') {
    const mutatingEvidenceSteps = swePlan.minimal_action_set.filter(step => {
      const target = String(step.target ?? '').replace(/\\/g, '/').toLowerCase();
      return step.tool === 'file_write' ||
        (
          (step.tool === 'shell_exec' || step.tool === 'test_run') &&
          /\b(?:output_data|plan_b[12]\.jsonl|optimized_packer\.py|cost_model\.py)\b/.test(target)
        );
    });
    if (mutatingEvidenceSteps.length > 0) {
      failures.push({
        tag: 'SFDIPOT-P',
        condition:
          '[BENCHMARK_EVIDENCE_REQUEST_MUTATION] Evidence request plans for external benchmarks must only gather evidence. They must not write final artifacts or run artifact-generation/verifier commands; regenerate as an IMPLEMENTATION_PLAN after evidence is gathered.',
        confidence: 5,
        fix_hint:
          'Use file_read/directory_list-only evidence requests, then produce a separate implementation plan with explicit final artifact writes and verifier commands.',
      });
    }
  }

  if (/\blargest-eigenval\b/i.test(rawTask)) {
    if (/\bpower iteration\b|\brayleigh\b/.test(planText)) {
      failures.push({
        tag: 'SFDIPOT-F',
        condition:
          '[BENCHMARK_WEAK_NUMERICAL_STRATEGY] largest-eigenval plan uses naive power iteration/Rayleigh quotient language even though the task allows non-symmetric matrices with complex dominant eigenpairs.',
        confidence: 5,
        fix_hint:
          'Regenerate with a strategy that handles complex non-symmetric eigenpairs and proves correctness against a reference before optimizing speed.',
      });
    }
    const hasCorrectnessAndTimingVerifier = shellSteps.some(command =>
      /\b(?:eval\.py|pytest|verify|check|test)\b/.test(command) &&
      /\b(?:time|timing|speed|benchmark|perf|median|eval\.py)\b/.test(command),
    );
    if (!hasCorrectnessAndTimingVerifier) {
      failures.push({
        tag: 'SFDIPOT-T',
        condition:
          '[BENCHMARK_NUMERICAL_VERIFIER_REQUIRED] largest-eigenval plan must include an executable verifier covering both eigenpair correctness and speed/timing before completion.',
        confidence: 5,
        fix_hint:
          'Add a local verifier or eval.py run that checks A @ v ~= lambda * v, dominant magnitude, and timing against the reference.',
      });
    }
  }

  if (/\bwrite-compressor\b/i.test(rawTask)) {
    const hasRoundTripVerifier = shellSteps.some(command =>
      /\bdata\.comp\b/.test(command) &&
      /\b(?:decomp|decomp2)\b/.test(command) &&
      /\b(?:diff|cmp|sha256sum|python|node|perl)\b/.test(command),
    );
    if (!hasRoundTripVerifier) {
      failures.push({
        tag: 'SFDIPOT-F',
        condition:
          '[BENCHMARK_ARTIFACT_ROUNDTRIP_REQUIRED] write-compressor plan must verify data.comp by running the provided decompressor and comparing output to data.txt.',
        confidence: 5,
        fix_hint:
          'Add a decompressor round-trip command and size check before completion.',
      });
    }
  }

  if (/\bmerge-diff-arc-agi-task\b/i.test(rawTask)) {
    const hasGitNativeSteps = shellSteps.some(command =>
      /\bgit\s+(?:init|bundle|fetch|checkout|switch|merge|status|branch)\b/.test(command),
    );
    if (!hasGitNativeSteps) {
      failures.push({
        tag: 'SFDIPOT-P',
        condition:
          '[BENCHMARK_GIT_NATIVE_PLAN_REQUIRED] merge-diff-arc-agi-task plan must use Git-native bundle, branch, and merge commands before editing/verifying algo.py.',
        confidence: 5,
        fix_hint:
          'Regenerate with git init, git bundle/fetch, branch1/branch2 checkout, merge, and examples verification steps.',
      });
    }
    const writesRepoAlgo = fileWrites.some(target => /(?:^|\/)repo\/algo\.py$/.test(target));
    if (writesRepoAlgo && !hasGitNativeSteps) {
      failures.push({
        tag: 'SFDIPOT-P',
        condition:
          '[BENCHMARK_SOURCE_ONLY_GIT_BYPASS] merge-diff plan writes repo/algo.py without proving the required bundle checkout and merge state.',
        confidence: 5,
        fix_hint:
          'Do not bypass the required Git state. Fetch and merge the bundles first, then repair algo.py if needed.',
      });
    }
  }

  if (/\bpytorch-model-cli\b/i.test(rawTask)) {
    const requiredArtifacts = ['cli_tool', 'weights.json', 'prediction.txt'];
    const mentionsArtifacts = requiredArtifacts.every(artifact => planText.includes(artifact));
    const runsCliTool = shellSteps.some(command =>
      /\b(?:\.\/)?cli_tool\b/.test(command) &&
      /\bweights\.json\b/.test(command) &&
      /\bimage\.png\b/.test(command),
    );
    if (!mentionsArtifacts || !runsCliTool) {
      failures.push({
        tag: 'SFDIPOT-F',
        condition:
          '[BENCHMARK_CLI_ARTIFACT_VERIFIER_REQUIRED] pytorch-model-cli plan must produce cli_tool, weights.json, prediction.txt and run ./cli_tool weights.json image.png before completion.',
        confidence: 5,
        fix_hint:
          'Add explicit artifact creation and an executable CLI smoke test whose output is a single digit.',
      });
    }
  }

  if (/\bllm-inference-batching-scheduler\b/i.test(rawTask)) {
    const requiredOutputs = ['plan_b1.jsonl', 'plan_b2.jsonl'];
    const mentionsBothOutputs = requiredOutputs.every(output => planText.includes(output));
    const writesBothOutputs = requiredOutputs.every(output =>
      fileWrites.some(target => target.endsWith(`/output_data/${output}`) || target.endsWith(`/${output}`)),
    );
    const invokesNoArgPacker = shellSteps.some(command =>
      /\boptimized_packer\.py\b/.test(command) &&
      !/\brequests_bucket_1\.jsonl\b/.test(command) &&
      !/\brequests_bucket_2\.jsonl\b/.test(command) &&
      !/\bplan_b1\.jsonl\b/.test(command) &&
      !/\bplan_b2\.jsonl\b/.test(command),
    );
    const hasBucket1Generation = shellSteps.some(command =>
      /\boptimized_packer\.py\b/.test(command) &&
      /\brequests_bucket_1\.jsonl\b/.test(command) &&
      /\bplan_b1\.jsonl\b/.test(command),
    );
    const hasBucket2Generation = shellSteps.some(command =>
      /\boptimized_packer\.py\b/.test(command) &&
      /\brequests_bucket_2\.jsonl\b/.test(command) &&
      /\bplan_b2\.jsonl\b/.test(command),
    );
    const hasPlanGenerationStep = (hasBucket1Generation && hasBucket2Generation) || writesBothOutputs;
    const hasCostOrVerifier = shellSteps.some(command =>
      (
        /\b(?:cost_model\.py|test_outputs\.py|pytest|verify_llm_batching_plan\.py)\b/.test(command) ||
        /\b(?:coverage|shape|pad_ratio|latency|sequential_timecost)\b/.test(command)
      ) &&
      /\bplan_b1\.jsonl\b/.test(command) &&
      /\bplan_b2\.jsonl\b/.test(command),
    );

    if (!mentionsBothOutputs || !hasPlanGenerationStep || !hasCostOrVerifier || invokesNoArgPacker) {
      failures.push({
        tag: 'SFDIPOT-F',
        condition:
          '[BENCHMARK_LLM_BATCHING_OUTPUTS_REQUIRED] llm-inference-batching-scheduler plan must explicitly generate task_file/output_data/plan_b1.jsonl and plan_b2.jsonl, avoid no-arg optimized_packer.py invocation when args are required, and validate both plans with cost_model.py or an equivalent executable verifier.',
        confidence: 5,
        fix_hint:
          'Add explicit bucket 1 and bucket 2 generation commands plus a verifier that checks coverage, schema, shape limits, and cost/latency thresholds before completion.',
      });
    }
  }

  return failures;
}

export function verifyBenchmarkPreCompleteContract(
  rawTask: string,
  toolCallLog: readonly ToolCallLog[],
): BenchmarkVerificationResult | null {
  const contract = getBenchmarkVerificationContract(rawTask);
  if (!contract) {
    if (!isExternalBenchmarkTask(rawTask)) {
      return null;
    }

    const successfulVerifier = toolCallLog.find(entry =>
      (entry.tool === 'shell_exec' || entry.tool === 'test_run') &&
      entry.exit_code === 0 &&
      entry.verified,
    );
    if (successfulVerifier) {
      return {
        contractId: 'verify.generic_external_benchmark.local_evidence',
        passed: true,
        message:
          `Generic external benchmark verification satisfied by step ${successfulVerifier.step}: ` +
          `${successfulVerifier.target}`,
      };
    }

    return {
      contractId: 'verify.generic_external_benchmark.local_evidence',
      passed: false,
      failureCategory: 'missing_verifier_evidence',
      message:
        'Generic external benchmark pre-complete verification failed: no successful verified ' +
        'shell_exec/test_run evidence was recorded after the benchmark work. Run a local verifier, ' +
        'test, comparison, or artifact-inspection command before EXECUTION_COMPLETE.',
    };
  }

  const successfulCommand = toolCallLog
    .filter(entry =>
      (entry.tool === 'shell_exec' || entry.tool === 'test_run') &&
      entry.exit_code === 0 &&
      entry.verified,
    )
    .find(entry => contract.acceptsCommand(String(entry.target ?? ''), entry));

  if (successfulCommand) {
    return {
      contractId: contract.id,
      passed: true,
      message:
        `Benchmark pre-complete verification satisfied by step ${successfulCommand.step}: ` +
        `${successfulCommand.target}`,
    };
  }

  return {
    contractId: contract.id,
    passed: false,
    failureCategory: 'task_specific_contract',
    message:
      `Benchmark pre-complete verification failed for ${contract.id}: ` +
      `${contract.completionRequirement}`,
  };
}
