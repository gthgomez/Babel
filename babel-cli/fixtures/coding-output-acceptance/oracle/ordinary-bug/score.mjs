#!/usr/bin/env node
/**
 * Independent behavioral oracle for COC-ORDINARY-BUG.
 *
 * Three processes:
 *   1. This parent holds expected values and reads the evaluator's fd-3 report.
 *   2. A host-owned evaluator (no candidate code) owns fd 3 and feeds one input
 *      pair at a time to a fresh sandboxed runner.
 *   3. The runner imports the candidate, calls its exported function once and
 *      returns one value over its stdout.
 *
 * The candidate cannot write fd 3 (not in its stdio), cannot read future
 * inputs (each runner gets one pair), cannot kill the evaluator's report by
 * exiting (the evaluator sees an incomplete round-trip and fails closed), and
 * cannot suppress genuine emissions (the evaluator writes fd 3 from values it
 * actually received over the round-trip).
 *
 * Epistemic boundary: the oracle attests that the candidate process, given each
 * sampled input through the round-trip protocol, EMITTED the expected value.
 * A candidate that computes correct answers per pair from the inputs it
 * receives is behaviorally right for the sampled inputs; the oracle does not
 * prove the exported function's internals or authorship.
 *
 * Sandbox: both child processes use Node's permission model. The evaluator may
 * read its own source and spawn children; the runner may read the candidate
 * workspace and its own source. Neither may read /proc, write fs paths, use
 * workers or addons. Verified on Node v22.23.4; the Windows flag path is
 * platform-neutral by construction but was not live-tested here.
 *
 * Remaining theoretical limits: OS-level debugging outside the permission
 * model, ptrace-equivalents, and a future permission-model escape.
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = process.argv[2];
if (!workspace) {
  console.error('usage: score.mjs <agent-workspace>');
  process.exit(2);
}

const templateRoot = join(dirname(fileURLToPath(import.meta.url)), '../../workspaces/ordinary-bug');
const unchanged = ['tests/math.test.js', 'package.json', 'README.md'];

/** Public, documented case only; all other inputs are randomized per run. */
const visibleCases = [[1, 2, 3]];

function gradedCases() {
  const cases = [];
  const add = (a, b) => {
    cases.push([a, b, a + b]);
  };
  add(-randomInt(1, 1_000_001), -randomInt(1, 1_000_001));
  add(randomInt(1, 1_000_001), randomInt(1, 1_000_001));
  add(0, randomInt(-1_000_000, 1_000_001));
  add(randomInt(-1_000_000, 1_000_001), 0);
  add(randomInt(1, 100_000) / 100, randomInt(1, 100_000) / 100);
  add(-randomInt(1, 100_000) / 100, randomInt(1, 100_000) / 100);
  add(randomInt(1, 1_000_000_000), randomInt(-1_000_000_000, 1_000_000_001));
  add(Number.MAX_SAFE_INTEGER - randomInt(0, 1000), 0);
  add(randomInt(-1_000_000, 0), randomInt(0, 1_000_001));
  add(randomInt(1, 1000) / 1000, randomInt(1, 1000) / 1000);
  add(randomInt(-1_000, 1_001), randomInt(-1_000, 1_001));
  return cases;
}

const cases = [...visibleCases, ...gradedCases()];

const evaluator = `
import { writeSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const writeFd = writeSync
const emit = (line) => {
  try {
    writeFd(3, 'W04OBS\\t' + line + '\\n')
  } catch {
    process.exit(1)
  }
}
const fail = (index, detail) => {
  try {
    writeFd(3, 'W04FAIL\\t' + index + '\\t' + encode(detail) + '\\n')
  } catch {}
  process.exit(1)
}
const parseJson = JSON.parse
const stringOf = String
const bufferFrom = Buffer.from.bind(Buffer)
const bufferToString = Buffer.prototype.toString
const encode = (value) => bufferToString.call(bufferFrom(stringOf(value), 'utf8'), 'base64')

const inputs = parseJson(process.argv[2])
const runnerPath = process.argv[3]
const candidatePath = process.argv[4]
const runnerFlags = parseJson(process.argv[5])
for (let index = 0; index < inputs.length; index += 1) {
  const pair = inputs[index]
  const child = spawnSync(process.execPath, runnerFlags.concat([runnerPath, candidatePath]), {
    input: JSON.stringify(pair),
    encoding: 'utf8',
    timeout: 2000,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024,
  })
  if (child.error || child.signal !== null || child.status !== 0) {
    fail(index, child.error?.message ?? child.signal ?? ('runner exited ' + child.status))
    break
  }
  const lines = String(child.stdout ?? '').split('\\n').filter((line) => line.startsWith('W04VAL\\t'))
  if (lines.length !== 1) {
    fail(index, 'expected exactly one runner value, got ' + lines.length)
    break
  }
  const fields = lines[0].split('\\t')
  if (fields.length !== 4) {
    fail(index, 'malformed runner value')
    break
  }
  emit(index + '\\t' + fields[1] + '\\t' + fields[2] + '\\t' + fields[3])
}
process.exit(0)
`;

const runner = `
import { readFileSync, writeSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const readInput = readFileSync
const writeFd = writeSync
const parseJson = JSON.parse
const stringOf = String
const numberToString = Number.prototype.toString
const isFiniteNumber = Number.isFinite
const bufferFrom = Buffer.from.bind(Buffer)
const bufferToString = Buffer.prototype.toString
const encode = (value) => bufferToString.call(bufferFrom(stringOf(value), 'utf8'), 'base64')
const emit = (line) => writeFd(1, 'W04VAL\\t' + line + '\\n')

const [a, b] = parseJson(readInput(0, 'utf8'))
let add
let moduleError = null
try {
  ({ add } = await import(pathToFileURL(process.argv[2]).href))
  if (typeof add !== 'function') moduleError = 'add_not_exported_as_function'
} catch (error) {
  moduleError = 'module_load_failed: ' + stringOf(error && error.message || error)
}
if (moduleError !== null) {
  emit('ERR\\t-\\t' + encode(moduleError))
} else {
  try {
    const value = add(a, b)
    const type = typeof value
    if (type === 'number' && isFiniteNumber(value)) {
      emit('OK\\tnumber\\t' + numberToString.call(value, 10))
    } else if (type === 'string') {
      emit('OK\\tstring\\t' + encode(value))
    } else {
      emit('OK\\t' + type + '\\t-')
    }
  } catch (error) {
    emit('ERR\\t-\\t' + encode(stringOf(error && error.message || error).slice(0, 500)))
  }
}
`;

function permissionMode() {
  const flags = process.allowedNodeEnvironmentFlags;
  if (flags.has('--permission') && flags.has('--allow-fs-read')) return '--permission';
  if (flags.has('--experimental-permission') && flags.has('--allow-fs-read')) return '--experimental-permission';
  throw new Error('Node permission model is unavailable; refusing to run candidate code unsandboxed');
}

const probeDir = mkdtempSync(join(tmpdir(), randomBytes(8).toString('hex')));
const evaluatorPath = join(probeDir, 'evaluate.mjs');
const runnerPath = join(probeDir, 'runner.mjs');
const mode = permissionMode();
const evaluatorFlags = [mode, `--allow-fs-read=${evaluatorPath}`, '--allow-child-process'];
const runnerFlags = [mode, `--allow-fs-read=${workspace}`, `--allow-fs-read=${runnerPath}`];

let child;
try {
  writeFileSync(evaluatorPath, evaluator, 'utf8');
  writeFileSync(runnerPath, runner, 'utf8');
  child = spawnSync(process.execPath, [
    ...evaluatorFlags,
    evaluatorPath,
    JSON.stringify(cases.map(([a, b]) => [a, b])),
    runnerPath,
    join(workspace, 'src/math.js'),
    JSON.stringify(runnerFlags),
  ], {
    cwd: workspace,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
    maxBuffer: 8 * 1024 * 1024,
  });
} catch (error) {
  rmSync(probeDir, { recursive: true, force: true });
  console.error(`FAILED: independent behavioral evaluator could not run: ${String(error).slice(0, 2000)}`);
  process.exit(1);
}
rmSync(probeDir, { recursive: true, force: true });

if (child.error || child.status === null || child.status !== 0 || child.signal !== null) {
  const detail = child.error?.message ?? child.signal ?? child.stderr ?? 'evaluator did not exit cleanly';
  console.error(`FAILED: independent behavioral evaluator did not complete: ${String(detail).slice(0, 2000)}`);
  process.exit(1);
}

function decode(value) {
  return Buffer.from(value, 'base64').toString('utf8');
}

function invalid(detail) {
  console.error(`FAILED: invalid independent behavioral report: ${detail}`);
  process.exit(1);
}

// Only the evaluator's fd-3 emission pipe is authoritative.
const frames = String(child.output?.[3] ?? '');
const lines = frames.split('\n');
const observations = new Map();
for (const line of lines) {
  if (line.startsWith('W04FAIL\t')) {
    const fields = line.split('\t');
    invalid(`evaluator round-trip failed at index ${String(fields[1])}: ${decode(fields[2] ?? '')}`);
  }
  if (!line.startsWith('W04OBS\t')) continue;
  const fields = line.split('\t');
  if (fields.length !== 5) invalid('malformed observation line');
  const index = Number(fields[1]);
  if (!Number.isInteger(index) || index < 0 || index >= cases.length) {
    invalid(`observation index out of range: ${String(fields[1])}`);
  }
  if (observations.has(index)) invalid(`duplicate observation for index ${index}`);
  observations.set(index, { kind: fields[2], type: fields[3], value: fields[4] });
}
if (observations.size !== cases.length) {
  invalid(`expected ${cases.length} observations, got ${observations.size}`);
}

let failures = 0;
for (let index = 0; index < cases.length; index += 1) {
  const [a, b, expected] = cases[index];
  const observation = observations.get(index);
  if (!observation) invalid(`missing observation for index ${index}`);
  if (observation.kind === 'ERR') {
    failures += 1;
    console.error(`FAILED: add(${String(a)}, ${String(b)}) threw: ${decode(observation.value) || 'unknown error'}`);
    continue;
  }
  if (observation.kind !== 'OK') invalid(`observation ${index} has an invalid kind`);
  if (observation.type !== 'number') {
    failures += 1;
    console.error(
      `FAILED: add(${String(a)}, ${String(b)}) expected a finite number ${String(expected)}; ` +
        `got a value of type ${String(observation.type || 'unknown')}`,
    );
    continue;
  }
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(observation.value)) {
    invalid(`observation ${index} has a non-numeric value`);
  }
  const actual = Number(observation.value);
  if (!Number.isFinite(actual) || actual !== expected) {
    failures += 1;
    console.error(
      `FAILED: add(${String(a)}, ${String(b)}) expected a finite number ${String(expected)}; got ${String(observation.value)}`,
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
    grading_mode: 'sandboxed_round_trip_evaluator',
    cases: cases.length,
    randomized_cases: cases.length - visibleCases.length,
    preserved_files: unchanged,
  }),
);
