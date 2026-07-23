import {
  getMcpServersConfigPath,
  isAllowedMcpServerCommand,
  readMcpServers,
  type McpServerConfig,
} from '../config/mcpServers.js';

export interface McpDoctorCheck {
  server: string;
  status: 'pass' | 'warn' | 'fail';
  transport: 'stdio';
  checks: Array<{
    id: string;
    status: 'pass' | 'warn' | 'fail';
    message: string;
  }>;
}

export interface McpDoctorReport {
  status: 'ok' | 'warn' | 'fail';
  config_path: string;
  server_count: number;
  timeout_ms: number;
  external_content_policy: {
    untrusted_external_content: true;
    applies_to: string[];
    prompt_injection_label: string;
  };
  schema_policy: {
    lazy_tool_search: boolean;
    default_schema_limit: number;
    max_tool_results: number;
  };
  servers: McpDoctorCheck[];
}

const MCP_TIMEOUT_MS = 15_000;

function commandLooksExecutable(config: McpServerConfig): boolean {
  return isAllowedMcpServerCommand(config.command);
}

function authCheck(
  server: string,
  config: McpServerConfig,
): { status: 'pass' | 'warn'; message: string } {
  const haystack = [server, config.command, ...config.args].join(' ').toLowerCase();
  if (haystack.includes('github')) {
    return process.env['GITHUB_TOKEN'] || process.env['GH_TOKEN']
      ? { status: 'pass', message: 'GitHub token environment variable is present.' }
      : {
          status: 'warn',
          message: 'GitHub MCP usually needs GITHUB_TOKEN or GH_TOKEN for authenticated API calls.',
        };
  }
  if (haystack.includes('postgres') || haystack.includes('sqlite')) {
    return {
      status: 'pass',
      message: 'Database auth is carried by server arguments or local filesystem permissions.',
    };
  }
  return { status: 'pass', message: 'No known auth hint required by Babel static doctor.' };
}

function worstStatus(statuses: Array<'pass' | 'warn' | 'fail'>): 'ok' | 'warn' | 'fail' {
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('warn')) return 'warn';
  return 'ok';
}

export function runMcpDoctor(): McpDoctorReport {
  const servers = readMcpServers();
  const serverChecks: McpDoctorCheck[] = Object.entries(servers).map(([server, config]) => {
    const auth = authCheck(server, config);
    const checks: McpDoctorCheck['checks'] = [
      {
        id: 'transport',
        status: 'pass',
        message: 'Configured transport: stdio child process.',
      },
      {
        id: 'command',
        status: commandLooksExecutable(config) ? 'pass' : 'fail',
        message: commandLooksExecutable(config)
          ? `Command configured: ${config.command}`
          : `Command is not allowlisted: ${config.command}`,
      },
      {
        id: 'auth',
        status: auth.status,
        message: auth.message,
      },
      {
        id: 'timeout',
        status: 'pass',
        message: `MCP request timeout is ${MCP_TIMEOUT_MS} ms.`,
      },
      {
        id: 'tool_schema',
        status: 'pass',
        message:
          'Executor uses mcp_tool_search with bounded lazy schema loading before specific tool calls.',
      },
    ];
    const status = checks.some((check) => check.status === 'fail')
      ? 'fail'
      : checks.some((check) => check.status === 'warn')
        ? 'warn'
        : 'pass';
    return {
      server,
      status,
      transport: 'stdio',
      checks,
    };
  });

  return {
    status: worstStatus(serverChecks.map((server) => server.status)),
    config_path: getMcpServersConfigPath(),
    server_count: serverChecks.length,
    timeout_ms: MCP_TIMEOUT_MS,
    external_content_policy: {
      untrusted_external_content: true,
      applies_to: ['resources/read', 'prompts/get', 'tools/search'],
      prompt_injection_label: 'UNTRUSTED_MCP_CONTENT',
    },
    schema_policy: {
      lazy_tool_search: true,
      default_schema_limit: 10,
      max_tool_results: 50,
    },
    servers: serverChecks,
  };
}

export function formatMcpDoctorHuman(report: McpDoctorReport): string {
  const lines = [
    'Babel MCP Doctor',
    `Status: ${report.status}`,
    `Config: ${report.config_path}`,
    `Servers: ${report.server_count}`,
    `Timeout: ${report.timeout_ms} ms`,
    `External content: untrusted (${report.external_content_policy.applies_to.join(', ')})`,
    '',
  ];

  for (const server of report.servers) {
    lines.push(`${server.server}  ${server.status}  ${server.transport}`);
    for (const check of server.checks) {
      lines.push(`  - ${check.id}: ${check.status} - ${check.message}`);
    }
  }

  return lines.join('\n');
}
