// Deterministic evaluator for the provider-switch fixture. The runner freezes
// this file's SHA-256 before each cell and re-checks it after the run: the
// candidate under test cannot edit its evaluator or invent completion evidence.
// Usage: node evaluator/verify.mjs   (cwd = materialized fixture root)
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.cwd();
const evaluatorDir = dirname(fileURLToPath(import.meta.url));
const ledgerPath = join(root, 'workspace', 'current', 'ledger.mjs');
const testCwd = join(root, 'workspace', 'current');
// Verdict lands where the runner points it (cell evidence dir); never beside
// the pristine evaluator, so a run cannot mutate the shipped fixture tree.
const verdictPath = process.env['VERDICT_PATH'] ?? join(evaluatorDir, 'verdict.json');

const checks = [];
const record = (id, pass, detail) => {
  checks.push({ id, pass: pass === true, detail: detail ?? null });
};

// 1. Evaluator self-integrity: the frozen hash must still match.
const selfSha = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
const expectedSelfSha = process.env['EVALUATOR_SHA256'] ?? null;
record('evaluator_unmodified', expectedSelfSha === null || selfSha === expectedSelfSha,
  expectedSelfSha === null ? 'no frozen hash supplied (plan mode)' : `self=${selfSha}`);

// 2. A real edit: the production file must differ from the frozen pristine hash.
let ledgerSha = null;
let ledgerSource = null;
try {
  ledgerSource = readFileSync(ledgerPath);
  ledgerSha = createHash('sha256').update(ledgerSource).digest('hex');
} catch {
  record('ledger_present', false, `missing ${ledgerPath}`);
}
if (ledgerSource !== null) {
  const pristineSha = process.env['PRISTINE_LEDGER_SHA256'] ?? null;
  record('ledger_edited', pristineSha === null || ledgerSha !== pristineSha,
    pristineSha === null ? 'no pristine hash supplied (plan mode)' : `ledger=${ledgerSha}`);
}

// 3. The project's own checks must pass from the project directory.
const testRun = spawnSync(process.execPath, ['--test'], {
  cwd: testCwd,
  encoding: 'utf8',
  timeout: 60_000,
  windowsHide: true,
});
record('project_tests_pass', testRun.status === 0,
  testRun.status === 0 ? 'node --test exited 0' : `exit=${testRun.status} tail=${String(testRun.stdout ?? '').slice(-200)}`);

// 4. The corrected value must be observable: import the module and check it.
let correctedValue = null;
try {
  const mod = await import(pathToFileURL(ledgerPath).href);
  correctedValue = typeof mod.total === 'function' ? mod.total() : null;
  record('total_correct', correctedValue === 150, `total()=${String(correctedValue)}`);
} catch (error) {
  record('total_correct', false, `import failed: ${error instanceof Error ? error.message : String(error)}`);
}

const pass = checks.every((check) => check.pass);
const verdict = {
  schemaVersion: 1,
  pass,
  ledgerSha256: ledgerSha,
  evaluatorSha256: selfSha,
  correctedTotal: correctedValue,
  checks,
};
writeFileSync(verdictPath, `${JSON.stringify(verdict, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
process.exit(pass ? 0 : 1);
