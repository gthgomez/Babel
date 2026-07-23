// ─── MCP Command Handlers ────────────────────────────────────────────────────
// Extracted from interactive.ts — MCP server inspection and interaction.

import type { ReplContext } from '../context.js';
import { readMcpServers } from '../../config/mcpServers.js';
import { formatMcpDoctorHuman, runMcpDoctor } from '../../services/mcpDoctor.js';
import {
  handleMcpPromptGet,
  handleMcpPromptList,
  handleMcpResourceList,
  handleMcpResourceRead,
  handleMcpToolSearch,
} from '../../tools/mcpTransport.js';
import { renderErrorPanel } from '../../ui/renderers.js';
import { accentBright, muted, primary, padRight } from '../../ui/theme.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

export function parseMcpPromptArgs(args: string[]): Record<string, unknown> {
  const parsed: Record<string, unknown> = {};
  for (const arg of args) {
    const eq = arg.indexOf('=');
    if (eq <= 0) {
      throw new Error(`Prompt argument must be key=value: ${arg}`);
    }
    parsed[arg.slice(0, eq)] = arg.slice(eq + 1);
  }
  return parsed;
}

export async function printMcpResult(
  resultPromise: Promise<{ exit_code: number; stdout: string; stderr: string }>,
): Promise<void> {
  const result = await resultPromise;
  if (result.stdout) {
    try {
      console.log('\n' + JSON.stringify(JSON.parse(result.stdout), null, 2));
    } catch {
      console.log('\n' + result.stdout);
    }
  }
  if (result.stderr) {
    console.log(accentBright('\n  ' + result.stderr));
  }
}

// ── MCP Servers ──────────────────────────────────────────────────────────────

export async function handleMcpServers(_ctx: ReplContext, args: string[]): Promise<void> {
  const subcommand = args[0]?.toLowerCase();
  if (subcommand === 'doctor') {
    console.log('\n' + formatMcpDoctorHuman(runMcpDoctor()));
    return;
  }

  if (subcommand === 'tools') {
    const server = args[1];
    if (!server) {
      console.log(accentBright('\n  Usage: /mcp tools <server> [query]'));
      return;
    }
    await printMcpResult(
      handleMcpToolSearch({
        tool: 'mcp_tool_search',
        server,
        ...(args[2] ? { query: args.slice(2).join(' ') } : {}),
      }),
    );
    return;
  }

  if (subcommand === 'resources') {
    const server = args[1];
    if (!server) {
      console.log(accentBright('\n  Usage: /mcp resources <server>'));
      return;
    }
    await printMcpResult(handleMcpResourceList({ tool: 'mcp_resource_list', server }));
    return;
  }

  if (subcommand === 'resource') {
    const server = args[1];
    const uri = args[2];
    if (!server || !uri) {
      console.log(accentBright('\n  Usage: /mcp resource <server> <uri>'));
      return;
    }
    await printMcpResult(handleMcpResourceRead({ tool: 'mcp_resource_read', server, uri }));
    return;
  }

  if (subcommand === 'prompts') {
    const server = args[1];
    if (!server) {
      console.log(accentBright('\n  Usage: /mcp prompts <server>'));
      return;
    }
    await printMcpResult(handleMcpPromptList({ tool: 'mcp_prompt_list', server }));
    return;
  }

  if (subcommand === 'prompt') {
    const server = args[1];
    const name = args[2];
    if (!server || !name) {
      console.log(accentBright('\n  Usage: /mcp prompt <server> <name> [key=value...]'));
      return;
    }
    try {
      await printMcpResult(
        handleMcpPromptGet({
          tool: 'mcp_prompt_get',
          server,
          name,
          arguments: parseMcpPromptArgs(args.slice(3)),
        }),
      );
    } catch (error) {
      console.log(
        '\n' +
          renderErrorPanel(
            'MCP Error',
            error instanceof Error ? error.message : String(error),
            'Check MCP server status with /mcp doctor',
          ),
      );
    }
    return;
  }

  const servers = readMcpServers();
  console.log(primary('\n  MCP Servers:'));
  Object.entries(servers).forEach(([name, server]) => {
    console.log(
      `    ${accentBright(padRight(name, 14))} ${muted(`${server.command} ${server.args.join(' ')}`.trim())}`,
    );
  });
  console.log(
    muted('\n  Slash: /mcp doctor  /mcp tools <server> [query]  /mcp resources <server>'),
  );
  console.log(muted('         /mcp prompts <server>  /mcp prompt <server> <name> [key=value...]'));
  console.log(muted('  CLI: babel mcp add|remove|list|status|doctor|tools|resources|prompts'));
}
