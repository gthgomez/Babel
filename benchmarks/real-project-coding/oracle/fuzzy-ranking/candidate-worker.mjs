// Candidate execution only. This child never receives expected values or emits a verdict.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const stringify = JSON.stringify.bind(JSON);
const arrayIsArray = Array.isArray.bind(Array);
const freeze = Object.freeze.bind(Object);
const write = process.stdout.write.bind(process.stdout);
const NativeRangeError = RangeError;
const payload = JSON.parse(readFileSync(0, 'utf8'));
const results = [];
function decode(encoded) {
  if (encoded.type === 'undefined') return undefined;
  if (encoded.type === 'null') return null;
  if (encoded.type === 'bigint') return BigInt(encoded.value);
  if (encoded.type === 'special_number') return Number(encoded.value);
  return encoded.value;
}
function snapshot(value) {
  return stringify(value, (_key, item) => {
    if (typeof item === 'bigint') return { type: 'bigint', value: String(item) };
    if (typeof item === 'number' && !Number.isFinite(item)) return { type: 'special_number', value: String(item) };
    if (item === undefined) return { type: 'undefined' };
    return item;
  });
}
try {
  const root = process.argv[2];
  const { rankCandidates } = await import(pathToFileURL(join(root, 'src/rankCandidates.ts')).href);
  const { fuzzyScore } = await import(pathToFileURL(join(root, 'src/fuzzy.ts')).href);
  for (const request of payload.requests) {
    const args = request.args;
    const candidates = request.method === 'rank' ? freeze([...args.candidates]) : undefined;
    const options = args.options === undefined ? undefined
      : freeze(Object.fromEntries(Object.entries(args.options).map(([key, value]) => [key, decode(value)])));
    const before = snapshot({ candidates, options });
    let outcome;
    try {
      const value = request.method === 'score' ? fuzzyScore(args.query, args.target)
        : rankCandidates(args.query, candidates, options);
      const isArray = arrayIsArray(value);
      const projected = request.method === 'rank' && isArray
        ? value.map((row) => ({ item: row?.item, score: row?.score, index: row?.index }))
        : value;
      // JSON alone would erase boxed primitives and can invoke toJSON. Record
      // the actual JavaScript types before serialization as part of each call.
      const fieldTypes = request.method === 'rank' && isArray
        ? projected.map((row) => ({ item: typeof row.item, score: typeof row.score, index: typeof row.index }))
        : undefined;
      outcome = { kind: 'return', value: projected, value_type: typeof value,
        is_array: isArray, field_types: fieldTypes };
    } catch (error) {
      outcome = { kind: 'error', name: String(error?.name), range_error: error instanceof NativeRangeError };
    }
    results.push({ id: request.id, ...outcome, inputs_unchanged: before === snapshot({ candidates, options }) });
  }
  write(stringify({ protocol: 'brpcb-fuzzy-values-v1', results },
    (_key, value) => Object.is(value, -0) ? { type: 'negative_zero' } : value) + '\n');
} catch (error) {
  write(stringify({ protocol: 'brpcb-fuzzy-values-v1', load_error: String(error?.message ?? error), results }) + '\n');
}
