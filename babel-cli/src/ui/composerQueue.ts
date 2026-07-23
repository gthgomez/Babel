/**
 * FIFO queue for composer follow-up messages while the agent is busy (C2).
 *
 * Codex/claude-code queue user input during in-flight turns; this module holds
 * plain-text messages until the REPL drains them after the current task completes.
 */

export const DEFAULT_COMPOSER_QUEUE_MAX = 20;

export class ComposerQueue {
  private items: string[] = [];

  constructor(private readonly maxDepth = DEFAULT_COMPOSER_QUEUE_MAX) {}

  get length(): number {
    return this.items.length;
  }

  snapshot(): readonly string[] {
    return [...this.items];
  }

  /** Returns false when the queue is at capacity. */
  enqueue(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) return false;
    if (this.items.length >= this.maxDepth) return false;
    this.items.push(trimmed);
    return true;
  }

  dequeue(): string | undefined {
    return this.items.shift();
  }

  drain(): string[] {
    const out = [...this.items];
    this.items = [];
    return out;
  }

  clear(): void {
    this.items = [];
  }
}

/** Session-scoped queue shared by PromptInput and the REPL loop. */
const sessionQueue = new ComposerQueue();

export function getComposerQueue(): ComposerQueue {
  return sessionQueue;
}

export function enqueueComposerMessage(text: string): boolean {
  return sessionQueue.enqueue(text);
}

export function dequeueComposerMessage(): string | undefined {
  return sessionQueue.dequeue();
}

export function getComposerQueueSnapshot(): readonly string[] {
  return sessionQueue.snapshot();
}

export function drainComposerQueue(): string[] {
  return sessionQueue.drain();
}

export function clearComposerQueue(): void {
  sessionQueue.clear();
}