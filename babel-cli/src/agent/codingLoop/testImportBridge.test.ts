import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtempSync,writeFileSync,rmSync,mkdirSync,symlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {proposeTestImports,corroboratesTestImport} from './testImportBridge.js'

test('import proposals bind the actual named assertion, local alias and exported symbol', () => {
  const root = mkdtempSync(join(tmpdir(),'babel-import-syntax-'))
  try {
    writeFileSync(join(root,'math.js'),'export function add(a,b){return a-b}')
    writeFileSync(join(root,'other.js'),'export function wrong(){}')
    const header = "import {test} from 'node:test';import assert from 'node:assert/strict';import {add as sum} from './math.js';import {wrong} from './other.js';"
    const propose = (body:string, prefix=header) => proposeTestImports({content:prefix+body,testPath:'math.test.js',testName:'addition',projectRoot:root})
    assert.deepEqual(propose("test('addition',()=>assert.equal(sum(2,3),5));test('other',()=>assert.equal(wrong(),1));"),
      [{path:'math.js',relation:'add',source:'import_call',fromTestPath:'math.test.js'}])
    const multi = header + "test('addition',()=>{assert.equal(sum(2,3),5);assert.ok(wrong())});"
    assert.deepEqual(proposeTestImports({content:multi,testPath:'math.test.js',testName:'addition',projectRoot:root,line:1,column:multi.indexOf('assert.equal')+1}),
      [{path:'math.js',relation:'add',source:'import_call',fromTestPath:'math.test.js'}])
    for (const body of [
      "test('other',()=>assert.equal(sum(2,3),5));test('addition',()=>assert.equal(1,1));",
      "test('addition',()=>assert.equal('sum(2,3)',5));",
      "test('addition',()=>{ /* assert.equal(sum(2,3),5) */ assert.equal(1,1) });",
      "test('addition',(sum)=>assert.equal(sum(2,3),5));",
      "test('addition',function sum(){assert.equal(sum(2,3),5)});",
      "test('addition',()=>{assert.equal(sum(2,3),5);assert.ok(wrong())});",
      "test('addition',()=>{const sum=()=>1;assert.equal(sum(),1)});",
      "test('addition',()=>{const assert={equal:()=>{}};assert.equal(sum(),1)});",
      "test('addition',()=>{(()=>assert.equal(sum(),1))()});",
      "test('addition',()=>assert.equal(sum(),1));test('addition',()=>assert.equal(sum(),1));",
    ]) assert.deepEqual(propose(body),[],body)
    assert.deepEqual(propose("test('addition',()=>assert.equal(sum(),1));",header.replace('./math.js','../math.js')),[])
    assert.deepEqual(propose("test('addition',()=>assert.equal(sum(),1));",header.replace('./math.js','package-math')),[])
    assert.deepEqual(propose('0;'.repeat(11_000)+"test('addition',()=>assert.equal(sum(),1));"),[], 'exhausted module traversal fails closed')
    assert.equal(corroboratesTestImport('/* export function add(){} */ export function address(){}','add'),false)
    assert.equal(corroboratesTestImport('export const add = (a,b) => a+b','add'),true)
    assert.equal(corroboratesTestImport('1│export const add = (a,b) => a+b','add'),true)
    assert.equal(corroboratesTestImport('[Showing lines 1-200 of 300]\n1│export const add = (a,b) => a+b','add'),false)
    assert.equal(corroboratesTestImport('export { add } from "./other.js"','add'),false)
  } finally {rmSync(root,{recursive:true,force:true})}
})

test('import proposals reject symlinks outside the project', () => {
  const root=mkdtempSync(join(tmpdir(),'babel-import-contained-'))
  const outside=mkdtempSync(join(tmpdir(),'babel-import-external-'))
  try {
    mkdirSync(join(outside,'lib'));writeFileSync(join(outside,'lib','math.js'),'export function add(){}')
    symlinkSync(join(outside,'lib'),join(root,'lib'),'junction')
    const content="import {test} from 'node:test';import assert from 'node:assert/strict';import {add} from './lib/math.js';test('addition',()=>assert.equal(add(),1));"
    assert.deepEqual(proposeTestImports({content,testPath:'math.test.js',testName:'addition',projectRoot:root}),[])
  } finally {rmSync(root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true})}
})
