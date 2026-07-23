/**
 * Provision SWE-bench Verified JSONL subset for babel-agent-benchmark manifest tasks.
 *
 * Usage:
 *   node scripts/provision_swebench_dataset.mjs
 *   node scripts/provision_swebench_dataset.mjs --force
 *
 * Output:
 *   benchmarks/datasets/swe-bench-verified/benchmark-subset.jsonl
 *
 * Set for benchmark runs:
 *   $env:SWEBENCH_DATASET_PATH = "/tmp/Babel\benchmarks\datasets\swe-bench-verified\benchmark-subset.jsonl"
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const babelRoot = resolve(scriptDir, '..', '..');
const manifestPath = join(
  babelRoot,
  'benchmarks',
  'babel-agent-benchmark',
  'manifest.json',
);
const outDir = join(babelRoot, 'benchmarks', 'datasets', 'swe-bench-verified');
const outPath = join(outDir, 'benchmark-subset.jsonl');
const force = process.argv.includes('--force');

function requiredInstanceIds() {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  return [
    ...new Set(
      manifest.tasks
        .filter((task) => task.verifier?.kind === 'swebench')
        .map((task) => task.verifier.instance_id)
        .filter(Boolean),
    ),
  ];
}

async function fetchAllRows(dataset) {
  const rows = [];
  const pageSize = 100;
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;

  while (offset < total) {
    const url = new URL('https://datasets-server.huggingface.co/rows');
    url.searchParams.set('dataset', dataset);
    url.searchParams.set('config', 'default');
    url.searchParams.set('split', 'test');
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('length', String(pageSize));

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `HuggingFace datasets-server HTTP ${response.status} for ${dataset}: ${await response.text()}`,
      );
    }
    const payload = await response.json();
    total = payload.num_rows_total ?? total;
    const batch = payload.rows ?? [];
    if (batch.length === 0) {
      break;
    }
    for (const entry of batch) {
      rows.push(entry.row);
    }
    offset += batch.length;
    process.stderr.write(`[provision] ${dataset}: fetched ${rows.length}/${total}\r`);
  }
  process.stderr.write('\n');
  return rows;
}

async function fetchAllVerifiedRows() {
  return fetchAllRows('princeton-nlp/SWE-bench_Verified');
}

async function loadInstanceIndex() {
  const byId = new Map();
  for (const dataset of ['princeton-nlp/SWE-bench_Verified', 'princeton-nlp/SWE-bench']) {
    const rows = await fetchAllRows(dataset);
    for (const row of rows) {
      const instanceId = typeof row['instance_id'] === 'string' ? row['instance_id'] : null;
      if (instanceId && !byId.has(instanceId)) {
        byId.set(instanceId, { ...row, _babel_eval_dataset: dataset });
      }
    }
  }
  return byId;
}

async function main() {
  if (existsSync(outPath) && !force) {
    console.log(`Dataset already present: ${outPath}`);
    console.log(`Re-run with --force to refresh.`);
    console.log(`SWEBENCH_DATASET_PATH=${outPath}`);
    return;
  }

  const wanted = new Set(requiredInstanceIds());
  console.log(`[provision] Need ${wanted.size} SWE-bench instances from manifest.`);

  const byId = await loadInstanceIndex();

  const selected = [];
  const missing = [];
  for (const id of wanted) {
    const row = byId.get(id);
    if (row) {
      selected.push(row);
    } else {
      missing.push(id);
    }
  }

  if (missing.length > 0) {
    throw new Error(`Missing ${missing.length} instance(s) in SWE-bench datasets: ${missing.join(', ')}`);
  }

  mkdirSync(outDir, { recursive: true });
  const jsonl = selected.map((row) => JSON.stringify(row)).join('\n') + '\n';
  writeFileSync(outPath, jsonl, 'utf8');

  const envPath = join(outDir, 'SWEBENCH_DATASET_PATH.txt');
  writeFileSync(envPath, `${outPath}\n`, 'utf8');

  console.log(`[provision] Wrote ${selected.length} rows -> ${outPath}`);
  console.log(`SWEBENCH_DATASET_PATH=${outPath}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
