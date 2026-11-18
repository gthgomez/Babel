import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import test from 'node:test'

import { executeMcpMethod } from './mcpTransport.js'
import { MCP_MAX_FRAME_BYTES } from '../mcp/framing.js'

// The official MCP SDK is an explicit devDependency used only by these tests.
// These tests exercise an independent implementation; no runtime dependency is
// added to the shipped CLI.

const CLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const REPO_ROOT = resolve(CLI_ROOT, '..')
const SDK_ESM_ROOT = join(CLI_ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm')

function nodeEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  return { ...env, BABEL_ROOT: REPO_ROOT, ...extra }
}

test(
  'independent MCP SDK client initializes and calls the Babel MCP server',
  { timeout: 60_000 },
  async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', '--no-warnings=ExperimentalWarning', 'src/index.ts', 'mcp'],
      cwd: CLI_ROOT,
      env: nodeEnv(),
      stderr: 'pipe',
    })
    const client = new Client({
      name: 'independent-sdk-client',
      version: '1.0.0',
    })
    try {
      await client.connect(transport)
      const listed = await client.listTools()
      assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
        'babel_catalog_inspect',
        'babel_executor_tools_list',
        'babel_instruction_stack_preview',
        'babel_manifest_preview',
        'babel_stack_resolve',
      ])

      const called = await client.callTool({
        name: 'babel_catalog_inspect',
        arguments: { ids: ['meta_mcp_adapter_v1'] },
      })
      const content = Array.isArray(called.content) ? called.content : []
      const text = content.map((entry) => (entry.type === 'text' ? entry.text : '')).join('\n')
      assert.match(text, /meta_mcp_adapter_v1/)
      assert.notEqual(called.isError, true)
    } finally {
      await client.close().catch(() => undefined)
    }
  },
)

test(
  'Babel MCP client calls an independent MCP SDK server with UTF-8 newline framing',
  { timeout: 45_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'babel-mcp-sdk-server-'))
    const serverPath = join(dir, 'server.mjs')
    const sdkServer = pathToFileURL(join(SDK_ESM_ROOT, 'server', 'index.js')).href
    const sdkStdio = pathToFileURL(join(SDK_ESM_ROOT, 'server', 'stdio.js')).href
    const sdkTypes = pathToFileURL(join(SDK_ESM_ROOT, 'types.js')).href
    writeFileSync(
      serverPath,
      [
        `const { Server } = await import(${JSON.stringify(sdkServer)});`,
        `const { StdioServerTransport } = await import(${JSON.stringify(sdkStdio)});`,
        `const { ListToolsRequestSchema, CallToolRequestSchema } = await import(${JSON.stringify(sdkTypes)});`,
        'const server = new Server(',
        "  { name: 'independent-sdk-server', version: '1.0.0' },",
        '  { capabilities: { tools: {} } },',
        ');',
        'server.setRequestHandler(ListToolsRequestSchema, async () => ({',
        '  tools: [{',
        "    name: 'lookup',",
        "    description: 'Echo a query.',",
        '    inputSchema: {',
        "      type: 'object',",
        "      properties: { query: { type: 'string' } },",
        "      required: ['query'],",
        '    },',
        '    annotations: { readOnlyHint: true, destructiveHint: false },',
        '  }],',
        '}));',
        'server.setRequestHandler(CallToolRequestSchema, async (request) => ({',
        '  content: [{ type: "text", text: `echo:${String(request.params.arguments?.query ?? "")}` }],',
        '}));',
        'await server.connect(new StdioServerTransport());',
      ].join('\n'),
      'utf8',
    )

    try {
      const result = await executeMcpMethod(
        'fixture',
        'tools/call',
        { name: 'lookup', arguments: { query: 'héllo 🌍' } },
        20_000,
        { fixture: { command: process.execPath, args: [serverPath] } },
      )
      assert.equal(result.exit_code, 0, result.stderr)
      assert.equal(result.mcp_lifecycle?.reason_code, 'response_received')
      assert.match(result.stdout, /echo:héllo 🌍/u)
    } finally {
      rmSync(dir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      })
    }
  },
)

test(
  'Babel MCP client rejects an oversized response frame with a bounded failure',
  { timeout: 45_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'babel-mcp-client-frame-limit-'))
    const serverPath = join(dir, 'server.cjs')
    writeFileSync(
      serverPath,
      [
        "let replied = false;",
        "process.stdin.on('data', () => {",
        '  if (replied) return;',
        '  replied = true;',
        `  const body = JSON.stringify({ jsonrpc: '2.0', id: 0, result: { data: 'a'.repeat(${MCP_MAX_FRAME_BYTES + 1}) } });`,
        "  process.stdout.write(body + '\\n');",
        '});',
      ].join('\n'),
      'utf8',
    )

    try {
      const result = await executeMcpMethod(
        'fixture',
        'tools/list',
        undefined,
        20_000,
        { fixture: { command: process.execPath, args: [serverPath] } },
      )
      assert.equal(result.exit_code, 1)
      assert.equal(result.mcp_lifecycle?.reason_code, 'frame_limit_exceeded')
      assert.match(result.stderr, /MCP_FRAME_LIMIT|exceeds/iu)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  },
)

test(
  'Babel MCP server processes bad, multi, and UTF-8 frames on one stream',
  { timeout: 45_000 },
  async () => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--no-warnings=ExperimentalWarning', 'src/index.ts', 'mcp'],
      { cwd: CLI_ROOT, env: nodeEnv(), stdio: ['pipe', 'pipe', 'pipe'] },
    )
    let buffer = ''
    const lines: Array<Record<string, unknown>> = []
    child.stdin.on('error', () => undefined)
    const received = new Promise<void>((resolveReceived, rejectReceived) => {
      const timer = setTimeout(() => {
        rejectReceived(new Error(`timed out waiting for MCP frames: ${buffer}`))
      }, 20_000)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk
        while (true) {
          const lineEnd = buffer.indexOf('\n')
          if (lineEnd === -1) break
          const line = buffer.slice(0, lineEnd).trim()
          buffer = buffer.slice(lineEnd + 1)
          if (!line) continue
          lines.push(JSON.parse(line) as Record<string, unknown>)
          if (lines.length === 3) {
            clearTimeout(timer)
            resolveReceived()
          }
        }
      })
    })

    try {
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'clïent 🌍', version: '1.0.0' },
          },
        })}\nnot-json\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`,
      )
      await received
      const byId = new Map(lines.map((line) => [line['id'], line]))
      assert.equal(
        (byId.get(1)?.['result'] as Record<string, unknown>)['protocolVersion'],
        '2024-11-05',
      )
      assert.equal(
        ((byId.get(2)?.['result'] as Record<string, unknown>)['tools'] as unknown[]).length,
        5,
      )
      const parseError = lines.find((line) => line['error'] !== undefined)
      assert.match(JSON.stringify(parseError), /Parse error/u)
    } finally {
      child.kill('SIGKILL')
    }
  },
)

test(
  'Babel MCP server terminates a peer that exceeds the frame memory ceiling',
  { timeout: 45_000 },
  async () => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--no-warnings=ExperimentalWarning', 'src/index.ts', 'mcp'],
      { cwd: CLI_ROOT, env: nodeEnv(), stdio: ['pipe', 'pipe', 'pipe'] },
    )
    let stdout = ''
    let stderr = ''
    child.stdin.on('error', () => undefined)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })

    const closed = new Promise<number | null>((resolveClosed, rejectClosed) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        rejectClosed(new Error(`server did not exit after frame overflow. stderr=${stderr}`))
      }, 30_000)
      child.once('close', (code) => {
        clearTimeout(timer)
        resolveClosed(code)
      })
    })

    try {
      child.stdin.write('a'.repeat(MCP_MAX_FRAME_BYTES + 1))
      const code = await closed
      assert.equal(code, 1)
      assert.match(stdout, /MCP_FRAME_LIMIT/)
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL')
    }
  },
)
