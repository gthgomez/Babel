import assert from 'node:assert/strict'
import test from 'node:test'
import { gradeJourneyCode } from './harness-journey-code-oracle.js'

const image = 'docker.io/library/node:22.19.0-bookworm-slim@sha256:cff78eb5aa1cf27dc2b6aeea9d31366415a43e9a9ea0ddec00d780b2b66fad0f'
const fixtures: Record<string, { path: string; source: string }> = {
  J05: { path: 'lib/total.mjs', source: 'export function total(items) { return items.reduce((sum, item) => sum + item.price * item.quantity, 0) }\n' },
  J06: { path: 'lib/invoice.mjs', source: `const DISCOUNT_RATE = 0.1;
function roundToCents(amount) { return Math.round((amount + Number.EPSILON) * 100) / 100; }
export function invoiceTotal(items) {
  const subtotal = items.reduce((sum, item) => {
    if (item.quantity < 0) throw new RangeError('Quantity must not be negative');
    return sum + item.price * item.quantity;
  }, 0);
  return roundToCents(subtotal * (1 - DISCOUNT_RATE));
}
` },
}

for (const [id, fixture] of Object.entries(fixtures)) {
  test(`${id} pure-code oracle executes the candidate in pinned Docker`, async () => {
    const bytes = Buffer.from(fixture.source)
    assert.equal(await gradeJourneyCode(id, async path => {
      assert.equal(path, fixture.path)
      return { bytes, evidenceRef: `${id}/fixture` }
    }, image), 'pass')
  })
}
