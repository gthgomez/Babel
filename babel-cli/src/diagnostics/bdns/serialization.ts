/** Secret-safe, deterministic serialization for BDNS payloads. */

import { redactEvidenceValue } from '../../utils/redaction.js'

function toSerializable(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'bigint') return `${value.toString()}n`
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.stack ? { stack: value.stack } : {}),
    }
  }
  if (Buffer.isBuffer(value)) {
    return { type: 'Buffer', base64: value.toString('base64') }
  }
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map((item) => toSerializable(item, seen))
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      result[key] = toSerializable((value as Record<string, unknown>)[key], seen)
    }
    seen.delete(value)
    return result
  }
  return value
}

/** Convert arbitrary observer data to redacted, JSON-safe data. */
export function toSafeBdnsValue(value: unknown): unknown {
  return redactEvidenceValue(toSerializable(value, new WeakSet<object>()))
}

/** Serialize an observation without throwing for non-JSON-native values. */
export function stringifyBdns(value: unknown): string {
  return JSON.stringify(toSafeBdnsValue(value))
}
