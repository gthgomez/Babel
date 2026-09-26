/** Offered-tool names are not in the event stream, so that row stays unavailable. */

import {
  subscribeSessionEventObservation,
  type SessionEvent,
} from '../../agent/sessionEvents.js'

export interface ShellInspectorContext {
  readonly selectedModel: string
  readonly sessionTokens?: { readonly tokens: number; readonly source: string } | null
}

export interface ShellToolState {
  readonly name: string
  readonly state: 'on' | 'off' | 'unknown'
}

export interface ShellInspectorView {
  readonly tools: readonly string[]
  readonly toolStates: readonly ShellToolState[]
  readonly context: readonly string[]
  readonly meter: { readonly used: number; readonly limit: number } | null
}

/** Render a captured tri-state without inventing a value. */
export function renderTriState(value: boolean | null | undefined): string {
  if (value === true) return 'yes'
  if (value === false) return 'no'
  return 'unknown'
}

const UNAVAILABLE_OFFERED =
  'Offered (request capture): unavailable — request records tool_schema_hash only'

function latest<T extends SessionEvent['kind']>(
  events: readonly SessionEvent[],
  kind: T,
): Extract<SessionEvent, { kind: T }> | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event && event.kind === kind) return event as Extract<SessionEvent, { kind: T }>
  }
  return undefined
}

/** Build the request-scoped inspector rows from captured events. */
export function buildShellInspectorView(
  events: readonly SessionEvent[],
  context: ShellInspectorContext,
): ShellInspectorView {
  const receipt = latest(events, 'model_input_receipt')
  const turnId = receipt?.turn_id ?? null
  const turnEvents = turnId ? events.filter((event) => event.turn_id === turnId) : events

  const proposed = [
    ...new Set(
      turnEvents
        .filter(
          (event): event is Extract<SessionEvent, { kind: 'tool_proposed' }> =>
            event.kind === 'tool_proposed',
        )
        .map((event) => event.tool_name),
    ),
  ]
  const capabilities = turnEvents.filter(
    (event): event is Extract<SessionEvent, { kind: 'capability_binding_receipt' }> =>
      event.kind === 'capability_binding_receipt',
  )

  const tools: string[] = [
    proposed.length > 0
      ? `Proposed (observed): ${proposed.join(', ')}`
      : 'Proposed (observed): none this turn',
  ]
  if (capabilities.length > 0) {
    for (const capability of capabilities) {
      tools.push(
        `Permitted ${capability.capability}: advertised=${renderTriState(capability.advertised)} ` +
          `authorized=${renderTriState(capability.authorized)} ` +
          `effective=${renderTriState(capability.effective)}`,
      )
    }
  } else {
    tools.push('Permitted capability: unknown (no capability_binding_receipt)')
  }
  tools.push(UNAVAILABLE_OFFERED)

  const toolStates: ShellToolState[] = []
  for (const capability of capabilities) {
    toolStates.push({
      name: capability.capability,
      state: capability.effective === true ? 'on' : capability.effective === false ? 'off' : 'unknown',
    })
  }
  for (const name of proposed) {
    if (toolStates.some((tool) => tool.name === name)) continue
    toolStates.push({ name, state: 'unknown' })
  }

  const requestContext: string[] = []
  if (receipt) {
    requestContext.push(`Sent model: ${receipt.sent_model_id}`)
    requestContext.push(`Requested: ${receipt.requested_model_id}`)
    requestContext.push(`Normalized: ${receipt.normalized_model_id}`)
    requestContext.push(
      receipt.context_limit_tokens !== undefined && receipt.context_limit_tokens !== null
        ? `Request limit: ${receipt.context_limit_tokens} tokens (${receipt.context_limit_source ?? 'unknown source'})`
        : 'Request limit: unknown',
    )
  } else {
    requestContext.push('No provider request yet.')
  }
  requestContext.push(
    context.sessionTokens
      ? `Session estimate: ${context.sessionTokens.tokens} tokens (${context.sessionTokens.source})`
      : 'Session estimate: unknown',
  )

  const limit = receipt?.context_limit_tokens
  const meter =
    context.sessionTokens && typeof limit === 'number' && limit > 0
      ? { used: context.sessionTokens.tokens, limit }
      : null

  return { tools, toolStates, context: requestContext, meter }
}

/** Bounded, presentation-only buffer of canonical session events. */
const PINNED_KINDS = new Set<SessionEvent['kind']>(['model_input_receipt', 'capability_binding_receipt'])

export class ShellInspectorStore {
  private events: SessionEvent[] = []
  private pinned: SessionEvent[] = []
  private activeSessionId: string | undefined

  constructor(private readonly maxEvents = 256) {}

  observe(event: SessionEvent): void {
    if (PINNED_KINDS.has(event.kind)) {
      this.pinned = this.pinned.filter((existing) => !samePinnedFact(existing, event))
      this.pinned.push(event)
    }
    this.events.push(event)
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents)
    }
  }

  /**
   * Bind the inspector to the active session/thread. `undefined` means no
   * session is established yet, in which case the view must show the explicit
   * "no provider request" state rather than any buffered prior-session facts.
   */
  setActiveSession(sessionId: string | undefined): void {
    this.activeSessionId = sessionId
  }

  getActiveSessionId(): string | undefined {
    return this.activeSessionId
  }

  reset(): void {
    this.events = []
    this.pinned = []
  }

  getEvents(): readonly SessionEvent[] {
    return this.events
  }

  /** Subscribe to the existing canonical session-event bus. */
  attach(onChange?: (event: SessionEvent) => void): () => void {
    return subscribeSessionEventObservation(
      (event) => {
        this.observe(event)
        onChange?.(event)
      },
      { id: 'north-star-inspector' },
    )
  }

  build(context: ShellInspectorContext): ShellInspectorView {
    // Scope strictly to the active session so a prior session's request facts
    // can never leak into the current inspector.
    if (this.activeSessionId === undefined) {
      return buildShellInspectorView([], context)
    }
    return buildShellInspectorView(this.eventsForActiveSession(), context)
  }

  private eventsForActiveSession(): SessionEvent[] {
    const sessionId = this.activeSessionId
    const live = this.events.filter((event) => event.session_id === sessionId)
    const liveIds = new Set(live.map((event) => event.event_id))
    const kept = this.pinned.filter(
      (event) => event.session_id === sessionId && !liveIds.has(event.event_id),
    )
    return [...kept, ...live]
  }
}

function samePinnedFact(left: SessionEvent, right: SessionEvent): boolean {
  if (left.kind !== right.kind || left.session_id !== right.session_id || left.turn_id !== right.turn_id) {
    return false
  }
  if (left.kind === 'capability_binding_receipt' && right.kind === 'capability_binding_receipt') {
    return left.capability === right.capability
  }
  return true
}
