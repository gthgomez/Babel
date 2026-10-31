/** Gemini native generateContent adapter. */
import { randomUUID } from 'node:crypto'
import { normalizeProviderMessages } from './providerMessages.js'
import type { ProviderMessage, ToolDefinition, ToolStreamEvent } from './base.js'
import { NativeMessagesRunner, nativeRecord, type NativeRunnerOptions, type NativeStreamState } from './protocol/native-messages.js'

export class GeminiApiRunner extends NativeMessagesRunner {
  constructor(options: NativeRunnerOptions = {}) {
    const env = options.env ?? process.env
    super('gemini', env['BABEL_GEMINI_MODEL'] ?? 'gemini-2.5-flash-lite', { ...options,
      maxTokens: options.maxTokens ?? Number(env['BABEL_GEMINI_TOKENS'] ?? 8192), temperature: options.temperature ?? 0 })
  }
  protected endpoint(stream: boolean): string {
    const base = this.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta'
    return `${base.replace(/\/$/, '')}/models/${encodeURIComponent(this.model)}${stream ? ':streamGenerateContent?alt=sse' : ':generateContent'}`
  }
  protected headers(): Record<string, string> { return { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey } }

  buildNativeToolsWireBody(inputMessages: ProviderMessage[], tools: ToolDefinition[], systemPrompt?: string,
    options: { stream?: boolean; toolChoice?: 'auto' | 'required' } = {}): string {
    const messages = normalizeProviderMessages(inputMessages, '', systemPrompt)
    const calls = new Map(messages.flatMap(message => message.tool_calls ?? []).map(call => [call.id, call]))
    const contents: Array<{ role: string; parts: Record<string, unknown>[] }> = []
    const systems = messages.filter(message => message.role === 'system').map(message => message.content)
    for (const message of messages) {
      if (message.role === 'system') continue
      let parts: Record<string, unknown>[]
      if (message.role === 'tool') {
        const call = message.tool_call_id ? calls.get(message.tool_call_id) : undefined
        if (!call) throw new Error('[gemini] Tool result has no matching function call.')
        parts = [{ functionResponse: { id: call.id, name: call.function.name, response: { result: message.content } } }]
      } else if (message.tool_calls?.length) {
        const metadata = message.tool_calls.find(call => call.providerMetadata?.provider === 'gemini')?.providerMetadata
        parts = metadata ? metadata.parts : message.tool_calls.map(call => ({ functionCall: { id: call.id, name: call.function.name, args: nativeRecord(JSON.parse(call.function.arguments)) } }))
      } else parts = [{ text: message.content }]
      const role = message.role === 'assistant' ? 'model' : 'user'
      const last = contents.at(-1)
      if (last?.role === role) last.parts.push(...parts)
      else contents.push({ role, parts })
    }
    return JSON.stringify({ contents, ...(systems.length ? { systemInstruction: { parts: [{ text: systems.join('\n\n') }] } } : {}),
      generationConfig: { maxOutputTokens: this.maxTokens, ...(this.temperature !== undefined ? { temperature: this.temperature } : {}) },
      ...(tools.length ? { tools: [{ functionDeclarations: tools.map(tool => ({ name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters })) }], toolConfig: { functionCallingConfig: { mode: options.toolChoice === 'required' ? 'ANY' : 'AUTO' } } } : {}) })
  }

  protected bufferedFrames(frame: Record<string, unknown>): Record<string, unknown>[] {
    const candidates = Array.isArray(frame['candidates']) ? frame['candidates'].map(value => {
      const candidate = nativeRecord(value)
      return { ...candidate, finishReason: candidate['finishReason'] ?? 'STOP' }
    }) : []
    return [{ ...frame, candidates }]
  }

  protected consume(frame: Record<string, unknown>, state: NativeStreamState): ToolStreamEvent[] {
    if (frame['error']) throw new Error('[gemini] Provider stream error.')
    if (typeof frame['modelVersion'] === 'string') state.model = frame['modelVersion']
    const usage = frame['usageMetadata'] ? nativeRecord(frame['usageMetadata']) : null
    if (usage) {
      if (typeof usage['promptTokenCount'] === 'number') state.inputTokens = usage['promptTokenCount']
      if (typeof usage['candidatesTokenCount'] === 'number') state.outputTokens = usage['candidatesTokenCount'] + (typeof usage['thoughtsTokenCount'] === 'number' ? usage['thoughtsTokenCount'] : 0)
    }
    const events: ToolStreamEvent[] = []
    const candidates = frame['candidates']
    if (!Array.isArray(candidates)) return events
    const candidate = candidates[0] ? nativeRecord(candidates[0]) : {}
    const content = candidate['content'] ? nativeRecord(candidate['content']) : {}
    if (Array.isArray(content['parts'])) for (const rawPart of content['parts']) {
      const part = nativeRecord(rawPart)
      state.outputMaterial += JSON.stringify(part)
      state.parts.push(part)
      if (typeof part['text'] === 'string') events.push({ type: part['thought'] === true ? 'thought_delta' : 'text_delta', text: part['text'] })
      if (part['functionCall']) {
        const call = nativeRecord(part['functionCall'])
        if (typeof call['name'] !== 'string') throw new Error('[gemini] Function name missing.')
        const id = typeof call['id'] === 'string' ? call['id'] : `gemini_${randomUUID()}`
        // Normalize omitted IDs in the retained parts as well as the canonical call.
        part['functionCall'] = { ...call, id }
        const args = nativeRecord(call['args'] ?? {})
        state.calls.set(state.calls.size, { id, name: call['name'], arguments: JSON.stringify(args), providerMetadata: { provider: 'gemini', parts: state.parts } })
      }
    }
    if (typeof candidate['finishReason'] === 'string') {
      if (!['STOP', 'MAX_TOKENS'].includes(candidate['finishReason'])) throw new Error('[gemini] Response blocked or stopped before normal completion.')
      state.finishReason = candidate['finishReason'] === 'MAX_TOKENS' ? 'length' : state.calls.size ? 'tool_calls' : 'stop'
      state.complete = true
    }
    return events
  }
}
