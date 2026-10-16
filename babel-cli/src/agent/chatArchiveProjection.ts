import type { ThreadEventLog, ThreadEvent } from './threadEventLog.js';

/** Retained history is independent of the compacted provider request context. */
export function projectChatArchive(log: ThreadEventLog): Record<string, unknown>[] {
  const routes = new Map<string, Extract<ThreadEvent, { kind: 'turn_started' }>>();
  const visibleTerminals = new Set(log.events.filter(event => event.kind === 'turn_ended' && event.response).map(event => event.turn_id));
  const messages: Record<string, unknown>[] = [];
  for (const event of log.events) {
    if (event.context_copy) continue;
    if (event.kind === 'turn_started') routes.set(event.turn_id, event);
    let message: Record<string, unknown>;
    switch (event.kind) {
      case 'user_message':
        message = {
          role: 'user', content: event.content,
          ...(event.name !== undefined ? {name:event.name} : {}),
          ...(event.provenance !== undefined ? {provenance:event.provenance} : {}),
          ...(event.authoritative !== undefined ? {authoritative:event.authoritative} : {}),
        };
        break;
      case 'assistant_message':
        message = {
          role: 'assistant', content: event.content,
          ...(visibleTerminals.has(event.turn_id) && !event.name ? { archive_kind: 'model_candidate' } : {}),
          ...(event.name !== undefined ? { name: event.name } : {}),
          ...(event.provenance !== undefined ? { provenance: event.provenance } : {}),
          ...(event.authoritative !== undefined ? { authoritative: event.authoritative } : {}),
        };
        break;
      case 'assistant_tool_calls':
        message = { role: 'assistant', content: event.content, tool_calls: event.tool_calls };
        break;
      case 'tool_result':
        message = {
          role: 'tool', content: event.content, name: event.tool_name,
          tool_call_id: event.tool_call_id,
          ...(event.exit_code !== undefined ? { exit_code: event.exit_code } : {}),
        };
        break;
      case 'turn_ended':
        if (!event.response) continue;
        message = {
          role: 'assistant', content: event.response.content, archive_kind: 'terminal_response',
          response_kind: event.response.kind, terminal_status: event.status,
          ...(event.outcome !== undefined ? { terminal_outcome: event.outcome } : {}),
          ...(event.reason_code !== undefined ? { reason_code: event.reason_code } : {}),
        };
        break;
      default:
        continue;
    }
    const route = routes.get(event.turn_id);
    messages.push({
      archive_kind: event.kind, ...message, archive_source: 'thread_events', source_event_id: event.event_id,
      thread_id: event.thread_id, turn_id: event.turn_id, item_id: event.item_id,
      seq: event.seq, timestamp: event.ts,
      ...(route ? { route: { provider: route.provider, model: route.model, source: 'turn_started' } } : {}),
    });
  }
  return messages;
}
