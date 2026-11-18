// License: Apache-2.0 - see LICENSE
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createRequire } from 'node:module'

const root = new URL('../../', import.meta.url)
const { load } = createRequire(new URL('babel-cli/package.json', root))('js-yaml')
const workflowText = readFileSync(new URL('.github/workflows/trusted-control-plane.yml', root), 'utf8')
const workflow = load(workflowText)
const guide = readFileSync(new URL('docs/guides/REVIEW_MARKERS.md', root), 'utf8')

test('review docs promise only reachable audit triggers', () => {
  assert.equal(workflow.on.issue_comment, undefined, 'comments must not be able to restart privileged audits')
  const lifecycle = workflow.on.pull_request_target.types
  for (const event of ['opened', 'synchronize', 'reopened', 'ready_for_review', 'converted_to_draft', 'labeled', 'unlabeled']) {
    assert.ok(lifecycle.includes(event), `audit must refresh on ${event}`)
    assert.ok(guide.includes(`\`${event}\``), `review guide must name reachable event ${event}`)
  }
  assert.doesNotMatch(guide, /re-runs its merge audit when the\s+repository owner comments/i)
  assert.match(guide, /does \*\*not\*\* start, cancel, or rerun any\s+workflow/i)
  assert.match(guide, /do not promise or retry a\s+comment-triggered rerun/i)
  assert.match(guide, /successful\*\*\s+`Public Release Gate` `pull_request` run completes \(`conclusion == 'success'`/i)
  assert.match(workflow.jobs['merge-audit-after-release-gate'].if, /workflow_run\.conclusion == 'success'/)
  assert.match(workflow.jobs['merge-audit-after-release-gate'].if, /workflow_run\.event == 'pull_request'/)
})

test('the unreachable comment-only job cannot be silently re-enabled', () => {
  const refresh = workflow.jobs['rerun-after-review']
  assert.ok(refresh, 'the documented refresh job remains present as an inert boundary')
  assert.match(refresh.if, /github\.event_name == 'issue_comment'/)
  const product = load(readFileSync(new URL('.github/workflows/typecheck.yml', root), 'utf8'))
  const productTypes = product.on.pull_request.types
  assert.equal(productTypes.includes('ready_for_review'), false)
  assert.equal(productTypes.includes('converted_to_draft'), false)
})
