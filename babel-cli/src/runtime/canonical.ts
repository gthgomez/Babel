/**
 * Injective canonical encoding and JSON-safe cloning shared by the runtime
 * projection (P04) and durable command admission (P05).
 *
 * The canonical encoder is the single source of truth for semantic digests: it
 * must never depend on wall clock, random nonce, process id, or input-order, so
 * two identical semantic inputs always produce the same key. It distinguishes
 * every value JSON collapses or cannot represent (NaN, ±Infinity, -0, undefined,
 * BigInt, Map/Set/Date) and rejects functions, symbols, true cycles and
 * inaccessible objects.
 *
 * This module imports no UI/interactive/authority code; it is a pure data
 * utility on the runtime boundary.
 */

import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';

/** Code-unit lexicographic comparison; total and locale-independent. */
export function codeUnitCompare(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

type Canonical = unknown;
export type CanonicalResult = { ok: true; value: Canonical } | { ok: false };

/**
 * Injective canonical encoding. Every value becomes a tagged array so a plain
 * user object/array can never reproduce a special-value tag: strings are
 * `['str', v]`, numbers `['num', v]`, NaN `['num','NaN']`, user objects
 * `['obj', entries]`, etc. Distinguishes values JSON collapses or cannot
 * represent (NaN, ±Infinity, -0, undefined, BigInt, Map/Set/Date) and rejects
 * functions, symbols, true cycles and inaccessible objects. `path` is a
 * recursion stack, so a shared non-cyclic reference is valid.
 */
export function canonicalize(value: unknown, path: WeakSet<object>): CanonicalResult {
  if (value === null) return { ok: true, value: ['null'] };
  const type = typeof value;
  if (type === 'string') return { ok: true, value: ['str', value] };
  if (type === 'boolean') return { ok: true, value: ['bool', value] };
  if (type === 'number') {
    if (Number.isNaN(value)) return { ok: true, value: ['num', 'NaN'] };
    if (value === Infinity) return { ok: true, value: ['num', 'Infinity'] };
    if (value === -Infinity) return { ok: true, value: ['num', '-Infinity'] };
    if (Object.is(value, -0)) return { ok: true, value: ['num', '-0'] };
    return { ok: true, value: ['num', value] };
  }
  if (type === 'undefined') return { ok: true, value: ['undef'] };
  if (type === 'bigint') return { ok: true, value: ['bigint', (value as bigint).toString()] };
  if (type === 'function' || type === 'symbol') return { ok: false };

  const object = value as object;
  if (path.has(object)) return { ok: false };
  path.add(object);
  try {
    if (object instanceof Date) return { ok: true, value: ['date', object.toISOString()] };
    if (object instanceof Map) {
      const entries: unknown[] = [];
      for (const [key, entry] of object.entries()) {
        const canonicalKey = canonicalize(key, path);
        if (!canonicalKey.ok) return { ok: false };
        const canonicalValue = canonicalize(entry, path);
        if (!canonicalValue.ok) return { ok: false };
        entries.push([canonicalKey.value, canonicalValue.value]);
      }
      return { ok: true, value: ['map', entries] };
    }
    if (object instanceof Set) {
      const entries: unknown[] = [];
      for (const entry of object.values()) {
        const canonical = canonicalize(entry, path);
        if (!canonical.ok) return { ok: false };
        entries.push(canonical.value);
      }
      return { ok: true, value: ['set', entries] };
    }
    if (Array.isArray(object)) {
      const entries: unknown[] = [];
      for (const entry of object) {
        const canonical = canonicalize(entry, path);
        if (!canonical.ok) return { ok: false };
        entries.push(canonical.value);
      }
      return { ok: true, value: ['arr', entries] };
    }
    const record = object as Record<string, unknown>;
    const entries: unknown[] = [];
    for (const key of Object.keys(record).sort(codeUnitCompare)) {
      const canonical = canonicalize(record[key], path);
      if (!canonical.ok) return { ok: false };
      entries.push([key, canonical.value]);
    }
    return { ok: true, value: ['obj', entries] };
  } catch {
    return { ok: false };
  } finally {
    path.delete(object);
  }
}

/**
 * Canonical JSON text for a JSON-compatible value, or `null` when the value is
 * not canonically encodable. Stable across key ordering and independent of the
 * caller's object identity.
 */
export function canonicalEncode(value: unknown): string | null {
  const canonical = canonicalize(value, new WeakSet());
  if (!canonical.ok) return null;
  try {
    return JSON.stringify(canonical.value);
  } catch {
    return null;
  }
}

/**
 * SHA-256 over the canonical encoding of `value`. Returns `null` when the value
 * cannot be canonically encoded (callers must fail closed rather than reuse a
 * lossy key).
 */
export function canonicalDigest(value: unknown): string | null {
  let encoded: string | null;
  try {
    encoded = canonicalEncode(value);
  } catch {
    encoded = null;
  }
  if (encoded === null) return null;
  return createHash('sha256').update(encoded, 'utf8').digest('hex');
}

export type CloneResult = { ok: true; value: unknown } | { ok: false };

/** Bound payload nesting so canonicalization/JSON hashing cannot overflow. */
export const MAX_JSON_DEPTH = 64;
/** Per-value clone budget: acceptance is content-deterministic, never order-based. */
export const MAX_JSON_NODES = 100_000;

export interface CloneBudget {
  nodes: number;
}

/**
 * Deep-copy a value into fresh plain JSON data, reading each property once and
 * rejecting anything that is not a JSON value (boxed primitives, class
 * instances, Date/Map/Set/RegExp/Error, functions, symbols, bigint, undefined,
 * NaN/Infinity, cycles, nesting beyond MAX_JSON_DEPTH, or more than
 * MAX_JSON_NODES total). Output objects have a null prototype so an own
 * `__proto__` key stays an own key instead of mutating the prototype. This is
 * what makes the canonical encoding injective: downstream code only ever
 * touches snapshots, never the caller's object.
 */
export function cloneJsonSafe(
  value: unknown,
  path: WeakSet<object>,
  depth = 0,
  budget: CloneBudget = { nodes: 0 },
): CloneResult {
  budget.nodes += 1;
  if (budget.nodes > MAX_JSON_NODES) return { ok: false };
  if (value === null) return { ok: true, value: null };
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return { ok: true, value };
  if (type === 'number') {
    if (Number.isNaN(value) || value === Infinity || value === -Infinity) return { ok: false };
    return { ok: true, value };
  }
  if (type !== 'object') return { ok: false };
  // Facts are plain JSON values. Reject any Proxy outright (native check, no
  // trap invoked) so a stateful trap cannot influence ordering or content.
  if (utilTypes.isProxy(value)) return { ok: false };
  if (depth >= MAX_JSON_DEPTH) return { ok: false };
  const object = value as object;
  // Any repeated reference (shared or cyclic) is not JSON-representable as a
  // tree. Rejecting it prevents DAG expansion/retention amplification and is
  // conservative: the caller's data cannot be projected as canonical JSON.
  if (path.has(object)) return { ok: false };
  path.add(object);
  try {
    if (Array.isArray(object)) {
      const out: unknown[] = [];
      const length = object.length;
      for (let index = 0; index < length; index += 1) {
        // Read through the descriptor so an accessor element is rejected rather
        // than invoked (a stateful getter must not make cloning order-dependent).
        const descriptor = Object.getOwnPropertyDescriptor(object, String(index));
        if (
          descriptor === undefined ||
          typeof descriptor.get === 'function' ||
          typeof descriptor.set === 'function'
        ) {
          return { ok: false };
        }
        const cloned = cloneJsonSafe(descriptor.value, path, depth + 1, budget);
        if (!cloned.ok) return { ok: false };
        out.push(cloned.value);
      }
      return { ok: true, value: out };
    }
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) return { ok: false };
    const out = Object.create(null) as Record<string, unknown>;
    // Note: a hostile `ownKeys` trap can itself allocate an unbounded key array
    // inside Object.keys; that JS-inherent case is a documented residual.
    for (const key of Object.keys(object)) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (
        descriptor === undefined ||
        typeof descriptor.get === 'function' ||
        typeof descriptor.set === 'function'
      ) {
        return { ok: false };
      }
      const cloned = cloneJsonSafe(descriptor.value, path, depth + 1, budget);
      if (!cloned.ok) return { ok: false };
      out[key] = cloned.value;
    }
    return { ok: true, value: out };
  } catch {
    return { ok: false };
  }
}

/**
 * Clone a value to plain JSON, rejecting anything `cloneJsonSafe` rejects.
 * Returns the detached snapshot so callers never persist a live object.
 */
export function toImmutableJson(value: unknown): { ok: true; value: unknown } | { ok: false } {
  const budget: CloneBudget = { nodes: 0 };
  const cloned = cloneJsonSafe(value, new WeakSet(), 0, budget);
  if (!cloned.ok) return { ok: false };
  return cloned;
}
