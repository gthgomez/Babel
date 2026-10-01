import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const checker = fileURLToPath(new URL('../check-architectural-budget.ps1', import.meta.url));
function fixture(t, source, path = 'ui/probe.ts', policy = {}) {
  const root = mkdtempSync(join(tmpdir(), 'babel-budget-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'babel-cli/src/ui'), { recursive: true });
  mkdirSync(join(root, 'babel-cli/src', path, '..'), { recursive: true });
  writeFileSync(join(root, 'babel-cli/src', path), source);
  mkdirSync(join(root, 'config/architectural-budget'), { recursive: true });
  // The legacy PowerShell checker requires more than one oversized result
  // to reach its verdict under StrictMode. Give it harmless controlled debt.
  for (const name of ['first', 'second']) writeFileSync(join(root, 'babel-cli/src', name + '.ts'), '// filler\n'.repeat(2001));
  writeFileSync(join(root, 'config/architectural-budget/file-sizes.json'), JSON.stringify({
    'babel-cli/src/first.ts': 2001, 'babel-cli/src/second.ts': 2001,
  }));
  writeFileSync(join(root, 'config/architectural-budget/as-any-counts.json'), '{}');
  writeFileSync(join(root, 'config/architectural-budget/process-boundaries.json'), JSON.stringify({
    schemaVersion: 1, stdout: [], exits: [], ...policy,
  }));
  return { root, run(...args) {
    const result = spawnSync('pwsh', ['-NoProfile', '-File', checker, '-Root', root, ...args], { encoding: 'utf8', timeout: 30_000 });
    assert.ifError(result.error);
    const output = result.stdout + result.stderr;
    assert.doesNotMatch(output, /property 'Count' cannot be found/);
    return { code: result.status, output };
  }};
}

test('comments and generated script data are not host process exits/output', t => {
  const f = fixture(t, '// process.exit(1)\nconst oracle = `process.exit(1)`;\nconst child = "process.stdout.write(\'ready\')";\n');
  const result = f.run();
  assert.equal(result.code, 0, result.output);
});

test('computed optional and aliased host exits cannot bypass the boundary', t => {
  const f = fixture(t, "import { exit as terminate } from 'node:process';\nterminate(1);\nprocess['exit']?.(1);\nprocess.exit (1);\n");
  const result = f.run();
  assert.notEqual(result.code, 0, result.output);
  assert.match(result.output, /exit.*3|3.*exit/i);
});

test('allowed host paths still reject additional exit calls', t => {
  const f = fixture(t, 'process.exit(1);\nprocess.exit(2);\n', 'commands/coreCommands.ts', {
    exits: [{ path: 'src/commands/coreCommands.ts', maxCalls: 1, reason: 'CLI boundary', kind: 'cli' }],
  });
  assert.notEqual(f.run().code, 0);
});

test('registry is authoritative for a reviewed host output boundary', t => {
  const f = fixture(t, 'process.stdout.write("ok");\n', 'ui/probe.ts', {
    stdout: [{ path: 'src/ui/probe.ts', maxCalls: 1, reason: 'Terminal restore', kind: 'terminal' }],
  });
  const result = f.run();
  assert.equal(result.code, 0, result.output);
});

test('baseline update refuses to grant larger file budgets', t => {
  const f = fixture(t, 'const value = 1;\n'.repeat(2001));
  assert.notEqual(f.run('-UpdateBaseline').code, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'config/architectural-budget/file-sizes.json'), 'utf8')), {
    'babel-cli/src/first.ts': 2001, 'babel-cli/src/second.ts': 2001,
  });
});

test('a missing baseline is described without inventing Git history', t => {
  const f = fixture(t, 'const value = 1;\n'.repeat(2001));
  const result = f.run();
  assert.notEqual(result.code, 0);
  assert.match(result.output, /UNBASELINED/);
  assert.doesNotMatch(result.output, /NEW FILE/);
});

test('duplicate boundary grants fail closed', t => {
  const grant = { path: 'src/ui/probe.ts', maxCalls: 1, reason: 'Terminal restore', kind: 'terminal' };
  const f = fixture(t, 'process.stdout.write("ok");\n', 'ui/probe.ts', { stdout: [grant, grant] });
  assert.notEqual(f.run().code, 0);
});
test('baseline update cannot adopt unbaselined type casts', t => {
  const f = fixture(t, 'const value = unknownValue as any;\n');
  const result = f.run('-UpdateBaseline');
  assert.notEqual(result.code, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'config/architectural-budget/as-any-counts.json'), 'utf8')), {});
});
test('eliminated cast ceilings remain zero and reject reintroduction', t => {
  const f = fixture(t, 'const value = 1;\n');
  const baseline = join(f.root, 'config/architectural-budget/as-any-counts.json');
  writeFileSync(baseline, JSON.stringify({ 'babel-cli/src/ui/probe.ts': 1 }));
  const result = f.run('-UpdateBaseline');
  assert.equal(result.code, 0, result.output);
  assert.equal(JSON.parse(readFileSync(baseline, 'utf8'))['babel-cli/src/ui/probe.ts'], 0);
  writeFileSync(join(f.root, 'babel-cli/src/ui/probe.ts'), 'const value = unknownValue as any;\n');
  assert.notEqual(f.run().code, 0);
});
