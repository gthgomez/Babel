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
 *
 * The child receives only inputs, never expected values. Results are returned
 * through a parent-generated nonce file rather than candidate-writable stdout,
 * and the parent validates the complete report shape before accepting it. A
 * candidate that reads argv, prints a fake `{}`, or exits during import fails
 * closed.
 */
import { createHash, randomBytes } from 'node:crypto';
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

// Behavior is the contract. Expected values stay in this parent process and
// are never serialized into the child's argv, environment or working tree.
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
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// Consume the control channel before importing candidate code. The nonce and
// result path are never placed in argv or the environment.
const control = JSON.parse(readFileSync(0, 'utf8'))
const writeResult = writeFileSync.bind(null)
const observations = []
let moduleError = null
const inputs = JSON.parse(process.argv[3])
let add
try {
  ({ add } = await import(pathToFileURL(process.argv[2]).href))
  if (typeof add !== 'function') moduleError = 'add_not_exported_as_function'
} catch (error) {
  moduleError = 'module_load_failed: ' + String(error && error.message || error)
}
for (let index = 0; index < inputs.length; index += 1) {
  const [a, b] = inputs[index]
  if (moduleError !== null) {
    observations.push({ index, threw: true, threwMessage: moduleError })
    continue
  }
  try {
    const value = add(a, b)
    const valueType = typeof value
    if ((valueType === 'number' && Number.isFinite(value)) || valueType === 'string') {
      observations.push({ index, threw: false, valueType, value })
    } else {
      observations.push({ index, threw: false, valueType })
    }
  } catch (error) {
    observations.push({ index, threw: true, threwMessage: String(error && error.message || error).slice(0, 500) })
  }
}
writeResult(control.resultPath, JSON.stringify({ nonce: control.nonce, moduleError, observations }), { flag: 'wx' })
`;

const probeDir = mkdtempSync(join(tmpdir(), 'ordinary-bug-oracle-'));
const probePath = join(probeDir, 'probe.mjs');
const resultPath = join(probeDir, 'result.json');
const nonce = randomBytes(16).toString('hex');
let stderr = '';
try {
  writeFileSync(probePath, probe, 'utf8');
  execFileSync(process.execPath, [probePath, join(workspace, 'src/math.js'), JSON.stringify(cases.map(([a, b]) => [a, b]))], {
    cwd: workspace,
    input: JSON.stringify({ nonce, resultPath }),
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    stdio: ['pipe', 'ignore', 'pipe'],
  });
} catch (error) {
  stderr =
    error && typeof error === 'object' && 'stderr' in error
      ? String(error.stderr || error.message)
      : String(error);
  console.error(`FAILED: independent behavioral probe could not run: ${stderr.slice(0, 2000)}`);
  rmSync(probeDir, { recursive: true, force: true });
  process.exit(1);
}

let report;
try {
  report = JSON.parse(readFileSync(resultPath, 'utf8'));
} catch {
  console.error('FAILED: independent behavioral probe produced no valid result file.');
  rmSync(probeDir, { recursive: true, force: true });
  process.exit(1);
}
rmSync(probeDir, { recursive: true, force: true });

function invalid(detail) {
  console.error(`FAILED: invalid independent behavioral report: ${detail}`);
  process.exit(1);
}

if (!report || typeof report !== 'object' || report.nonce !== nonce) invalid('nonce mismatch');
if (report.moduleError !== null) invalid(`candidate module error: ${String(report.moduleError).slice(0, 1000)}`);
if (!Array.isArray(report.observations)) invalid('observations is not an array');
if (report.observations.length !== cases.length) {
  invalid(`expected ${cases.length} observations, got ${report.observations.length}`);
}

let failures = 0;
for (let index = 0; index < cases.length; index += 1) {
  const [a, b, expected] = cases[index];
  const observation = report.observations[index];
  if (
    !observation ||
    typeof observation !== 'object' ||
    observation.index !== index ||
    typeof observation.threw !== 'boolean'
  ) {
    invalid(`observation ${index} is missing required fields`);
  }
  if (observation.threw) {
    failures += 1;
    console.error(`FAILED: add(${String(a)}, ${String(b)}) threw: ${String(observation.threwMessage ?? 'unknown error')}`);
    continue;
  }
  if (typeof observation.valueType !== 'string') invalid(`observation ${index} is missing valueType`);
  const ok =
    observation.valueType === 'number' &&
    typeof observation.value === 'number' &&
    Number.isFinite(observation.value) &&
    observation.value === expected;
  if (!ok) {
    failures += 1;
    console.error(
      `FAILED: add(${String(a)}, ${String(b)}) expected a finite number ${String(expected)}; ` +
        `got ${String(observation.value ?? `<${observation.valueType}>`)} (${observation.valueType})`,
    );
  }
}
if (failures > 0) process.exit(1);

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
    cases: cases.length,
    preserved_files: unchanged,
  }),
);
