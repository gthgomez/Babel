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

  it('parses paired positive safe integers', () => {
    const resolved = resolveProductionCliDocumentHostByteCeilings({
      BABEL_RESEARCH_ADMITTED_DOCUMENT_HOST_WIRE_BYTES: '2300000',
      BABEL_RESEARCH_ADMITTED_DOCUMENT_HOST_DECOMPRESSED_BYTES: '2400000',
    })
    assert.deepEqual(resolved, {
      maxDocumentWireBytes: 2_300_000,
      maxDocumentDecompressedBytes: 2_400_000,
    })
  })

  it('rejects fractional, scientific, and non-decimal env values', () => {
    for (const bad of ['2300000.5', '1e6', '0x10', ' 100 ', '-1']) {
      assert.throws(
        () =>
          resolveProductionCliDocumentHostByteCeilings({
            BABEL_RESEARCH_ADMITTED_DOCUMENT_HOST_WIRE_BYTES: bad,
            BABEL_RESEARCH_ADMITTED_DOCUMENT_HOST_DECOMPRESSED_BYTES: '1000',
          }),
        /positive safe integer/,
      )
    }
  })

  it('rejects unsafe integers above MAX_SAFE_INTEGER', () => {
    assert.throws(
      () =>
        resolveProductionCliDocumentHostByteCeilings({
          BABEL_RESEARCH_ADMITTED_DOCUMENT_HOST_WIRE_BYTES: '9007199254740992',
          BABEL_RESEARCH_ADMITTED_DOCUMENT_HOST_DECOMPRESSED_BYTES: '1000',
        }),
      /positive safe integer/,
    )
  })
})
