import assert from 'node:assert/strict'
import test from 'node:test'
import { parseAgentActions } from './actions.js'
import { ChatToolActionSchema, buildChatToolDefinitions } from './chatToolDefinitions.js'
import { mapAgentActionToToolCalls } from './toolExecutor.js'
import { ExecutorTurnSchema } from '../schemas/agentContracts.js'
import { ToolCallRequestSchema } from '../localTools.js'

test('directory continuation survives Chat and Deep contracts and dispatch mapping', () => {
  const revision = 'a'.repeat(64); const after = 'file-name.txt'
  const chat = ChatToolActionSchema.parse({ type: 'list_dir', path: 'src', after, revision })
  assert.deepEqual(chat, { type: 'list_dir', path: 'src', after, revision })
  const parsed = parseAgentActions({ actions: [{ tool: 'directory_list', path: 'src', after, revision }] })
  assert.deepEqual(parsed[0], chat)
  assert.deepEqual(mapAgentActionToToolCalls(parsed[0]!), [{ kind: 'execute', request: { tool: 'directory_list', path: 'src', after, revision } }])
  const deep = ExecutorTurnSchema.parse({ type: 'tool_call', thinking: 'Continue listing', tool: 'directory_list', path: 'src', after, revision })
  assert.equal(deep.type, 'tool_call')
  if (deep.type !== 'tool_call') throw new Error('unexpected completion')
  const { type: _type, thinking: _thinking, ...fields } = deep
  assert.deepEqual(ToolCallRequestSchema.parse(fields), { tool: 'directory_list', path: 'src', after, revision })
  const schema = buildChatToolDefinitions().find(tool => tool.function.name === 'list_dir')?.function.parameters as { properties?: Record<string, unknown> } | undefined
  assert.ok(schema?.properties?.['after']); assert.ok(schema.properties['revision'])
})
