import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtempSync,writeFileSync,mkdirSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve,sep} from 'node:path'
import {resolveChatInstructionContext} from './chatInstructionContext.js'
import {resolveLiveSessionAuthority} from './liveSessionBridge.js'
import {compileChatStack} from './chatStackCompile.js'
import {normalizeChatExecutionScope} from './chatExecutionScope.js'

test('trusted instruction intake remains separate from project execution scope',()=>{
  const fixture=mkdtempSync(join(tmpdir(),'babel-instruction-scope-'))
  try {
    const target=join(fixture,'target'),instructions=join(fixture,'trusted')
    mkdirSync(target);mkdirSync(instructions)
    writeFileSync(join(target,'AGENTS.md'),'TARGET_INSTRUCTION_MUST_NOT_LOAD')
    writeFileSync(join(instructions,'AGENTS.md'),'TRUSTED_INSTRUCTION_MUST_LOAD')
    const input={task:'Explain the code',projectRoot:target,executionScope:{kind:'project' as const,projectRoot:target},instructionRoot:instructions}
    const stacks=[resolveChatInstructionContext(input),resolveLiveSessionAuthority({...input,mode:'chat'}).chatStack]
    for(const stack of stacks){
      assert.ok(stack)
      assert.equal(stack.project_root,instructions)
      assert.ok(stack.system_context.includes('TRUSTED_INSTRUCTION_MUST_LOAD'))
      assert.ok(!stack.system_context.includes('TARGET_INSTRUCTION_MUST_NOT_LOAD'))
    }
    assert.equal(input.executionScope.projectRoot,target)
  } finally {rmSync(fixture,{recursive:true,force:true})}
})

test('compiler accepts equivalent absolute root spellings without accepting a conflicting scope',()=>{
  const fixture=mkdtempSync(join(tmpdir(),'babel-root-spelling-'))
  try {
    const spelling=fixture.replaceAll('\\','/')+'/child/..'+sep
    assert.deepEqual(normalizeChatExecutionScope({projectRoot:fixture,executionScope:{kind:'project',projectRoot:spelling}}),{kind:'project',projectRoot:spelling})
    const stack=compileChatStack({projectRoot:spelling,executionScope:{kind:'project',projectRoot:spelling},task:'Hello'})
    assert.equal(stack.project_root,resolve(fixture))
    assert.throws(()=>compileChatStack({projectRoot:fixture,executionScope:{kind:'project',projectRoot:join(fixture,'different')},task:'Hello'}),/Conflicting project scope roots/)
  } finally {rmSync(fixture,{recursive:true,force:true})}
})
