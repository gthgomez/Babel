import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { inspectSource, validateRegistry } from '../architectural-boundaries.mjs';

for (const source of [
  'Reflect.apply(process.exit, process, [1])',
  'globalThis.Reflect.apply(process.exit, process, [1])',
  'const invoke=Reflect.apply; invoke(process.exit, process, [1])',
  'const R=Reflect; R["apply"](process.exit, process, [1])',
  'const {apply: invoke}=Reflect; const quit=process.exit; invoke(quit, process, [1])',
  'const invoke=Reflect.apply.bind(Reflect); invoke(process.exit, process, [1])',
  'Reflect.apply.call(Reflect, process.exit, process, [1])',
  'Reflect.apply.apply(Reflect, [process.exit, process, [1]])',
]) test('Reflect invocation retains exit ownership: ' + source, () => {
  assert.deepEqual(inspectSource(source), {exits:[1], stdout:[], ambiguous:[]});
});

for (const source of [
  'Reflect.apply(process.stdout.write, process.stdout, ["x"])',
  'const {apply}=globalThis.Reflect; const emit=process.stdout.write; apply(emit, null, ["x"])',
]) test('Reflect invocation retains stdout ownership: ' + source, () => {
  assert.deepEqual(inspectSource(source), {exits:[], stdout:[1], ambiguous:[]});
});

test('dynamic Reflect invocation cannot clear a possible host target', () => {
  assert.equal(inspectSource('Reflect[key](process.exit, process, [1])').ambiguous.length, 1);
});

test('nested Reflect invokers cannot clear a possible host target', () => {
  assert.equal(inspectSource('Reflect.apply(Reflect.apply, Reflect, [process.exit, process, [1]])').ambiguous.length, 1);
  assert.equal(inspectSource('Reflect.apply(Reflect.apply, Reflect, [process.stdout.write, process.stdout, ["x"]])').ambiguous.length, 1);
  assert.deepEqual(inspectSource('Reflect.apply(Reflect.apply, Reflect, [()=>{}, null, []])'), {exits:[], stdout:[], ambiguous:[]});
});

for (const source of [
  'const invoke=Reflect.apply.bind(Reflect,process.exit,process); invoke([1])',
  'const invoke=Reflect.apply.bind(Reflect,process.exit); invoke(process,[1])',
  'const R=Reflect; const invoke=R.apply.bind(R,process.exit,process); invoke([1])',
  'const invoke=Reflect.apply.bind(Reflect,process.stdout.write,process.stdout); invoke(["x"])',
  'const {apply}=Reflect; const quit=process.exit; const invoke=apply.bind(Reflect,quit); invoke(process,[1])',
  'const invoke=Reflect.apply.call.bind(Reflect.apply,Reflect,process.exit,process); invoke([1])',
  'const invoke=Reflect.apply.call.bind(Reflect.apply,Reflect); invoke(process.exit,process,[1])',
  'const invoke=Reflect.apply.apply.bind(Reflect.apply,Reflect,[process.exit,process,[1]]); invoke()',
  'const invoke=Reflect.apply.apply.bind(Reflect.apply,Reflect); invoke([process.exit,process,[1]])',
  'const invoke=Reflect.apply.bind(Reflect).bind(null,process.exit,process); invoke([1])',
  'const invoke=Reflect.apply.bind(Reflect,Reflect.apply); invoke(Reflect,[process.exit,process,[1]])',
]) test('partially bound Reflect invokers retain their stored host target: ' + source, () => {
  const result=inspectSource(source);
  assert.equal(result.exits.length + result.stdout.length + result.ambiguous.length, 1);
});

test('partial Reflect binding controls do not invoke host boundaries', () => {
  for (const source of [
    'const invoke=Reflect.apply.bind(Reflect,process.exit,process)',
    'const invoke=Reflect.apply.bind(Reflect,()=>{},process); invoke([])',
    'const invoke=Reflect.apply.bind(Reflect,()=>{},null); invoke([process.exit])',
    'const invoke=Reflect.apply.call.bind(Reflect.apply,Reflect,()=>{},null); invoke([process.exit])',
    'const invoke=Reflect.apply.apply.bind(Reflect.apply,Reflect,[()=>{},null,[process.exit]]); invoke()',
    'function f(Reflect){const invoke=Reflect.apply.bind(Reflect,process.exit,process); invoke([1])}',
    'const Reflect={apply:()=>{}}; const invoke=Reflect.apply.bind(Reflect,process.exit); invoke([])',
  ]) assert.deepEqual(inspectSource(source), {exits:[], stdout:[], ambiguous:[]});
});

test('shadowed require loaders do not imply Node process ownership', () => {
  for (const source of [
    'function f(require){require("node:process").exit(1)}',
    'const require=()=>({exit:()=>{}}); require("node:process").exit(1)',
    'function require(){return {exit:()=>{}}} require("process").exit(1)',
    'import {createRequire} from "./fake.js"; const require=createRequire("x"); require("process").exit(1)',
    'function f(createRequire){const require=createRequire("x"); require("process").exit(1)}',
    'const load=()=>({exit:()=>{}}); load("node:process").exit(1)',
  ]) assert.deepEqual(inspectSource(source), {exits:[], stdout:[], ambiguous:[]});
});

test('Node createRequire aliases retain host process ownership', () => {
  for (const source of [
    'import {createRequire as makeRequire} from "node:module"; const require=makeRequire(import.meta.url); require("node:process").exit(1)',
    'import * as M from "node:module"; const load=M.createRequire(import.meta.url); load("node:process").exit(1)',
    'import M from "node:module"; const load=M.createRequire(import.meta.url); load("node:process").exit(1)',
    'import {createRequire} from "node:module"; createRequire(import.meta.url)("node:process").exit(1)',
    'import {createRequire} from "node:module"; const factory=createRequire; const load=factory(import.meta.url); load("process").exit(1)',
    'import {createRequire} from "node:module"; let factory; factory=createRequire; const load=factory(import.meta.url); load("process").exit(1)',
    'const load=require; load("node:process").exit(1)',
    'let load; load=require; load("process").exit(1)',
  ]) assert.equal(inspectSource(source).exits.length, 1, source);
});

for (const factory of [
  'const N=M; const factory=N.createRequire',
  'const {createRequire:factory}=M',
  'const factory=M["createRequire"]',
  'const box={M}; const {M:N}=box; const factory=N.createRequire',
  'const [N]=[M]; const factory=N.createRequire',
  'let N; N=M; let factory; ({createRequire:factory}=N)',
  'const factory=M.createRequire.bind(null)',
]) test('native module factory projection retains exit and stdout: ' + factory, () => {
  for (const suffix of ['exit(1)', 'stdout.write("x")']) {
    const result=inspectSource('import * as M from "node:module"; '+factory+'; const load=factory(import.meta.url); load("node:process").'+suffix);
    assert.equal(result.exits.length + result.stdout.length + result.ambiguous.length, 1, suffix);
  }
});

test('native factory invocation adapters retain loader identity', () => {
  for (const source of [
    'import {createRequire} from "node:module"; const load=createRequire.call(null,import.meta.url); load("process").exit(1)',
    'import {createRequire} from "node:module"; const load=createRequire.apply(null,[import.meta.url]); load("process").exit(1)',
  ]) assert.equal(inspectSource(source).exits.length, 1, source);
});

for (const factory of [
  'const factory=M.createRequire || other',
  'const factory=other && M.createRequire',
  'const factory=M.createRequire ?? other',
  'let factory; factory ||= M.createRequire',
  'const {factory=M.createRequire}={}',
  'const [factory=M.createRequire]=[]',
  'const {...N}=M; const factory=N.createRequire',
  'const {default:ignored,...N}=M; const factory=N.createRequire',
  'const box={}; box.factory=M.createRequire; const factory=box.factory',
  'const box={}; const alias=box; alias.factory=M.createRequire; const factory=box.factory',
  'const box={nested:{}}; box.nested.factory=M.createRequire; const factory=box.nested.factory',
  'const box={}; box["factory"]=M.createRequire; const factory=box["factory"]',
  'const box={}; box[key]=M.createRequire; const factory=box.factory',
  'const box={factory:M.createRequire}; const factory=box[key]',
  'const factory=M.createRequire.bind(null,import.meta.url)',
  'const {nested:{factory}={factory:M.createRequire}}={}',
  'const [[factory]=[M.createRequire]]=[]',
  'class C {static factory=M.createRequire} const factory=C.factory',
  'class C {factory=M.createRequire} const factory=new C().factory',
  'class C {constructor(public factory=M.createRequire){}} const factory=new C().factory',
  'class C {factory=M.createRequire} class D extends C {} const {factory}=new D()',
  'namespace N {export const factory=M.createRequire} const factory=N.factory',
]) test('bounded native factory routes retain exit and stdout: ' + factory, () => {
  for (const suffix of ['exit(1)', 'stdout.write("x")']) {
    const result=inspectSource('import * as M from "node:module"; '+factory+'; const load=factory(import.meta.url); load("node:process").'+suffix);
    assert.ok(result.exits.length + result.stdout.length + result.ambiguous.length > 0, suffix);
  }
});

for (const invocation of [
  'const load=native.bind(null); load("node:process")',
  'const load=native.bind(null,"node:process"); load()',
  'native.call(null,"node:process")',
  'native.apply(null,["node:process"])',
  'const invoke=native.call.bind(native,null); invoke("node:process")',
  'const invoke=native.apply.bind(native,null); invoke(["node:process"])',
  'const load=native.bind(null,"node:module"); load().createRequire(import.meta.url)("node:process")',
  'native.call.call(native,null,"node:process")',
  'native.call.apply(native,[null,"node:process"])',
  'class C {static load=native} C.load("node:process")',
  'const {load=native}={}; load("node:process")',
  'const load=native || other; load("node:process")',
]) test('native loader adapters retain host calls: ' + invocation, () => {
  for (const suffix of ['exit(1)', 'stdout.write("x")']) {
    const result=inspectSource('import {createRequire} from "node:module"; const native=createRequire(import.meta.url); '+invocation+'.'+suffix);
    assert.ok(result.exits.length + result.stdout.length + result.ambiguous.length > 0, suffix);
  }
});

test('native loader route controls retain local functions and unrelated modules', () => {
  for (const source of [
    'const M={createRequire:()=>()=>({exit(){}})}; const factory=M.createRequire || other; factory("x")("process").exit(1)',
    'const factory=()=>()=>({exit(){}}); const box={}; box.factory=factory; box.factory("x")("process").exit(1)',
    'const load=()=>({exit(){}}); const invoke=load.bind(null,"process"); invoke().exit(1)',
    'const load=()=>({exit(){}}); load.call(null,"process").exit(1); load.apply(null,["process"]).exit(1)',
    'import {createRequire} from "node:module"; const native=createRequire(import.meta.url); const load=native.bind(null,"node:fs"); load().exit(1)',
    'import * as M from "node:module"; const {createRequire:ignored,...N}=M; N.createRequire(import.meta.url)("process").exit(1)',
    'import * as M from "node:module"; const box={factory:M.createRequire,run:()=>()=>({exit(){}})}; box.run("x")("process").exit(1)',
    'import {createRequire} from "node:module"; createRequire.apply(null,args)',
    'import {createRequire} from "node:module"; const native=createRequire(import.meta.url); native.bind(null,"process")',
  ]) assert.deepEqual(inspectSource(source), {exits:[], stdout:[], ambiguous:[]}, source);
});

test('Reflect invocation of native loaders and factories retains the returned process', () => {
  for (const expression of [
    'Reflect.apply(native,null,["process"])',
    'const apply=Reflect.apply; apply(native,null,["process"])',
    'globalThis.Reflect.apply(native,null,["process"])',
    'Reflect.apply.call(null,native,null,["process"])',
    'const load=Reflect.apply.bind(Reflect,native,null); load(["process"])',
    'Reflect.apply(createRequire,null,[import.meta.url])("process")',
  ]) {
    const result=inspectSource('import {createRequire} from "node:module"; const native=createRequire(import.meta.url); '+expression+'.exit(1)');
    assert.ok(result.exits.length + result.ambiguous.length > 0, expression);
  }
  assert.deepEqual(inspectSource('const Reflect={apply:()=>({exit(){}})}; Reflect.apply(require,null,["process"]).exit(1)'), {exits:[], stdout:[], ambiguous:[]});
});

test('factory namespace and bind controls do not imply a native loader', () => {
  for (const source of [
    'import * as M from "./fake.js"; const N=M; const load=N.createRequire("x"); load("process").exit(1)',
    'const M={createRequire:()=>()=>({exit:()=>{}})}; const {createRequire:factory}=M; const load=factory("x"); load("process").exit(1)',
    'import * as M from "node:module"; function f(M){const load=M["createRequire"]("x"); load("process").exit(1)}',
    'import {createRequire} from "node:module"; const factory=createRequire.bind(null,import.meta.url); factory("process").exit(1)',
  ]) assert.deepEqual(inspectSource(source), {exits:[], stdout:[], ambiguous:[]});
});

test('Reflect property mutation shares the global object identity', () => {
  assert.equal(inspectSource('globalThis.Reflect.apply=process.exit; Reflect.apply(1)').ambiguous.length, 1);
});

for (const source of [
  'function f(Reflect) { Reflect.apply(process.exit, process, [1]) }',
  'const Reflect={apply:()=>{}}; Reflect.apply(process.exit, process, [1])',
  'Reflect.apply(()=>{}, null, [])',
  'const invoke=Reflect.apply; invoke(()=>{}, null, [])',
  'const R={apply:()=>{}}; R.apply(process.exit, process, [1])',
  'Reflect.apply(process.cwd, process, [])',
  'const invoke=Reflect.apply.bind(Reflect)',
]) test('ordinary or shadowed Reflect operations do not count: ' + source, () => {
  assert.deepEqual(inspectSource(source), {exits:[], stdout:[], ambiguous:[]});
});

for (const source of [
  'class C {constructor(public quit=process.exit){}} new C().quit(1)',
  'class C {constructor(readonly quit=process.exit){}} const c=new C(); c.quit(1)',
  'class C {constructor(private quit=process.exit){} run(){this.quit(1)}} new C().run()',
  'class C {constructor(protected quit=process.exit){}} class D extends C {run(){this.quit(1)}} new D().run()',
  'const end=process.exit; class C {constructor(public quit=end){}} new C().quit(1)',
  'class C {constructor(public quit=process.exit){}} const {quit}=new C(); quit(1)',
  'class C {constructor(public quit=process.exit){}} const c=new C(); const quit=c.quit; quit(1)',
  'class C {constructor(readonly quit=process.exit.bind(process)){}} new C()["quit"](1)',
  'namespace M {export class C {constructor(public quit=process.exit){}}} const ctor=M.C; new ctor().quit(1)',
  'class C {constructor(public quit=process.exit){}} Reflect.apply(new C().quit, null, [1])',
]) test('initialized parameter property retains exit ownership: ' + source, () => {
  const result=inspectSource(source);
  assert.equal(result.exits.length + result.ambiguous.length, 1);
});

test('initialized parameter properties retain stdout and reverse mutation ownership', () => {
  assert.equal(inspectSource('class C {constructor(public out=process.stdout){}} new C().out.write("x")').stdout.length, 1);
  assert.equal(inspectSource('class C {constructor(public p=process){}} const c=new C(); c.p.quit=c.p.exit; process.quit(1)').ambiguous.length, 1);
});

for (const source of [
  'class C {constructor(public quit=process.exit){}} new C()',
  'class C {constructor(quit=process.exit){}} new C().quit(1)',
  'class C {constructor(public quit=()=>{}){}} new C().quit()',
  'function f(process) {class C {constructor(public quit=process.exit){}} new C().quit(1)}',
  'class C {constructor(public quit=process.exit){} run(){this.resize()} resize(){}} new C().run()',
]) test('parameter property controls preserve ordinary construction and shadowing: ' + source, () => {
  assert.deepEqual(inspectSource(source), {exits:[], stdout:[], ambiguous:[]});
});

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
test('computed destructuring keys preserve literal-object host boundaries', () => {
  for (const source of [
    'const {["quit"]: quit} = {quit:process.exit}; quit(1)',
    'const {["p"]: p} = {p:process}; p.exit(1)',
    'let quit; ({["quit"]: quit} = {quit:process.exit}); quit(1)',
  ]) assert.equal(inspectSource(source).exits.length, 1, source);
  assert.equal(inspectSource('const {nested: {["quit"]: quit}} = {nested:{quit:process.exit}}; quit(1)').ambiguous.length, 1);
  assert.equal(inspectSource('let emit; ({["emit"]: emit} = {emit:process.stdout.write}); emit("x")').stdout.length, 1);
  assert.equal(inspectSource('const {[name]: quit} = {quit:process.exit}; quit(1)').ambiguous.length, 1);
  assert.equal(inspectSource('let quit; ({[name]: quit} = {quit:process.exit}); quit(1)').ambiguous.length, 1);
  assert.deepEqual(inspectSource('const {[name]: run} = {run:()=>{}}; run()'), {exits:[], stdout:[], ambiguous:[]});
});
test('calls on environment values are not dynamic process methods', () => {
  assert.equal(inspectSource('process.env[name].trim()').ambiguous.length, 0);
});
test('numeric destructuring keys preserve literal-object host boundaries', () => {
  for (const source of [
    'const {0: quit} = {0:process.exit}; quit(1)',
    'const {[0]: quit} = {0:process.exit}; quit(1)',
    'let quit; ({0:quit} = {0:process.exit}); quit(1)',
    'let quit; ({[0]:quit} = {0:process.exit}); quit(1)',
    'const {16:quit} = {0x10:process.exit}; quit(1)',
  ]) assert.equal(inspectSource(source).exits.length, 1, source);
  assert.equal(inspectSource('const {0:emit} = {0:process.stdout.write}; emit("x")').stdout.length, 1);
  assert.equal(inspectSource('let emit; ({0:emit} = {0:process.stdout.write}); emit("x")').stdout.length, 1);
});
test('tagged templates account for executable bound host methods', () => {
  assert.equal(inspectSource('const quit=process.exit.bind(process,7); quit`x`').exits.length, 1);
  assert.equal(inspectSource('const emit=process.stdout.write.bind(process.stdout,"x",undefined,()=>{}); emit`y`').stdout.length, 1);
  assert.deepEqual(inspectSource('const render=(parts)=>parts.join(""); render`x`'), {exits:[], stdout:[], ambiguous:[]});
});
test('direct global process member transfers cannot obtain clearance', () => {
  for (const source of [
    'process["quit"]=process.exit; process["quit"](7)',
    'process.stdout.emit=process.stdout.write; process.stdout.emit("x")',
    'const p=process; process.quit=process.exit; p.quit(1)',
  ]) assert.equal(inspectSource(source).ambiguous.length, 1, source);
  assert.deepEqual(inspectSource('process.exitCode=1; process.stdout.columns=80; process.cwd()'), {exits:[], stdout:[], ambiguous:[]});
});
test('constructor syntax accounts for executable bound host methods', () => {
  assert.equal(inspectSource('new (process.exit.bind(process,7))()').exits.length, 1);
  assert.equal(inspectSource('const quit=process.exit.bind(process,7); new quit()').exits.length, 1);
  assert.deepEqual(inspectSource('class Widget {} new Widget()'), {exits:[], stdout:[], ambiguous:[]});
});
test('known global and imported process identities share mutation ownership', () => {
  for (const source of [
    'global.process.quit=process.exit; global.process.quit(7)',
    'const out=globalThis.process.stdout; out.emit=out.write; process.stdout.emit("x")',
    'const p=process; p.quit=process.exit; global.process.quit(7)',
    'const g=globalThis; g.process.quit=g.process.exit; process.quit(7)',
    'import p from "node:process"; p.quit=p.exit; process.quit(7)',
    'const p=require("node:process"); p.quit=p.exit; process.quit(7)',
  ]) assert.equal(inspectSource(source).ambiguous.length, 1, source);
  assert.deepEqual(inspectSource('const process={quit:()=>{}}; process.quit(); const global={process:{quit:()=>{}}}; global.process.quit()'), {exits:[], stdout:[], ambiguous:[]});
});
test('binding a host method does not invoke it, including capture and restore', () => {
  assert.deepEqual(inspectSource('const original=process.stdout.write.bind(process.stdout); process.stdout.write=original'), {exits:[], stdout:[], ambiguous:[]});
  for (const source of [
    'process.stdout.write.bind=process.exit; process.stdout.write.bind(7)',
    'const obj={bind:process.exit}; obj.bind(7)',
    'const obj={[key]:process.exit}; obj.bind(7)',
  ]) assert.equal(inspectSource(source).ambiguous.length, 1, source);
});
test('unresolved nested and dynamic host invocation suffixes fail closed', () => {
  for (const source of [
    'process.exit.call.call(process.exit,process,7)',
    'process.exit.apply.call(process.exit,process,[7])',
    'const quit=process.exit.bind.call(process.exit,process,7); quit()',
    'process.stdout.write.call.call(process.stdout.write,process.stdout,"x")',
    'const method="call"; process.exit[method](process,7)',
    'const method="call"; process.stdout.write[method](process.stdout,"x")',
  ]) assert.ok(inspectSource(source).ambiguous.length > 0, source);
  assert.deepEqual(inspectSource('process.env[method].trim(); const formatter={call:()=>{}}; formatter.call()'), {exits:[], stdout:[], ambiguous:[]});
});
test('ambient declarations do not create runtime shadows of host globals', () => {
  assert.equal(inspectSource('declare const process:any; process.exit(1)').exits.length, 1);
  assert.equal(inspectSource('declare var global:any; global.process.exit(1)').exits.length, 1);
  assert.equal(inspectSource('declare const globalThis:any; globalThis.process.stdout.write("x")').stdout.length, 1);
  assert.deepEqual(inspectSource('const process={exit:()=>{}}; process.exit(1)'), {exits:[], stdout:[], ambiguous:[]});
});
test('process data in arrays and alternative environment keys do not create host boundaries', () => {
  assert.equal(inspectSource('const args = [process.execPath, "--flag"]; args.map(String).join(" "); const roots = process.env["ROOT_A"] || process.env["ROOT_B"] || ""; roots.split(",")').ambiguous.length, 0);
});
test('external import-equals process aliases preserve host calls and mutation ownership', () => {
  for (const module of ['process', 'node:process']) {
    assert.equal(inspectSource(`import p = require('${module}'); p.exit(7)`).exits.length, 1);
    assert.equal(inspectSource(`import p = require('${module}'); p.stdout.write('x')`).stdout.length, 1);
    assert.equal(inspectSource(`import p = require('${module}'); p.quit=p.exit; process.quit(7)`).ambiguous.length, 1);
  }
  assert.deepEqual(inspectSource("import fs = require('node:fs'); fs.readFileSync('x')"), {exits:[], stdout:[], ambiguous:[]});
});
test('internal import-equals qualified aliases preserve local host routes', () => {
  assert.equal(inspectSource('import p = globalThis.process; p.exit(7)').exits.length, 1);
  assert.equal(inspectSource('import quit = process.exit; quit(7)').exits.length, 1);
  assert.equal(inspectSource('import emit = process.stdout.write; emit("x")').stdout.length, 1);
  assert.equal(inspectSource('import p = global.process; p.quit=p.exit; process.quit(7)').ambiguous.length, 1);
  assert.deepEqual(inspectSource('namespace local { export function run() {} } import run = local.run; run()'), {exits:[], stdout:[], ambiguous:[]});
});
test('assignment-backed parameter bindings merge possible host roles', () => {
  for (const source of [
    'function f(p:any) { p=process.stdout; p=process; p.exit(1) } f(null)',
    'function f(p:any) { p=process; p=process.stdout; p.write("x") } f(null)',
    'function f(p:any) { p=process.stdout; p=process; const quit=p.exit; quit(1) } f(null)',
    'function f(p:any) { p=process; p=process.stdout; const emit=p.write; emit("x") } f(null)',
  ]) assert.equal(inspectSource(source).ambiguous.length, 1, source);
  assert.equal(inspectSource('function f(p:any) { p=process; p.exit(1) } f(null)').exits.length, 1);
  assert.equal(inspectSource('function f(p:any) { p=process.stdout; p.write("x") } f(null)').stdout.length, 1);
  assert.deepEqual(inspectSource('function f(p:any) { p={run:()=>{}}; p.run() } f(null)'), {exits:[], stdout:[], ambiguous:[]});
});
test('identifier parameter defaults preserve host routes and mutation identity', () => {
  assert.equal(inspectSource('function f(quit=process.exit){quit(7)} f()').exits.length, 1);
  assert.equal(inspectSource('function f(out=process.stdout){out.write("x")} f()').stdout.length, 1);
  assert.equal(inspectSource('function f(p=process){p.quit=p.exit; process.quit(7)} f()').ambiguous.length, 1);
  assert.equal(inspectSource('function f(p:any=process.stdout){p=process; p.exit(7)} f()').ambiguous.length, 1);
  assert.deepEqual(inspectSource('function f(run=()=>{}){run()} f()'), {exits:[], stdout:[], ambiguous:[]});
});
test('assignments to implicit globals preserve replacement host routes', () => {
  for (const source of [
    'global=process; global.exit(7)',
    'globalThis=process; globalThis.exit(7)',
    'process=process.stdout; process.write("x")',
    'global=process.stdout; const emit=global.write; emit("x")',
  ]) assert.equal(inspectSource(source).ambiguous.length, 1, source);
});
test('static class and namespace containers preserve host routes', () => {
  for (const source of [
    'class C { static quit=process.exit } C.quit(7)',
    'const C=class Named { static quit=process.exit }; C.quit(7)',
    'const C=class { static out=process.stdout }; C.out.write("x")',
    'namespace M { export const quit=process.exit } M.quit(7)',
    'namespace M { export const out=process.stdout } M.out.write("x")',
    'namespace M.N { export const quit=process.exit } M.N.quit(7)',
    'namespace M { export class C { static quit=process.exit } } M.C.quit(7)',
    'class C { static quit=process.exit } class D extends C {} D.quit(7)',
    'class C { static quit=process.exit; static { this.quit(7) } }',
    'class C { static { this.quit=process.exit; this.quit(7) } }',
  ]) { const result = inspectSource(source); assert.ok(result.ambiguous.length + result.exits.length + result.stdout.length > 0, source); }
  assert.deepEqual(inspectSource('class C { static run=()=>{} } C.run(); namespace M { export const run=()=>{} } M.run()'), {exits:[], stdout:[], ambiguous:[]});
});
test('static class and namespace aliases retain reverse mutation ownership', () => {
  for (const source of [
    'const original:any={}; class C {static alias=original}; C.alias.quit=process.exit; original.quit(7)',
    'class C {static p=process}; C.p.quit=C.p.exit; process.quit(7)',
    'const original:any={}; const C=class {static alias=original}; C.alias.quit=process.exit; original.quit(7)',
    'const original:any={}; namespace M {export const alias=original}; M.alias.quit=process.exit; original.quit(7)',
    'namespace M {export const p=process}; M.p.quit=M.p.exit; process.quit(7)',
  ]) assert.ok(inspectSource(source).ambiguous.length > 0, source);
});
test('local class instances retain field routes without counting construction', () => {
  for (const source of [
    'class C {quit=process.exit} const c=new C(); c.quit(7)',
    'class C {out=process.stdout} const c=new C(); c.out.write("x")',
    'class C {quit=process.exit} const {quit}=new C(); quit(7)',
    'class C {quit=process.exit} class D extends C {} new D().quit(7)',
    'class C {quit=process.exit; constructor(){this.quit(7)}} new C()',
    'class C {constructor(){this.quit=process.exit;this.quit(7)}} new C()',
    'class C extends process.exit {} new C(7)',
    'class C {static quit=process.exit} let ctor:any=C; ctor=process.exit.bind(process,7); new ctor()',
  ]) { const result = inspectSource(source); assert.ok(result.ambiguous.length + result.exits.length + result.stdout.length > 0, source); }
  for (const source of [
    'class C {static quit=process.exit} new C()',
    'class C {static quit=process.exit} const ctor=C; new ctor()',
    'class C {quit=process.exit} new C()',
    'class C {out=process.stdout} class D extends C {} new D()',
  ]) assert.deepEqual(inspectSource(source), {exits:[], stdout:[], ambiguous:[]}, source);
  assert.equal(inspectSource('class C {quit=process.exit(7)} new C()').exits.length, 1);
});
test('instance field aliases preserve reverse mutation ownership', () => {
  for (const source of [
    'const original:any={}; class C {alias=original} const c=new C(); c.alias.quit=process.exit; original.quit(7)',
    'class C {p=process} const c=new C(); c.p.quit=c.p.exit; process.quit(7)',
    'const original:any={}; class C {alias=original} class D extends C {} const c=new D(); c.alias.quit=process.exit; original.quit(7)',
  ]) assert.ok(inspectSource(source).ambiguous.length > 0, source);
});
test('recursive class field graphs terminate and retain host ownership', () => {
  assert.deepEqual(inspectSource('class C {child=flag ? new C() : null}'), {exits:[], stdout:[], ambiguous:[]});
  assert.deepEqual(inspectSource('class A {child=flag ? new B() : null} class B {child=flag ? new A() : null}'), {exits:[], stdout:[], ambiguous:[]});
  assert.equal(inspectSource('class C {child=flag ? new C() : null; quit=process.exit} new C().quit(7)').exits.length, 1);
});
test('local constructor ownership survives members and transparent aliases', () => {
  for (const source of [
    'namespace M {export class C {quit=process.exit}} new M.C().quit(7)',
    'class C {quit=process.exit} const box={C}; new box.C().quit(7)',
    'class C {quit=process.exit} let ctor; ctor=C; new ctor().quit(7)',
    'class C {quit=process.exit} const ctor=(0,C); new ctor().quit(7)',
    'class C {quit=process.exit} const ctor=await C; new ctor().quit(7)',
    'class C {quit=process.exit} const [ctor]=[C]; new ctor().quit(7)',
    'class C {quit=process.exit} const {ctor}={ctor:C}; new ctor().quit(7)',
    'class C {quit=process.exit} const box={C}; new box["C"]().quit(7)',
    'namespace M {export class C {out=process.stdout}} class D extends M.C {} new D().out.write("x")',
  ]) { const result = inspectSource(source); assert.ok(result.ambiguous.length + result.exits.length + result.stdout.length > 0, source); }
  assert.deepEqual(inspectSource('namespace M {export class C {static quit=process.exit}} new M.C()'), {exits:[], stdout:[], ambiguous:[]});
});
test('class writer capture and restoration do not taint unrelated methods or process data', () => {
  assert.deepEqual(inspectSource('class C {original=process.stdout.write; capture(){this.original=process.stdout.write} restore(){process.stdout.write=this.original} run(){const self=this; self.resize(); this.resize(); process.stdin.resume(); process.stdout.on("resize",()=>{})} resize(){} } new C().run()'), {exits:[], stdout:[], ambiguous:[]});
  assert.deepEqual(inspectSource('class C {cols=process.stdout.columns; run(){this.resize(); process.stdout.on("resize",()=>{})} resize(){} } new C().run()'), {exits:[], stdout:[], ambiguous:[]});
  assert.equal(inspectSource('class C {original=process.stdout.write; run(){this.original("x")} } new C()').stdout.length, 1);
  assert.ok(inspectSource('process.stdout.write=process.exit; process.stdout.write(7)').ambiguous.length > 0);
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
