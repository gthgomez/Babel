import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const reference = `import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

function parseCsv(text) {
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"'
        index += 1
      } else if (char === '"') quoted = false
      else cell += char
    } else if (char === '"') quoted = true
    else if (char === ',') { row.push(cell); cell = '' }
    else if (char === '\\n') { row.push(cell.replace(/\\r$/, '')); rows.push(row); row = []; cell = '' }
    else cell += char
  }
  if (cell.length || row.length) { row.push(cell.replace(/\\r$/, '')); rows.push(row) }
  const [headers, ...records] = rows
  return records.filter((record) => record.length === headers.length).map((record) => Object.fromEntries(headers.map((header, index) => [header, record[index]])))
}

export async function main(inputPath = 'input/events.csv', outputPath = 'output/summary.csv') {
  const rows = parseCsv(await readFile(inputPath, 'utf8'))
  const newest = new Map()
  for (const row of rows) {
    const previous = newest.get(row.event_id)
    if (!previous || row.occurred_at > previous.occurred_at) newest.set(row.event_id, row)
  }
  const counts = new Map()
  for (const row of newest.values()) {
    const date = row.occurred_at.slice(0, 10)
    const key = date + ',' + row.status
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const output = ['date,status,count', ...[...counts].sort(([left], [right]) => left.localeCompare(right)).map(([key, count]) => key + ',' + count)].join('\\n') + '\\n'
  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(outputPath, output)
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) await main(process.argv[2], process.argv[3])
`

function parseCsv(text) {
  const records = []
  let row = []
  let field = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"'
        index += 1
      } else if (char === '"') quoted = false
      else field += char
    } else if (char === '"') quoted = true
    else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''))
      records.push(row)
      row = []
      field = ''
    } else field += char
  }
  if (field || row.length) {
    row.push(field.replace(/\r$/, ''))
    records.push(row)
  }
  const [headers, ...data] = records
  return data
    .filter((record) => record.length === headers.length)
    .map((record) => Object.fromEntries(headers.map((header, index) => [header, record[index]])))
}

function expectedSummary(inputText) {
  const newest = new Map()
  for (const row of parseCsv(inputText)) {
    const previous = newest.get(row.event_id)
    if (!previous || row.occurred_at > previous.occurred_at) newest.set(row.event_id, row)
  }
  const counts = new Map()
  for (const row of newest.values()) {
    const key = `${row.occurred_at.slice(0, 10)},${row.status}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [
    'date,status,count',
    ...[...counts].sort(([left], [right]) => left.localeCompare(right)).map(([key, count]) => `${key},${count}`),
  ].join('\n') + '\n'
}

export async function writeReference(workspace) {
  const source = path.join(workspace, 'src', 'summarize.mjs')
  await mkdir(path.dirname(source), { recursive: true })
  await writeFile(source, reference)
}

export async function verify(workspace) {
  const script = path.join(workspace, 'src', 'summarize.mjs')
  const input = path.join(workspace, 'input', 'events.csv')
  const output = path.join(workspace, 'output', 'summary.csv')
  await rm(output, { force: true })
  const run = spawnSync(process.execPath, [script, input, output], {
    cwd: workspace,
    encoding: 'utf8',
    timeout: 5000,
  })
  if (run.status !== 0) {
    return { status: 'failed', assertions: 1, errors: [run.stderr || `summarizer exited ${run.status}`] }
  }
  try {
    const [actual, sourceText] = await Promise.all([readFile(output, 'utf8'), readFile(input, 'utf8')])
    assert.equal(actual, expectedSummary(sourceText), 'rollup rows must be behaviorally correct and sorted')
    return { status: 'passed', assertions: 2, errors: [] }
  } catch (error) {
    return { status: 'failed', assertions: 2, errors: [error.message] }
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  const result = await verify(path.resolve(process.argv[2] ?? '.'))
  process.stdout.write(`${JSON.stringify(result)}\n`)
  if (result.status !== 'passed') process.exitCode = 1
}
