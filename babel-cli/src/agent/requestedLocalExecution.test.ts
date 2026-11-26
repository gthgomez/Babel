import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import {
  requestedLocalExecutionRefs,
  requiredLocalExecutionBlock,
  requiredLocalExecutionDenialMarker,
  requiredLocalExecutionScope,
} from './requestedLocalExecution.js'

const root = resolve('workspace-fixture')
const command = 'node tools/build-index.mjs --output "docs search.json"'

test('freezes exact required foreground argv and does not retain a command in provenance', () => {
  const refs = requestedLocalExecutionRefs([`Run \`${command}\`.`])
  assert.equal(refs.length, 1)
  assert.ok(!refs[0]?.ref.includes('build-index'))
  assert.equal(requiredLocalExecutionScope(refs, { type: 'run_command', command }, root), 'standalone')
  assert.equal(requiredLocalExecutionScope(refs, { type: 'run_command', command, cwd: '.' }, root), 'standalone')
  assert.equal(requiredLocalExecutionScope(refs, { type: 'run_command', command, cwd: 'tools' }, root), null)
  assert.equal(requiredLocalExecutionScope(refs, { type: 'run_command', command, background: true }, root), null)
  assert.equal(requiredLocalExecutionScope(refs, { type: 'run_command', command: `${command} --dry-run` }, root), null)
  assert.equal(requiredLocalExecutionScope(refs, { type: 'run_command', command: `${command} && echo ok` }, root), null)
  const mixed = requestedLocalExecutionRefs([`Create a README. Run \`${command}\`.`])
  assert.equal(requiredLocalExecutionScope(mixed, { type: 'run_command', command }, root), 'mixed')
})

test('does not create a required effect from optional, prohibited, quoted or composite commands', () => {
  for (const prose of [
    `If possible, run \`${command}\`.`,
    `Run \`${command}\` if possible.`,
    `Do not run \`${command}\`.`,
    `Run \`${command}\`. Never run shell commands.`,
    `"Run \`${command}\`."`,
    `Example: Run \`${command}\`.`,
    `For example. Run \`${command}\`.`,
    `Run \`${command} && echo ok\`.`,
  ]) assert.deepEqual(requestedLocalExecutionRefs([prose]), [], prose)
})

test('binds the declared warehouse pattern and a renamed pre-existing non-CSV job', () => {
  const exporter = requestedLocalExecutionRefs([
    'Add export_warehouse.py, a Python 3 CLI taking an input JSON file and an output CSV path.',
    'Run the exporter to create warehouse.csv from warehouse.json and leave both the exporter and generated CSV in the repository.',
  ])
  const exportCommand = 'python3 export_warehouse.py warehouse.json warehouse.csv'
  assert.equal(requiredLocalExecutionScope(exporter, { type: 'run_command', command: exportCommand }, root), 'standalone')
  assert.equal(requiredLocalExecutionScope(exporter, {
    type: 'run_command', command: 'python3 export_warehouse.py warehouse.csv warehouse.json',
  }, root), null)
  const job = requestedLocalExecutionRefs(['Run `jobs/build-index.mjs` to generate `public/検索.txt` from `inputs/catalog.txt`.'])
  assert.equal(requiredLocalExecutionScope(job, {
    type: 'run_command', command: 'node jobs/build-index.mjs inputs/catalog.txt public/検索.txt',
  }, root), 'standalone')
  const mixed = requestedLocalExecutionRefs([
    'Add export_warehouse.py, a Python CLI.',
    'Run the exporter to create warehouse.csv from warehouse.json.',
    'Update the README with usage instructions.',
  ])
  assert.equal(requiredLocalExecutionScope(mixed, { type: 'run_command', command: exportCommand }, root), 'mixed')
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
  assert.equal(requiredLocalExecutionBlock([
    missingCapability,
    { tool: 'test_run', target: command, working_directory: root, processExecuted: true },
  ], { final: true }), null)
  assert.notEqual(requiredLocalExecutionBlock([
    missingCapability,
    { tool: 'test_run', target: command, working_directory: resolve(root, 'tools'), processExecuted: true },
  ], { final: true }), null)
  assert.notEqual(requiredLocalExecutionBlock([
    missingCapability,
    { tool: 'run_command', target: command, working_directory: root, processExecuted: true, detail: 'background started fixture' },
  ], { final: true }), null)
})
