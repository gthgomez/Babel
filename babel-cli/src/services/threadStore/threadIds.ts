import { randomBytes } from 'node:crypto';

/** Canonical chat thread id allocation — single source for protocol, engine, and fork paths. */
export function allocateThreadId(): string {
  return `chat-${randomBytes(6).toString('hex')}`;
}