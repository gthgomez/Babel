import assert from 'node:assert/strict'
import test from 'node:test'
import { renderJourneyHtml } from './harness-journey-html.js'
import { startJourneyService } from './harness-journey-service.js'

test('HTML fixture is rendered with visible semantic headers and accurate cells, without script or network', async t => {
  if (process.env['BABEL_JOURNEY_HTML_TEST'] !== '1') { t.skip('Browser qualification requires an explicitly admitted local browser workload'); return }
  const service = await startJourneyService({ sources: { blocked: 'A browser request would be recorded here.' } })
  t.after(() => service.close())
  const good = await renderJourneyHtml(`<!doctype html><html lang="en"><head><title>Memory comparison</title></head><body>
<h1>Memory comparison</h1><table><caption>Current requirements</caption><thead><tr><th scope="col">Option</th><th scope="col">Memory</th></tr></thead><tbody><tr><th scope="row">Aspen</th><td>6 GiB</td></tr><tr><th scope="row">Birch</th><td>4 GiB</td></tr></tbody></table>
<section><h2>Conclusion</h2><p>Birch needs 2 GiB less memory.</p></section>
<script>document.querySelector('h1').textContent='Script executed'</script><img src="${service.baseUrl}/sources/blocked"></body></html>`)
  assert.equal(good.heading, 'Memory comparison')
  assert.deepEqual(good.columnHeaders, ['Option', 'Memory'])
  assert.deepEqual(good.rows, [['Aspen', '6 GiB'], ['Birch', '4 GiB']])
  assert.equal(good.visible, true)
  assert.match(good.conclusion, /2 GiB/)
  assert.equal(service.snapshot().sourceReads.length, 0)
  const bad = await renderJourneyHtml('<html><head><title>Looks fine</title></head><body><h1>Memory</h1><table style="display:none"><tr><td>Aspen</td><td>6</td></tr></table></body></html>')
  assert.equal(bad.visible, false)
  assert.deepEqual(bad.columnHeaders, [])
})
