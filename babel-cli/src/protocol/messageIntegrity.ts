/**
 * Byte-integrity hashing for remote turn.submit payloads.
 *
 * Distinct from promptFingerprint, which hashes system-prompt / policy
 * provenance and does not prove user-message bytes survived transport.
 */

import { createHash } from 'node:crypto';

export interface MessageIntegrity {
  byteLength: number;
  sha256: string;
}

/** SHA-256 of the UTF-8 encoding of `text`. */
export function hashUserMessage(text: string): MessageIntegrity {
  const bytes = Buffer.from(text, 'utf8');
  return {
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export function integrityEqual(a: MessageIntegrity, b: MessageIntegrity): boolean {
  return a.byteLength === b.byteLength && a.sha256 === b.sha256;
}
