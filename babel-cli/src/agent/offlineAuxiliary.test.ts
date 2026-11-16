import assert from 'node:assert/strict'
import test from 'node:test'
import { isSyntheticProviderFixtureReady, runSyntheticProviderTestFile } from '../testinfra/synthetic-provider-fixture.mjs'

if (!isSyntheticProviderFixtureReady()) {
  test('offline auxiliary boundaries use an isolated synthetic profile', {timeout:60000}, async t => {
    const result=await runSyntheticProviderTestFile(import.meta.url);t.diagnostic(JSON.stringify(result))
    assert.equal(result.exitCode,0);assert.ok(result.passed>0)
  })
} else {
const { LLMSummarizeCompaction } = await import('./chatCompaction.js')
const { createEmbeddingProvider } = await import('../services/embeddingProvider.js')
const { handleWebFetch, handleWebSearch } = await import('../tools/webContext.js')
const { SttClient } = await import('../voice/stt-client.js')

test('offline mode prevents voice transcription from opening a cloud WebSocket', async () => {
  const old=process.env['BABEL_OFFLINE'];const OriginalWebSocket=globalThis.WebSocket;let calls=0
  try {
    process.env['BABEL_OFFLINE']='1'
    globalThis.WebSocket=class { constructor(){calls++;throw new Error('unexpected WebSocket')} } as unknown as typeof WebSocket
    await assert.rejects(new SttClient({mode:'cloud'}).connect(),/offline/i)
    assert.equal(calls,0)
  } finally {
    globalThis.WebSocket=OriginalWebSocket
    if(old===undefined)delete process.env['BABEL_OFFLINE'];else process.env['BABEL_OFFLINE']=old
  }
})

test('offline mode prevents auxiliary compaction from contacting a cloud endpoint', async () => {
  const old=process.env['BABEL_OFFLINE'];const oldFetch=globalThis.fetch;let calls=0
  try {
    process.env['BABEL_OFFLINE']='1'
    globalThis.fetch=async()=>{calls++;return new Response('{}',{status:401})}
    const compactor=new LLMSummarizeCompaction() as unknown as {
      callOpenAiCompatibleApi:(prompt:string,model:string,key:string,url:string,tokens:number)=>Promise<unknown>
      callAnthropicApi:(prompt:string,model:string,key:string,tokens:number)=>Promise<unknown>
    }
    await assert.rejects(compactor.callOpenAiCompatibleApi('fixture','fixture','synthetic','https://openrouter.ai/api/v1/chat/completions',64),/offline/i)
    await assert.rejects(compactor.callAnthropicApi('fixture','fixture','synthetic',64),/offline/i)
    assert.equal(calls,0)
  } finally {
    globalThis.fetch=oldFetch
    if(old===undefined)delete process.env['BABEL_OFFLINE'];else process.env['BABEL_OFFLINE']=old
  }
})

test('offline web tools do not dispatch public requests', async () => {
  const old=process.env['BABEL_OFFLINE'];const oldFetch=globalThis.fetch;let calls=0
  try {
    process.env['BABEL_OFFLINE']='1'
    globalThis.fetch=async()=>{calls++;return new Response('<html></html>',{status:200})}
    const context={runId:'offline-fixture',babelRoot:process.cwd()}
    const page=await handleWebFetch({tool:'web_fetch',url:'https://93.184.216.34/fixture'},context)
    const search=await handleWebSearch({tool:'web_search',query:'offline fixture unique query'},context)
    assert.equal(page.exit_code,1);assert.match(page.stderr,/offline/i)
    assert.equal(search.exit_code,1);assert.match(search.stderr,/offline/i)
    assert.equal(calls,0)
  } finally {
    globalThis.fetch=oldFetch
    if(old===undefined)delete process.env['BABEL_OFFLINE'];else process.env['BABEL_OFFLINE']=old
  }
})

test('an ambient OpenAI key alone does not silently enable paid embeddings', () => {
  const oldKey=process.env['OPENAI_API_KEY'];const oldExplicit=process.env['BABEL_EMBEDDING_API_KEY'];const oldOptIn=process.env['BABEL_EMBEDDING_ENABLE']
  try {
    process.env['OPENAI_API_KEY']='synthetic-ambient-key'
    delete process.env['BABEL_EMBEDDING_API_KEY'];delete process.env['BABEL_EMBEDDING_ENABLE']
    assert.equal(createEmbeddingProvider(),null)
  } finally {
    if(oldKey===undefined)delete process.env['OPENAI_API_KEY'];else process.env['OPENAI_API_KEY']=oldKey
    if(oldExplicit===undefined)delete process.env['BABEL_EMBEDDING_API_KEY'];else process.env['BABEL_EMBEDDING_API_KEY']=oldExplicit
    if(oldOptIn===undefined)delete process.env['BABEL_EMBEDDING_ENABLE'];else process.env['BABEL_EMBEDDING_ENABLE']=oldOptIn
  }
})

test('embedding failures never echo a provider response that contains a credential', async () => {
  const oldKey=process.env['BABEL_EMBEDDING_API_KEY'];const oldOffline=process.env['BABEL_OFFLINE'];const oldFetch=globalThis.fetch
  try {
    const key='synthetic-embedding-secret';process.env['BABEL_EMBEDDING_API_KEY']=key;delete process.env['BABEL_OFFLINE']
    globalThis.fetch=async()=>new Response(`provider echoed ${key}`,{status:401})
    const provider=createEmbeddingProvider();assert.ok(provider)
    await assert.rejects(provider.embedTexts(['fixture']),error=>error instanceof Error&&/401/.test(error.message)&&!error.message.includes(key))
  } finally {
    globalThis.fetch=oldFetch
    if(oldKey===undefined)delete process.env['BABEL_EMBEDDING_API_KEY'];else process.env['BABEL_EMBEDDING_API_KEY']=oldKey
    if(oldOffline===undefined)delete process.env['BABEL_OFFLINE'];else process.env['BABEL_OFFLINE']=oldOffline
  }
})
}
