import type { ChatCallbacks } from '../chatEngineContracts.js'
import type { ChatEngineActionExecutorHost } from '../chatEngineContracts.js'
import type { ChatToolAction } from '../chatToolDefinitions.js'

export interface TodoWriteActionContext {
  host: ChatEngineActionExecutorHost
  action: Extract<ChatToolAction, { type: 'todo_write' }>
  tool: string
  target: string
  toolId: number
  meta: { index: number }
  callbacks: ChatCallbacks
}

/** Merge-patch the engine todo map and return the formatted observation. */
export function executeTodoWriteAction(
  ctx: TodoWriteActionContext,
): { index: number; observation: string } {
  const { host, action, tool, target, toolId, meta, callbacks } = ctx
  for (const item of action.todos) {
    host.todos.set(item.id, {
      content: item.content,
      status: item.status,
    })
  }
  const formattedTodos = [...host.todos.entries()]
    .map(([id, t]) => `- [${t.status}] ${t.content} (${id})`)
    .join('\n')
  host.toolCallLog.push({
    tool,
    target,
    detail: `${host.todos.size} todos`,
    index: meta.index,
    exit_code: 0,
  })
  callbacks?.onToolComplete?.(
    toolId,
    `${host.todos.size} todos`,
    undefined,
    0,
  )
  return {
    index: meta.index,
    observation: `### todo_write\nexit_code: 0\n\`\`\`\n${formattedTodos}\n\`\`\``,
  }
}
