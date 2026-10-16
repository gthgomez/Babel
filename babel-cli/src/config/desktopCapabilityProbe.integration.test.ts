import assert from 'node:assert/strict'
import test from 'node:test'
import {spawnSync} from 'node:child_process'
import {writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {prepareSyntheticProviderFixture,removeSyntheticProviderFixture} from '../testinfra/synthetic-provider-fixture.mjs'

test('built CLI capability probe completes before credential bootstrap and paid execution',t=>{
  const fixture=prepareSyntheticProviderFixture()
  const entry=fileURLToPath(new URL('../../dist/index.js',import.meta.url))
  try{
    writeFileSync(join(fixture.root,'config','.env'),'BABEL_CAPABILITY_PROBE_CANARY=synthetic-legacy-value\n',{mode:0o600})
    const code=`process.env.BABEL_PROJECT_CREDENTIALS_DIR=${JSON.stringify(join(fixture.cwd,'must-not-inspect'))};process.env.BABEL_LEGACY_CLI_ENV='1';process.argv=[process.execPath,${JSON.stringify(entry)},'--desktop-capabilities'];await import(${JSON.stringify(new URL('../../dist/index.js',import.meta.url).href)});if(process.env.BABEL_ENV_LOADED!==undefined||process.env.BABEL_CAPABILITY_PROBE_CANARY!==undefined)process.exitCode=8;`
    const child=spawnSync(process.execPath,['--import',new URL('../testinfra/synthetic-provider-fixture.mjs',import.meta.url).href,'--import',new URL('../testinfra/register-no-ambient-inference.mjs',import.meta.url).href,'--input-type=module','-e',code],{cwd:fixture.cwd,env:fixture.env,encoding:'utf8',windowsHide:true,timeout:20000,maxBuffer:64*1024})
    let capabilities:unknown;try{capabilities=JSON.parse(String(child.stdout))}catch{}
    t.diagnostic(JSON.stringify({exitCode:child.status,hasValidResponse:typeof capabilities==='object'&&capabilities!==null,bootstrapTouched:child.status===8,timedOut:Boolean(child.error&&'code' in child.error&&child.error.code==='ETIMEDOUT')}))
    assert.equal(child.error===undefined,true,'capability probe must settle')
    assert.equal(child.status,0,'CAPABILITY_PROBE_NOT_EARLY')
    assert.deepEqual(capabilities,{schemaVersion:1,credentialEnvironment:'native-resolved-v1'})
  }finally{removeSyntheticProviderFixture(fixture.root)}
})
