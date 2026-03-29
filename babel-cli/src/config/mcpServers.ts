/**
 * mcpServers.ts — MCP Server Configuration Map
 *
 * Maps a logical MCP server name (as used in `mcp_request.server`) to the
 * local command that launches that server over stdio.
 *
 * This map is the single source of truth for which MCP servers Babel
 * recognises. Add entries here before referencing a new server name in a plan.
 *
 * For this iteration the executor uses the map to validate server names and
 * build stub responses. Full stdio JSON-RPC transport is deferred to a later
 * Epic — only the routing layer is wired here.
 */

export interface McpServerConfig {
  /** The executable to spawn (must be on PATH or an absolute path). */
  command: string;
  /** Arguments passed to the command, including the server-specific flags. */
  args: string[];
}

export const MCP_SERVERS: Record<string, McpServerConfig> = {
  github: {
    command: 'npx',
    args:    ['-y', '@modelcontextprotocol/server-github'],
  },
  postgres: {
    command: 'npx',
    args:    ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://localhost/postgres'],
  },
  sqlite: {
    command: 'npx',
    args:    ['-y', '@modelcontextprotocol/server-sqlite', '--db', './database.sqlite'],
  },
};
