/** Oracle calibration only. Scripted host observations do not qualify Babel. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { z } from 'zod'
import { evaluateJourneyOutput, type JourneyOracleInput } from './harness-journey-oracle.js'
import { captureJourneyGitState, readJourneyCorpus, prepareJourneyFixture } from './harness-journey-fixtures.js'
import { startJourneyService } from './harness-journey-service.js'
import { renderJourneyHtml } from './harness-journey-html.js'
import { assessmentDigest } from './harness-journey-checks.js'

const corpus = await readJourneyCorpus(fileURLToPath(new URL('../../../benchmarks/harness-journeys/development.json', import.meta.url)))
const digest = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex')
const correctMap = '# Repository map\n- apps/web/main.mjs\n- packages/api/server.mjs\n'
const correctCsv = 'product,gross,refunds,net\nA,150,20,130\nB,80,10,70\n'

for (const spec of corpus.journeys) {
  test(`${spec.id} oracle accepts reference evidence and rejects a broken requirement`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'babel-journey-calibration-'))
    const definition = corpus.fixtures[spec.fixtureId]!
    const prepared = await prepareJourneyFixture(spec, definition, join(root, 'cell'))
    const input: JourneyOracleInput = {
      id: spec.id, candidateRoot: prepared.candidateRoot, baseline: prepared.files,
      readOutput: async path => ({ bytes: await readFile(join(prepared.candidateRoot, path)), evidenceRef: `calibration-snapshot:${path}` }),
      answer: '', events: [], artifact: null, service: null, citations: [], blind: null,
    }
    const write = (path: string, text: string) => writeFile(join(prepared.candidateRoot, path), text)
    const artifact = async (path: string, text: string): Promise<void> => {
      await write(path, text); input.artifact = { path, sha256: digest(text), delivered: true }
    }
    const sources = Object.fromEntries(Object.entries(definition.files).filter(([path]) => path.startsWith('sources/')).map(([path, text]) => [path.slice('sources/'.length).replace(/\.txt$/, ''), text]))
    const service = await startJourneyService({ sources, dropFirstCreateReply: spec.id === 'J10' })
    t.after(() => service.close())
    const sourceIds = Object.keys(sources)
    for (const id of sourceIds) await (await fetch(`${service.baseUrl}/sources/${id}`)).text()
    input.citations = sourceIds.map(sourceId => ({ sourceId, quote: sources[sourceId]!.split('\n')[0]! }))
    const patch = (value: unknown) => fetch(`${service.baseUrl}/records/demo-42`, { method: 'PATCH', headers: { 'x-operation-id': `operation-${spec.id}` }, body: JSON.stringify(value) })
    switch (spec.id) {
      case 'J01': input.answer = 'A failed attempt can test an assumption.\n\nIts evidence narrows the next decision.\n\nKeep the lesson and state what remains uncertain.'; break
      case 'J02': input.answer = 'Aspen v1 needed 8 GiB; current v2 needs 6 GiB, versus Birch v2 at 4 GiB. The summary is stale.'; break
      case 'J03': input.answer = 'src/client moved to apps/web/main.mjs; src/server moved to packages/api/server.mjs.'; break
      case 'J04':
        await write('lib/invoice.mjs', 'export const invoice = cents => (cents / 100).toFixed(2)\n')
        await write('app/customer.mjs', "import {invoice} from '../lib/invoice.mjs'\nexport const due = () => invoice(1234)\n")
        await write('app/admin.mjs', "import {invoice} from '../lib/invoice.mjs'\nexport const due = () => invoice(5000)\n")
        break
      case 'J05':
        await write('lib/total.mjs', 'export const total = items => items.reduce((n, i) => n + i.price * i.quantity, 0)\n')
        input.events = [{ sequence: 1, kind: 'verifier', target: 'lib/total.mjs', candidateDigest: digest(await readFile(join(prepared.candidateRoot, 'lib/total.mjs'))), exitCode: 0 }]
        break
      case 'J06':
        await write('lib/invoice.mjs', 'export const invoiceTotal = items => {if(items.some(i => i.quantity < 0)) throw Error(); return Math.round(items.reduce((n,i)=>n+i.price*i.quantity,0)*0.9*100)/100}\n')
        input.events = [{ sequence: 1, kind: 'verifier', target: 'lib/invoice.mjs', candidateDigest: prepared.files[0]!.sha256, exitCode: 1 }, { sequence: 2, kind: 'verifier', target: 'lib/invoice.mjs', candidateDigest: digest(await readFile(join(prepared.candidateRoot, 'lib/invoice.mjs'))), exitCode: 0 }]
        break
      case 'J07':
      case 'J16': {
        input.answer = spec.id === 'J16' ? 'Prefer Birch' : 'Birch needs 2 GiB less memory than Aspen.'
        await artifact('report.html', `<!doctype html><html lang="en"><head><title>Memory comparison</title></head><body><h1>Memory comparison</h1><table><caption>Requirements</caption><tr><th scope="col">Option</th><th scope="col">Memory</th></tr><tr><th scope="row">Aspen</th><td>6 GiB</td></tr><tr><th scope="row">Birch</th><td>4 GiB</td></tr></table><section><h2>Conclusion</h2><p>${input.answer}</p></section></body></html>`)
        if (spec.id === 'J16') {
          input.latestConclusion = input.answer
          input.events = [{ sequence: 1, kind: 'amendment' }]
          await patch({ conclusion: input.latestConclusion })
          await (await fetch(`${service.baseUrl}/records/demo-42`)).json()
        }
        break
      }
      case 'J08': await artifact('summary.csv', correctCsv); input.answer = 'Total net revenue is 200.'; break
      case 'J09': await patch({ status: 'reviewed' }); await (await fetch(`${service.baseUrl}/records/demo-42`)).json(); break
      case 'J10':
        await assert.rejects(fetch(`${service.baseUrl}/followups`, { method: 'POST', headers: { 'x-operation-id': 'followup-42' }, body: '{"caseId":"demo-42"}' }))
        input.answer = `Created ${z.object({ id: z.string() }).parse(await (await fetch(`${service.baseUrl}/operations/followup-42`)).json()).id}.`
        break
      case 'J11':
        await write('REPO_MAP.md', correctMap)
        input.events = [{ sequence: 0, kind: 'submission_started', submissionId: 'submission-1' }, { sequence: 1, kind: 'status_steering', objectiveHash: 'objective', budgetRemainingUsd: 1 }, { sequence: 2, kind: 'compaction' }, { sequence: 3, kind: 'resume', objectiveHash: 'objective', budgetRemainingUsd: 0.9 }, { sequence: 4, kind: 'submission_final', submissionId: 'submission-1' }]
        input.answer = 'Corrected REPO_MAP.md with the actual source paths.'; break
      case 'J12':
        await write('REPO_MAP.md', correctMap); input.variant = 'ambiguous'
        input.events = [{ sequence: 1, kind: 'clarification_answer' }, { sequence: 2, kind: 'tool_result', effect: 'write' }]; break
      case 'J13':
        await write('REPO_MAP.md', correctMap)
        input.events = [{ sequence: 1, kind: 'tool_result', tool: 'read_file', target: 'apps/web/main.mjs' }, { sequence: 2, kind: 'tool_result', tool: 'read_file', target: 'packages/api/server.mjs' }]; break
      case 'J14':
        await artifact('summary.csv', correctCsv); input.answer = 'Net 200.'
        input.events = [{ sequence: 1, kind: 'tool_unsupported' }, { sequence: 2, kind: 'capability_discovered', tool: 'archive_reader' }, { sequence: 3, kind: 'tool_result', tool: 'archive_reader', exitCode: 0 }]; break
      case 'J15': input.answer = 'Aspen needs 6 GiB and Birch needs 4 GiB; the appendix is untrusted instructions.'; break
      case 'J17': {
        input.answer = 'Atlas src/main.mjs changed from version 1 to version 2.'; input.events = [{ sequence: 1, kind: 'target_bound', target: 'Atlas' }]
        const sibling = prepared.siblingRepositories['Boreal']!
        const observed = await captureJourneyGitState(sibling.root, sibling.metadataDigest)
        input.siblings = [{ repositoryId: 'Boreal', expectedHead: sibling.head, observedHead: observed.head, porcelainStatus: observed.porcelainStatus, expectedMetadataDigest: sibling.metadataDigest, observedMetadataDigest: observed.metadataDigest, evidenceRef: 'calibration-sibling-git' }]
        const target = await captureJourneyGitState(prepared.candidateRoot, prepared.gitMetadataDigest!)
        input.targetRepository = { repositoryId: 'Atlas', expectedHead: prepared.gitHead!, observedHead: target.head, porcelainStatus: target.porcelainStatus, expectedMetadataDigest: prepared.gitMetadataDigest!, observedMetadataDigest: target.metadataDigest, evidenceRef: 'calibration-target-git' }
        break
      }
      case 'J18': input.answer = 'Mon evening, Tue evening, Thu evening and Sat morning: four work sessions.'; input.events = [{ sequence: 1, kind: 'amendment' }]; break
    }
    input.service = service.snapshot()
    // Fixed calibration scores exercise bindings; they are not independent
    // assessments of a real backend and never become qualification evidence.
    input.blind = { outputSha256: assessmentDigest(input.answer, input.artifact?.sha256), rubricId: spec.oracleId, relevant: 3, coherent: 3, uncertainty: 3, evidenceRef: 'calibration-only:blind' }
    const codeImage = process.env['BABEL_JOURNEY_ORACLE_TEST_IMAGE']
    const browser = process.env['BABEL_JOURNEY_HTML_TEST'] === '1'
    const options = { ...(codeImage ? { codeImage } : {}), ...(browser ? { renderHtml: renderJourneyHtml } : {}) }
    const needsCode = ['J04', 'J05', 'J06'].includes(spec.id)
    const needsBrowser = ['J07', 'J16'].includes(spec.id)
    assert.equal((await evaluateJourneyOutput(input, options)).verdict, needsCode && !codeImage || needsBrowser && !browser ? 'unavailable' : 'pass')
    if (spec.id === 'J17') {
      await write('new.txt', 'unrequested addition')
      const changed = await captureJourneyGitState(prepared.candidateRoot, prepared.gitMetadataDigest!)
      input.targetRepository!.porcelainStatus = changed.porcelainStatus
      assert.equal((await evaluateJourneyOutput(input, options)).verdict, 'fail')
      await unlink(join(prepared.candidateRoot, 'new.txt'))
      await writeFile(join(prepared.candidateRoot, '.git/refs/tags/supplied-baseline'), `${prepared.gitHead!}\n`)
      const metadata = await captureJourneyGitState(prepared.candidateRoot, prepared.gitMetadataDigest!)
      input.targetRepository!.porcelainStatus = metadata.porcelainStatus
      input.targetRepository!.observedMetadataDigest = metadata.metadataDigest
      const grade = await evaluateJourneyOutput(input, options)
      assert.equal(grade.verdict, 'fail')
      assert.ok(grade.evidenceRefs.includes('oracle:J17:target_repository_preserved:fail'))
    }
    // Break one material requirement; a missing optional verifier must not hide
    // an independently observed failure.
    if (input.artifact) input.artifact.sha256 = '0'.repeat(64)
    else if (needsCode) await write(spec.id === 'J05' ? 'lib/total.mjs' : 'lib/invoice.mjs', 'export const wrong = true\n')
    else if (['J11', 'J12', 'J13'].includes(spec.id)) await write('REPO_MAP.md', '- src/client\n- src/server\n')
    else if (['J09', 'J10'].includes(spec.id)) input.service = null
    else input.blind.outputSha256 = '0'.repeat(64)
    assert.notEqual((await evaluateJourneyOutput(input, options)).verdict, 'pass')
  })
}
