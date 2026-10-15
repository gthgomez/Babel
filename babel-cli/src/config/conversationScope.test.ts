import assert from 'node:assert/strict'
import test from 'node:test'
import {conversationScopeRequested,resolveRunScope} from './conversationScope.js'
test('bootstrap recognizes conversation scope before argument parsing, including duplicate narrowing flags',()=>{
  assert.equal(conversationScopeRequested(['run','--execution-scope','conversation','--','Hello']),true)
  assert.equal(conversationScopeRequested(['run','--execution-scope=conversation','--execution-scope','project']),true)
  assert.equal(conversationScopeRequested(['run','--','--execution-scope=conversation']),false)
  assert.equal(conversationScopeRequested(['run','Hello']),false)
})
test('explicit conversation scope cannot fall through project, pipeline or unsupported mode paths',()=>{
  assert.equal(resolveRunScope({},{}),'project')
  assert.equal(resolveRunScope({executionScope:'conversation'},{}),'conversation')
  assert.throws(()=>resolveRunScope({executionScope:'unknown'},{}),/Invalid execution scope/)
  for(const extra of [{mode:'deep'},{mode:'plan'},{mode:'manual'},{useChatPipeline:true},{project:'x'},{projectRoot:'/tmp/project'},{executionProfile:'dev_local'},{orchestrator:'v9'},{sessionId:'x'}])assert.throws(()=>resolveRunScope({executionScope:'conversation',...extra},{}),/Conversation scope/)
  assert.throws(()=>resolveRunScope({executionScope:'conversation'},{BABEL_LITE_WORKER_CHAIN:'1'}),/Conversation scope/)
})
