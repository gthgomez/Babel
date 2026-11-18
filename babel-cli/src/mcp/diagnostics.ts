/**
 * Secret-safe projections for MCP configuration diagnostics.
 *
 * MCP server arguments frequently carry bearer tokens, database URLs, or
 * inline assignments. Diagnostics are routinely copied into terminals, JSON
 * exports, and issue reports, so they must never reproduce raw argument values.
 */

import type { McpServerConfig, McpServerOrigin } from '../config/mcpServers.js'

/** Summary emitted by `mcp doctor`, `mcp list`, and the `/mcp` listing. */
export interface McpServerDiagnosticSummary {
  command: string
  /** One fixed placeholder per configured argument; no original values. */
  args: string[]
  arg_count: number
  args_redacted: true
  origin?: {
    kind: 'plugin'
    plugin_id: string
    manifest_sha256: string
  }
}

function summarizeOrigin(
  origin: McpServerOrigin | undefined,
): McpServerDiagnosticSummary['origin'] {
  if (!origin) return undefined
  return {
    kind: origin.kind,
    plugin_id: origin.plugin_id,
    manifest_sha256: origin.manifest_sha256,
  }
}

/**
 * Reduce a configured server to non-sensitive metadata. Argument values are
 * deliberately omitted rather than pattern-matched: a diagnostic that
 * advertises redaction must not depend on guessing every credential shape.
 */
export function summarizeMcpServerForDiagnostics(
  config: McpServerConfig,
): McpServerDiagnosticSummary {
  const origin = summarizeOrigin(config.origin)
  return {
    command: config.command,
    args: config.args.map(() => '[REDACTED]'),
    arg_count: config.args.length,
    args_redacted: true,
    ...(origin ? { origin } : {}),
  }
}

/** Reduce a full registry for a diagnostic payload. */
export function summarizeMcpServersForDiagnostics(
  servers: Record<string, McpServerConfig>,
): Record<string, McpServerDiagnosticSummary> {
  const summaries: Record<string, McpServerDiagnosticSummary> = {}
  for (const [name, config] of Object.entries(servers)) {
    summaries[name] = summarizeMcpServerForDiagnostics(config)
  }
  return summaries
}
