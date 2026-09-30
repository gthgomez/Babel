/**
 * Retirement guard for #215: `agentRunCoordinator.ts` is dead scaffold.
 *
 * The module had zero importers and failed six lifecycle acceptance boundaries
 * (see `/tmp/opencode/babel-eaststar/v2/r-s05-report.md`). It was retired
 * rather than adapted into a competing supervisor. This guard keeps it retired:
 * no production source may reference it, and the module file must stay gone.
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, '..');
const packageRoot = resolve(srcRoot, '..');
const repoRoot = resolve(packageRoot, '..');

const MODULE_RELATIVE_PATH = 'agent/agentRunCoordinator.ts';
const RETIRED_SPECIFIER_RE = /agentruncoordinator/i;
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

function isTestFile(name: string): boolean {
  return /\.test\.[cm]?[tj]sx?$/.test(name);
}

function collectProductionSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      out.push(...collectProductionSourceFiles(full));
      continue;
    }
    if (isTestFile(entry)) continue;
    if (!SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext))) continue;
    out.push(full);
  }
  return out;
}

test('retired module file is absent', () => {
  assert.equal(
    existsSync(join(srcRoot, MODULE_RELATIVE_PATH)),
    false,
    `${MODULE_RELATIVE_PATH} was retired (#215) and must not be re-added`,
  );
});

test('no production source references the retired coordinator', () => {
  const offenders = collectProductionSourceFiles(srcRoot)
    .filter((file) => RETIRED_SPECIFIER_RE.test(readFileSync(file, 'utf8')))
    .map((file) => relative(srcRoot, file).replace(/\\/g, '/'));

  assert.deepEqual(
    offenders,
    [],
    `production source must not import or mention the retired AgentRunCoordinator: ${offenders.join(', ')}`,
  );
});

test('architectural cast baseline no longer lists the retired module', () => {
  const baselinePath = join(repoRoot, 'config', 'architectural-budget', 'as-any-counts.json');
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Record<string, number>;
  const staleEntries = Object.keys(baseline).filter((key) => RETIRED_SPECIFIER_RE.test(key));

  assert.deepEqual(
    staleEntries,
    [],
    `cast baseline still lists the retired module: ${staleEntries.join(', ')}`,
  );
});
