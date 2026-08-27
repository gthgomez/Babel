/** Bounded asynchronous multi-subscriber observation plumbing for BDNS. */

import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'
import type { BdnsHealth, BdnsObservation } from './types.js'

export interface BdnsSubscriberOptions<T> {
  id?: string
  maxQueue?: number
  isCritical?: (observation: BdnsObservation<T>) => boolean
  onObservation: (observation: BdnsObservation<T>) => void | Promise<void>
}

export interface BdnsObservationBusOptions {
  maxQueue?: number
  onSubscriberFailure?: (subscriberId: string, error: unknown) => void
}

export interface BdnsPublishResult {
  observerSequence: number
  queued: number
  dropped: number
  coalesced: number
}

interface Subscriber<T> {
  id: string
  maxQueue: number
  isCritical: (observation: BdnsObservation<T>) => boolean
  onObservation: (observation: BdnsObservation<T>) => void | Promise<void>
  queue: BdnsObservation<T>[]
  draining: Promise<void> | null
  active: boolean
}

const DEFAULT_QUEUE_SIZE = 256
const DEFAULT_CLOSE_TIMEOUT_MS = 1_000

function monotonicTimeMs(): number {
  return performance.timeOrigin + performance.now()
}

function isHighFrequency(kind: string): boolean {
  return kind === 'canonical_event' || kind === 'workspace_watcher_signal'
}

/**
 * Create a bounded observation bus. Publication only enqueues and schedules a
 * drain; subscriber work is always performed asynchronously.
 */
export function createBdnsObservationBus<T>(
  options: BdnsObservationBusOptions = {},
): BdnsObservationBus<T> {
  return new BdnsObservationBus(options)
}

export class BdnsObservationBus<T> {
  private readonly subscribers = new Map<string, Subscriber<T>>()
  private readonly defaultMaxQueue: number
  private readonly onSubscriberFailure: ((subscriberId: string, error: unknown) => void) | undefined
  private observerSequence = 0
  private closed = false
  private published = 0
  private delivered = 0
  private dropped = 0
  private coalesced = 0
  private subscriberFailures = 0
  private lastError: string | undefined

  constructor(options: BdnsObservationBusOptions = {}) {
    this.defaultMaxQueue = Math.max(1, Math.floor(options.maxQueue ?? DEFAULT_QUEUE_SIZE))
    this.onSubscriberFailure = options.onSubscriberFailure
  }

  /** Add an independent subscriber and return a deterministic unsubscribe operation. */
  subscribe(options: BdnsSubscriberOptions<T>): () => void {
    if (this.closed) throw new Error('BDNS observation bus is closed')
    const id = options.id ?? randomUUID()
    if (this.subscribers.has(id)) throw new Error(`BDNS subscriber already exists: ${id}`)
    const subscriber: Subscriber<T> = {
      id,
      maxQueue: Math.max(1, Math.floor(options.maxQueue ?? this.defaultMaxQueue)),
      isCritical: options.isCritical ?? (() => false),
      onObservation: options.onObservation,
      queue: [],
      draining: null,
      active: true,
    }
    this.subscribers.set(id, subscriber)
    return () => this.unsubscribe(id)
  }

  /** Stop accepting new events and dispose subscribers after bounded draining. */
  async close(timeoutMs = DEFAULT_CLOSE_TIMEOUT_MS): Promise<void> {
    this.closed = true
    for (const subscriber of this.subscribers.values()) subscriber.active = false
    const drains = [...this.subscribers.values()]
      .map((subscriber) => subscriber.draining)
      .filter((drain): drain is Promise<void> => drain !== null)
    if (drains.length === 0) return
    await Promise.race([
      Promise.allSettled(drains).then(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, timeoutMs))),
    ])
    this.subscribers.clear()
  }

  /** Wait for currently queued work, bounded by timeout. */
  async flush(timeoutMs = DEFAULT_CLOSE_TIMEOUT_MS): Promise<boolean> {
    const drains = [...this.subscribers.values()]
      .map((subscriber) => subscriber.draining)
      .filter((drain): drain is Promise<void> => drain !== null)
    if (drains.length === 0) return true
    let completed = false
    await Promise.race([
      Promise.allSettled(drains).then(() => { completed = true }),
      new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, timeoutMs))),
    ])
    return completed
  }

  /** Publish a bounded observation envelope. */
  publish(input: Omit<BdnsObservation<T>, 'observerSequence' | 'wallTime' | 'monotonicTimeMs'>): BdnsPublishResult {
    if (this.closed) return { observerSequence: this.observerSequence, queued: 0, dropped: 1, coalesced: 0 }
    const observation: BdnsObservation<T> = {
      ...input,
      observerSequence: this.observerSequence++,
      wallTime: new Date().toISOString(),
      monotonicTimeMs: monotonicTimeMs(),
    }
    this.published += 1
    let queued = 0
    let dropped = 0
    let coalesced = 0
    for (const subscriber of this.subscribers.values()) {
      if (!subscriber.active) continue
      const result = this.enqueue(subscriber, observation)
      queued += result.queued
      dropped += result.dropped
      coalesced += result.coalesced
      if (result.queued > 0) this.scheduleDrain(subscriber)
    }
    this.dropped += dropped
    this.coalesced += coalesced
    return { observerSequence: observation.observerSequence, queued, dropped, coalesced }
  }

  /** Snapshot degradation and delivery counters for operator diagnostics. */
  health(): BdnsHealth {
    return {
      evidenceState: this.subscriberFailures > 0
        ? 'observer_failed'
        : this.dropped > 0 || this.coalesced > 0
          ? 'events_dropped'
          : 'complete',
      published: this.published,
      delivered: this.delivered,
      dropped: this.dropped,
      coalesced: this.coalesced,
      subscriberFailures: this.subscriberFailures,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    }
  }

  private enqueue(subscriber: Subscriber<T>, observation: BdnsObservation<T>): { queued: number; dropped: number; coalesced: number } {
    if (subscriber.queue.length < subscriber.maxQueue) {
      subscriber.queue.push(observation)
      return { queued: 1, dropped: 0, coalesced: 0 }
    }
    const highFrequency = isHighFrequency(observation.kind)
    const existing = highFrequency
      ? subscriber.queue.findIndex((item) => item.kind === observation.kind)
      : -1
    if (existing >= 0) {
      subscriber.queue[existing] = observation
      return { queued: 0, dropped: 0, coalesced: 1 }
    }
    const nonCritical = subscriber.queue.findIndex((item) => !subscriber.isCritical(item))
    if (nonCritical >= 0 && !subscriber.isCritical(observation)) {
      subscriber.queue.splice(nonCritical, 1)
      subscriber.queue.push(observation)
      return { queued: 1, dropped: 1, coalesced: 0 }
    }
    return { queued: 0, dropped: 1, coalesced: 0 }
  }

  private scheduleDrain(subscriber: Subscriber<T>): void {
    if (subscriber.draining !== null) return
    subscriber.draining = Promise.resolve().then(async () => {
      while (subscriber.active && subscriber.queue.length > 0) {
        const observation = subscriber.queue.shift()
        if (!observation) continue
        try {
          await subscriber.onObservation(observation)
          this.delivered += 1
        } catch (error) {
          subscriber.active = false
          this.subscriberFailures += 1
          this.lastError = error instanceof Error ? error.message : String(error)
          this.onSubscriberFailure?.(subscriber.id, error)
          subscriber.queue.length = 0
        }
      }
      subscriber.draining = null
    }).catch((error) => {
      subscriber.active = false
      this.subscriberFailures += 1
      this.lastError = error instanceof Error ? error.message : String(error)
      this.onSubscriberFailure?.(subscriber.id, error)
      subscriber.draining = null
    })
  }

  private unsubscribe(id: string): void {
    const subscriber = this.subscribers.get(id)
    if (!subscriber) return
    subscriber.active = false
    subscriber.queue.length = 0
    this.subscribers.delete(id)
  }
}
