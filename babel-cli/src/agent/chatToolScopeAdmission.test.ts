import assert from 'node:assert/strict'
import test from 'node:test'
import {denyConversationAction} from './chatToolScopeAdmission.js'
import type {ChatEngineActionExecutorHost} from './chatEngineContracts.js'

test('a denial from a superseded owner cannot append evidence to its successor',()=>{
  let generation=1
  const calls:ChatEngineActionExecutorHost['toolCallLog']=[]
  const host={
    activeSubmissionGeneration:1,
    toolCallLog:calls,
    isSubmissionCurrent:(owner:number)=>owner===generation,
    settleStaleActionResult:(_tool:string,_target:string,index:number)=>({index,observation:'stale owner'}),
  }
  const result=denyConversationAction(host,{type:'read_file',path:'fixture.txt'},
    {onToolStart:()=>{generation=2;return 0}},0,1)
  assert.equal(calls.length,0)
  assert.equal(result.observation,'stale owner')
})
