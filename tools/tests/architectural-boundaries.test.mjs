import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { inspectSource, validateRegistry } from '../architectural-boundaries.mjs';

test('cyclic container aliases terminate and preserve host mutation detection', () => {
  const moduleUrl = new URL('../architectural-boundaries.mjs', import.meta.url).href;
  const graph = 'const c0 = {};\n' + Array.from({length: 22}, (_, i) => `const c${i+1} = c${i}; c${i}.next = c${i+1};`).join('\n');
  const code = `import {inspectSource} from ${JSON.stringify(moduleUrl)}; const graph=${JSON.stringify(graph)}; console.log(JSON.stringify([inspectSource(graph+' c0.run()'),inspectSource(graph+' c22.quit=process.exit; c0.quit(1)')]))`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 4000 });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stderr);
  const [ordinary, host] = JSON.parse(result.stdout);
  assert.deepEqual(ordinary, {exits: [], stdout: [], ambiguous: []});
  assert.equal(host.ambiguous.length, 1);
});

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
  'let quit; (quit ??= process.exit)(1)',
  'let quit; (quit ||= process.exit)(1)',
  'const [quit = process.exit] = []; quit(1)',
  'const {quit = process.exit} = {}; quit(1)',
  'let quit; ({quit = process.exit} = {}); quit(1)',
  'const [quit] = [...[process.exit]]; quit(1)',
  'const [x, quit] = [0, ...[process.exit]]; quit(1)',
  'const {quit} = {quit: process.exit}; quit(1)',
  'let quit; ({quit} = {quit: process.exit}); quit(1)',
  'const {exit} = {exit: () => {}, ...process}; exit(1)',
  'const {quit} = {quit: () => {}, ...{quit: process.exit}}; quit(1)',
  'const {quit} = {quit: () => {}, quit: process.exit}; quit(1)',
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
test('default and spread aliases preserve stdout ownership', () => {
  assert.equal(inspectSource('const [write = process.stdout.write] = []; write("x"); const {emit = process.stdout.write} = {}; emit("y"); const [out] = [...[process.stdout]]; out.write("z"); let send; (send ??= process.stdout.write)("s")').stdout.length, 4);
});
test('object containers retain boundary ownership conservatively', () => {
  assert.equal(inspectSource('const host = {quit: process.exit}; host.quit(1)').ambiguous.length, 1);
  assert.equal(inspectSource('const {write} = {write: process.stdout.write}; write("x")').stdout.length, 1);
});
test('container property mutations cannot obtain false clearance', () => {
  assert.equal(inspectSource('const box = {quit: () => {}}; box.quit = process.exit; box.quit(1)').ambiguous.length, 1);
  assert.equal(inspectSource('const box = {}; box["write"] ??= process.stdout.write; box.write("x")').ambiguous.length, 1);
});
test('mutations through container aliases taint every local view of that object', () => {
  assert.equal(inspectSource('const box = {}; const alias = box; alias.quit = process.exit; box.quit(1)').ambiguous.length, 1);
  assert.equal(inspectSource('const box = {nested: {}}; const alias = box.nested; alias.quit = process.exit; box.nested.quit(1)').ambiguous.length, 1);
  assert.equal(inspectSource('const box = {}; let alias; alias = box; alias.write = process.stdout.write; box.write("x")').ambiguous.length, 1);
});
test('wrapped container assignment receivers cannot obtain false clearance', () => {
  assert.equal(inspectSource('const box = {}; (box).quit = process.exit; box.quit(1)').ambiguous.length, 1);
  assert.equal(inspectSource('const box = {}; (box as any).write = process.stdout.write; box.write("x")').ambiguous.length, 1);
});
for (const container of ['{original}', '[original]', '{nested: {alias: original}}']) test('literal containers preserve reverse mutation ownership: ' + container, () => {
  const receiver = container === '[original]' ? 'box[0]' : container.includes('nested') ? 'box.nested.alias' : 'box.original';
  assert.equal(inspectSource(`const original = {}; const box = ${container}; ${receiver}.quit = process.exit; original.quit(1)`).ambiguous.length, 1);
});
for (const value of ['(0, original)', 'await original', '(other = original)', '(other ??= original)']) test('transparent local values preserve reverse mutation ownership: ' + value, () => {
  assert.equal(inspectSource(`const original = {}; let other; const alias = ${value}; alias.write = process.stdout.write; original.write("x")`).ambiguous.length, 1);
});
test('nested binding and static iteration preserve container ownership', () => {
  assert.equal(inspectSource('const original = {}; const {nested: {alias}} = {nested: {alias: original}}; alias.quit = process.exit; original.quit(1)').ambiguous.length, 1);
  assert.equal(inspectSource('const original = {}; for (const alias of [original]) alias.quit = process.exit; original.quit(1)').ambiguous.length, 1);
  assert.equal(inspectSource('for (const p of [process]) p.exit(1)').ambiguous.length, 1);
  assert.equal(inspectSource('for (const {p} of [{p: process}]) p.exit(1)').ambiguous.length, 1);
  assert.equal(inspectSource('for (const [p] of [[process]]) p.exit(1)').ambiguous.length, 1);
});
test('member assignments and default bindings preserve reverse container ownership', () => {
  assert.equal(inspectSource('const original = {}; const box = {}; box.original = original; box.original.quit = process.exit; original.quit(1)').ambiguous.length, 1);
  assert.equal(inspectSource('const original = {}; const {alias = original} = {}; alias.write = process.stdout.write; original.write("x")').ambiguous.length, 1);
  assert.equal(inspectSource('const original = {}; const [alias = original] = []; alias.quit = process.exit; original.quit(1)').ambiguous.length, 1);
});
test('static iteration into existing bindings preserves process and container ownership', () => {
  assert.equal(inspectSource('let p; for (p of [process]) p.exit(1)').ambiguous.length, 1);
  assert.equal(inspectSource('const original = {}; let alias; for (alias of [original]) alias.quit = process.exit; original.quit(1)').ambiguous.length, 1);
});
for (const receiver of ['(flag ? box : other)', '(box || other)', '(0, box)', '({box}).box']) test('value-bearing mutation receivers retain container ownership: ' + receiver, () => {
  assert.equal(inspectSource(`const box = {}, other = {}; ${receiver}.quit = process.exit; box.quit(1)`).ambiguous.length, 1);
  assert.equal(inspectSource(`const box = {}, other = {}; ${receiver}.write = process.stdout.write; box.write("x")`).ambiguous.length, 1);
});
test('computed object overrides and stdout spreads cannot obtain false clearance', () => {
  assert.equal(inspectSource('const {quit} = {quit: () => {}, [name]: process.exit}; quit(1)').ambiguous.length, 1);
  assert.equal(inspectSource('const {write} = {write: () => {}, ...{write: process.stdout.write}}; write("x")').stdout.length, 1);
});
test('shorthand assignment defaults resolve their own value symbols', () => {
  assert.equal(inspectSource('const exit = process.exit; let quit; ({quit = exit} = {}); quit(1)').exits.length, 1);
  assert.equal(inspectSource('const emit = process.stdout.write; let write; ({write = emit} = {}); write("x")').stdout.length, 1);
  assert.equal(inspectSource('const original = {}; let alias; ({alias = original} = {}); alias.quit = process.exit; original.quit(1)').ambiguous.length, 1);
});
test('enclosing binding defaults preserve process projections and reverse aliases', () => {
  assert.equal(inspectSource('const {p: {exit: quit} = process} = {}; quit(1)').exits.length, 1);
  assert.equal(inspectSource('const [{exit: quit} = process] = []; quit(1)').exits.length, 1);
  assert.equal(inspectSource('const {p: {stdout: {write: emit}} = process} = {}; emit("x")').stdout.length, 1);
  assert.equal(inspectSource('const original = {}; const {nested: {alias} = {alias: original}} = {}; alias.quit = process.exit; original.quit(1)').ambiguous.length, 1);
});
test('unknown dynamic process access fails closed', () => {
  assert.equal(inspectSource('process[name](1)').ambiguous.length, 1);
});
test('calls on environment values are not dynamic process methods', () => {
  assert.equal(inspectSource('process.env[name].trim()').ambiguous.length, 0);
});
test('process data in arrays and alternative environment keys do not create host boundaries', () => {
  assert.equal(inspectSource('const args = [process.execPath, "--flag"]; args.map(String).join(" "); const roots = process.env["ROOT_A"] || process.env["ROOT_B"] || ""; roots.split(",")').ambiguous.length, 0);
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
