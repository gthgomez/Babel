#!/usr/bin/env node
// Exhaustive, disjoint selection from the canonical package unit command.
import { createHash } from 'node:crypto';
import { existsSync, globSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

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
  if (count > inventory.length) throw new Error('Unit shard count would produce empty shards');
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
  const plan = balanceUnitInventory(inventory, count, durations);
  const selected = plan[index].files;
  const args = [...tokens.slice(1, testIndex), '--test-reporter=./scripts/required_tap_reporter.mjs', '--test-concurrency=1', '--test', ...selected];
  return { index, count, patterns, inventory, selected, args, inventoryHash: hash(inventory), selectionHash: hash(selected), scheduling: { platform, measuredFiles: Object.keys(durations).length, estimatedMs: plan[index].estimatedMs } };
}

function main() {
  const { values } = parseArgs({ options: {
    'shard-index': { type: 'string' }, 'shard-count': { type: 'string' }, list: { type: 'boolean', default: false },
  } });
  if (values['shard-index'] === undefined || values['shard-count'] === undefined) throw new Error('Unit shard index/count are required');
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const selection = prepareUnitShard(packageRoot, Number(values['shard-index']), Number(values['shard-count']));
  const artifacts = join(packageRoot, 'artifacts', 'ci-unit');
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(join(artifacts, 'selection.json'), JSON.stringify({ ...selection, schemaVersion: 1, suite: 'unit', nodeVersion: process.version, platform: process.platform, arch: process.arch, packageScriptSha256: createHash('sha256').update(readFileSync(join(packageRoot, 'package.json'))).digest('hex'), files: selection.selected.map(path => ({ path, sha256: createHash('sha256').update(readFileSync(join(packageRoot, path))).digest('hex') })) }, null, 2) + '\n');
  console.log(`[ci-unit] shard ${selection.index + 1}/${selection.count}: ${selection.selected.length}/${selection.inventory.length} files; inventory ${selection.inventoryHash}`);
  if (values.list) return;
  const result = spawnSync(process.execPath, [join(packageRoot, 'node_modules/tsx/dist/cli.mjs'), ...selection.args], {
    cwd: packageRoot, env: { ...process.env, BABEL_TAP_EXECUTION_PATH: join(artifacts, 'execution.json') }, stdio: 'inherit', windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.signal || result.status === null) throw new Error(`Unit shard terminated without a successful exit: ${result.signal ?? 'unknown'}`);
  process.exitCode = result.status;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
