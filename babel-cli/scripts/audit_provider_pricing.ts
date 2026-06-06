import {
  DEEPSEEK_PRICING_SOURCE_URL,
  DEEPSEEK_SUPPORTED_MODELS,
  MODEL_PRICING_REGISTRY,
  getDeepInfraPricingEntries,
} from '../src/services/modelPricingRegistry.js';

const DEEPINFRA_MODELS_API_URL = 'https://api.deepinfra.com/models/list';
const RATE_TOLERANCE_USD_PER_1M = 0.000001;

interface DeepInfraModelListEntry {
  model_name?: string;
  pricing?: {
    cents_per_input_token?: number | null;
    cents_per_output_token?: number | null;
  };
}

interface AuditFinding {
  provider: string;
  model_id: string;
  field: string;
  expected: number | string;
  actual: number | string | null;
  source_url: string;
}

function centsPerTokenToUsdPer1m(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value * 10_000 : null;
}

function ratesDiffer(expected: number, actual: number | null): boolean {
  return actual === null || Math.abs(expected - actual) > RATE_TOLERANCE_USD_PER_1M;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while fetching ${url}`);
  }
  return response.text();
}

async function auditDeepInfra(): Promise<AuditFinding[]> {
  const response = await fetch(DEEPINFRA_MODELS_API_URL);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while fetching ${DEEPINFRA_MODELS_API_URL}`);
  }
  const models = await response.json() as DeepInfraModelListEntry[];
  const byModel = new Map(models.map(model => [model.model_name, model]));
  const findings: AuditFinding[] = [];

  for (const expected of getDeepInfraPricingEntries()) {
    const actualModel = byModel.get(expected.modelId);
    const actualInput = centsPerTokenToUsdPer1m(actualModel?.pricing?.cents_per_input_token);
    const actualOutput = centsPerTokenToUsdPer1m(actualModel?.pricing?.cents_per_output_token);
    if (ratesDiffer(expected.inputCostPer1M, actualInput)) {
      findings.push({
        provider: 'deepinfra',
        model_id: expected.modelId,
        field: 'input_cost_per_1m',
        expected: expected.inputCostPer1M,
        actual: actualInput,
        source_url: DEEPINFRA_MODELS_API_URL,
      });
    }
    if (ratesDiffer(expected.outputCostPer1M, actualOutput)) {
      findings.push({
        provider: 'deepinfra',
        model_id: expected.modelId,
        field: 'output_cost_per_1m',
        expected: expected.outputCostPer1M,
        actual: actualOutput,
        source_url: DEEPINFRA_MODELS_API_URL,
      });
    }
  }

  return findings;
}

function rateAppearsOnPage(page: string, rate: number): boolean {
  const normalized = page.replace(/\s+/g, ' ');
  const fixed = rate.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return normalized.includes(`$${fixed}`) || normalized.includes(fixed);
}

async function auditDeepSeek(): Promise<AuditFinding[]> {
  const page = await fetchText(DEEPSEEK_PRICING_SOURCE_URL);
  const findings: AuditFinding[] = [];
  for (const modelId of DEEPSEEK_SUPPORTED_MODELS) {
    const expected = MODEL_PRICING_REGISTRY[`deepseek:${modelId}`];
    if (!expected) {
      findings.push({
        provider: 'deepseek',
        model_id: modelId,
        field: 'registry',
        expected: 'registered',
        actual: null,
        source_url: DEEPSEEK_PRICING_SOURCE_URL,
      });
      continue;
    }
    if (!page.includes(modelId)) {
      findings.push({
        provider: 'deepseek',
        model_id: modelId,
        field: 'model_id',
        expected: modelId,
        actual: null,
        source_url: DEEPSEEK_PRICING_SOURCE_URL,
      });
    }
    const rates = [
      ['input_cache_hit_cost_per_1m', expected.inputCacheHitCostPer1M],
      ['input_cache_miss_cost_per_1m', expected.inputCacheMissCostPer1M],
      ['output_cost_per_1m', expected.outputCostPer1M],
    ] as const;
    for (const [field, rate] of rates) {
      if (typeof rate === 'number' && !rateAppearsOnPage(page, rate)) {
        findings.push({
          provider: 'deepseek',
          model_id: modelId,
          field,
          expected: rate,
          actual: null,
          source_url: DEEPSEEK_PRICING_SOURCE_URL,
        });
      }
    }
  }
  return findings;
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const findings = [
    ...await auditDeepInfra(),
    ...await auditDeepSeek(),
  ];
  const payload = {
    artifact_type: 'babel_provider_pricing_audit',
    generated_at: startedAt,
    sources: {
      deepinfra: DEEPINFRA_MODELS_API_URL,
      deepseek: DEEPSEEK_PRICING_SOURCE_URL,
    },
    checked_model_count: getDeepInfraPricingEntries().length + DEEPSEEK_SUPPORTED_MODELS.length,
    finding_count: findings.length,
    findings,
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (findings.length > 0) {
    process.exitCode = 1;
  }
}

await main().catch((error: unknown) => {
  process.stderr.write(`[audit_provider_pricing] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
