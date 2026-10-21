import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveProductionCliDocumentHostByteCeilings } from './productionCliDocumentHostBudget.js'

describe('productionCliDocumentHostBudget', () => {
  it('returns undefined when env unset', () => {
    assert.equal(resolveProductionCliDocumentHostByteCeilings({}), undefined)
  })

  it('requires both wire and decompressed env vars', () => {
    assert.throws(
      () =>
        resolveProductionCliDocumentHostByteCeilings({
          BABEL_RESEARCH_ADMITTED_DOCUMENT_HOST_WIRE_BYTES: '2300000',
        }),
      /both BABEL_RESEARCH_ADMITTED_DOCUMENT_HOST/,
    )
  })

  it('parses paired positive integers', () => {
    const resolved = resolveProductionCliDocumentHostByteCeilings({
      BABEL_RESEARCH_ADMITTED_DOCUMENT_HOST_WIRE_BYTES: '2300000',
      BABEL_RESEARCH_ADMITTED_DOCUMENT_HOST_DECOMPRESSED_BYTES: '2400000',
    })
    assert.deepEqual(resolved, {
      maxDocumentWireBytes: 2_300_000,
      maxDocumentDecompressedBytes: 2_400_000,
    })
  })
})
