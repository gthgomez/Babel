import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  ExecutorTurnCompletionSchema,
  ExecutorTurnToolCallSchema,
} from '../schemas/agentContracts.js'
import { ToolCallRequestSchema } from '../localTools.js'
import { DEEP_EXECUTOR_TOOL_NAMES, EXECUTOR_TOOL_NAMES } from './toolContracts.js'
import {
  getExecutorToolRegistrySnapshot,
  getExecutorToolSnapshot,
} from '../localTools.js'
import { getManifestSnapshot } from './toolManifest.js'
import { handleToolCatalog } from '../localTools.js'
import { buildExecutorTask, formatHistoryEntry } from '../stages/executorHelpers.js'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Fields intentionally withheld from the model-facing manifest. */
const HOST_ONLY_TOOL_FIELDS = new Set(['file_read.raw', 'file_write.createOnly'])
/** Tools deliberately restricted to non-Deep surfaces. */
const DEEP_STAGE_RESTRICTED_TOOLS = new Set(['lsp'])

const INTEGER_FIELDS = new Set([
  'limit',
  'max_results',
  'max_matches',
  'max_bytes',
  'max_paths',
  'max_depth',
  'max_files',
  'max_lines',
  'schema_limit',
  'ttl_sec',
  'timeout_seconds',
  'line',
  'character',
  'depth',
  'context_lines',
])
const BOOLEAN_FIELDS = new Set(['ignore_case', 'mutating', 'hard', 'force'])
const OBJECT_FIELDS = new Set(['arguments'])

function sampleFieldValue(tool: string, field: string): unknown {
  if (OBJECT_FIELDS.has(field)) return {}
  if (BOOLEAN_FIELDS.has(field)) return false
  if (INTEGER_FIELDS.has(field)) return 1
  if (field === 'revision') return 'a'.repeat(64)
  if (field === 'output_format') return 'json'
  if (field === 'format' && tool !== 'git_context') return tool === 'tool_catalog' ? 'full' : 'summary'
  if (field === 'format') return 'summary'
  if (field === 'direction') return 'both'
  if (field === 'detail') return 'summary'
  if (field === 'operation') return 'hover'
  if (field === 'max_bytes') return 1024
  return `${field}-value`
}

function sampleToolCall(tool: string, fields: Record<string, string[]>): Record<string, unknown> {
  const request: Record<string, unknown> = { tool }
  for (const field of [...fields['required']!, ...fields['optional']!]) {
    if (HOST_ONLY_TOOL_FIELDS.has(`${tool}.${field}`)) continue
    request[field] = sampleFieldValue(tool, field)
  }
  return request
}

function registryFields(tool: string): Record<string, string[]> {
  const snapshot = getExecutorToolSnapshot(tool)
  assert.ok(snapshot, `registry entry missing for ${tool}`)
  return {
    required: [...snapshot.input.required],
    optional: [...snapshot.input.optional],
  }
}

test('manifest and registry advertise the same executed tool surface', () => {
  const registryNames = getExecutorToolRegistrySnapshot().map(tool => tool.name)
  const manifestNames = getManifestSnapshot().map(entry => entry.name)

  assert.deepEqual(
    [...registryNames].sort(),
    [...EXECUTOR_TOOL_NAMES].sort(),
    'toolContracts must list every registered executor tool',
  )
  const missingFromManifest = registryNames.filter(name => !manifestNames.includes(name))
  assert.deepEqual(
    missingFromManifest.sort(),
    [...DEEP_STAGE_RESTRICTED_TOOLS].sort(),
    'only documented Deep-stage restrictions may be absent from the model manifest',
  )
  assert.deepEqual(
    manifestNames.filter(name => !(registryNames as string[]).includes(name)),
    [],
    'the manifest cannot advertise tools without a reachable handler',
  )

  for (const name of manifestNames) {
    assert.deepEqual(
      registryFields(name),
      {
        required: getManifestSnapshot().find(entry => entry.name === name)!.input.required.map(field => field.name),
        optional: getManifestSnapshot().find(entry => entry.name === name)!.input.optional.map(field => field.name),
      },
      `${name} input contract must match the executable registry`,
    )
  }
})

test('every advertised registry input is accepted by the strict request schema', () => {
  for (const name of EXECUTOR_TOOL_NAMES) {
    const request = sampleToolCall(name, registryFields(name))
    if (name === 'kg_impact_analysis') request['files'] = ['src/index.ts']
    const parsed = ToolCallRequestSchema.safeParse(request)
    assert.equal(
      parsed.success,
      true,
      `${name} advertises an unexecutable input contract: ${parsed.success ? '' : parsed.error.toString()}`,
    )
  }
})

test('Deep executor schema preserves every advertised argument instead of stripping it', () => {
  const turnToolNames = ExecutorTurnToolCallSchema.shape.tool.options
  assert.deepEqual(
    [...DEEP_EXECUTOR_TOOL_NAMES].sort(),
    [...turnToolNames].sort(),
    'DEEP_EXECUTOR_TOOL_NAMES must equal the Deep turn schema tool enum',
  )
  for (const restricted of DEEP_STAGE_RESTRICTED_TOOLS) {
    assert.equal(turnToolNames.includes(restricted as never), false, `${restricted} stays restricted in Deep`)
  }

  for (const name of DEEP_EXECUTOR_TOOL_NAMES) {
    const request = sampleToolCall(name, registryFields(name))
    if (name === 'kg_impact_analysis') request['files'] = ['src/index.ts']
    const parsed = ExecutorTurnToolCallSchema.safeParse({
      type: 'tool_call',
      thinking: 'parity fixture',
      ...request,
    })
    assert.equal(
      parsed.success,
      true,
      `${name} cannot be represented by the Deep turn schema: ${parsed.success ? '' : parsed.error.toString()}`,
    )
    assert.equal(parsed.success, true)
    if (parsed.success) {
      for (const [field, value] of Object.entries(request)) {
        if (field === 'tool') continue
        assert.deepEqual(
          (parsed.data as Record<string, unknown>)[field],
          value,
          `${name}.${field} must survive Deep turn parsing`,
        )
      }
      const { type: _type, ...strictArgs } = parsed.data
      assert.equal(
        ToolCallRequestSchema.safeParse(strictArgs).success,
        true,
        `${name} must remain executable after Deep turn parsing`,
      )
    }
  }
})

test('Deep executor prompt shapes advertise only executable Deep tools', () => {
  const prompt = buildExecutorTask(
    { minimal_action_set: [] } as never,
    'parity fixture',
    [],
  )
  const advertised = [...prompt.matchAll(/^ {2}([a-z_]+): \{/gm)].map(match => match[1]!)
  assert.ok(advertised.includes('grep'), 'grep must stay advertised to Deep')
  assert.ok(advertised.includes('glob'), 'glob must stay advertised to Deep')
  assert.ok(advertised.includes('directory_list'), 'directory_list must stay advertised to Deep')
  assert.equal(advertised.includes('lsp'), false, 'lsp is intentionally restricted from Deep')
  assert.equal(advertised.includes('tool_catalog'), false, 'tool_catalog is self-referential')
  assert.equal(advertised.includes('enter_plan_mode'), false, 'mode tools stay host-driven')
  const directoryShape = prompt.split('\n').find(line => line.startsWith('  directory_list: '))
  assert.ok(directoryShape?.includes('"after"') && directoryShape.includes('"revision"'))
  const grepShape = prompt.split('\n').find(line => line.startsWith('  grep: '))
  assert.ok(grepShape?.includes('"ignore_case"') && grepShape.includes('"context_lines"'))
  for (const name of advertised) {
    const snapshot = getExecutorToolSnapshot(name)
    assert.ok(snapshot, `${name} is advertised to Deep without a handler`)
    assert.ok(
      (DEEP_EXECUTOR_TOOL_NAMES as readonly string[]).includes(name),
      `${name} is advertised but missing from the Deep turn schema`,
    )
  }
})

test('tool_catalog reports reachable handlers and marks Deep-stage restrictions', () => {
  const result = handleToolCatalog({ tool: 'tool_catalog', format: 'full' })
  assert.equal(result.exit_code, 0)
  const payload = JSON.parse(result.stdout) as {
    tools: Array<{ name: string; deep_executor: boolean; surface_restrictions: string[] }>
  }
  const byName = new Map(payload.tools.map(tool => [tool.name, tool]))
  for (const name of EXECUTOR_TOOL_NAMES) {
    assert.ok(byName.has(name), `${name} is executable but not advertised by tool_catalog`)
  }
  assert.equal(byName.get('lsp')?.deep_executor, false)
  assert.match(byName.get('lsp')?.surface_restrictions.join(' ') ?? '', /Chat only/)
  assert.equal(byName.get('grep')?.deep_executor, true)
  assert.deepEqual(byName.get('grep')?.surface_restrictions, [])
})

test('the model manifest ships with the built package', () => {
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
    files: string[]
  }
  assert.ok(
    pkg.files.includes('dist/tools/tool-manifest.json'),
    'package.json must publish the compiled tool manifest',
  )
  const copyScript = readFileSync(join(packageRoot, 'scripts', 'copy_playbooks.mjs'), 'utf8')
  assert.match(copyScript, /src', 'tools', 'tool-manifest\.json|src\/tools\/tool-manifest\.json/)
  assert.match(copyScript, /dist', 'tools', 'tool-manifest\.json|dist\/tools\/tool-manifest\.json/)
})

test('Deep tool history keeps structured glob data instead of flattening it', () => {
  const line = formatHistoryEntry({
    step: 1,
    tool: 'glob',
    target: '*',
    exit_code: 0,
    stdout: 'a.ts\nb.ts',
    stderr: '',
    glob_result: { paths: ['a.ts', 'b.ts'], returned_count: 2, truncated: false },
    verified: true,
  })
  assert.match(line, /Glob result: \{"paths":\["a\.ts","b\.ts"\],"returned_count":2,"truncated":false\}/)
})

test('completion schema remains a separate decision contract', () => {
  assert.equal(
    ExecutorTurnCompletionSchema.safeParse({
      type: 'completion',
      status: 'EXECUTION_COMPLETE',
    }).success,
    true,
  )
})
