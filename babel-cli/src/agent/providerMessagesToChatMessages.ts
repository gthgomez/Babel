import type { ProviderMessage } from '../runners/base.js';
import type { ChatMessage } from './chatToolDefinitions.js';

/** Mirror provider context for legacy loop paths; never load the display archive. */
export function providerMessagesToChatMessages(messages: ProviderMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.name !== undefined ? {name:message.name} : {}),
    ...(message.provenance !== undefined ? {provenance:message.provenance} : {}),
    ...(message.authoritative !== undefined ? {authoritative:message.authoritative} : {}),
    ...(message.compactionCandidate ? {compactionCandidate:true as const} : {}),
    ...(message.tool_call_id !== undefined ? {toolCallId:message.tool_call_id} : {}),
    ...(message.role === 'tool' && message.name !== undefined ? {toolName:message.name} : {}),
  }));
}

/** Transcript-only history has no invented event or tool-cycle identities. */
export function legacyArchiveToChatMessages(records: Record<string, unknown>[],options:{includeSystem?:boolean} = {}): ChatMessage[] {
  return records.flatMap(record => {
    if (!['user','assistant','tool',...(options.includeSystem?['system']:[])].includes(String(record['role'])) || typeof record['content'] !== 'string') return [];
    return [{role:record['role'] as ChatMessage['role'],content:record['content'],
      ...(record['compactionCandidate'] === true ? {compactionCandidate:true as const} : {}),
      ...(typeof record['toolCallId'] === 'string' ? {toolCallId:record['toolCallId']} : {}),
      ...(typeof record['name'] === 'string' ? {name:record['name']} : {}),
      ...(record['provenance']==='controller'||record['provenance']==='model'||record['provenance']==='mixed'?{provenance:record['provenance']}:{}),
      ...(typeof record['authoritative'] === 'boolean' ? {authoritative:record['authoritative']} : {}),
      ...(typeof record['toolName'] === 'string' ? {toolName:record['toolName']} : {})}];
  });
}
