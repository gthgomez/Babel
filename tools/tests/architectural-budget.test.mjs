import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const checker = fileURLToPath(new URL('../check-architectural-budget.ps1', import.meta.url));
// cmd may echo a quoted path; spawnSync's native argument array must not retain
// those shell delimiters. Preserve the actual path, including interior spaces.
const nativeAliasPath = output => output.trim().replace(/^"(.*)"$/, '$1');
function windowsShortRoot(root) {
  // cmd consumes a command string rather than the usual native argv quoting.
  // Expand the owned path as quoted data, without interpolating it into code.
  const alias = spawnSync('cmd.exe', ['/d', '/c', 'for %I in ("%BABEL_BUDGET_FIXTURE_ROOT%") do @echo %~sI'], {
    encoding: 'utf8', windowsVerbatimArguments: true,
    env: { ...process.env, BABEL_BUDGET_FIXTURE_ROOT: root },
  });
  assert.ifError(alias.error);
  assert.equal(alias.status, 0, alias.stderr);
  return nativeAliasPath(alias.stdout);
}
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
  return { root, run(...args) { return this.runRoot(root, ...args); }, runRoot(rootPath, ...args) {
    const result = spawnSync('pwsh', ['-NoProfile', '-File', checker, '-Root', rootPath, ...args], { encoding: 'utf8', timeout: 30_000 });
    assert.ifError(result.error);
    const output = result.stdout + result.stderr;
    assert.doesNotMatch(output, /property 'Count' cannot be found/);
    return { code: result.status, output };
  }};
}

test('quoted Windows alias output reaches the checker as a native path argument', t => {
  const f = fixture(t, 'const value = 1;\n');
  const result = f.runRoot(nativeAliasPath(`"${f.root}"\r\n`));
  assert.equal(result.code, 0, result.output);
});

test('Windows short-path roots preserve file and zero-cast baseline identities', t => {
  if (process.platform !== 'win32') return t.skip('Windows 8.3 alias regression');
  const f = fixture(t, 'const value = 1;\n');
  // Read the actual NTFS alias; this command only expands a generated fixture path.
  const shortRoot = windowsShortRoot(f.root);
  assert.equal(realpathSync.native(shortRoot), realpathSync.native(f.root));
  if (!shortRoot.includes('~')) return t.skip('This volume has no 8.3 fixture alias');
  const clean = f.runRoot(shortRoot);
  assert.equal(clean.code, 0, clean.output);
  writeFileSync(join(f.root, 'config/architectural-budget/as-any-counts.json'), JSON.stringify({ 'babel-cli/src/ui/probe.ts': 0 }));
  writeFileSync(join(f.root, 'babel-cli/src/ui/probe.ts'), 'const value = source as any;\n');
  const regression = f.runRoot(shortRoot);
  assert.notEqual(regression.code, 0, regression.output);
  assert.match(regression.output, /babel-cli\/src\/ui\/probe\.ts.*grew from 0 to 1/);
});

test('Windows alias query resolves native paths before checking 8.3 availability', t => {
  if (process.platform !== 'win32') return t.skip('Windows native argument regression');
  const f = fixture(t, 'const value = 1;\n');
  const dataPath = join(f.root, 'space & literal%name');
  mkdirSync(dataPath);
  for (const root of [f.root, dataPath]) {
    assert.equal(realpathSync.native(windowsShortRoot(root)), realpathSync.native(root));
  }
});

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
