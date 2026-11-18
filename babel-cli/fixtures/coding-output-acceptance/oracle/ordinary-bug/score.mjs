#!/usr/bin/env node
/**
 * Independent behavioral oracle for COC-ORDINARY-BUG.
 *
 * Candidate code is never executed in the oracle process. The oracle spawns a
 * sandboxed evaluator child with Node's permission model, lets it import the
 * candidate and return observed values, then computes expected values and
 * decides in the parent. The candidate therefore never shares memory with the
 * expected answers and never owns the report channel.
 *
 * The child receives inputs only. Graded inputs are randomized per run; only
 * the documented (1,2) case is public. The child may print whatever it wants to
 * stdout, but the parent accepts exactly one well-formed observation per input
 * index and fails closed on duplicates, malformed lines or missing indices.
 *
 * Sandbox: `--permission --allow-fs-read=<workspace> --allow-fs-read=<evaluator>`
 * denies /proc reads (including /proc/self/mem and /proc/<ppid>/mem), fs writes,
 * child processes, workers and addons. Verified on this host's Node v22.23.4:
 * all three /proc reads return ERR_ACCESS_DENIED, child_process and worker are
 * denied, and the honest candidate import still succeeds. Node v22 labels the
 * permission model experimental; the `--permission` alias is used when
 * available (`--experimental-permission` otherwise). The Windows flag path is
 * platform-neutral by construction but was not live-tested on this host.
 *
 * Independence limits: the sandbox is a Node permission-model boundary, not an
 * OS sandbox. OS-level debugging outside it, ptrace-equivalent access, and a
 * future permission-model escape remain theoretical. A candidate that reads
 * the inputs and computes correct answers is right, not a spoof; the oracle
 * proves observed behavior, not authorship.
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { spawnSync } from 'node:child_process';
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

/**
 * Public, documented case only. Everything else is generated per run with its
 * expected value computed here in the parent; no expected table exists in
 * source, argv, the environment or the child's reachable files.
 */
const visibleCases = [[1, 2, 3]];

function gradedCases() {
  const cases = [];
  const add = (a, b) => {
    cases.push([a, b, a + b]);
  };
  // Random magnitudes with deterministic behavioral categories: negatives,
  // positives, zero operands, fractions, mixed signs and large safe integers.
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
import { pathToFileURL } from 'node:url'

// Capture every primitive the value channel uses before candidate import.
const writeOut = process.stdout.write.bind(process.stdout)
const parseJson = JSON.parse
const stringOf = String
const numberToString = Number.prototype.toString
const isFiniteNumber = Number.isFinite
const bufferFrom = Buffer.from.bind(Buffer)
const bufferToString = Buffer.prototype.toString
const encode = (value) => bufferToString.call(bufferFrom(stringOf(value), 'utf8'), 'base64')
const emit = (line) => writeOut('W04OBS\\t' + line + '\\n')

const inputs = parseJson(process.argv[3])
let add
let moduleError = null
try {
  ({ add } = await import(pathToFileURL(process.argv[2]).href))
  if (typeof add !== 'function') moduleError = 'add_not_exported_as_function'
} catch (error) {
  moduleError = 'module_load_failed: ' + stringOf(error && error.message || error)
}
if (moduleError !== null) writeOut('W04MODULE\\t' + encode(moduleError) + '\\n')
for (let index = 0; index < inputs.length; index += 1) {
  const [a, b] = inputs[index]
  const prefix = numberToString.call(index, 10)
  if (moduleError !== null) {
    emit(prefix + '\\tERR\\t-\\t' + encode(moduleError))
    continue
  }
  try {
    const value = add(a, b)
    const type = typeof value
    if (type === 'number' && isFiniteNumber(value)) {
      emit(prefix + '\\tOK\\tnumber\\t' + numberToString.call(value, 10))
    } else if (type === 'string') {
      emit(prefix + '\\tOK\\tstring\\t' + encode(value))
    } else {
      emit(prefix + '\\tOK\\t' + type + '\\t-')
    }
  } catch (error) {
    emit(prefix + '\\tERR\\t-\\t' + encode(stringOf(error && error.message || error).slice(0, 500)))
  }
}
`;

function permissionFlags(workspacePath, evaluatorPath) {
  const flags = process.allowedNodeEnvironmentFlags;
  const mode = flags.has('--permission')
    ? '--permission'
    : flags.has('--experimental-permission')
      ? '--experimental-permission'
      : null;
  if (mode === null || !flags.has('--allow-fs-read')) {
    throw new Error('Node permission model is unavailable; refusing to run candidate code unsandboxed');
  }
  // Read only the candidate workspace (module import) and the evaluator source.
  // No fs write, child-process, worker or addon permission is granted.
  return [mode, `--allow-fs-read=${workspacePath}`, `--allow-fs-read=${evaluatorPath}`];
}

// Unpredictable evaluator directory; no stable prefix for a candidate to scan.
const probeDir = mkdtempSync(join(tmpdir(), randomBytes(8).toString('hex')));
const probePath = join(probeDir, 'evaluate.mjs');
let child;
try {
  writeFileSync(probePath, evaluator, 'utf8');
  const inputs = cases.map(([a, b]) => [a, b]);
  child = spawnSync(process.execPath, [
    ...permissionFlags(workspace, probePath),
    probePath,
    join(workspace, 'src/math.js'),
    JSON.stringify(inputs),
  ], {
    cwd: workspace,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 8 * 1024 * 1024,
  });
} catch (error) {
  rmSync(probeDir, { recursive: true, force: true });
  console.error(`FAILED: independent behavioral evaluator could not run: ${String(error).slice(0, 2000)}`);
  process.exit(1);
}
rmSync(probeDir, { recursive: true, force: true });

if (child.error || child.status === null) {
  const detail = child.error?.message ?? child.stderr ?? 'evaluator did not exit';
  console.error(`FAILED: independent behavioral evaluator could not run: ${String(detail).slice(0, 2000)}`);
  process.exit(1);
}

function decode(value) {
  return Buffer.from(value, 'base64').toString('utf8');
}

function invalid(detail) {
  console.error(`FAILED: invalid independent behavioral report: ${detail}`);
  process.exit(1);
}

const stdout = String(child.stdout ?? '');
const lines = stdout.split('\n');
let moduleError = null;
const observations = new Map();
for (const line of lines) {
  if (line.startsWith('W04MODULE\t')) {
    moduleError = decode(line.slice('W04MODULE\t'.length));
    continue;
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
if (moduleError !== null) invalid(`candidate module error: ${String(moduleError).slice(0, 1000)}`);
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
    grading_mode: 'sandboxed_behavioral_evaluator',
    cases: cases.length,
    randomized_cases: cases.length - visibleCases.length,
    preserved_files: unchanged,
  }),
);
