// BRPCB-B transport worker. This process runs candidate code, never grades it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspect } from 'node:util';

function restore(value) {
  switch (value.kind) {
    case 'undefined': return undefined;
    case 'null': return null;
    case 'string':
    case 'number':
    case 'boolean': return value.value;
    case 'nan': return NaN;
    case 'infinity': return Infinity;
    case 'negative-infinity': return -Infinity;
    case 'bigint': return BigInt(value.value);
    case 'symbol': return Symbol(value.value);
    case 'function': return () => '2026-02-03';
    case 'date': return new Date(value.value);
    case 'array': return value.value.map(restore);
    case 'object': return Object.fromEntries(Object.entries(value.fields).map(([key, item]) => [key, restore(item)]));
    default: throw new Error('Unsupported input tag');
  }
}

const snapshot = (value) => inspect(value, { depth: 8, sorted: true, customInspect: false, getters: false });
const request = JSON.parse(readFileSync(0, 'utf8'));
if (request.protocol !== 'brpcb-b-input-v1' || !Array.isArray(request.cases)) {
  throw new Error('Invalid supervisor input');
}
const { isPriceExpired } = await import(pathToFileURL(join(process.argv[2], 'src', 'model_tariff.ts')).href);
if (typeof isPriceExpired !== 'function') throw new Error('isPriceExpired must be exported');

const entries = new Map();
const results = [];
for (const vector of request.cases) {
  let entry;
  if (vector.entry_key && entries.has(vector.entry_key)) {
    entry = entries.get(vector.entry_key);
  } else {
    entry = restore(vector.entry);
    if (entry && typeof entry === 'object') Object.freeze(entry);
    if (vector.entry_key) entries.set(vector.entry_key, entry);
  }
  const now = new Date(vector.now_ms);
  const originalEntry = snapshot(entry);
  const originalNow = now.getTime();
  const originalNowObject = snapshot(now);
  let result;
  try {
    const value = isPriceExpired(entry, now);
    result = { id: vector.id, ok: true, return_type: typeof value, value: typeof value === 'boolean' ? value : null };
  } catch (error) {
    result = { id: vector.id, ok: false, error: String(error?.message ?? error).slice(0, 300) };
  }
  result.entry_unchanged = snapshot(entry) === originalEntry;
  result.now_unchanged = now.getTime() === originalNow && snapshot(now) === originalNowObject;
  results.push(result);
}
console.log(JSON.stringify({ protocol: 'brpcb-b-results-v1', results }));
