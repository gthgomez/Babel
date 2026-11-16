import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {installLinuxKeyringBinding} from '../scripts/lib/linux-keyring-binding.mjs';

test('Linux packaging installs the exact native binding and requires its notices',()=>{
  const cwd=mkdtempSync(join(tmpdir(),'babel-keyring-package-'));
  writeFileSync(join(cwd,'package.json'),'{}');
  const wrapper=join(cwd,'node_modules','@napi-rs','keyring');mkdirSync(wrapper,{recursive:true});
  writeFileSync(join(wrapper,'package.json'),'{"main":"index.js"}');writeFileSync(join(wrapper,'index.js'),'exports.Entry=class Entry {}');
  let call;
  const result=installLinuxKeyringBinding({cwd,npmCli:'npm-cli.js',nodeExec:'node',platform:'linux',arch:'x64',execute:(exe,args)=>{
    call={exe,args};const root=join(cwd,'node_modules','@napi-rs','keyring-linux-x64-gnu');mkdirSync(root,{recursive:true});
    writeFileSync(join(root,'package.json'),'{"name":"@napi-rs/keyring-linux-x64-gnu","version":"2.1.2"}');
    writeFileSync(join(root,'LICENSE.third-party.md'),'synthetic license fixture');
  }});
  assert.equal(result,'@napi-rs/keyring-linux-x64-gnu');
  assert.ok(call.args.includes('@napi-rs/keyring-linux-x64-gnu@2.1.2'));
  assert.ok(call.args.includes('--ignore-scripts'));
  assert.throws(()=>installLinuxKeyringBinding({cwd,npmCli:'x',platform:'win32',arch:'x64'}),/linux-x64/i);
});
