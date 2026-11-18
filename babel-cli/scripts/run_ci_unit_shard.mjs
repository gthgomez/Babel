#!/usr/bin/env node
// Exhaustive, disjoint selection from the canonical package unit command.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, globSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runLoggedTapChild } from './run_logged_tap_child.mjs';
import { probeUnitShardHostPython, writeHostPythonProbeRecord } from './ci_unit_host_python_probe.mjs';

const hash = files => createHash('sha256').update(files.join('\n')).digest('hex');

/** Duration hints affect scheduling only; every file is assigned exactly once. */
export function balanceUnitInventory(inventory, count, durations = {}) {
  if (!Number.isInteger(count) || count < 1 || count > inventory.length || new Set(inventory).size !== inventory.length) throw new Error('Invalid shard inventory');
  const weight = path => typeof durations[path] === 'number' && Number.isFinite(durations[path]) && durations[path] > 0 && durations[path] <= 86400000 ? durations[path] : 1000;
  const shards = Array.from({ length: count }, () => ({ files: [], estimatedMs: 0 }));
  for (const file of [...inventory].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0))) {
    let target = shards[0];
    for (const shard of shards) if (shard.estimatedMs < target.estimatedMs || (shard.estimatedMs === target.estimatedMs && shard.files.length < target.files.length)) target = shard;
    target.files.push(file); target.estimatedMs += weight(file);
  }
  return shards.map(shard => ({ ...shard, files: shard.files.sort() }));
}

/** Required TAP suites whose exact inventories already execute on both hosted platforms. */
export const DELEGATED_UNIT_SUITES = ['chat-truth', 'harness-runtime'];

function expandCanonicalTestScript(packageRoot, scriptName, { requiredPrefix = null } = {}) {
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const script = pkg.scripts?.[scriptName];
  if (typeof script !== 'string') return null;
  if (requiredPrefix && !script.startsWith(requiredPrefix)) throw new Error(`Unexpected canonical ${scriptName} command`);
  if (/["';&|`]/.test(script)) throw new Error(`Unexpected canonical ${scriptName} command`);
  const tokens = script.trim().split(/\s+/);
  const testIndex = tokens.indexOf('--test');
  if (testIndex < 1) throw new Error(`Canonical ${scriptName} command must contain --test`);
  const patterns = tokens.slice(testIndex + 1);
  if (!patterns.length || patterns.some(pattern => !/^src\/[a-zA-Z0-9_*./-]+\.test\.ts$/.test(pattern) || pattern.split('/').includes('..'))) {
    throw new Error(`Unexpected canonical ${scriptName} test pattern`);
  }
  const files = new Set();
  for (const pattern of patterns) {
    const matches = globSync(pattern, { cwd: packageRoot });
    if (!matches.length) throw new Error(`Canonical ${scriptName} pattern matched no test files: ${pattern}`);
    for (const file of matches) {
      const stat = statSync(join(packageRoot, file));
      if (!stat.isFile()) throw new Error(`Canonical ${scriptName} pattern matched a non-file: ${file}`);
      if (stat.size === 0) throw new Error(`Canonical ${scriptName} pattern matched an empty test file: ${file}`);
      files.add(file.split(sep).join('/'));
    }
  }
  return [...files].sort();
}

/**
 * Return canonical unit files already executed by required TAP suites. A file
 * is delegated only when it appears in both the unit inventory and a required
 * suite's expanded selection, and that suite keeps the same no-ambient
 * bootstrap; deleting coverage from either side fails instead of silently
 * shrinking qualification.
 */
export function delegatedUnitFiles(packageRoot, inventory) {
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const bootstrapOf = name => {
    const tokens = typeof pkg.scripts?.[name] === 'string' ? pkg.scripts[name].trim().split(/\s+/) : [];
    const index = tokens.indexOf('--import');
    return index >= 0 ? tokens[index + 1] : null;
  };
  const unitBootstrap = bootstrapOf('test:unit');
  if (!unitBootstrap) throw new Error('Canonical unit command must declare its bootstrap import');
  const byPath = new Map();
  for (const suite of DELEGATED_UNIT_SUITES) {
    const files = expandCanonicalTestScript(packageRoot, `test:${suite}:raw`);
    if (files === null) continue;
    if (bootstrapOf(`test:${suite}:raw`) !== unitBootstrap) {
      throw new Error(`Required ${suite} suite must retain the unit no-ambient bootstrap`);
    }
    const selected = files.filter(file => inventory.includes(file));
    if (selected.length === 0) throw new Error(`Required ${suite} suite delegates no canonical unit files`);
    for (const file of selected) {
      const entry = byPath.get(file) ?? { path: file, sha256: createHash('sha256').update(readFileSync(join(packageRoot, file))).digest('hex'), suites: [] };
      entry.suites.push(suite);
      byPath.set(file, entry);
    }
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export function prepareUnitShard(packageRoot, index, count, { platform = process.platform } = {}) {
  if (!Number.isInteger(index) || !Number.isInteger(count) || count < 1 || index < 0 || index >= count) {
    throw new Error('Invalid unit shard coordinates');
  }
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const script = pkg.scripts?.['test:unit'];
  if (typeof script !== 'string' || !script.startsWith('tsx ') || /["';&|`]/.test(script)) {
    throw new Error('Unexpected canonical unit command');
  }
  const tokens = script.trim().split(/\s+/);
  const testIndex = tokens.indexOf('--test');
  if (testIndex < 2) throw new Error('Canonical unit command must contain runner options and --test');
  const patterns = tokens.slice(testIndex + 1);
  if (!patterns.length || patterns.some(pattern => !/^src\/[a-zA-Z0-9_*./-]+\.test\.ts$/.test(pattern) || pattern.split('/').includes('..'))) {
    throw new Error('Unexpected canonical test pattern');
  }
  const files = new Set();
  for (const pattern of patterns) {
    const matches = globSync(pattern, { cwd: packageRoot });
    if (!matches.length) throw new Error(`Canonical pattern matched no test files: ${pattern}`);
    for (const file of matches) {
      const stat = statSync(join(packageRoot, file));
      if (!stat.isFile()) throw new Error(`Canonical test pattern matched a non-file: ${file}`);
      if (stat.size === 0) throw new Error(`Canonical test pattern matched an empty test file: ${file}`);
      files.add(file.split(sep).join('/'));
    }
  }
  const inventory = [...files].sort();
  // `inventory` stays the exhaustive canonical lane used by classification
  // guards. Shards execute the same files minus exact required-suite matches.
  const delegated = delegatedUnitFiles(packageRoot, inventory);
  const delegatedPaths = new Set(delegated.map(file => file.path));
  const shardInventory = inventory.filter(file => !delegatedPaths.has(file));
  if (count > shardInventory.length) throw new Error('Unit shard count would produce empty shards');
  const durations = {};
  const durationPath = join(packageRoot, 'config', 'ci-unit-durations.json');
  if (existsSync(durationPath)) {
    try {
      const hints = JSON.parse(readFileSync(durationPath, 'utf8'));
      for (const [path, hint] of Object.entries(hints.schemaVersion === 1 ? hints.platforms?.[platform] ?? {} : {})) {
        if (files.has(path) && hint?.sha256 === createHash('sha256').update(readFileSync(join(packageRoot, path))).digest('hex')) durations[path] = hint.durationMs;
      }
    } catch { /* Advisory hints never remove work or fail a correctness gate. */ }
  }
  const plan = balanceUnitInventory(shardInventory, count, durations);
  const selected = plan[index].files;
  const args = [...tokens.slice(1, testIndex), '--test-reporter=./scripts/required_tap_reporter.mjs', '--test-concurrency=1', '--test', ...selected];
  const estimates = plan.map(shard => shard.estimatedMs);
  const meanEstimate = estimates.reduce((sum, value) => sum + value, 0) / estimates.length;
  const measuredShardFiles = shardInventory.filter(file => file in durations).length;
  return {
    index,
    count,
    patterns,
    inventory,
    delegated,
    shardInventory,
    selected,
    args,
    inventoryHash: hash(inventory),
    selectionHash: hash(selected),
    scheduling: {
      platform,
      measuredFiles: Object.keys(durations).length,
      measuredShardFiles,
      shardInventoryCount: shardInventory.length,
      hintCoverage: shardInventory.length > 0 ? measuredShardFiles / shardInventory.length : null,
      estimatedMs: plan[index].estimatedMs,
      shardEstimatedMs: estimates,
      estimatedSpreadMs: Math.max(...estimates) - Math.min(...estimates),
      estimatedImbalanceRatio: meanEstimate > 0 ? Math.max(...estimates) / meanEstimate : null,
    },
  };
}

async function main() {
  const { values } = parseArgs({ options: {
    'shard-index': { type: 'string' }, 'shard-count': { type: 'string' }, list: { type: 'boolean', default: false },
  } });
  if (values['shard-index'] === undefined || values['shard-count'] === undefined) throw new Error('Unit shard index/count are required');
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const selection = prepareUnitShard(packageRoot, Number(values['shard-index']), Number(values['shard-count']));
  const artifacts = join(packageRoot, 'artifacts', 'ci-unit');
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(join(artifacts, 'selection.json'), JSON.stringify({
    schemaVersion: 1,
    suite: 'unit',
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    packageScriptSha256: createHash('sha256').update(readFileSync(join(packageRoot, 'package.json'))).digest('hex'),
    inventoryHash: selection.inventoryHash,
    selectionHash: selection.selectionHash,
    index: selection.index,
    count: selection.count,
    delegate: {
      suites: DELEGATED_UNIT_SUITES,
      files: selection.delegated,
      inventoryCount: selection.inventory.length,
      shardInventoryCount: selection.shardInventory.length,
    },
    scheduling: selection.scheduling,
    selected: selection.selected,
    files: selection.selected.map(path => ({ path, sha256: createHash('sha256').update(readFileSync(join(packageRoot, path))).digest('hex') })),
  }, null, 2) + '\n');
  console.log(`[ci-unit] shard ${selection.index + 1}/${selection.count}: ${selection.selected.length}/${selection.shardInventory.length} shard files (${selection.inventory.length} canonical, ${selection.delegated.length} delegated); inventory ${selection.inventoryHash}`);
  if (values.list) return;
  // Keep growing logs outside the project while tests capture its source.
  // CI's outer Tee-Object has its own full.tap; never write to that live file.
  const captureDirectory = join(packageRoot, '..', 'artifacts', 'ci-unit');
  mkdirSync(captureDirectory, { recursive: true });
  const tapPath = join(captureDirectory, 'producer.tap');
  for (const name of ['full.tap', 'full.tap.stderr.log', 'execution.json', 'results.json']) rmSync(join(artifacts, name), { force: true });
  const hostPython = probeUnitShardHostPython(selection.selected, process.env);
  writeHostPythonProbeRecord(packageRoot, hostPython.record);
  if (hostPython.record.required && !hostPython.record.resolved) {
    console.error(`[ci-unit] host Python required for: ${hostPython.record.selected.join(', ')}; tried: ${hostPython.record.tried.join(', ')}`);
  }
  let result;
  try {
    result = await runLoggedTapChild(process.execPath, [join(packageRoot, 'node_modules/tsx/dist/cli.mjs'), ...selection.args], {
      cwd: packageRoot,
      env: { ...process.env, ...hostPython.env, BABEL_TAP_EXECUTION_PATH: join(artifacts, 'execution.json') },
      tapPath, label: 'ci-unit',
    });
  } finally {
    for (const suffix of ['', '.stderr.log']) {
      if (existsSync(tapPath + suffix)) copyFileSync(tapPath + suffix, join(artifacts, 'full.tap' + suffix));
    }
  }
  if (result.error) throw result.error;
  if (result.signal || result.status === null) throw new Error(`Unit shard terminated without a successful exit: ${result.signal ?? 'unknown'}`);
  process.exitCode = result.status;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
