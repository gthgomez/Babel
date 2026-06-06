/**
 * mcpServers.ts — MCP Server Configuration Map
 *
 * Loads the server registry from config/mcp_servers.json at runtime.
 * The JSON file is the single source of truth — add entries there to
 * register new servers without touching code.
 *
 * Falls back to a hardcoded baseline if the file is absent or malformed,
 * so the CLI remains functional in environments where the config dir is
 * not present.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname }         from 'node:path';
import { fileURLToPath }            from 'node:url';

import { readActivePluginMcpServers } from '../services/plugins.js';
import { evaluateMcpServerPolicy, formatEnterprisePolicyDecision } from './enterprisePolicy.js';

export interface McpServerConfig {
  /** The executable to spawn. Must be an approved command name resolved from PATH. */
  command: string;
  /** Arguments passed to the command, including the server-specific flags. */
  args: string[];
}

// ─── Fallback defaults (used when config/mcp_servers.json is missing) ─────────

const FALLBACK_SERVERS: Record<string, McpServerConfig> = {
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

export const ALLOWED_MCP_SERVER_COMMANDS = new Set([
  'bun',
  'node',
  'npm',
  'npx',
  'pnpm',
  'py',
  'python',
  'python3',
  'uvx',
  'yarn',
]);

// ─── Loader ───────────────────────────────────────────────────────────────────

interface McpServersJson {
  $schema?: string;
  description?: string;
  servers: Record<string, McpServerConfig>;
}

export function getMcpServersConfigPath(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  // babel-cli/src/config/ → babel-cli/ → config/mcp_servers.json
  return resolve(__dirname, '../..', 'config', 'mcp_servers.json');
}

export function isAllowedMcpServerCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.includes(' ') || trimmed.includes('\t')) return false;
  if (trimmed.includes('/') || trimmed.includes('\\')) return false;
  if (/^[A-Za-z]:/.test(trimmed) || trimmed.startsWith('.')) return false;

  const normalized = trimmed.toLowerCase().replace(/\.(cmd|exe|bat)$/u, '');
  return ALLOWED_MCP_SERVER_COMMANDS.has(normalized);
}

export function filterAllowedMcpServers(servers: Record<string, McpServerConfig>): Record<string, McpServerConfig> {
  const allowed: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(servers)) {
    if (!isAllowedMcpServerCommand(config.command)) {
      process.stderr.write(`[babel] mcp server "${name}": command is not allowlisted, skipping\n`);
      continue;
    }
    allowed[name] = {
      command: config.command.trim(),
      args: [...config.args],
    };
  }
  return allowed;
}

export function filterEnterpriseMcpServers(servers: Record<string, McpServerConfig>): Record<string, McpServerConfig> {
  const allowed: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(servers)) {
    const decision = evaluateMcpServerPolicy(name);
    if (!decision.allowed) {
      process.stderr.write(`[babel] mcp server "${name}": ${formatEnterprisePolicyDecision(decision)}, skipping\n`);
      continue;
    }
    allowed[name] = config;
  }
  return allowed;
}

export function readMcpServers(): Record<string, McpServerConfig> {
  const configPath = getMcpServersConfigPath();
  let servers: Record<string, McpServerConfig>;
  if (!existsSync(configPath)) {
    servers = FALLBACK_SERVERS;
  } else {
    try {
      const raw = readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(raw) as McpServersJson;

      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        typeof parsed.servers !== 'object' ||
        parsed.servers === null
      ) {
        process.stderr.write(`[babel] mcp_servers.json: unexpected shape, using defaults\n`);
        servers = FALLBACK_SERVERS;
      } else {
        const parsedServers: Record<string, McpServerConfig> = {};
        for (const [name, cfg] of Object.entries(parsed.servers)) {
          if (
            typeof cfg.command === 'string' &&
            Array.isArray(cfg.args) &&
            cfg.args.every((a) => typeof a === 'string')
          ) {
            parsedServers[name] = { command: cfg.command, args: cfg.args };
          } else {
            process.stderr.write(`[babel] mcp_servers.json: skipping malformed entry "${name}"\n`);
          }
        }

        servers = Object.keys(parsedServers).length > 0 ? parsedServers : FALLBACK_SERVERS;
      }
    } catch {
      process.stderr.write(`[babel] mcp_servers.json: failed to parse, using defaults\n`);
      servers = FALLBACK_SERVERS;
    }
  }

  return filterEnterpriseMcpServers(filterAllowedMcpServers({
    ...servers,
    ...readActivePluginMcpServers(),
  }));
}

function assertValidMcpServerName(name: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error('MCP server name must contain only letters, numbers, underscores, or hyphens.');
  }
}

export function writeMcpServers(servers: Record<string, McpServerConfig>): void {
  const configPath = getMcpServersConfigPath();
  mkdirSync(dirname(configPath), { recursive: true });
  const payload: McpServersJson = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    description: 'MCP server registry. Add entries here to make new servers available to the Babel executor without code changes. Each key is the logical server name used in mcp_request.server.',
    servers,
  };
  writeFileSync(configPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
}

export function upsertMcpServer(name: string, config: McpServerConfig): Record<string, McpServerConfig> {
  assertValidMcpServerName(name);
  if (!isAllowedMcpServerCommand(config.command)) {
    throw new Error(`MCP server command "${config.command}" is not allowlisted.`);
  }
  const servers = {
    ...readMcpServers(),
    [name]: {
      command: config.command.trim(),
      args: config.args,
    },
  };
  writeMcpServers(servers);
  return servers;
}

export function removeMcpServer(name: string): Record<string, McpServerConfig> {
  assertValidMcpServerName(name);
  const servers = readMcpServers();
  if (!servers[name]) {
    throw new Error(`MCP server "${name}" is not configured.`);
  }
  const next = { ...servers };
  delete next[name];
  writeMcpServers(next);
  return next;
}
