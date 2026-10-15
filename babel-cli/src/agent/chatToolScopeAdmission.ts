import type {ChatCallbacks,ChatEngineActionExecutorHost} from './chatEngineContracts.js'
import {chatActionToolName,chatActionTarget,type ChatToolAction} from './chatToolDefinitions.js'
import type {BlockedReport} from '../schemas/agentContracts.js'

export {requireProjectRoot} from './chatExecutionScope.js'
export const PROJECT_REQUIRED_MESSAGE='PROJECT_REQUIRED: Select and authorize a project before using tools.'

/** Receipt of the controller's actual scope admission check, with no invented tool checks. */
export function conversationScopeRequiredReport():BlockedReport {
  return {
    schema_version:1,status:'BLOCKED',reason:PROJECT_REQUIRED_MESSAGE,
    reason_code:'permission_denied',cause_class:'harness',
    missing:'An explicitly selected and authorized project',
    checked:[{action:'execution scope admission',target:'conversation',finding:'The current conversation grants no project effects; no project tool was dispatched.'}],
    next_steps:['Select the project explicitly, then continue this objective.'],
  }
}

/** Settle a proposed tool as denied before any cache, environment or dispatch access. */
export function denyConversationAction(
  host: Pick<ChatEngineActionExecutorHost,'toolCallLog'|'activeSubmissionGeneration'|'isSubmissionCurrent'|'settleStaleActionResult'>,
  action: ChatToolAction,
  callbacks: ChatCallbacks,
  index: number,
  ownerGeneration=host.activeSubmissionGeneration,
): {index:number;observation:string;stop:true} {
  const tool=chatActionToolName(action)
  const target=chatActionTarget(action)
  const message=PROJECT_REQUIRED_MESSAGE
  const stale=()=>({...host.settleStaleActionResult(tool,target,index,'parent submission superseded before scope denial settled'),stop:true as const})
  if(!host.isSubmissionCurrent(ownerGeneration))return stale()
  const toolId=callbacks.onToolStart?.(tool,target)??-1
  if(!host.isSubmissionCurrent(ownerGeneration))return stale()
  host.toolCallLog.push({tool,target,index,error:message,exit_code:1})
  callbacks.onToolComplete?.(toolId,message,message,1)
  return {index,observation:message,stop:true}
}

/** Explain actual denied admissions, without presenting them as completed filesystem checks. */
export function conversationProjectRequiredReport(
  calls:readonly Pick<ChatEngineActionExecutorHost['toolCallLog'][number],'tool'|'target'>[],
):BlockedReport {
  if(calls.length===0)throw new Error('A project-required report needs a denied admission receipt')
  return {
    schema_version:1,
    status:'BLOCKED',
    reason:PROJECT_REQUIRED_MESSAGE,
    reason_code:'permission_denied',
    cause_class:'harness',
    missing:'An explicitly selected and authorized project',
    checked:calls.slice(0,50).map(call=>({
      action:call.tool,
      target:call.target||'project scope',
      finding:'Denied before dispatch: conversation scope has no project authority',
    })),
    next_steps:['Select the project explicitly, then continue this objective.'],
  }
}
