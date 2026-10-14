// License: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname,join,isAbsolute,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import vm from 'node:vm';
import * as childEnvironment from '../native/childEnv.mjs';
import {parsePreferences} from '../native/security.mjs';

const projectA=resolve(tmpdir(),'babel-scope-project-a');
const projectB=resolve(tmpdir(),'babel-scope-project-b');
const profile=resolve(tmpdir(),'babel-scope-profile');
const source=readFileSync(new URL('../scripts/cli-launch.mjs',import.meta.url),'utf8')
  .replace(/^import .*;\r?$/gm,'')
  .replaceAll('import.meta.url',JSON.stringify(pathToFileURL(join(profile,'resources','babel-runtime','cli-launch.mjs')).href));
function launcherEnvironment(args,preferences,{unsafe=false}={}) {
  let captured;
  vm.runInNewContext(source,{
    process:{argv:['node','cli-launch.mjs',`--profile-dir=${profile}`,...args],env:{},cwd:()=>projectB},
    dirname,join,isAbsolute,resolve,fileURLToPath,console,
    readFileSync:()=>JSON.stringify(preferences),
    lstatSync:()=>({isFile:()=>true,isSymbolicLink:()=>unsafe,nlink:1,size:100}),
    parsePreferences,
    bundledEnvironment:()=>({BABEL_CONFIG_DIR:join(profile,'missing-config'),BABEL_PROJECT_CREDENTIALS_DIR:projectA}),
    resolvePackagedEngine:()=>({ready:true,path:'synthetic-entry'}),
    applyProviderRoute:env=>env,
    applyCliCredentialScope:childEnvironment.applyCliCredentialScope,
    spawn:(_exe,_args,options)=>{captured=options.env;return{on:()=>{}};},
  });
  return captured;
}
test('installed launcher strips ambient project scope and restores only a matching saved opt-in',()=>{
  const preferences={projectRoot:projectA,projectCredentialRoot:projectA};
  assert.equal(launcherEnvironment(['run','--project-root',projectB],preferences).BABEL_PROJECT_CREDENTIALS_DIR,undefined);
  assert.equal(launcherEnvironment(['run','--project-root',projectA],preferences).BABEL_PROJECT_CREDENTIALS_DIR,projectA);
  assert.equal(launcherEnvironment(['run',`--project-root=${projectA}`],preferences).BABEL_PROJECT_CREDENTIALS_DIR,projectA);
  assert.equal(launcherEnvironment(['interactive'],{projectRoot:projectB,projectCredentialRoot:projectB}).BABEL_PROJECT_CREDENTIALS_DIR,projectB);
  assert.equal(launcherEnvironment(['run','--project','another-project'],{projectRoot:projectB,projectCredentialRoot:projectB}).BABEL_PROJECT_CREDENTIALS_DIR,undefined);
  assert.equal(launcherEnvironment(['deep','another-project','Public task'],{projectRoot:projectB,projectCredentialRoot:projectB}).BABEL_PROJECT_CREDENTIALS_DIR,undefined);
  assert.equal(launcherEnvironment(['run','--',`--project-root=${projectA}`],preferences).BABEL_PROJECT_CREDENTIALS_DIR,undefined);
  assert.equal(launcherEnvironment(['run','--project-root',projectA],preferences,{unsafe:true}).BABEL_PROJECT_CREDENTIALS_DIR,undefined);
});
