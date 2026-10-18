import { getChatApprovalSession } from './chatApproval.js'
import { TaskMutationOwnership } from './taskMutationOwnership.js'
import type { ExecutionContext } from './executionContext.js'
import type { ChatExecutionScope } from './chatExecutionScope.js'

export interface ChatExecutionContextHost {
  options: { projectRoot: string | null; executionScope?: ChatExecutionScope }
  engineRunId: string
  parity: { eventLog: { thread_id?: string }; turnId: string | null }
  taskAllowance?: { taskOwnerId: string } | null
  taskMutationOwnership: TaskMutationOwnership | null
}

/** Bind only this engine's task owner; inherited async state cannot select it. */
export function buildChatEngineExecutionContext(host: ChatExecutionContextHost): ExecutionContext {
  if (host.options.projectRoot && !host.taskMutationOwnership) {
    host.taskMutationOwnership = new TaskMutationOwnership(
      host.options.projectRoot, host.taskAllowance?.taskOwnerId ?? host.engineRunId,
    )
  }
  return {
    threadId: host.parity.eventLog.thread_id ?? host.engineRunId,
    turnId: host.parity.turnId,
    root: host.options.projectRoot,
    ...(host.options.executionScope ? { executionScope: host.options.executionScope } : {}),
    approvalSession: getChatApprovalSession(),
    indexWritePolicy: host.options.projectRoot ? 'allow' : 'deny',
    ...(host.taskMutationOwnership ? { mutationOwnership: host.taskMutationOwnership } : {}),
  }
}
