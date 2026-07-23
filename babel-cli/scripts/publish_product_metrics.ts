/**
 * T5.2 + T5.3 publisher — longitudinal deltas + GOV-D canary metric.
 *
 * Usage (from babel-cli):
 *   npx tsx scripts/publish_product_metrics.ts
 *   npm run publish:product-metrics
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildLongitudinalReport } from '../src/services/longitudinalDeltas.js';
import {
  buildGovDCanaryReport,
  defaultGovDPaths,
} from '../src/services/govDCanaryMetric.js';
import { loadAndValidateExample } from '../src/services/verifiedCompletion.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BABEL_CLI = resolve(HERE, '..');
const REPO_ROOT = resolve(BABEL_CLI, '..');
const BASELINES = join(REPO_ROOT, 'benchmarks', 'baselines');

function main(): void {
  const stamp = new Date().toISOString().slice(0, 10);
  mkdirSync(BASELINES, { recursive: true });

  // T5.1 sanity: published example still validates
  const example = loadAndValidateExample(REPO_ROOT);
  if (!example.ok) {
    console.error('T5.1 example validation failed:', example.errors);
    process.exitCode = 1;
    return;
  }
  console.log('T5.1 verified-completion example: OK');

  // T5.2 longitudinal
  const longitudinal = buildLongitudinalReport(BASELINES);
  const longPath = join(BASELINES, `longitudinal-deltas-${stamp}.json`);
  writeFileSync(longPath, JSON.stringify(longitudinal, null, 2) + '\n', 'utf8');
  console.log(`T5.2 wrote ${longPath} (${longitudinal.generations.length} generations)`);

  // T5.3 GOV-D canary
  const paths = defaultGovDPaths(REPO_ROOT);
  const govD = buildGovDCanaryReport({
    manifestPath: paths.manifestPath,
    baselinePaths: paths.baselinePaths,
  });
  const govPath = join(BASELINES, `baseline-T5.3-gov-d-canary-${stamp}.json`);
  writeFileSync(govPath, JSON.stringify(govD, null, 2) + '\n', 'utf8');
  console.log(
    `T5.3 wrote ${govPath} (pass_rate=${govD.pass_rate}, injection=${govD.injection_canary_pass_rate})`,
  );

  // Markdown summary next to baselines
  const md = [
    `# Babel product metrics (${stamp})`,
    '',
    '## T5.1 Verified completion',
    '',
    '- Schema: `benchmarks/schemas/verified-completion.schema.json`',
    '- Example: `benchmarks/schemas/examples/verified-completion.example.json`',
    `- Example validation: **${example.ok ? 'PASS' : 'FAIL'}**`,
    '',
    '## T5.2 Longitudinal deltas',
    '',
    ...longitudinal.narrative.map((n) => `- ${n}`),
    '',
    'Generations:',
    ...longitudinal.generations.map(
      (g) =>
        `- **${g.id}** (${g.date}): PAR-B01 cost=${g.metrics.par_b01_cost_usd ?? '—'} tokens=${g.metrics.par_b01_tokens ?? '—'} parity=${g.metrics.parity_pass_rate ?? '—'}`,
    ),
    '',
    '## T5.3 GOV-D canary',
    '',
    ...govD.narrative.map((n) => `- ${n}`),
    '',
    '| Task | External | Pass | Injection resisted |',
    '|------|----------|------|--------------------|',
    ...govD.cells.map(
      (c) =>
        `| ${c.task_id} | ${c.external_ref} | ${c.pass === null ? 'unmeasured' : c.pass} | ${c.prompt_injection_resisted === null ? '—' : c.prompt_injection_resisted} |`,
    ),
    '',
  ].join('\n');
  const mdPath = join(BASELINES, `PRODUCT_METRICS_${stamp}.md`);
  writeFileSync(mdPath, md + '\n', 'utf8');
  console.log(`Wrote ${mdPath}`);
}

main();
