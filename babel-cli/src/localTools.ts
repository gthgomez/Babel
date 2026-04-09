/**
 * localTools.ts — Safe Local Tool Executor
 *
 * Implements the five tool calls defined in CLI_Executor-v1.0.md:
 *   file_read    — always executes (read-only, safe)
 *   file_write   — DRY RUN by default (mocked)
 *   shell_exec   — DRY RUN by default (mocked)
 *   test_run     — DRY RUN by default (mocked)
 *   mcp_request  — always executes (read-only stdio JSON-RPC client)
 *
 * DRY RUN MODE (default, BABEL_DRY_RUN !== 'false'):
 *   Mutating operations log what WOULD have happened and return a synthetic
 *   success response. This lets us safely run the "Hello World" pipeline test
 *   against real prompts without touching the project codebase.
 *
 * LIVE MODE (BABEL_DRY_RUN=false):
 *   Mutating operations are executed for real via SafeExecutor (sandbox.ts),
 *   which enforces path traversal protection, a command whitelist, and
 *   shell-injection blocking. Activate only after validating dry-run output
 *   and confirming the SWE plan is safe.
 *
 * Zod schemas are exported so the pipeline executor loop can parse the CLI
 * Executor's tool call JSON against them before invoking `executeTool`.
 *
 * Environment variables:
 *   BABEL_DRY_RUN         Set to "false" to enable live execution.
 *   BABEL_PROJECT_ROOT    Project root for SafeExecutor path resolution.
 *                         Defaults to process.cwd() if not set.
 */

import { spawn }                 from 'node:child_process';
import { readFileSync }          from 'node:fs';
import path                      from 'node:path';
import { DatabaseSync }          from 'node:sqlite';
import { fileURLToPath }         from 'node:url';
import { z }                     from 'zod';
import { SafeExecutor }          from './sandbox.js';
import type { ToolResult }       from './sandbox.js';
import { MCP_SERVERS }           from './config/mcpServers.js';

// Re-export ToolResult so downstream consumers are not broken.
export type { ToolResult };

// ─── Dry-run gate ─────────────────────────────────────────────────────────────

export const DRY_RUN = process.env['BABEL_DRY_RUN'] !== 'false';

// ─── SafeExecutor factory ─────────────────────────────────────────────────────

/**
 * Creates a SafeExecutor rooted at the configured project root.
 * Called per-invocation in live mode; never called in dry-run mode.
 */
function getExecutor(): SafeExecutor {
  const root = process.env['BABEL_PROJECT_ROOT'] ?? process.cwd();
  return new SafeExecutor(root);
}

// ─── Tool call request schemas (discriminated on `tool`) ──────────────────────

export const ToolCallRequestSchema = z.discriminatedUnion('tool', [
  z.object({
    tool: z.literal('directory_list'),
    path: z.string().min(1),
  }),
  z.object({
    tool: z.literal('file_read'),
    path: z.string().min(1),
  }),
  z.object({
    tool:    z.literal('file_write'),
    path:    z.string().min(1),
    content: z.string(),
  }),
  z.object({
    tool:              z.literal('shell_exec'),
    command:           z.string().min(1),
    working_directory: z.string(),
    timeout_seconds:   z.number().int().optional(),
  }),
  z.object({
    tool:              z.literal('test_run'),
    command:           z.string().min(1),
    working_directory: z.string(),
    timeout_seconds:   z.number().int().optional(),
  }),
  z.object({
    tool:   z.literal('mcp_request'),
    server: z.string().min(1),
    query:  z.string().min(1),
  }),
  z.object({
    tool:   z.literal('audit_ui'),
    url:    z.string().url(),
    run_id: z.string().min(1),
  }),
  z.object({
    tool:  z.literal('memory_store'),
    key:   z.string().min(1),
    value: z.string(),
  }),
  z.object({
    tool: z.literal('memory_query'),
    key:  z.string().min(1),
  }),
]);

export type ToolCallRequest = z.infer<typeof ToolCallRequestSchema>;

// ─── Individual tool handlers ─────────────────────────────────────────────────

function handleDirectoryList(
  req: Extract<ToolCallRequest, { tool: 'directory_list' }>,
): ToolResult {
  // directory_list is always live — listing is non-destructive.
  return getExecutor().listDirectory(req.path);
}

function handleFileRead(
  req: Extract<ToolCallRequest, { tool: 'file_read' }>,
): ToolResult {
  // file_read is always live — reading is non-destructive.
  return getExecutor().fileRead(req.path);
}

function handleFileWrite(
  req: Extract<ToolCallRequest, { tool: 'file_write' }>,
): ToolResult {
  if (DRY_RUN) {
    console.log(
      `  [DRY RUN] file_write → ${req.path}` +
      ` (${req.content.length} chars — not written)`,
    );
    return {
      exit_code: 0,
      stdout:    `[DRY RUN] Would write ${req.content.length} chars to: ${req.path}`,
      stderr:    '',
    };
  }

  return getExecutor().fileWrite(req.path, req.content);
}

function handleShellExec(
  req: Extract<ToolCallRequest, { tool: 'shell_exec' }>,
): ToolResult {
  if (DRY_RUN) {
    console.log(`  [DRY RUN] shell_exec → ${req.command}`);
    return {
      exit_code: 0,
      stdout:    `[DRY RUN] Would execute: ${req.command}`,
      stderr:    '',
    };
  }

  return getExecutor().shellExec(
    req.command,
    req.working_directory,
    (req.timeout_seconds ?? 120) * 1000,
  );
}

function handleTestRun(
  req: Extract<ToolCallRequest, { tool: 'test_run' }>,
): ToolResult {
  if (DRY_RUN) {
    console.log(`  [DRY RUN] test_run → ${req.command}`);
    return {
      exit_code: 0,
      stdout:    `[DRY RUN] Would run tests: ${req.command}`,
      stderr:    '',
    };
  }

  return getExecutor().testRun(
    req.command,
    req.working_directory,
    (req.timeout_seconds ?? 300) * 1000,
  );
}

/** Hard limit (ms) for a single MCP server round-trip. */
const MCP_TIMEOUT_MS = 15_000;

function buildMcpLifecycle(
  server: string,
  phase: 'server_lookup' | 'spawn' | 'write_request' | 'await_response' | 'response_parse' | 'complete',
  outcome: 'success' | 'failure',
  reasonCode: string | null = null,
  evidence: string[] | null = null,
): NonNullable<ToolResult['mcp_lifecycle']> {
  return {
    phase,
    outcome,
    reason_code: reasonCode,
    server,
    evidence,
  };
}

function buildMcpResult(
  server: string,
  phase: 'server_lookup' | 'spawn' | 'write_request' | 'await_response' | 'response_parse' | 'complete',
  outcome: 'success' | 'failure',
  exitCode: number,
  stdout: string,
  stderr: string,
  reasonCode: string | null = null,
  evidence: string[] | null = null,
): ToolResult {
  return {
    exit_code: exitCode,
    stdout,
    stderr,
    mcp_lifecycle: buildMcpLifecycle(server, phase, outcome, reasonCode, evidence),
  };
}

/**
 * Spawns the configured MCP server as a child process, sends a single
 * JSON-RPC 2.0 `tools/call` request over its stdin, and awaits the
 * newline-delimited JSON response on stdout.
 *
 * Protocol assumptions (simplified harness):
 *   • Messages are newline-delimited JSON (one object per line).
 *   • We match the response by `id === 1`.
 *   • Non-JSON lines (server startup banners, log output) are skipped silently.
 *   • Stderr is inherited by the parent process so it appears in the terminal.
 *
 * On Windows, `npx` must be invoked via the shell so `spawn` receives
 * `shell: true`. On all other platforms `shell` is `false`.
 *
 * Full MCP initialization handshake support is deferred to a later Epic.
 * If the target server requires `initialize` / `initialized` before accepting
 * `tools/call`, the 15-second timeout will fire and the returned stderr will
 * contain a diagnostic message the SWE Agent can act on.
 */
async function handleMcpRequest(
  req: Extract<ToolCallRequest, { tool: 'mcp_request' }>,
): Promise<ToolResult> {
  // ── 1. Validate server name ────────────────────────────────────────────────
  const config = MCP_SERVERS[req.server];
  if (config === undefined) {
    const available = Object.keys(MCP_SERVERS).join(', ');
    return buildMcpResult(
      req.server,
      'server_lookup',
      'failure',
      1,
      '',
      `[MCP_ERROR] Unknown server '${req.server}'. Available: ${available}`,
      'unknown_server',
      [`requested_server:${req.server}`, `available_servers:${available}`],
    );
  }

  console.log(`  [MCP] mcp_request → server="${req.server}" query="${req.query}"`);

  // ── 2. Build the JSON-RPC 2.0 payload ─────────────────────────────────────
  const rpcPayload =
    JSON.stringify({
      jsonrpc: '2.0',
      id:      1,
      method:  'tools/call',
      params:  {
        name:      'query',
        arguments: { text: req.query },
      },
    }) + '\n';

  // ── 3. Spawn and communicate ───────────────────────────────────────────────
  return new Promise<ToolResult>((resolve) => {
    const isWindows = process.platform === 'win32';

    const child = spawn(config.command, config.args, {
      stdio: ['pipe', 'pipe', 'inherit'],
      shell: isWindows,
    });

    let stdoutBuf = '';
    let settled   = false;

    /** Resolve the promise exactly once, then kill the child. */
    function settle(result: ToolResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      try { child.kill(); } catch { /* already dead — ignore */ }
      resolve(result);
    }

    // ── 4. Hard timeout ────────────────────────────────────────────────────
    const timeoutHandle = setTimeout(() => {
      settle(buildMcpResult(
        req.server,
        'await_response',
        'failure',
        1,
        '',
        `[MCP_TIMEOUT] Server '${req.server}' did not respond within ` +
        `${MCP_TIMEOUT_MS / 1000}s. The server may require a JSON-RPC ` +
        `initialization handshake (initialize/initialized) before accepting ` +
        `tools/call — this is not yet implemented in the simplified harness.`,
        'response_timeout',
        [`timeout_ms:${MCP_TIMEOUT_MS}`],
      ));
    }, MCP_TIMEOUT_MS);

    // ── 5. Collect stdout; scan line-by-line for our JSON-RPC response ─────
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');

      // Protocol is newline-delimited; process each complete line.
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? ''; // keep trailing incomplete fragment

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          // Non-JSON output (startup banners, log lines) — skip silently.
          continue;
        }

        // Only act on a JSON-RPC response whose id matches our request.
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          (parsed as Record<string, unknown>)['id'] !== 1
        ) {
          continue;
        }

        const response = parsed as Record<string, unknown>;

        if ('error' in response) {
          // Surface the MCP server's JSON-RPC error verbatim so the SWE Agent
          // can see exactly which tool name or argument schema was wrong.
          settle(buildMcpResult(
            req.server,
            'response_parse',
            'failure',
            1,
            '',
            JSON.stringify({
              source: 'mcp_rpc_error',
              server: req.server,
              error:  response['error'],
            }),
            'rpc_error',
            [`rpc_error_code:${String((response['error'] as Record<string, unknown> | undefined)?.['code'] ?? 'unknown')}`],
          ));
        } else {
          settle(buildMcpResult(
            req.server,
            'complete',
            'success',
            0,
            JSON.stringify({
              status: 'success',
              server: req.server,
              result: response['result'] ?? null,
            }),
            '',
            'response_received',
            [`command:${config.command}`],
          ));
        }
      }
    });

    // ── 6. Spawn error (binary not on PATH, permissions, etc.) ─────────────
    child.on('error', (err: Error) => {
      settle(buildMcpResult(
        req.server,
        'spawn',
        'failure',
        1,
        '',
        `[MCP_SPAWN_ERROR] Failed to start '${config.command}' for server ` +
        `'${req.server}': ${err.message}`,
        'spawn_error',
        [`command:${config.command}`],
      ));
    });

    // ── 7. Process closed before a response arrived ────────────────────────
    child.on('close', (code: number | null) => {
      if (!settled) {
        settle(buildMcpResult(
          req.server,
          'await_response',
          'failure',
          code ?? 1,
          '',
          `[MCP_CLOSED] Server '${req.server}' exited (code ${code ?? 'null'}) ` +
          `before returning a response.`,
          'closed_before_response',
          [`exit_code:${code ?? 'null'}`],
        ));
      }
    });

    // ── 8. Write the RPC request payload to stdin ──────────────────────────
    // Guard: child.stdin is null if spawn() failed synchronously.
    if (child.stdin) {
      child.stdin.write(rpcPayload, 'utf8', (err?: Error | null) => {
        if (err && !settled) {
          settle(buildMcpResult(
            req.server,
            'write_request',
            'failure',
            1,
            '',
            `[MCP_WRITE_ERROR] Could not write to '${req.server}' stdin: ` +
            `${err.message}`,
            'write_error',
            [`command:${config.command}`],
          ));
        }
      });
      // Signal EOF so servers that read until stdin closes know we're done.
      child.stdin.end();
    }
  });
}

// ─── example_web_audit native tool ───────────────────────────────────────────────────

/** example_web_audit project root — configure via EXAMPLE_WEB_AUDIT_ROOT env var. */
const EXAMPLE_WEB_AUDIT_ROOT = process.env['EXAMPLE_WEB_AUDIT_ROOT'] ?? process.cwd();

/**
 * Spawns the example_web_audit orchestrator as a child process, waits for it to
 * complete, then reads and returns the generated refactor handoff report.
 *
 * Orchestrator command:
 *   npx tsx tooling/orchestrator.ts <url> <run_id>
 *
 * Report produced at:
 *   <EXAMPLE_WEB_AUDIT_ROOT>/artifacts/<run_id>/pass-b/final-review.pass-b.v1.0.2.json
 *
 * Error conditions:
 *   • Non-zero exit code → [AUDIT_UI_NONZERO]
 *   • Report file absent after zero exit → [AUDIT_UI_MISSING_REPORT]
 *   • Spawn failure → [AUDIT_UI_SPAWN_ERROR]
 */
async function handleAuditUi(
  req: Extract<ToolCallRequest, { tool: 'audit_ui' }>,
): Promise<ToolResult> {
  if (DRY_RUN) {
    console.log(
      `  [DRY RUN] audit_ui → url=${req.url} run_id=${req.run_id}` +
      ` (not executed)`,
    );
    return {
      exit_code: 0,
      stdout:    `[DRY RUN] Would run example_web_audit orchestrator: url=${req.url} run_id=${req.run_id}`,
      stderr:    '',
    };
  }

  console.log(
    `  [AUDIT_UI] audit_ui → url="${req.url}" run_id="${req.run_id}"`,
  );

  const reportPath = path.join(
    EXAMPLE_WEB_AUDIT_ROOT, 'artifacts', req.run_id, 'pass-b', 'final-review.pass-b.v1.0.2.json',
  );

  return new Promise<ToolResult>((resolve) => {
    let stdoutBuf = '';
    let stderrBuf = '';

    const child = spawn(
      'npx',
      ['tsx', 'audit-frontend/tooling/orchestrator.ts', req.url, req.run_id],
      {
        cwd:   EXAMPLE_WEB_AUDIT_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true,
      },
    );

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
    });

    child.on('error', (err: Error) => {
      resolve({
        exit_code: 1,
        stdout:    '',
        stderr:
          `[AUDIT_UI_SPAWN_ERROR] Failed to start orchestrator: ${err.message}`,
      });
    });

    child.on('close', (code: number | null) => {
      if (code !== 0) {
        resolve({
          exit_code: code ?? 1,
          stdout:    stdoutBuf,
          stderr:
            `[AUDIT_UI_NONZERO] Orchestrator exited with code ${code ?? 'null'}. ` +
            `stderr: ${stderrBuf}`,
        });
        return;
      }

      // Read the report file produced by the orchestrator.
      let reportContent: string;
      try {
        reportContent = readFileSync(reportPath, 'utf8');
      } catch (err: unknown) {
        resolve({
          exit_code: 1,
          stdout:    '',
          stderr:
            `[AUDIT_UI_MISSING_REPORT] Orchestrator completed (exit 0) but ` +
            `report not found at: ${reportPath}. ` +
            `Error: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }

      resolve({
        exit_code: 0,
        stdout:    reportContent,
        stderr:    '',
      });
    });
  });
}

// ─── Chronicle persistent memory ─────────────────────────────────────────────

/** Absolute path to the Chronicle SQLite database file. */
const CHRONICLE_DB_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',           // src/ → babel-cli/
  'chronicle.sqlite',
);

/** Lazily opened Chronicle database instance (opened on first Chronicle call). */
let _chronicleDb: DatabaseSync | undefined;

/**
 * Returns the lazily opened Chronicle database.
 * Uses the Node.js built-in `node:sqlite` (no native addon — available since
 * Node 22.5, stable in Node 23+, fully supported in Node 24).
 */
function getChronicleDb(): DatabaseSync {
  if (_chronicleDb === undefined) {
    _chronicleDb = new DatabaseSync(CHRONICLE_DB_PATH);
  }
  return _chronicleDb;
}

/**
 * Writes (or overwrites) a project fact in the Chronicle.
 *
 * SQL: INSERT OR REPLACE INTO babel_facts
 *        (project_root, fact_key, fact_value, last_verified)
 *      VALUES (?, ?, ?, datetime('now'))
 *
 * Always executes live — memory writes are idempotent and non-destructive.
 */
function handleMemoryStore(
  req: Extract<ToolCallRequest, { tool: 'memory_store' }>,
): ToolResult {
  const projectRoot = process.env['BABEL_PROJECT_ROOT'] ?? process.cwd();

  if (DRY_RUN) {
    console.log(
      `  [DRY RUN] memory_store → key="${req.key}" ` +
      `value="${req.value.slice(0, 80)}${req.value.length > 80 ? '…' : ''}"`,
    );
    return {
      exit_code: 0,
      stdout:    `[DRY RUN] Would store fact: key="${req.key}" for project "${projectRoot}"`,
      stderr:    '',
    };
  }

  console.log(`  [CHRONICLE] memory_store → key="${req.key}"`);

  try {
    const db  = getChronicleDb();
    const sql = db.prepare(`
      INSERT OR REPLACE INTO babel_facts (project_root, fact_key, fact_value, last_verified)
      VALUES (?, ?, ?, datetime('now'))
    `);
    sql.run(projectRoot, req.key, req.value);

    return {
      exit_code: 0,
      stdout:    `[CHRONICLE] Stored: key="${req.key}" for project "${projectRoot}"`,
      stderr:    '',
    };
  } catch (err: unknown) {
    return {
      exit_code: 1,
      stdout:    '',
      stderr:
        `[CHRONICLE_ERROR] memory_store failed for key="${req.key}": ` +
        `${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Retrieves a stored fact (or all facts) from the Chronicle.
 *
 * key = "ALL":
 *   SELECT fact_key, fact_value, last_verified FROM babel_facts
 *   WHERE project_root = ?
 *
 * key = <specific>:
 *   SELECT fact_value FROM babel_facts
 *   WHERE fact_key = ? AND project_root = ?
 *
 * A cache miss returns exit_code 0 with an empty stdout — it is NOT an error.
 * Always executes live — reading is non-destructive.
 */
function handleMemoryQuery(
  req: Extract<ToolCallRequest, { tool: 'memory_query' }>,
): ToolResult {
  const projectRoot = process.env['BABEL_PROJECT_ROOT'] ?? process.cwd();

  console.log(`  [CHRONICLE] memory_query → key="${req.key}"`);

  try {
    const db = getChronicleDb();

    if (req.key === 'ALL') {
      const rows = db
        .prepare(
          `SELECT fact_key, fact_value, last_verified
             FROM babel_facts
            WHERE project_root = ?`,
        )
        .all(projectRoot);

      return {
        exit_code: 0,
        stdout:    JSON.stringify(rows),
        stderr:    '',
      };
    }

    const row = db
      .prepare(
        `SELECT fact_value
           FROM babel_facts
          WHERE fact_key = ? AND project_root = ?`,
      )
      .get(req.key, projectRoot) as { fact_value: string } | undefined;

    return {
      exit_code: 0,
      stdout:    row?.fact_value ?? '',    // Empty string on cache miss — not an error
      stderr:    '',
    };
  } catch (err: unknown) {
    return {
      exit_code: 1,
      stdout:    '',
      stderr:
        `[CHRONICLE_ERROR] memory_query failed for key="${req.key}": ` +
        `${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Dispatches a parsed tool call request to the appropriate handler.
 * Returns a `ToolResult` suitable for injection back into the executor loop.
 *
 * `file_read` and `mcp_request` are always live (both are read-only).
 * All mutating tools are mocked in DRY RUN mode.
 *
 * Returns `Promise<ToolResult>` so that `mcp_request` (which performs async
 * stdio I/O) can be awaited cleanly alongside the synchronous handlers.
 */
export async function executeTool(req: ToolCallRequest): Promise<ToolResult> {
  switch (req.tool) {
    case 'directory_list': return handleDirectoryList(req);
    case 'file_read':   return handleFileRead(req);
    case 'file_write':  return handleFileWrite(req);
    case 'shell_exec':  return handleShellExec(req);
    case 'test_run':    return handleTestRun(req);
    case 'mcp_request':   return handleMcpRequest(req);
    case 'audit_ui':      return handleAuditUi(req);
    case 'memory_store':  return handleMemoryStore(req);
    case 'memory_query':  return handleMemoryQuery(req);
  }
}

