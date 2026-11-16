import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isSyntheticProviderFixtureReady, prepareSyntheticProviderFixture, removeSyntheticProviderFixture, summarizeSyntheticProviderOutput } from '../testinfra/synthetic-provider-fixture.mjs'

if (!isSyntheticProviderFixtureReady()) {
  test('product entry checks run in an isolated synthetic profile', {timeout:45000}, async t => {
    const fixture=prepareSyntheticProviderFixture();t.after(()=>removeSyntheticProviderFixture(fixture.root))
    const child=spawn(process.execPath,['--import',new URL('../testinfra/synthetic-provider-fixture.mjs',import.meta.url).href,
      '--import',import.meta.resolve('tsx'),'--import',new URL('../testinfra/register-no-ambient-inference.mjs',import.meta.url).href,
      '--test','--test-reporter=tap',fileURLToPath(import.meta.url)],{cwd:fixture.cwd,env:fixture.env,windowsHide:true,stdio:['ignore','pipe','pipe']})
    let output='';child.stdout.on('data',chunk=>{output+=String(chunk)});child.stderr.on('data',chunk=>{output+=String(chunk)})
    const code=await new Promise<number>(resolve=>{child.once('error',()=>resolve(1));child.once('close',value=>resolve(value??1))})
    const result=summarizeSyntheticProviderOutput(output,code);t.diagnostic(result)
    assert.equal(code,0,result);assert.ok(JSON.parse(result).passed>0)
  })
} else {
const { updateUserSettings } = await import('../config/userSettings.js')
test('the actual headless CLI rejects a legacy unapproved connection before provider dispatch', { timeout: 30000 }, async () => {
  updateUserSettings({connections:{legacy:{id:'legacy',provider:'deepseek',model:'deepseek-v4-flash'}},defaults:{connection:'legacy'}})
  const child=spawn(process.execPath,[
    '--import',new URL('../testinfra/synthetic-provider-fixture.mjs',import.meta.url).href,
    '--import',import.meta.resolve('tsx'),
    '--import',new URL('../testinfra/register-no-ambient-inference.mjs',import.meta.url).href,
    fileURLToPath(new URL('../index.ts',import.meta.url)),
    'run','Inspect the fixture','--model','connection/legacy/deepseek-v4-flash','--read-only','--json',
  ],{cwd:process.cwd(),env:process.env,windowsHide:true,stdio:['ignore','pipe','pipe']})
  let output=''
  child.stdout.on('data',chunk=>{output+=String(chunk)})
  child.stderr.on('data',chunk=>{output+=String(chunk)})
  const timer=setTimeout(()=>child.kill(),25000)
  const code=await new Promise<number>(resolve=>{child.once('error',()=>resolve(1));child.once('close',value=>resolve(value??1))})
  clearTimeout(timer)
  assert.notEqual(code,0)
  assert.equal(/unsupported provider|choose openrouter or command code/i.test(output),true,'the public entry must enforce gateway policy')
  assert.equal(output.includes('SYNTHETIC_PROVIDER_NETWORK_DISPATCH_BLOCKED'),false,'the rejection must precede provider dispatch')
})
}
