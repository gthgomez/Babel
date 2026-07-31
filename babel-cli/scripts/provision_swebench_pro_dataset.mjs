/**
 * Provision SWE-Bench Pro (Scale AI) pilot JSONL for Babel campaigns.
 *
 * Usage:
 *   node scripts/provision_swebench_pro_dataset.mjs
 *   node scripts/provision_swebench_pro_dataset.mjs --force
 *   node scripts/provision_swebench_pro_dataset.mjs --limit 5 --language python
 *
 * Output (repo-relative):
 *   benchmarks/datasets/swe-bench-pro/pilot-subset.jsonl
 *
 * Env for campaigns:
 *   SWEBENCH_PRO_DATASET_PATH=<outPath>
 *   SWEBENCH_PRO_ROOT=<path-to-ScaleAI/SWE-bench_Pro clone>
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const babelRoot = resolve(scriptDir, '..', '..');
const outDir = join(babelRoot, 'benchmarks', 'datasets', 'swe-bench-pro');
const outPath = join(outDir, 'pilot-subset.jsonl');
const cachePath = join(outDir, 'hf-cache-sample.jsonl');

const force = process.argv.includes('--force');
const limitArg = process.argv.indexOf('--limit');
const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1] || 5) : 5;
const langArg = process.argv.indexOf('--language');
const languageFilter =
  langArg >= 0 ? String(process.argv[langArg + 1] || 'python').toLowerCase() : 'python';

const HF_DATASET = 'ScaleAI/SWE-bench_Pro';

async function fetchRowsPage(offset, length) {
  const url = new URL('https://datasets-server.huggingface.co/rows');
  url.searchParams.set('dataset', HF_DATASET);
  url.searchParams.set('config', 'default');
  url.searchParams.set('split', 'test');
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('length', String(length));
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `HuggingFace datasets-server HTTP ${response.status} for ${HF_DATASET}: ${await response.text()}`,
    );
  }
  return response.json();
}

/**
 * Fetch enough rows to build a diverse pilot (python-first across repos).
 * Caps total HF page fetches so we do not download the whole 731-row set.
 */
async function collectPilotCandidates(maxPages = 8, pageSize = 100) {
  const candidates = [];
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;

  for (let page = 0; page < maxPages && offset < total; page += 1) {
    const payload = await fetchRowsPage(offset, pageSize);
    total = payload.num_rows_total ?? total;
    const batch = payload.rows ?? [];
    if (batch.length === 0) break;
    for (const entry of batch) {
      candidates.push(entry.row);
    }
    offset += batch.length;
    process.stderr.write(
      `[provision-pro] fetched ${candidates.length}/${total} rows (scanning for pilot)\r`,
    );
    // Early exit if we already have enough diversity for selection.
    if (enoughForPilot(candidates)) break;
  }
  process.stderr.write('\n');
  return candidates;
}

function enoughForPilot(rows) {
  const byRepo = new Map();
  for (const row of rows) {
    const lang = String(row.repo_language ?? '').toLowerCase();
    if (languageFilter && lang !== languageFilter) continue;
    const repo = String(row.repo ?? '');
    if (!repo || !row.instance_id) continue;
    byRepo.set(repo, (byRepo.get(repo) ?? 0) + 1);
  }
  // Want at least 2 repos and >= limit matching language rows.
  let matching = 0;
  for (const n of byRepo.values()) matching += n;
  return matching >= limit && byRepo.size >= 2;
}

function selectPilot(rows, n) {
  const filtered = rows.filter((row) => {
    const lang = String(row.repo_language ?? '').toLowerCase();
    if (languageFilter && lang !== languageFilter) return false;
    if (!row.instance_id || !row.repo || !row.base_commit || !row.problem_statement) {
      return false;
    }
    // Skip tutao-style long evals when detectable in id/repo
    const id = String(row.instance_id).toLowerCase();
    const repo = String(row.repo).toLowerCase();
    if (id.includes('tutao') || repo.includes('tutao')) return false;
    return true;
  });

  // Round-robin across repos for diversity.
  const byRepo = new Map();
  for (const row of filtered) {
    const repo = String(row.repo);
    if (!byRepo.has(repo)) byRepo.set(repo, []);
    byRepo.get(repo).push(row);
  }
  const repos = [...byRepo.keys()];
  const selected = [];
  let i = 0;
  while (selected.length < n && repos.length > 0) {
    const repo = repos[i % repos.length];
    const bucket = byRepo.get(repo);
    if (bucket && bucket.length > 0) {
      selected.push(bucket.shift());
    }
    if (!bucket || bucket.length === 0) {
      repos.splice(i % Math.max(repos.length, 1), 1);
      if (repos.length === 0) break;
      continue;
    }
    i += 1;
  }
  return selected;
}

/**
 * Strip absolute home/workspace paths so public content policy (PCONT002)
 * never fails on upstream problem-statement noise or local examples.
 */
function scrubMachinePaths(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  return value
    .replace(/[A-Za-z]:[\\/]+(?:Users|Workspace|Projects)[\\/]+[^\s'"`]+/gi, '<LOCAL_PATH>/')
    .replace(/\/(?:Users|home)\/[^/\s'"`]+\//gi, '<HOME>/');
}

function scrubRecordStrings(record) {
  const out = { ...record };
  for (const [key, val] of Object.entries(out)) {
    if (typeof val === 'string') out[key] = scrubMachinePaths(val);
  }
  return out;
}

function normalizeRow(row) {
  return scrubRecordStrings({
    instance_id: row.instance_id,
    repo: row.repo,
    base_commit: row.base_commit,
    problem_statement: row.problem_statement,
    patch: row.patch ?? '',
    test_patch: row.test_patch ?? '',
    repo_language: row.repo_language ?? '',
    requirements: row.requirements ?? '',
    interface: row.interface ?? '',
    fail_to_pass: row.fail_to_pass ?? row.FAIL_TO_PASS ?? '',
    pass_to_pass: row.pass_to_pass ?? row.PASS_TO_PASS ?? '',
    dockerhub_tag: row.dockerhub_tag ?? '',
    before_repo_set_cmd: row.before_repo_set_cmd ?? '',
    selected_test_files_to_run: row.selected_test_files_to_run ?? '',
    issue_specificity: row.issue_specificity ?? '',
    issue_categories: row.issue_categories ?? '',
    _babel_eval_dataset: HF_DATASET,
    _babel_source: 'swe_bench_pro',
  });
}

async function main() {
  if (existsSync(outPath) && !force) {
    const lines = readFileSync(outPath, 'utf8').split(/\r?\n/).filter(Boolean);
    console.log(`Dataset already present: ${outPath} (${lines.length} rows)`);
    console.log('Re-run with --force to refresh.');
    console.log(`SWEBENCH_PRO_DATASET_PATH=${outPath}`);
    return;
  }

  console.log(
    `[provision-pro] Selecting up to ${limit} rows (language=${languageFilter}) from ${HF_DATASET}`,
  );
  const candidates = await collectPilotCandidates();
  mkdirSync(outDir, { recursive: true });
  // Optional cache of scanned rows (first N) for offline re-select
  writeFileSync(
    cachePath,
    candidates
      .slice(0, 200)
      .map((r) => JSON.stringify(normalizeRow(r)))
      .join('\n') + '\n',
    'utf8',
  );

  const selected = selectPilot(candidates, limit);
  if (selected.length === 0) {
    throw new Error(
      `No pilot rows matched language=${languageFilter}. Try --language '' or --force after checking HF access.`,
    );
  }

  const body = selected.map((r) => JSON.stringify(normalizeRow(r))).join('\n') + '\n';
  writeFileSync(outPath, body, 'utf8');
  console.log(`Wrote ${selected.length} rows → ${outPath}`);
  for (const r of selected) {
    console.log(`  - ${r.instance_id} (${r.repo} / ${r.repo_language})`);
  }
  console.log(`SWEBENCH_PRO_DATASET_PATH=${outPath}`);
  console.log('SWEBENCH_PRO_ROOT=<path-to-ScaleAI/SWE-bench_Pro clone>');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
