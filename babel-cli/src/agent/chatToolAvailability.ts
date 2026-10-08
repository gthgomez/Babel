import type { ToolDefinition } from '../runners/base.js'
import type { TaskOperation } from '../config/chatTaskClass.js'
import { filterChatToolNamesForTask } from './chatReadOnly.js'
import { canUseChatLsp } from './chatLspPolicy.js'

export interface ChatToolAvailability {
  operation?: TaskOperation | undefined
  requiredVerifiers?: readonly string[] | undefined
  hostFallbackAllowed?: boolean | undefined
  env?: NodeJS.ProcessEnv | undefined
}

/** Project task scope and host-process authority into every model protocol. */
export function availableChatToolNames(names: readonly string[], policy: ChatToolAvailability): string[] {
  const env = policy.env ?? process.env
  const taskNames = filterChatToolNamesForTask(names, policy.operation, policy.requiredVerifiers ?? [], env)
  const allowLsp = canUseChatLsp({ hostFallbackAllowed: policy.hostFallbackAllowed === true,
    ...(policy.operation ? { operation: policy.operation } : {}), env })
  return [...new Set(taskNames)].filter(name => name !== 'lsp' || allowLsp)
}

/** Native schemas and generated text manuals share the same name projection. */
export function availableChatTools(tools: ToolDefinition[], policy: ChatToolAvailability): ToolDefinition[] {
  const names = new Set(availableChatToolNames(tools.map(tool => tool.function.name), policy))
  return tools.filter(tool => names.has(tool.function.name)).map(tool => {
    if (policy.operation !== 'READ_ONLY' || !['run_command', 'test_run'].includes(tool.function.name)) return tool
    const parameters = tool.function.parameters as { properties?: Record<string, unknown> }
    const properties = Object.fromEntries(Object.entries(parameters.properties ?? {})
      .filter(([name]) => name !== 'background' && name !== 'detached'))
    properties['command'] = { type: 'string', enum: [...new Set(policy.requiredVerifiers?.map(command => command.trim()) ?? [])] }
    return { ...tool, function: { ...tool.function,
      description: 'Run one of the required verifier commands in the foreground within the governed project scope.',
      parameters: { ...tool.function.parameters, properties, additionalProperties: false },
    } }
  })
}
