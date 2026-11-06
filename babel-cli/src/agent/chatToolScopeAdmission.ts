import type {ChatCallbacks,ChatEngineActionExecutorHost} from './chatEngineContracts.js'
import {chatActionToolName,chatActionTarget,type ChatToolAction} from './chatToolDefinitions.js'
import type {BlockedReport} from '../schemas/agentContracts.js'
import {analyzeTaskShape,isReadOnlyTaskFrame,stripFencedCodeBodies,TASK_REQUEST_PREFIX_SOURCE,type TaskOperation} from '../config/chatTaskClass.js'

export {requireProjectRoot} from './chatExecutionScope.js'
export const PROJECT_REQUIRED_MESSAGE='PROJECT_REQUIRED: Select and authorize a project before using tools.'

/** A read-only scope cannot deliver a requested execution-and-artifact workflow.
 * This is a controller-owned refusal, never permission to bypass a no-edit rule.
 */
export function readOnlyExecutionConflictReport(input:{
  taskText:string
  operation:TaskOperation
  executionProfile:string
  presentationOnly?:boolean
}):BlockedReport|null {
  if(input.operation!=='READ_ONLY'||input.executionProfile==='plan'||input.presentationOnly)return null
  const prose=stripFencedCodeBodies(input.taskText)
  if(isReadOnlyTaskFrame(prose)||analyzeTaskShape(prose).operation==='READ_ONLY')return null
  const executionProse=prose.replace(/\b(?:do\s+not|don't|never)\s+(?:(?:actually|really)\s+)?(?:execute|run)\b[^.;!?\n]*/gi,' ')
  const executionDirective=new RegExp(`(?:^|[.;!?\\n]\\s*|\\b(?:then|afterwards|and\\s+then)\\s+)${TASK_REQUEST_PREFIX_SOURCE}(?:(?:actually|really)\\s+)?(?:execute|run)\\b`,'i')
  const requiresExecution=executionDirective.test(executionProse)||/\b(?:actually|really)\s+(?:execute|run)\b|\b(?:execute|run)\b[^.!?\n]*\b(?:actual|observed)\s+(?:output|results?|exits?|exit\s+codes?)\b/i.test(executionProse)
  if(!requiresExecution)return null
  return {
    schema_version:1,status:'BLOCKED',reason_code:'unsupported_operation',cause_class:'harness',
    reason:'The requested execution and output creation were not performed: this submission was narrowed to read-only authority.',
    missing:'An accepted task scope that permits the requested execution and output changes',
    checked:[{action:'task scope admission',target:'READ_ONLY',finding:'The accepted submission permits inspection only; no execution or output creation was dispatched.'}],
    next_steps:['Clarify the permitted output changes, or request a read-only explanation.'],
  }
}

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
