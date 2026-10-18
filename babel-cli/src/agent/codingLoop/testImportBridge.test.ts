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
      "test('addition',()=>assert.equal(1,2,wrong()));",
      "test('addition',()=>assert.ok(false,wrong()));",
      "test('addition',()=>assert.match('a',/b/,wrong()));",
      "test('addition',()=>assert.equal(...[1,2,wrong()]));",
      "test('addition',()=>{ /* assert.equal(sum(2,3),5) */ assert.equal(1,1) });",
      "test('addition',(sum)=>assert.equal(sum(2,3),5));",
      "test('addition',function sum(){assert.equal(sum(2,3),5)});",
      "test('addition',()=>{assert.equal(sum(2,3),5);assert.ok(wrong())});",
      "test('addition',()=>{const sum=()=>1;assert.equal(sum(),1)});",
      "test('addition',()=>{const assert={equal:()=>{}};assert.equal(sum(),1)});",
      "test('addition',()=>{(()=>assert.equal(sum(),1))()});",
      "test('addition',()=>assert.equal(sum(),1));test('addition',()=>assert.equal(sum(),1));",
    ]) assert.deepEqual(propose(body),[],body)
    assert.deepEqual(propose("test('addition',()=>assert.equal(sum(2,3),5,wrong()));"),
      [{path:'math.js',relation:'add',source:'import_call',fromTestPath:'math.test.js'}])
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
    writeFileSync(join(outside,'lib','styles.css'),'.status {}')
    symlinkSync(join(outside,'lib'),join(root,'lib'),'junction')
    const content="import {test} from 'node:test';import assert from 'node:assert/strict';import {add} from './lib/math.js';test('addition',()=>assert.equal(add(),1));"
    assert.deepEqual(proposeTestImports({content,testPath:'math.test.js',testName:'addition',projectRoot:root}),[])
    const data="import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';test('style',()=>assert.match(readFileSync(new URL('./lib/styles.css',import.meta.url),'utf8'),/opacity/));"
    assert.deepEqual(proposeTestImports({content:data,testPath:'render.test.js',testName:'style',projectRoot:root}),[])
  } finally {rmSync(root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true})}
})

test('a failing text-file assertion proposes only its static contained standard-library read', () => {
  const root=mkdtempSync(join(tmpdir(),'babel-file-assertion-'))
  try {
    writeFileSync(join(root,'styles.css'),'.status { display: inline-flex; }')
    const header="import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync as read} from 'node:fs';"
    const body="test('busy style',()=>assert.match(read(new URL('./styles.css',import.meta.url),'utf8'),/opacity/));"
    const propose=(content:string)=>proposeTestImports({content,testPath:'render.test.js',testName:'busy style',projectRoot:root})
    assert.deepEqual(propose(header+body),[{path:'styles.css',relation:'readFileSync',source:'file_read',fromTestPath:'render.test.js'}])
    for(const content of [
      header+body.replace('./styles.css','../styles.css'),
      header+body.replace("'./styles.css'","target"),
      header+body.replace('import.meta.url','base'),
      header.replace('node:fs','untrusted-fs')+body,
      header+body.replace("()=>assert", "(read)=>assert"),
      header+body.replace("()=>assert", "(URL)=>assert"),
      header+"const URL=OtherURL;"+body,
      header+body.replace("new URL", "new OtherURL"),
      header+body.replace("'utf8'", "'base64'"),
      header+body.replace("'busy style'", "'unrelated'"),
      header+"test('busy style',()=>assert.equal(1,2,read(new URL('./styles.css',import.meta.url),'utf8')));",
      header+"test('busy style',()=>assert.ok(false,read(new URL('./styles.css',import.meta.url),'utf8')));",
      header+"test('busy style',()=>assert.equal(1,1));"+body.replace("'busy style'", "'unrelated'"),
    ]) assert.deepEqual(propose(content),[],content)
    assert.equal(corroboratesTestImport('1│.status {}','readFileSync','file_read'),true)
    assert.equal(corroboratesTestImport('','readFileSync','file_read'),true)
    assert.equal(corroboratesTestImport('[Showing lines 2-3 of 4]\n2│.status {}','readFileSync','file_read'),false)
  } finally {rmSync(root,{recursive:true,force:true})}
})
