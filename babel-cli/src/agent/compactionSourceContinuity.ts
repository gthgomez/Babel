import { sha256Canonical } from '../acceptance/canonical.js'
import type { ChatMessage } from './chatCompaction.js'
import { rebuildProviderMessagesFromEvents, type ThreadEventLog } from './threadEventLog.js'
import type { SessionEventLog } from './sessionEvents.js'

interface OwnedEvent {
  readonly eventId: string
  readonly digest: string
}

/** Ephemeral transaction evidence; never persisted or treated as task authority. */
export interface CompactionOwnedEvents {
  readonly thread: readonly OwnedEvent[]
  readonly session: readonly OwnedEvent[]
}

const EMPTY: CompactionOwnedEvents = { thread: [], session: [] }

function captureOwned(events: readonly { event_id: string }[], ids: readonly string[]): OwnedEvent[] {
  return ids.map(eventId => {
    const matches = events.filter(event => event.event_id === eventId)
    if (matches.length !== 1) throw new Error('compaction_owned_event_missing_or_duplicated')
    return Object.freeze({ eventId, digest: sha256Canonical(matches[0]) })
  })
}

export function captureCompactionOwnedEvents(
  thread: ThreadEventLog, session: SessionEventLog,
  threadIds: readonly string[], sessionIds: readonly string[],
): CompactionOwnedEvents {
  return Object.freeze({
    thread: Object.freeze(captureOwned(thread.events, threadIds)),
    session: Object.freeze(captureOwned(session.events, sessionIds)),
  })
}

function ownedEventsMatch(events: readonly { event_id: string }[], owned: readonly OwnedEvent[]): boolean {
  return owned.every(record => {
    const matches = events.filter(event => event.event_id === record.eventId)
    return matches.length === 1 && sha256Canonical(matches[0]) === record.digest
  })
}

/** Fence the actual live source across async summarization and atomic commit. */
export function createCompactionSourceFence(input: {
  getConversation: () => ChatMessage[]
  thread: ThreadEventLog
  session: SessionEventLog
}): {
  isCurrent: (owned?: CompactionOwnedEvents) => boolean
  isConversationCurrent: () => boolean
  updateConversation: (update: () => void) => boolean
} {
  let expected = input.getConversation()
  let conversationDigest = sha256Canonical(expected)
  const sourceDigest = (owned: CompactionOwnedEvents): string => {
    const threadIds = new Set(owned.thread.map(record => record.eventId))
    const sessionIds = new Set(owned.session.map(record => record.eventId))
    const events = input.thread.events.filter(event => !threadIds.has(event.event_id))
    return sha256Canonical({
      messages: rebuildProviderMessagesFromEvents({ ...input.thread, events }),
      task: events.filter(event => event.kind === 'turn_started'
        || event.kind === 'task_attempt_admitted' || event.kind === 'task_acceptance_amended'),
      // Committed compaction controls installed lineage; usage/budget records do not.
      session: input.session.events.filter(event => event.kind === 'compaction_committed' && !sessionIds.has(event.event_id)),
    })
  }
  const originalSourceDigest = sourceDigest(EMPTY)
  const isConversationCurrent = (): boolean => {
    try {
      return input.getConversation() === expected && sha256Canonical(expected) === conversationDigest
    } catch {
      return false
    }
  }
  const isCurrent = (owned: CompactionOwnedEvents = EMPTY): boolean => {
    try {
      return isConversationCurrent()
        && ownedEventsMatch(input.thread.events, owned.thread) && ownedEventsMatch(input.session.events, owned.session)
        && sourceDigest(owned) === originalSourceDigest
    } catch {
      return false
    }
  }
  return {
    isCurrent,
    isConversationCurrent,
    updateConversation: update => {
      if (!isCurrent()) return false
      update()
      expected = input.getConversation()
      conversationDigest = sha256Canonical(expected)
      return true
    },
  }
}
