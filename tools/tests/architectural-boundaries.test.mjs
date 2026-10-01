import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectSource, validateRegistry } from '../architectural-boundaries.mjs';

for (const source of [
  'process.exit(1)', 'process.exit (1)', "process['exit']?.(1)",
  'globalThis.process.exit(1)', '(process as any).exit(1)',
  'global.process.exit(1)', 'let p; p = process; p.exit(1)',
  'let quit; ({exit: quit} = process); quit(1)',
  'let exit; ({exit} = process); exit(1)',
  'const p = flag ? process : {}; p.exit(1)',
  'const p = replacement || process; p.exit(1)',
  'const p = replacement ?? process; p.exit(1)',
  'let quit; quit ||= process.exit; quit(1)',
  'let quit; quit ??= process.exit; quit(1)',
  'let quit; quit &&= process.exit; quit(1)',
  'const [quit] = [process.exit]; quit(1)',
  'let quit; [quit] = [process.exit]; quit(1)',
  'const {...p} = process; p.exit(1)',
  'let p; ({...p} = process); p.exit(1)',
  '(0, process.exit)(1)',
  "const {default: p} = await import('node:process'); p.exit(1)",
  "const p = await import('node:process'); p['default'].exit(1)",
  "import { default as process } from 'node:process'; process.exit(1)",
  "const process = await import('node:process'); process.exit(1)",
  "const { exit } = await import('node:process'); exit(1)",
  "import { exit as quit } from 'node:process'; quit(1)",
  "import p from 'node:process'; p.exit(1)",
  "import * as p from 'node:process'; p.exit(1)",
  'const {exit: quit} = process; quit(1)',
  'const quit = process.exit; quit(1)',
  "const p = require('node:process'); p.exit(1)",
  'const quit = process.exit.bind(process); quit(1)',
  'process.exit.call(process, 1)', 'process.exit.apply(process, [1])',
]) test('recognizes executable exit: ' + source, () => {
  assert.equal(inspectSource(source, 'C:\\fixture\\source.ts').exits.length, 1);
});

test('strings, comments and locally shadowed objects do not exit the host', () => {
  assert.equal(inspectSource('// process.exit(1)\nconst s = `process.exit(1)`; function f(process) { process.exit(1) }').exits.length, 0);
});
test('aliased stdout write retains output ownership', () => {
  assert.equal(inspectSource('const out = process.stdout; const write = out.write; write("x")').stdout.length, 1);
});
test('nested destructuring and global stdout retain output ownership', () => {
  assert.equal(inspectSource('const {stdout: {write: emit}} = process; emit("x"); global.process.stdout.write("x")').stdout.length, 2);
});
test('shorthand destructuring assignments retain output ownership', () => {
  assert.equal(inspectSource('let write; ({stdout: {write}} = process); write("x")').stdout.length, 1);
});
test('array destructuring and logical assignments retain output ownership', () => {
  assert.equal(inspectSource('let write; [write] = [process.stdout.write]; write("x"); let out; out ??= process.stdout; out.write("y")').stdout.length, 2);
});
test('array aliases and rest bindings cannot obtain false clearance', () => {
  assert.equal(inspectSource('const values = [process]; const [p] = values; p.exit(1)').ambiguous.length, 1);
  assert.equal(inspectSource('const [...values] = [process]; values[0].exit(1)').ambiguous.length, 1);
});
test('unknown dynamic process access fails closed', () => {
  assert.equal(inspectSource('process[name](1)').ambiguous.length, 1);
});
test('calls on environment values are not dynamic process methods', () => {
  assert.equal(inspectSource('process.env[name].trim()').ambiguous.length, 0);
});
test('malformed source cannot produce clearance', () => {
  assert.throws(() => inspectSource('function broken( { process.exit(1)'));
});
test('a mutable alias changing process roles cannot evade clearance', () => {
  assert.equal(inspectSource('let p = process.stdout; p = process; p.exit(1)').ambiguous.length, 1);
  assert.equal(inspectSource('let {stdout: p} = process; p = process; p.exit(1)').ambiguous.length, 1);
});
for (const entry of [
  { path: 'src/../other.ts' }, { maxCalls: -1 }, { maxCalls: 1.5 },
  { reason: '' }, { kind: 'unreviewed' },
]) test('rejects invalid boundary grant: ' + JSON.stringify(entry), () => {
  assert.throws(() => validateRegistry({ schemaVersion: 1, stdout: [], exits: [
    { path: 'src/entry.ts', maxCalls: 1, reason: 'Explicit CLI entrypoint', kind: 'cli', ...entry },
  ] }));
});
