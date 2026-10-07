import { compileChatStack, resolveStackBudgetForClass, type ChatCompiledStack } from './chatStackCompile.js'
import { resolveChatTaskClass, type RequestedTaskOperation } from '../config/chatTaskClass.js'

/** One compiler contract for direct, prepared and reused Chat engines. */
export function resolveChatInstructionContext(options: {
  task: string
  projectRoot: string
  instructionRoot?: string
  model?: string
  operation?: RequestedTaskOperation
  compiledChatStack?: ChatCompiledStack
}): ChatCompiledStack {
  const stack = options.compiledChatStack ?? compileChatStack({
    projectRoot: options.instructionRoot ?? options.projectRoot,
    task: options.task,
    promptBudgetChars: resolveStackBudgetForClass(resolveChatTaskClass({
      taskText: options.task, operation: options.operation,
    })),
    ...(options.model ? { modelId: options.model } : {}),
  })
  if (stack.context_error) throw new Error(`[chat] ${stack.context_error}`)
  return stack
}
