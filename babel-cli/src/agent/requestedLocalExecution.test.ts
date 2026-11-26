import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { requestsLocalExporterExecution } from './requestedLocalExecution.js'

const command = 'python3 export.py source.json output.csv'
const create = 'Add `export.py`, a local CLI.'
const execute = 'Run the exporter to create `output.csv` from `source.json` and leave both generated files.'
const root = resolve('fixture-project')

test('recognizes a user-requested run of the exporter just written', () => {
  assert.equal(requestsLocalExporterExecution(`${create} ${execute}`, command, root, [resolve(root, 'export.py')]), true)
  assert.equal(requestsLocalExporterExecution(`${create} ${execute}`, command, root, ['other.py', '../export.py']), false)
})

test('leaves optional, prohibited, example and different command failures recoverable', () => {
  for (const request of [
    create,
    `${create} If possible, ${execute}`,
    `${create} Do not ${execute}`,
    `${create} ${execute} Never run the exporter.`,
    `${create} ${execute.slice(0, -1)} if possible.`,
    `${create}\nExamples:\n${execute}`,
    `${create}\n> ${execute}`,
    `${create}\n\`\`\`text\n${execute}\n\`\`\``,
    `${create} Add backup.py. ${execute}`,
  ]) assert.equal(requestsLocalExporterExecution(request, command, root, ['export.py']), false, request)

  for (const attempted of [
    'python3 --version', 'python3 export.py output.csv source.json', 'python3 export.py source.json other.csv',
    'python3 export.py source.json output.csv && echo done', 'python3 "export.py',
  ]) assert.equal(requestsLocalExporterExecution(`${create} ${execute}`, attempted, root, ['export.py']), false, attempted)
})
