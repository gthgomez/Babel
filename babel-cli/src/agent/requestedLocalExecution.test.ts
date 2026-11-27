import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { sha256Canonical } from '../acceptance/canonical.js'
import { createCriterionCompletionServiceV1, evaluateCriterionCompletionV1 } from '../authority/criterionCompletion.js'
import { resolveGovernedCriterionCandidateRevisionSha } from '../evidence/chatRevisionBinding.js'
import { captureChatVerifierReceipt } from './chatEngineVerifierAdapter.js'
import { loadLiveSessionAuthority, persistLiveSessionAuthority, resolveLiveSessionAuthority } from './liveSessionBridge.js'
import {
  REQUESTED_LOCAL_EXECUTION_KIND,
  hasSettledLocalJobSetup,
  requestedForegroundEffect,
  requestedLocalExecutionAcceptance,
  requiredLocalExecutionBlock,
  requiredLocalExecutionDenialMarker,
  requiredLocalExecutionScope,
  substitutesRequestedProcessOutput,
} from './requestedLocalExecution.js'
import { buildTaskContractV1, freezeTaskContract } from './taskContract.js'

const root = resolve('workspace-fixture')
const command = 'node tools/build-index.mjs --output "docs search.json"'
const directRequest = `Run \`${command}\`.`

function admit(activeProse: readonly string[]) {
  return requestedLocalExecutionAcceptance({
    request: activeProse.join('\n'), activeProse, existingCriteria: [],
  })
}

test('freezes exact required foreground argv and does not retain a command in provenance', () => {
  const admitted = admit([directRequest])
  const refs = admitted.provenance
  assert.equal(admitted.criteria.length, 1)
  assert.equal(refs.length, 2)
  assert.ok(refs.every(record => !record.ref.includes('build-index')))
  assert.ok(refs.some(record => record.ref.includes(sha256Canonical(directRequest)) &&
    record.ref.endsWith(`:${admitted.criteria[0]?.id}`)))
  assert.equal(requiredLocalExecutionScope(refs, { type: 'run_command', command }, root), 'standalone')
  assert.equal(requiredLocalExecutionScope(refs, { type: 'run_command', command, cwd: '.' }, root), 'standalone')
  assert.equal(requiredLocalExecutionScope(refs, { type: 'run_command', command, cwd: 'tools' }, root), null)
  assert.equal(requiredLocalExecutionScope(refs, { type: 'run_command', command, background: true }, root), null)
  assert.equal(requiredLocalExecutionScope(refs, { type: 'run_command', command: `${command} --dry-run` }, root), null)
  assert.equal(requiredLocalExecutionScope(refs, { type: 'run_command', command: `${command} && echo ok` }, root), null)
  const { provenance: mixed } = admit([`Create a README. ${directRequest}`])
  assert.equal(requiredLocalExecutionScope(mixed, { type: 'run_command', command }, root), 'mixed')
  const projected = requestedLocalExecutionAcceptance({
    request: `Use the README to explain this tool.\n${directRequest}`,
    activeProse: [directRequest], existingCriteria: [],
  }).provenance
  assert.equal(requiredLocalExecutionScope(projected, { type: 'run_command', command }, root), 'mixed')
  assert.equal(admit([directRequest, directRequest]).criteria.length, 1)
})

test('a blocked transformation closes only after the one declared setup write has settled', () => {
  const task = [
    'Add export.py, a Python 3 standard-library CLI taking an input JSON file and an output CSV path.',
    'It should export every record in input.json, sorted by aisle and then sku.',
    'Use UTF-8 and LF line endings.',
    'Keep empty notes and non-ASCII text intact using standard CSV quoting.',
    'Run the exporter to create output.csv from input.json and leave both the exporter and generated CSV in the repository.',
    'Leave input.json unchanged. Show the verification you performed.',
  ].join(' ')
  const scopeRoot = mkdtempSync(join(tmpdir(), 'babel-local-job-scope-'))
  const inspect = (request: string, log: Parameters<typeof hasSettledLocalJobSetup>[0]['log']) => {
    const { taskContract: contract } = resolveLiveSessionAuthority({ mode: 'chat', task: request, projectRoot: scopeRoot })
    const effect = requestedForegroundEffect(contract, {
      type: 'run_command', command: 'python3 export.py input.json output.csv',
    }, scopeRoot)
    assert.ok(effect)
    return hasSettledLocalJobSetup({ contract, effect, root: scopeRoot, log })
  }
  try {
    const write = { tool: 'write_file', target: 'export.py', effect_status: 'confirmed_change', mutation_paths: ['export.py'] }
    assert.equal(inspect(task, [write]), true)
    assert.equal(inspect(task.replace('taking an input JSON file and an output CSV path', 'with input and output arguments'), [write]), true)
    const inputFirst = task.replace(
      'Run the exporter to create output.csv from input.json and leave both the exporter and generated CSV in the repository.',
      'Execute export.py using input.json and save the resulting CSV as output.csv. Keep the program and its output in the project.',
    )
    assert.equal(inspect(inputFirst, [write]), true)
    assert.equal(inspect(`${inputFirst} Document the data format in README.`, [write]), false)
    assert.equal(inspect(task, []), false)
    assert.equal(inspect(`${task} Update README independently.`, [write]), false)
    assert.equal(inspect(task.replace('sorted by aisle and then sku', 'sorted by aisle and then sku and update README'), [write]), false)
    assert.equal(inspect(task.replace('in the repository', 'in the repository, then update README'), [write]), false)
    assert.equal(inspect(task, [{ ...write, mutation_paths: ['input.json'] }]), false)
  } finally {
    rmSync(scopeRoot, { recursive: true, force: true })
  }
})

test('does not create a required effect from optional, prohibited, quoted or composite commands', () => {
  for (const prose of [
    `If possible, run \`${command}\`.`,
    `Run \`${command}\` if possible.`,
    `Run \`${command}\`?`,
    `Do not run \`${command}\`.`,
    `Run \`${command}\`. Never run shell commands.`,
    `"Run \`${command}\`."`,
    `Example: Run \`${command}\`.`,
    `For example. Run \`${command}\`.`,
    `Run \`${command} && echo ok\`.`,
  ]) assert.deepEqual(admit([prose]), { criteria: [], provenance: [], sources: [] }, prose)
  for (const prose of [
    'Execute export.py using input.json and save the resulting CSV as output.csv if possible.',
    'Execute export.py using ../input.json and save the resulting CSV as output.csv.',
    'Execute export.py using input.json and save the resulting CSV as output.csv. Do not run shell commands.',
  ]) assert.deepEqual(admit([prose]), { criteria: [], provenance: [], sources: [] }, prose)
})

test('an unrelated prohibition does not erase an independently required operation', () => {
  const denied = 'npm test'
  const { criteria, provenance } = admit([directRequest, `Do not run \`${denied}\`.`, `Run \`${denied}\`.`])
  assert.deepEqual(criteria.map(item => item.required), [true])
  assert.equal(requiredLocalExecutionScope(provenance, { type: 'run_command', command }, root), 'mixed')
  assert.equal(requiredLocalExecutionScope(provenance, { type: 'test_run', command: denied }, root), null)

  const exportCommand = 'python3 export.py input.json output.csv'
  const job = admit(['Add export.py, a local CLI.', 'Run the exporter to create output.csv from input.json.', 'Do not run tests.'])
  assert.equal(job.criteria.length, 1)
  assert.equal(requiredLocalExecutionScope(job.provenance, { type: 'run_command', command: exportCommand }, root), 'mixed')
})

test('binds the declared warehouse pattern and a renamed pre-existing non-CSV job', () => {
  const { criteria, provenance: exporter } = admit([
    'Add export_warehouse.py, a Python 3 CLI taking an input JSON file and an output CSV path.',
    'Run the exporter to create warehouse.csv from warehouse.json and leave both the exporter and generated CSV in the repository.',
  ])
  assert.equal(criteria.length, 1, 'interpreter aliases identify one user obligation')
  const exportCommand = 'python3 export_warehouse.py warehouse.json warehouse.csv'
  assert.equal(requiredLocalExecutionScope(exporter, { type: 'run_command', command: exportCommand }, root), 'mixed')
  assert.equal(requiredLocalExecutionScope(exporter, {
    type: 'run_command', command: 'python3 export_warehouse.py warehouse.csv warehouse.json',
  }, root), null)
  const { provenance: job } = admit(['Run `jobs/build-index.mjs` to generate `public/検索.txt` from `inputs/catalog.txt`.'])
  assert.equal(requiredLocalExecutionScope(job, {
    type: 'run_command', command: 'node jobs/build-index.mjs inputs/catalog.txt public/検索.txt',
  }, root), 'standalone')
  const { provenance: mixed } = admit([
    'Add export_warehouse.py, a Python CLI.',
    'Use the existing README to document how inventory is ordered.',
    'Run the exporter to create warehouse.csv from warehouse.json.',
  ])
  assert.equal(requiredLocalExecutionScope(mixed, { type: 'run_command', command: exportCommand }, root), 'mixed')
})

test('process-owned outputs reject direct substitutes without blocking independent edits', () => {
  const prose = ['Add export.py, a local CLI.', 'Run the exporter to create warehouse.csv from warehouse.json.']
  const records = admit(prose).provenance
  const requests = [prose.join('\n'), 'Also require:\n- Add preview.py.']
  assert.equal(substitutesRequestedProcessOutput(records, requests, { type: 'write_file', path: './warehouse.csv', content: 'substitute' }, root), true)
  assert.equal(substitutesRequestedProcessOutput(records, requests, {
    type: 'apply_patch', patch: '--- /dev/null\n+++ b/warehouse.csv\n@@ -0,0 +1 @@\n+substitute\n',
  }, root), true)
  assert.equal(substitutesRequestedProcessOutput(records, requests, {
    type: 'apply_patch', patch: '--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n--- warehouse.csv\n+++ warehouse.csv\n',
  }, root), false)
  assert.equal(substitutesRequestedProcessOutput(records, requests, { type: 'str_replace', file_path: 'export.py', old_str: 'old', new_str: 'new' }, root), false)
  assert.equal(substitutesRequestedProcessOutput([], requests, { type: 'write_file', path: 'warehouse.csv', content: 'untied' }, root), false)
})

test('a skipped runtime effect remains missing alongside a green governed verifier', async t => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-local-operation-'))
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }))
  const verifier = 'node --test math.test.mjs'
  writeFileSync(join(projectRoot, 'math.test.mjs'), 'import test from "node:test"; test("fixture arithmetic", () => {});\n')
  writeFileSync(join(projectRoot, 'math.js'), 'export const result = 2;\n')
  const task = `${directRequest}\nRequirements:\n- \`${verifier}\` must pass.`
  const { taskContract: contract } = resolveLiveSessionAuthority({
    mode: 'chat', task, projectRoot, projectTestCommands: [verifier], verifierRequirements: [verifier],
  })
  const effect = contract.acceptance.find(item => item.verification.kind === REQUESTED_LOCAL_EXECUTION_KIND)
  assert.ok(effect?.required)
  assert.equal(effect.type, 'runtime')
  assert.ok(contract.provenance.records.some(record => record.ref.endsWith(`:${effect.id}`)))
  assert.deepEqual(contract.verifier_requirements, [verifier])
  const receipt = await captureChatVerifierReceipt({
    projectRoot, command: verifier, exitCode: 0, summary: 'fixture arithmetic passed',
    mutationPaths: ['math.js'], execution: { working_directory: '.', environment_policy: 'host-process' },
  })
  assert.ok(receipt)
  receipt.tests_total = 1
  const candidate = resolveGovernedCriterionCandidateRevisionSha(projectRoot, receipt)
  assert.ok(candidate)
  const service = createCriterionCompletionServiceV1(() => ({ contract, runId: 'operation-fixture', projectRoot }))
  service.refreshPrivateEvidence({ proof: { compliant: true }, receipt, candidate_sha: candidate, has_mutation: true })
  const verdict = evaluateCriterionCompletionV1(service.currentRequest())
  assert.equal(verdict.verified, false)
  assert.equal(verdict.criterion_results?.find(item => item.requirement_id === effect.id)?.status, 'missing')
  assert.ok(verdict.criterion_results?.some(item => item.status === 'satisfied'), JSON.stringify(verdict.errors))

  const sameCheck = resolveLiveSessionAuthority({
    mode: 'chat', task: `Run \`${verifier}\`.\nRequirements:\n- \`${verifier}\` must pass.`,
    projectRoot, projectTestCommands: [verifier], verifierRequirements: [verifier],
  }).taskContract
  assert.equal(sameCheck.acceptance.some(item => item.verification.kind === REQUESTED_LOCAL_EXECUTION_KIND), false,
    'an already-bound exact check does not acquire an unsupported second proof obligation')
})

test('restoring an older operation binding keeps its original frozen acceptance', t => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-archived-operation-'))
  const runDir = mkdtempSync(join(tmpdir(), 'babel-archived-operation-run-'))
  t.after(() => { rmSync(projectRoot, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }) })
  const fresh = resolveLiveSessionAuthority({ mode: 'chat', task: directRequest, projectRoot })
  const legacyRecord = admit([directRequest]).provenance.find(record => record.ref.includes(':v2:standalone:'))
  assert.ok(legacyRecord)
  const legacy = freezeTaskContract(buildTaskContractV1({
    mode: 'chat', user_request: directRequest,
    provenance: [{ ...legacyRecord, ref: legacyRecord.ref.replace(':v2:', ':v1:') }],
  }))
  persistLiveSessionAuthority(runDir, { ...fresh, taskContract: legacy })
  const restored = loadLiveSessionAuthority(runDir)?.taskContract
  assert.equal(restored?.contract_hash, legacy.contract_hash)
  assert.deepEqual(restored?.acceptance, legacy.acceptance)
  assert.equal(requiredLocalExecutionScope(legacy.provenance.records, { type: 'run_command', command }, projectRoot), 'mixed')
})

test('a hard denial settles a standalone command; mixed tasks can finish independent work', () => {
  const refusal = (scope: 'standalone' | 'mixed', provenance: 'no_lease' | 'missing_capability') => ({
    tool: 'run_command', target: command, working_directory: root,
    detail: requiredLocalExecutionDenialMarker(scope, provenance), preDispatchNoEffect: true as const,
  })
  const missingLease = requiredLocalExecutionBlock([refusal('standalone', 'no_lease')], { final: false })
  assert.equal(missingLease?.blockedReport.reason_code, 'permission_denied')
  assert.match(missingLease?.answer ?? '', /no execution lease/)
  assert.match(missingLease?.answer ?? '', /No process started/)
  const missingCapability = refusal('mixed', 'missing_capability')
  assert.equal(requiredLocalExecutionBlock([missingCapability], { final: false }), null)
  assert.match(requiredLocalExecutionBlock([missingCapability], { final: true })?.answer ?? '', /does not include the required execution capability/)
  assert.equal(requiredLocalExecutionBlock([{ ...missingCapability, preDispatchNoEffect: undefined }], { final: true }), null)
  assert.equal(requiredLocalExecutionBlock([{ ...missingCapability, detail: 'blocked' }], { final: true }), null)
  const green = { tool: 'test_run', target: command, working_directory: root, processExecuted: true, processCompleted: true, exit_code: 0 }
  assert.equal(requiredLocalExecutionBlock([missingCapability, green], { final: true }), null)
  assert.notEqual(requiredLocalExecutionBlock([green, missingCapability], { final: true }), null)
  for (const nonProof of [
    { exit_code: 1 },
    { processCompleted: false },
    { simulated: true },
    { working_directory: resolve(root, 'tools') },
    { detail: 'background started fixture' },
  ]) assert.notEqual(requiredLocalExecutionBlock([missingCapability, { ...green, ...nonProof }], { final: true }), null)
  assert.notEqual(requiredLocalExecutionBlock([missingCapability, green, { ...green, exit_code: 1 }], { final: true }), null)
})
