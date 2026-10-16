import assert from 'node:assert/strict'
import test from 'node:test'
import {isAbsolute,resolve} from 'node:path'
import {normalizeChatExecutionScope,requireProjectRoot,assertConversationRestoreScope} from './chatExecutionScope.js'
import {availableChatToolNames} from './chatToolAvailability.js'
import {compileChatStack} from './chatStackCompile.js'

test('conversation scope never derives a project from ambient roots',()=>{
  const options={executionScope:{kind:'conversation' as const},projectRoot:null}
  assert.deepEqual(normalizeChatExecutionScope(options),{kind:'conversation'})
  assert.throws(()=>requireProjectRoot(options),/PROJECT_REQUIRED/)
  assert.throws(()=>normalizeChatExecutionScope({projectRoot:null}),/explicit/i)
  assert.throws(()=>normalizeChatExecutionScope({...options,projectRoot:resolve('project')}),/conflict/i)
  const root=resolve('project')
  assert.ok(isAbsolute(root))
  assert.deepEqual(normalizeChatExecutionScope({projectRoot:root}),{kind:'project',projectRoot:root})
  assert.equal(requireProjectRoot({projectRoot:root}),root)
})

test('conversation scope removes every advertised tool regardless of task or environment',()=>{
  const names=['read_file','read_range','run_command','write_file','apply_patch','sub_agent','web_search','lsp','unknown_future_tool']
  assert.deepEqual(availableChatToolNames(names,{
    executionScope:{kind:'conversation'},operation:'MUTATING',hostFallbackAllowed:true,
    env:{BABEL_PROJECT_ROOT:resolve('ambient'),BABEL_READ_ONLY:'0'},
  }),[])
})

test('conversation instruction compilation uses builtins and records no project',()=>{
  const stack=compileChatStack({projectRoot:null,executionScope:{kind:'conversation'},task:'Hello'})
  assert.equal(stack.project_root,null)
  assert.ok(stack.system_context.includes('Babel'))
  assert.ok(stack.selected_entries.every(entry=>entry.path==='(builtin)'))
  assert.equal(stack.context_error,undefined)
  assert.throws(()=>compileChatStack({projectRoot:null,task:'Hello'}),/explicit/i)
})

test('missing and project archive identities never become confirmed conversation scope',()=>{
  const scope={projectRoot:null,executionScope:{kind:'conversation' as const}}
  assert.throws(()=>assertConversationRestoreScope(null,scope),/SESSION_SCOPE_UNKNOWN/)
  assert.throws(()=>assertConversationRestoreScope({events:[{kind:'turn_started',projectRoot:resolve('project')}]},scope),/SESSION_SCOPE_UNKNOWN/)
  assert.throws(()=>assertConversationRestoreScope({events:[{kind:'turn_started',projectRoot:null}]},scope),/SESSION_SCOPE_UNKNOWN/)
  assert.doesNotThrow(()=>assertConversationRestoreScope({events:[{kind:'turn_started',projectRoot:null,executionScope:{kind:'conversation'}}]},scope))
})
