/** Anthropic native Messages adapter. */
import type { ProviderMessage, ToolDefinition, ToolStreamEvent } from './base.js'
import { normalizeProviderMessages } from './providerMessages.js'
import { NativeMessagesRunner, nativeRecord, type NativeRunnerOptions, type NativeStreamState } from './protocol/native-messages.js'

export class AnthropicApiRunner extends NativeMessagesRunner {
  constructor(options: NativeRunnerOptions = {}) {
    const env = options.env ?? process.env
    super('anthropic', env['BABEL_API_MODEL'] ?? 'claude-sonnet-4-6', { ...options, maxTokens: options.maxTokens ?? Number(env['BABEL_API_TOKENS'] ?? 8096) })
  }
  protected endpoint(_stream: boolean): string { return `${(this.baseUrl ?? 'https://api.anthropic.com/v1').replace(/\/$/, '')}/messages` }
  protected headers(): Record<string, string> { return { 'Content-Type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' } }

  buildNativeToolsWireBody(inputMessages: ProviderMessage[], tools: ToolDefinition[], systemPrompt?: string,
    options: { stream?: boolean; toolChoice?: 'auto' | 'required' } = {}): string {
    const messages = normalizeProviderMessages(inputMessages, '', systemPrompt)
    const systems = messages.filter(message => message.role === 'system').map(message => message.content)
    const contents: Array<{ role: string; content: Record<string, unknown>[] }> = []
    for (const message of messages) {
      if (message.role === 'system') continue
      const blocks: Record<string, unknown>[] = []
      if (message.role === 'tool') {
        if (!message.tool_call_id) throw new Error('[anthropic] Tool result requires a call ID.')
        blocks.push({ type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content })
      } else {
        if (message.content) blocks.push({ type: 'text', text: message.content })
        for (const call of message.tool_calls ?? []) blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input: nativeRecord(JSON.parse(call.function.arguments)) })
      }
      const role = message.role === 'assistant' ? 'assistant' : 'user'
      const previous = contents.at(-1)
      if (previous?.role === role) previous.content.push(...blocks)
      else contents.push({ role, content: blocks })
    }
    return JSON.stringify({ model: this.model, max_tokens: this.maxTokens, stream: options.stream ?? true,
      ...(systems.length ? { system: systems.join('\n\n') } : {}), messages: contents,
      ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
      ...(tools.length ? { tools: tools.map(tool => ({ name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters })), tool_choice: { type: options.toolChoice === 'required' ? 'any' : 'auto' } } : {}) })
  }

  protected bufferedFrames(frame: Record<string, unknown>): Record<string, unknown>[] {
    const blocks = Array.isArray(frame['content']) ? frame['content'].map((content_block, index) => ({ type: 'content_block_start', index, content_block })) : []
    return [{ type: 'message_start', message: frame }, ...blocks,
      { type: 'message_delta', delta: { stop_reason: frame['stop_reason'] }, usage: frame['usage'] }, { type: 'message_stop' }]
  }

  protected consume(frame: Record<string, unknown>, state: NativeStreamState): ToolStreamEvent[] {
    const type = frame['type']
    if (type === 'error') throw new Error('[anthropic] Provider stream error.')
    if (type === 'message_start') {
      const message = nativeRecord(frame['message'])
      if (typeof message['model'] === 'string') state.model = message['model']
      const usage = message['usage'] ? nativeRecord(message['usage']) : {}
      if (typeof usage['input_tokens'] === 'number') state.inputTokens = usage['input_tokens']
      if (typeof usage['output_tokens'] === 'number') state.outputTokens = usage['output_tokens']
    }
    if (type === 'message_delta') {
      const delta = nativeRecord(frame['delta'])
      if (typeof delta['stop_reason'] === 'string') {
        const reason = delta['stop_reason']
        if (!['end_turn', 'tool_use', 'max_tokens', 'stop_sequence'].includes(reason)) throw new Error('[anthropic] Unsupported or blocked terminal reason.')
        state.finishReason = reason === 'max_tokens' ? 'length' : reason === 'tool_use' ? 'tool_calls' : 'stop'
      }
      const usage = frame['usage'] ? nativeRecord(frame['usage']) : {}
      if (typeof usage['output_tokens'] === 'number') state.outputTokens = usage['output_tokens']
    }
    if (type === 'message_stop') state.complete = true
    if (type === 'content_block_start') {
      const block = nativeRecord(frame['content_block'])
      state.outputMaterial += JSON.stringify(block)
      if (block['type'] === 'tool_use') {
        if (typeof frame['index'] !== 'number' || typeof block['id'] !== 'string' || typeof block['name'] !== 'string') throw new Error('[anthropic] Malformed tool identity.')
        state.calls.set(frame['index'], { id: block['id'], name: block['name'], arguments: block['input'] && Object.keys(nativeRecord(block['input'])).length ? JSON.stringify(block['input']) : '' })
      }
      if (block['type'] === 'text' && typeof block['text'] === 'string' && block['text']) return [{ type: 'text_delta', text: block['text'] }]
    }
    if (type === 'content_block_delta') {
      const delta = nativeRecord(frame['delta'])
      state.outputMaterial += JSON.stringify(delta)
      if (delta['type'] === 'text_delta' && typeof delta['text'] === 'string') return [{ type: 'text_delta', text: delta['text'] }]
      if (delta['type'] === 'thinking_delta' && typeof delta['thinking'] === 'string') return [{ type: 'thought_delta', text: delta['thinking'] }]
      if (delta['type'] === 'input_json_delta' && typeof delta['partial_json'] === 'string') {
        const call = typeof frame['index'] === 'number' ? state.calls.get(frame['index']) : undefined
        if (!call) throw new Error('[anthropic] Tool arguments have no matching tool block.')
        call.arguments += delta['partial_json']
      }
    }
    return []
  }
}
