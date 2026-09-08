import { createHash } from 'node:crypto';
import type { NeutralLabReceipt, LabMetric } from './contracts.js';

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

export function hashLabValue(value: unknown): string {
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

export function buildNeutralReceipt(input: Omit<NeutralLabReceipt, 'RECEIPT_HASH'>): NeutralLabReceipt {
  return { ...input, RECEIPT_HASH: hashLabValue(input) };
}

export function validateNeutralReceipt(value: unknown): asserts value is NeutralLabReceipt {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('receipt must be an object');
  const receipt = value as Partial<NeutralLabReceipt>;
  if (typeof receipt.RECEIPT_HASH !== 'string' || receipt.RECEIPT_HASH.length !== 64) throw new Error('receipt hash is invalid');
  const { RECEIPT_HASH: actual, ...unsigned } = receipt;
  if (hashLabValue(unsigned) !== actual) throw new Error('receipt hash does not match its content');
  for (const key of ['EXPERIMENT_ID', 'PAIR_ID', 'RUN_ID', 'HARNESS', 'PROVIDER', 'REQUESTED_MODEL', 'TASK_ID', 'REPOSITORY', 'BASE_SHA'] as const) {
    if (typeof receipt[key] !== 'string' || receipt[key].length === 0) throw new Error(`receipt field ${key} is invalid`);
  }
}

export function metricDelta(left: LabMetric, right: LabMetric): LabMetric {
  return typeof left === 'number' && typeof right === 'number' ? right - left : 'UNKNOWN';
}
