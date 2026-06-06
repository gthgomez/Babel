import { classifyBenchmarkTaskRisk } from '../stages/benchmarkTaskRisk.js';

export interface ModelEscalationSignal {
  code: string;
  reason: string;
}

export interface ModelEscalationRecommendation {
  should_escalate: boolean;
  recommended_tier: 'escalation' | null;
  signals: ModelEscalationSignal[];
}

const HARD_TASK_PATTERNS: Array<{ code: string; pattern: RegExp; reason: string }> = [
  {
    code: 'performance_optimization',
    pattern: /\b(performance|optimi[sz]e|latency|speed|timeout|fast enough|slow|benchmark|throughput)\b/i,
    reason: 'Task mentions performance, speed, timeout, or benchmark-sensitive work.',
  },
  {
    code: 'algorithmic_reverse_engineering',
    pattern: /\b(reverse engineer|decomp|compressor|decompress|codegolf|eigenval|scheduler|batching|arc-agi|strategy|corewar)\b/i,
    reason: 'Task resembles algorithmic reverse engineering, search, compression, or strategy work.',
  },
  {
    code: 'exploit_or_bypass_construction',
    pattern: /\b(exploit|bypass|filter|payload|xss|sandbox escape|injection)\b/i,
    reason: 'Task asks for exploit-like, bypass, payload, or filter behavior in an isolated workflow.',
  },
  {
    code: 'repeated_halt_or_verifier_failure',
    pattern: /\b(executor_halted|qa_rejected|max_loops|verifier failed|complete but failed|segfault|wrong answer)\b/i,
    reason: 'Task context describes prior halts or verifier failures.',
  },
];

export function recommendModelEscalation(input: {
  task: string;
  status?: string | null;
  haltTag?: string | null;
  verifierMessage?: string | null;
}): ModelEscalationRecommendation {
  const haystack = [
    input.task,
    input.status ?? '',
    input.haltTag ?? '',
    input.verifierMessage ?? '',
  ].join('\n');

  const signals = HARD_TASK_PATTERNS
    .filter(candidate => candidate.pattern.test(haystack))
    .map(candidate => ({
      code: candidate.code,
      reason: candidate.reason,
    }));
  const riskReport = classifyBenchmarkTaskRisk(haystack);
  for (const label of riskReport.labels) {
    if (label.recommended_model_tier === 'default') {
      continue;
    }
    signals.push({
      code: `benchmark_risk_${label.label}`,
      reason:
        `Benchmark risk "${label.label}" recommends ${label.recommended_model_tier} model handling: ` +
        label.qa_rejection_rules[0],
    });
  }

  return {
    should_escalate: signals.length > 0,
    recommended_tier: signals.length > 0 ? 'escalation' : null,
    signals,
  };
}

export function formatEscalationRecommendationHuman(recommendation: ModelEscalationRecommendation): string {
  if (!recommendation.should_escalate) {
    return 'Model escalation: not recommended by current rules.';
  }

  return [
    `Model escalation: recommended (${recommendation.recommended_tier})`,
    ...recommendation.signals.map(signal => `  - ${signal.code}: ${signal.reason}`),
  ].join('\n');
}
