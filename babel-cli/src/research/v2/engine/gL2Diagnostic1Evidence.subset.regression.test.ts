import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { loadGL2Diagnostic1EvidenceSubset } from './testSupport/gL2Diagnostic1EvidenceSubset.js'

describe('G-L2 diagnostic-1 evidence subset (published, immutable)', () => {
  it('pins snapshot provenance and two-source cited passage inventory', () => {
    const {
      provenance,
      plan_revision,
      model_completions,
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
    assert.ok(provenance.read_only_verification_artifacts?.build_stdout_log)
    assert.equal(plan_revision.questions.length, 4)
    assert.equal(plan_revision.plan_revision_id, terminal_report.plan_revision_id)
    assert.equal(model_completions.length, 4)
    for (const op of model_completions) {
      assert.equal(op.settlement, 'succeeded')
      assert.ok(op.provider_invoke_diagnostics.output_digest)
      assert.equal(op.provider_invoke_diagnostics.normalized_finish_reason, 'NATURAL_COMPLETION')
    }
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
      assert.ok(finding.semantic_support?.rationale)
      assert.ok(finding.assertion_text)
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
