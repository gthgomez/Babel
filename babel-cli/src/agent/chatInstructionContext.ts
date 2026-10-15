import { compileChatStack, resolveStackBudgetForClass, type ChatCompiledStack } from './chatStackCompile.js'
import { resolveChatTaskClass, type RequestedTaskOperation } from '../config/chatTaskClass.js'
import {normalizeChatExecutionScope,type ChatExecutionScope} from './chatExecutionScope.js'

/** One compiler contract for direct, prepared and reused Chat engines. */
export function resolveChatInstructionContext(options: {
  task: string
  projectRoot: string | null
  executionScope?: ChatExecutionScope
  instructionRoot?: string
  model?: string
  operation?: RequestedTaskOperation
  compiledChatStack?: ChatCompiledStack
}): ChatCompiledStack {
  const scope=normalizeChatExecutionScope(options)
  if(scope.kind==='conversation'&&(options.instructionRoot||(options.compiledChatStack&&options.compiledChatStack.project_root!==null)))throw new Error('Conflicting project instruction context in conversation scope')
  const stack = options.compiledChatStack ?? compileChatStack({
    // Compiler scope describes instruction intake, not the execution target.
    ...(scope.kind==='conversation'?{executionScope:scope}:{}),
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
