import {appendThreadEvent,type ThreadEventLog} from './threadEventLog.js'
import {classifyChatTaskIntent} from './chatEngineTaskIntent.js'
import {beginUserSubmission,emptyTurnCounters,isAmendmentPrompt,isStatusPrompt,type TurnRuntimeSnapshot} from './turnRuntime.js'

/** Persist a conservative branch boundary without deleting retained events. */
export function recordTaskContinuityReset(log:ThreadEventLog):void{
  const turnId=log.events.at(-1)?.turn_id
  if(turnId)appendThreadEvent(log,{kind:'policy_decision',turn_id:turnId,source:'thread_rewind',action:'reset_task_continuity',message:'History was rewound; a fresh objective is required before execution continuation.'})
}

/** Rebuild user intent only. Receipts, authority, effects and completion use their own journals. */
export function restoreTurnRuntime(log:ThreadEventLog):TurnRuntimeSnapshot|null{
  let previous:TurnRuntimeSnapshot|null=null
  for(const event of log.events){
    if(event.kind==='policy_decision'&&event.source==='thread_rewind'&&event.action==='reset_task_continuity')previous=null
    if(event.kind!=='turn_started'||event.context_copy)continue
    // Legacy continuedTask also marked read-only status presentations. It is
    // not evidence that the caller explicitly requested execution continuation.
    const continueTask=event.requestedContinueTask??(event.continuedTask===true&&!isStatusPrompt(event.task)&&!isAmendmentPrompt(event.task))
    previous=beginUserSubmission({
      userInput:event.task,projectRoot:event.projectRoot,model:event.model,
      ...(event.executionScope?{executionScope:event.executionScope}:{}),
      // Old logs did not retain explicit READ_ONLY host overrides. Recover
      // their objective conservatively; prose cannot prove a lost policy.
      operation:event.requestedOperation??'READ_ONLY',
      ...(event.requestedTaskIntent!==undefined?{taskIntent:event.requestedTaskIntent}:{}),
      continueTask,classifyIntent:classifyChatTaskIntent,previous,
    })
  }
  return previous?{...previous,...emptyTurnCounters()}:null
}
