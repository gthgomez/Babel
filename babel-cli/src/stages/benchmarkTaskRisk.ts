export type BenchmarkRiskLabel =
  | 'numerical_performance'
  | 'hidden_test_generalization'
  | 'artifact_generation'
  | 'binary_or_compiler'
  | 'git_stateful_merge'
  | 'browser_or_security_adversarial'
  | 'dependency_sensitive'
  | 'many_file_aggregation'
  | 'exact_output_schema';

export interface BenchmarkRiskLabelReport {
  readonly label: BenchmarkRiskLabel;
  readonly confidence: number;
  readonly matched_terms: string[];
  readonly required_plan_properties: string[];
  readonly required_local_verifier: string[];
  readonly recommended_model_tier: 'default' | 'standard' | 'escalation';
  readonly qa_rejection_rules: string[];
}

export interface BenchmarkTaskRiskReport {
  readonly is_benchmark_task: boolean;
  readonly task_name: string | null;
  readonly labels: BenchmarkRiskLabelReport[];
  readonly recommended_model_tier: 'default' | 'standard' | 'escalation';
  readonly prompt_lines: string[];
}

interface RiskRule {
  readonly label: BenchmarkRiskLabel;
  readonly confidence: number;
  readonly patterns: readonly RegExp[];
  readonly requiredPlanProperties: readonly string[];
  readonly requiredLocalVerifier: readonly string[];
  readonly recommendedModelTier: 'default' | 'standard' | 'escalation';
  readonly qaRejectionRules: readonly string[];
}

const RISK_RULES: readonly RiskRule[] = [
  {
    label: 'numerical_performance',
    confidence: 5,
    patterns: [
      /\blargest-eigenval\b/i,
      /\bdominant eigenvalue\b/i,
      /\bnon-?symmetric\b/i,
      /\bcomplex eigen/i,
      /\bfaster than\b/i,
      /\bmedian time\b/i,
      /\boptimi[sz]e\b/i,
    ],
    requiredPlanProperties: [
      'Name the numerical edge cases, including non-symmetric matrices and complex eigenpairs.',
      'Use a verifier that checks A @ eigenvec is close to eigenval * eigenvec.',
      'Check that the returned eigenvalue has the largest magnitude.',
      'Measure candidate runtime against the reference on the same matrix set when speed is required.',
    ],
    requiredLocalVerifier: [
      'Seeded random non-symmetric matrix correctness check.',
      'Dominant magnitude comparison against numpy.linalg.eigvals or an equivalent reference.',
      'Median timing check against the visible reference when the task requires speed.',
    ],
    recommendedModelTier: 'escalation',
    qaRejectionRules: [
      'Reject naive power iteration for non-symmetric complex-eigenpair tasks unless the plan proves it handles those cases.',
      'Reject performance claims without an executable timing verifier.',
      'Reject correctness-only verification when the task asks for speed.',
    ],
  },
  {
    label: 'hidden_test_generalization',
    confidence: 4,
    patterns: [
      /\bhidden tests?\b/i,
      /\bgeneralize\b/i,
      /\bmultiple tests?\b/i,
      /\bwill run\b/i,
      /\brandom\b/i,
      /\bbenchmark\b/i,
      /\barc-agi\b/i,
    ],
    requiredPlanProperties: [
      'State the inferred general contract rather than overfitting visible examples.',
      'Use seeded or representative local checks when hidden cases are implied.',
    ],
    requiredLocalVerifier: [
      'Visible-example verifier plus at least one generated or contract-level check when feasible.',
    ],
    recommendedModelTier: 'standard',
    qaRejectionRules: [
      'Reject plans that only hard-code visible examples when the task asks for generalization.',
    ],
  },
  {
    label: 'artifact_generation',
    confidence: 5,
    patterns: [
      /\bllm-inference-batching-scheduler\b/i,
      /\bdata\.comp\b/i,
      /\bcli_tool\b/i,
      /\bprediction\.txt\b/i,
      /\bweights\.json\b/i,
      /\bmy_warrior\.red\b/i,
      /\bplan_b[12]\.jsonl\b/i,
      /\boutput_data\b/i,
      /\boutput artifact\b/i,
      /\bbinary executable\b/i,
    ],
    requiredPlanProperties: [
      'List each required artifact by exact filename.',
      'Verify artifacts exist at the requested root.',
      'Verify the artifact performs the requested behavior, not just that it was written.',
    ],
    requiredLocalVerifier: [
      'Artifact existence check.',
      'Task-specific round-trip or executable behavior check.',
    ],
    recommendedModelTier: 'standard',
    qaRejectionRules: [
      'Reject helper-only plans that do not verify the final requested artifact.',
      'Reject artifact writes that skip the executable or round-trip postcondition.',
    ],
  },
  {
    label: 'binary_or_compiler',
    confidence: 4,
    patterns: [
      /\bcompile\b/i,
      /\bgcc\b/i,
      /\brustc\b/i,
      /\bcargo\b/i,
      /\bbinary executable\b/i,
      /\bdecomp(?:2)?\b/i,
      /\bpytorch\b/i,
      /\bmodel\.pth\b/i,
    ],
    requiredPlanProperties: [
      'Use the benchmark runtime inventory before assuming compilers or libraries exist.',
      'Prefer existing runtime tools or source-only solutions over unapproved dependency installs.',
    ],
    requiredLocalVerifier: [
      'Compile/build command when required.',
      'Execution smoke test for the produced binary or CLI.',
    ],
    recommendedModelTier: 'standard',
    qaRejectionRules: [
      'Reject dependency installation unless the task explicitly allows it.',
      'Reject binary tasks that never run the produced executable.',
    ],
  },
  {
    label: 'git_stateful_merge',
    confidence: 5,
    patterns: [
      /\bmerge-diff-arc-agi-task\b/i,
      /\bgit bundle\b/i,
      /\bbundle1\.bundle\b/i,
      /\bbundle2\.bundle\b/i,
      /\bbranch1\b/i,
      /\bbranch2\b/i,
      /\bmerge branch2\b/i,
    ],
    requiredPlanProperties: [
      'Initialize the requested repository.',
      'Fetch both bundles with Git-native commands.',
      'Create branch1 and branch2.',
      'Merge branch2 into branch1.',
      'Verify final algo.py and visible examples.',
    ],
    requiredLocalVerifier: [
      'git branch/status verification.',
      'examples.json verifier for algo.py.',
    ],
    recommendedModelTier: 'escalation',
    qaRejectionRules: [
      'Reject source-only repo/algo.py writes that skip bundle fetch/merge.',
      'Reject archive extraction commands for Git bundle files.',
    ],
  },
  {
    label: 'browser_or_security_adversarial',
    confidence: 5,
    patterns: [
      /\bbreak-filter-js-from-html\b/i,
      /\bfilter\.py\b/i,
      /\bout\.html\b/i,
      /\balert\b/i,
      /\bbypass\b/i,
      /\bxss\b/i,
      /\bsanitizer\b/i,
    ],
    requiredPlanProperties: [
      'Read the sanitizer/filter source before choosing a payload family.',
      'Justify the payload using source evidence.',
      'Use an executable postcondition verifier instead of manual browser confirmation.',
    ],
    requiredLocalVerifier: [
      'Run the visible filter.',
      'Run a custom executable verifier for the filtered output when pytest is unavailable.',
    ],
    recommendedModelTier: 'escalation',
    qaRejectionRules: [
      'Reject payload plans that choose stripped families before source inspection.',
      'Reject manual browser checks as completion evidence.',
    ],
  },
  {
    label: 'dependency_sensitive',
    confidence: 4,
    patterns: [
      /\bpip install\b/i,
      /\bapt-get\b/i,
      /\bconda\b/i,
      /\bpackage\b/i,
      /\bpytorch\b/i,
      /\bmodel\.pth\b/i,
      /\bmissing module\b/i,
    ],
    requiredPlanProperties: [
      'Use existing benchmark runtime capabilities first.',
      'Avoid dependency installation unless the task explicitly permits it.',
    ],
    requiredLocalVerifier: [
      'Runtime inventory-compatible command.',
    ],
    recommendedModelTier: 'standard',
    qaRejectionRules: [
      'Reject unapproved package installation recovery paths.',
    ],
  },
  {
    label: 'many_file_aggregation',
    confidence: 4,
    patterns: [
      /\blog-summary-date-ranges\b/i,
      /\blogs?\//i,
      /\bsummary\.csv\b/i,
      /\blast_7_days\b/i,
      /\blast_30_days\b/i,
      /\bmonth_to_date\b/i,
      /\baggregate\b/i,
    ],
    requiredPlanProperties: [
      'Use a helper program for many-file aggregation.',
      'Preserve exact requested labels and row order.',
    ],
    requiredLocalVerifier: [
      'Schema/header check.',
      'Row-count and label-order check.',
    ],
    recommendedModelTier: 'default',
    qaRejectionRules: [
      'Reject manual sampling as proof for many-file aggregation.',
    ],
  },
  {
    label: 'exact_output_schema',
    confidence: 5,
    patterns: [
      /\bllm-inference-batching-scheduler\b/i,
      /\bsummary\.csv\b/i,
      /\bperiod,severity,count\b/i,
      /\bexactly\b/i,
      /\bonly contains\b/i,
      /\bprediction\.txt\b/i,
      /\bplan_b[12]\.jsonl\b/i,
      /\brequest_id\b/i,
      /\bbatch_id\b/i,
      /\bshape\b/i,
    ],
    requiredPlanProperties: [
      'Preserve exact schema, delimiter, labels, and row order.',
      'Run a postcondition check after final mutation.',
    ],
    requiredLocalVerifier: [
      'Exact schema and content-shape check.',
    ],
    recommendedModelTier: 'default',
    qaRejectionRules: [
      'Reject schema-altering label synonyms.',
      'Reject completion after file write without exact output verification.',
    ],
  },
];

export function extractBenchmarkTaskName(rawTask: string): string | null {
  const normalized = String(rawTask ?? '');
  const explicit = /\bTerminal-Bench 2 task:\s*([a-z0-9_.-]+)/i.exec(normalized)?.[1];
  if (explicit) {
    return explicit;
  }
  const known = [
    'log-summary-date-ranges',
    'largest-eigenval',
    'merge-diff-arc-agi-task',
    'write-compressor',
    'pytorch-model-cli',
    'break-filter-js-from-html',
    'gpt2-codegolf',
    'winning-avg-corewars',
    'llm-inference-batching-scheduler',
  ];
  return known.find(task => new RegExp(`\\b${escapeRegExp(task)}\\b`, 'i').test(normalized)) ?? null;
}

export function isBenchmarkTask(rawTask: string): boolean {
  return /\bTerminal-Bench 2 task\b/i.test(rawTask) ||
    /\bSWE-rebench\b/i.test(rawTask) ||
    extractBenchmarkTaskName(rawTask) !== null;
}

export function classifyBenchmarkTaskRisk(rawTask: string): BenchmarkTaskRiskReport {
  const text = String(rawTask ?? '');
  const taskName = extractBenchmarkTaskName(text);
  const isBenchmark = isBenchmarkTask(text);
  if (!isBenchmark) {
    return {
      is_benchmark_task: false,
      task_name: null,
      labels: [],
      recommended_model_tier: 'default',
      prompt_lines: [],
    };
  }

  const labels = RISK_RULES
    .map(rule => {
      const matchedTerms = rule.patterns
        .filter(pattern => pattern.test(text))
        .map(pattern => pattern.source);
      return matchedTerms.length > 0
        ? {
            label: rule.label,
            confidence: rule.confidence,
            matched_terms: matchedTerms,
            required_plan_properties: [...rule.requiredPlanProperties],
            required_local_verifier: [...rule.requiredLocalVerifier],
            recommended_model_tier: rule.recommendedModelTier,
            qa_rejection_rules: [...rule.qaRejectionRules],
          }
        : null;
    })
    .filter((label): label is BenchmarkRiskLabelReport => label !== null);

  const recommended = labels.some(label => label.recommended_model_tier === 'escalation')
    ? 'escalation'
    : labels.some(label => label.recommended_model_tier === 'standard')
      ? 'standard'
      : 'default';

  return {
    is_benchmark_task: true,
    task_name: taskName,
    labels,
    recommended_model_tier: recommended,
    prompt_lines: buildBenchmarkRiskPromptLinesFromLabels(taskName, labels),
  };
}

export function buildBenchmarkRiskPromptLines(rawTask: string): string[] {
  return classifyBenchmarkTaskRisk(rawTask).prompt_lines;
}

function buildBenchmarkRiskPromptLinesFromLabels(
  taskName: string | null,
  labels: readonly BenchmarkRiskLabelReport[],
): string[] {
  if (labels.length === 0) {
    return [];
  }

  const lines = [
    'Benchmark task risk profile:',
    `  - Task: ${taskName ?? '(unknown external benchmark task)'}`,
    `  - Risk labels: ${labels.map(label => label.label).join(', ')}`,
  ];
  for (const label of labels) {
    lines.push(
      `  - ${label.label}: required plan properties: ${label.required_plan_properties.join(' ')}`,
      `  - ${label.label}: required local verifier: ${label.required_local_verifier.join(' ')}`,
      `  - ${label.label}: QA rejection rules: ${label.qa_rejection_rules.join(' ')}`,
    );
  }
  return lines;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
