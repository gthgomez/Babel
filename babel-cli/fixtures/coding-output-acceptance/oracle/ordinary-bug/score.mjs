#!/usr/bin/env node
/**
 * Independent behavioral oracle for COC-ORDINARY-BUG.
 *
 * The candidate's own tests are agent-visible and must not be the authority.
 * This oracle imports the exported `add` function in a separate process and
 * checks behavioral equivalence on positive, negative, zero and fractional
 * inputs. It never executes candidate test files or compares source text, so
 * any behaviorally equivalent implementation is accepted and every wrong
 * implementation observed by the cases is rejected.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workspace = process.argv[2];
if (!workspace) {
  console.error('usage: score.mjs <agent-workspace>');
  process.exit(2);
}

const templateRoot = join(dirname(fileURLToPath(import.meta.url)), '../../workspaces/ordinary-bug');
const unchanged = ['tests/math.test.js', 'package.json', 'README.md'];

// Behavior is the contract. `expected` is computed here, never read from the
// workspace, so a candidate cannot rewrite the oracle or hardcode its output.
const cases = [
  [1, 2, 3],
  [2, 3, 5],
  [0, 0, 0],
  [-2, 5, 3],
  [2, -5, -3],
  [-3, -4, -7],
  [0.5, 0.25, 0.75],
  [-1.5, 0.5, -1],
  [1e9, 1, 1_000_000_001],
  [Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER],
  [-0, -0, 0],
];

const probe = `
import { pathToFileURL } from 'node:url'
const moduleUrl = pathToFileURL(process.argv[2]).href
let add
try {
  ({ add } = await import(moduleUrl))
} catch (error) {
  console.log(JSON.stringify({ error: 'module_load_failed', detail: String(error && error.message || error) }))
  process.exit(1)
}
if (typeof add !== 'function') {
  console.log(JSON.stringify({ error: 'add_not_exported_as_function' }))
  process.exit(1)
}
const cases = JSON.parse(process.argv[3])
const failures = []
for (let index = 0; index < cases.length; index += 1) {
  const [a, b, expected] = cases[index]
  let actual
  try {
    actual = add(a, b)
  } catch (error) {
    failures.push({ index, a, b, expected, threw: String(error && error.message || error) })
    continue
  }
  const ok = typeof actual === 'number' && Number.isFinite(actual) && actual === expected
  if (!ok) failures.push({ index, a, b, expected, actual: typeof actual === 'number' ? actual : String(actual), actualType: typeof actual })
}
console.log(JSON.stringify({ cases: cases.length, failures }))
`;

const probeDir = mkdtempSync(join(tmpdir(), 'ordinary-bug-oracle-'));
const probePath = join(probeDir, 'probe.mjs');
let result;
try {
  writeFileSync(probePath, probe, 'utf8');
  result = execFileSync(
    process.execPath,
    [probePath, join(workspace, 'src/math.js'), JSON.stringify(cases)],
    { cwd: workspace, encoding: 'utf8', timeout: 30_000, windowsHide: true },
  );
} catch (error) {
  const detail =
    error && typeof error === 'object' && 'stderr' in error
      ? String(error.stderr || error.message)
      : String(error);
  console.error(`FAILED: independent behavioral probe could not run: ${detail.slice(0, 2000)}`);
  process.exit(1);
} finally {
  rmSync(probeDir, { recursive: true, force: true });
}

let report;
try {
  report = JSON.parse(result.trim().split(/\r?\n/).at(-1));
} catch {
  console.error('FAILED: independent behavioral probe returned unparseable output.');
  process.exit(1);
}
if (report.error) {
  console.error(`FAILED: ${report.error}${report.detail ? `: ${report.detail}` : ''}`);
  process.exit(1);
}
if (Array.isArray(report.failures) && report.failures.length > 0) {
  for (const failure of report.failures) {
    console.error(
      `FAILED: add(${String(failure.a)}, ${String(failure.b)}) expected a finite number ` +
        `${String(failure.expected)}; got ${String(failure.threw ?? failure.actual)}` +
        (failure.actualType ? ` (${failure.actualType})` : ''),
    );
  }
  process.exit(1);
}

for (const rel of unchanged) {
  const expected = readFileSync(join(templateRoot, rel), 'utf8');
  const actual = readFileSync(join(workspace, rel), 'utf8');
  if (
    createHash('sha256').update(actual).digest('hex') !==
    createHash('sha256').update(expected).digest('hex')
  ) {
    console.error(`FAILED: ${rel} must remain unchanged`);
    process.exit(1);
  }
}

console.log(
  JSON.stringify({
    functional_success: true,
    oracle: 'ordinary-bug',
    grading_mode: 'independent_behavioral_probe',
    cases: report.cases,
    preserved_files: unchanged,
  }),
);
