export const BABEL_RUNTIME_PROTOCOL_VERSION = 1;

export const BABEL_RUNTIME_EVENT_TYPES = [
  'session.started',
  'session.completed',
  'plan.created',
  'qa.verdict',
  'policy.decision',
  'tool.requested',
  'tool.completed',
  'verification.decision',
] as const;

export type BabelRuntimeEventType = typeof BABEL_RUNTIME_EVENT_TYPES[number];

export interface BabelRuntimeEvent {
  protocol_version: typeof BABEL_RUNTIME_PROTOCOL_VERSION;
  event_type: BabelRuntimeEventType;
  payload: Record<string, unknown>;
}

export interface BabelRuntimeProtocolContract {
  schema_version: 1;
  protocol_id: 'babel.runtime.v1';
  protocol_version: typeof BABEL_RUNTIME_PROTOCOL_VERSION;
  event_types: readonly BabelRuntimeEventType[];
  required_event_fields: readonly string[];
  guarantees: readonly string[];
}

export function makeRuntimeEvent(
  eventType: BabelRuntimeEventType,
  payload: Record<string, unknown> = {},
): BabelRuntimeEvent {
  return {
    protocol_version: BABEL_RUNTIME_PROTOCOL_VERSION,
    event_type: eventType,
    payload,
  };
}

export function buildRuntimeProtocolContract(): BabelRuntimeProtocolContract {
  return {
    schema_version: 1,
    protocol_id: 'babel.runtime.v1',
    protocol_version: BABEL_RUNTIME_PROTOCOL_VERSION,
    event_types: BABEL_RUNTIME_EVENT_TYPES,
    required_event_fields: ['protocol_version', 'event_type', 'payload'],
    guarantees: [
      'Events are append-only observations and do not grant extra tool authority.',
      'Policy decisions and verification decisions are emitted as structured runtime events when available.',
      'Consumers should treat event payloads as audit data, not as instructions.',
    ],
  };
}
