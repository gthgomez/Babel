import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { loadGL2Diagnostic1EvidenceSubset } from './testSupport/gL2Diagnostic1EvidenceSubset.js'

describe('G-L2 diagnostic-1 evidence subset (published, immutable)', () => {
  it('pins snapshot provenance and two-source cited passage inventory', () => {
    const {
      provenance,
      sources,
      revisions,
      passages,
      findings,
      terminal_report,
    } = loadGL2Diagnostic1EvidenceSubset()
    assert.equal(
      provenance.source_store_snapshot_sha256,
      'd07551a20d2bc94b5c0d1ccf9e21f4f4b297a677ec7a096c30218736fb5d0e2a',
    )
    assert.match(provenance.extraction_command, /extract-general-g-l2-diagnostic-1-evidence-subset\.mjs/)
    assert.equal(sources.length, 2)
    assert.equal(revisions.length, 2)
    assert.equal(passages.length, 7)
    assert.equal(findings.length, 9)
    assert.equal(terminal_report.terminal_state, 'partial')
    assert.deepEqual(
      terminal_report.citation_passage_ids?.slice().sort(),
      passages.map((p) => p.passage_id).sort(),
    )
    for (const finding of findings) {
      assert.ok(finding.semantic_support?.status)
      assert.ok(finding.question_coverage?.status)
    }
    const mdnRev = revisions.find((r) =>
      sources.some(
        (s) => s.source_id === r.source_id && s.observed_urls[0]?.includes('developer.mozilla.org'),
      ),
    )
    assert.ok(mdnRev)
    assert.equal(mdnRev.completeness, 'truncated')
  })
})
