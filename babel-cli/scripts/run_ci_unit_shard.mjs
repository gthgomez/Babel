#!/usr/bin/env node
// Exhaustive, disjoint selection from the canonical package unit command.
import { createHash } from 'node:crypto';
import { globSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const hash = files => createHash('sha256').update(files.join('\n')).digest('hex');

export function prepareUnitShard(packageRoot, index, count) {
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
      if (!statSync(join(packageRoot, file)).isFile()) throw new Error(`Canonical test pattern matched a non-file: ${file}`);
      files.add(file.split(sep).join('/'));
    }
  }
  const inventory = [...files].sort();
  if (count > inventory.length) throw new Error('Unit shard count would produce empty shards');
  const selected = inventory.filter((_, position) => position % count === index);
  const args = [...tokens.slice(1, testIndex), '--test-reporter=tap', '--test-concurrency=1', '--test', ...selected];
  return { index, count, patterns, inventory, selected, args, inventoryHash: hash(inventory), selectionHash: hash(selected) };
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
  writeFileSync(join(artifacts, 'selection.json'), JSON.stringify(selection, null, 2) + '\n');
  console.log(`[ci-unit] shard ${selection.index + 1}/${selection.count}: ${selection.selected.length}/${selection.inventory.length} files; inventory ${selection.inventoryHash}`);
  if (values.list) return;
  const result = spawnSync(process.execPath, [join(packageRoot, 'node_modules/tsx/dist/cli.mjs'), ...selection.args], {
    cwd: packageRoot, env: process.env, stdio: 'inherit', windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.signal || result.status === null) throw new Error(`Unit shard terminated without a successful exit: ${result.signal ?? 'unknown'}`);
  process.exitCode = result.status;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
