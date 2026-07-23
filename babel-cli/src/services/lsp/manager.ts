/**
 * LSP Server Manager — lifecycle manager for LSP language servers.
 *
 * Manages multiple LSP server instances keyed by language ID. Servers are
 * lazily spawned on first request for a matching file extension.
 *
 * Features:
 *   - Per-language server registry
 *   - Lazy spawn on first use
 *   - Health checks and auto-restart on crash
 *   - Config loading from project `.babel/lsp-servers.json`
 *   - Built-in default TypeScript server
 *   - TextDocument open/close state tracking
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createLspClient, type LspClient } from './client.js';
import type { InitializeParams, LspServerConfig, LspServerState, SymbolInformation } from './types.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Default TypeScript server config (auto-detected). */
const TYPESCRIPT_SERVER_COMMAND = 'typescript-language-server';
const TYPESCRIPT_SERVER_ARGS = ['--stdio'];

/** How often to check server health (ms). */
const HEALTH_CHECK_INTERVAL_MS = 30_000;

// ─── Server Instance State ───────────────────────────────────────────────────

interface ServerInstance {
  readonly config: LspServerConfig;
  readonly name: string;
  client: LspClient | null;
  state: LspServerState;
  startTime: number | null;
  lastError: Error | null;
  restartCount: number;
  /** Files currently open on this server (URI → language ID). */
  openFiles: Map<string, string>;
  /** Timer handle for periodic health checks. */
  healthCheckTimer: ReturnType<typeof setInterval> | null;
}

// ─── Manager Interface ───────────────────────────────────────────────────────

export interface LspServerManager {
  /** Initialize the manager by loading all configured servers. */
  initialize(): Promise<void>;

  /** Shutdown all servers and clean up. */
  shutdown(): Promise<void>;

  /** Get the appropriate server for a file path (lazy-starts if needed). */
  ensureServerForFile(filePath: string): Promise<ServerInstance | null>;

  /** Send an LSP request for the given file. */
  sendRequest<T>(
    filePath: string,
    method: string,
    params: unknown,
  ): Promise<T | undefined>;

  /** Open a file on the appropriate LSP server (sends didOpen). */
  openFile(filePath: string, content: string): Promise<void>;

  /** Check if a file is already open on its server. */
  isFileOpen(filePath: string): boolean;

  /** Close a file on its server (sends didClose). */
  closeFile(filePath: string): Promise<void>;

  /** Get all running server instances. */
  getAllServers(): Map<string, ServerInstance>;

  /** Get a server instance by name. */
  getServer(name: string): ServerInstance | undefined;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Determine the language ID from a file extension.
 * Maps common extensions to LSP language IDs.
 */
function extensionToLanguageId(filePath: string): string | null {
  const ext = extname(filePath).toLowerCase();
  const extensionMap: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescriptreact',
    '.js': 'javascript',
    '.jsx': 'javascriptreact',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.mts': 'typescript',
    '.cts': 'typescript',
    '.json': 'json',
    '.css': 'css',
    '.scss': 'scss',
    '.html': 'html',
    '.md': 'markdown',
    '.py': 'python',
    '.rs': 'rust',
    '.go': 'go',
    '.rb': 'ruby',
    '.java': 'java',
    '.kt': 'kotlin',
    '.swift': 'swift',
    '.php': 'php',
    '.c': 'c',
    '.cpp': 'cpp',
    '.h': 'c',
    '.hpp': 'cpp',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.toml': 'toml',
    '.sh': 'shellscript',
    '.bash': 'shellscript',
    '.zsh': 'shellscript',
    '.sql': 'sql',
    '.graphql': 'graphql',
    '.gql': 'graphql',
    '.vue': 'vue',
    '.svelte': 'svelte',
    '.astro': 'astro',
  };
  return extensionMap[ext] ?? null;
}

/**
 * Detect the TypeScript language server binary.
 * Checks node_modules/.bin first, then falls back to npx.
 */
function detectTypeScriptServer(): { command: string; args: string[] } | null {
  // Check common locations for typescript-language-server
  const candidates = [
    join(process.cwd(), 'node_modules', '.bin', TYPESCRIPT_SERVER_COMMAND),
    join(process.cwd(), 'node_modules', 'typescript-language-server', 'lib', 'cli.mjs'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return { command: candidate, args: TYPESCRIPT_SERVER_ARGS };
    }
  }

  // Fall back to npx
  try {
    execSync('npx --yes typescript-language-server --version', { stdio: 'ignore', timeout: 10_000 });
    return { command: 'npx', args: ['--yes', TYPESCRIPT_SERVER_COMMAND, '--stdio'] };
  } catch {
    return null;
  }
}

/** Build the default TypeScript server config. */
function defaultTypeScriptConfig(): LspServerConfig | null {
  const detected = detectTypeScriptServer();
  if (!detected) return null;

  return {
    languageId: 'typescript',
    command: detected.command,
    args: detected.args,
    fileExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '.cts'],
    startupTimeout: 30_000,
    maxRestarts: 3,
  };
}

/**
 * Load LSP server configuration from project `.babel/lsp-servers.json`.
 * Falls back to built-in defaults when the config file doesn't exist.
 */
function loadConfig(): Record<string, LspServerConfig> {
  const servers: Record<string, LspServerConfig> = {};

  // Try project-level config
  const configPaths = [
    join(process.cwd(), '.babel', 'lsp-servers.json'),
    // Future: user-level config at os.homedir()/.babel/lsp-servers.json
  ];

  for (const configPath of configPaths) {
    try {
      if (existsSync(configPath)) {
        const raw = readFileSync(configPath, 'utf-8');
        const parsed = JSON.parse(raw) as Record<string, LspServerConfig>;
        for (const [name, config] of Object.entries(parsed)) {
          if (config.command && config.languageId) {
            servers[name] = {
              ...config,
              fileExtensions: config.fileExtensions ?? [],
              maxRestarts: config.maxRestarts ?? 3,
              startupTimeout: config.startupTimeout ?? 30_000,
            };
          }
        }
      }
    } catch {
      // Skip invalid config files
    }
  }

  // Add default TypeScript server if not explicitly configured
  if (!servers['typescript']) {
    const tsConfig = defaultTypeScriptConfig();
    if (tsConfig) {
      servers['typescript'] = tsConfig;
    }
  }

  return servers;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createLspServerManager(): LspServerManager {
  /** Server instances by name. */
  const servers = new Map<string, ServerInstance>();

  /** Extension → server name mapping (lowercase extension). */
  const extensionMap = new Map<string, string>();

  /** Last health check time per server. */
  const lastHealthCheck = new Map<string, number>();

  // ─── Internal helper for building the InitializeParams ───────────────────

  function buildInitializeParams(workspaceFolder: string): InitializeParams {
    const workspaceUri = pathToFileURL(workspaceFolder).href;
    return {
      processId: process.pid,
      rootPath: workspaceFolder,
      rootUri: workspaceUri,
      capabilities: {
        workspace: {
          configuration: false,
          workspaceFolders: false,
        },
        textDocument: {
          synchronization: {
            dynamicRegistration: false,
            willSave: false,
            willSaveWaitUntil: false,
            didSave: true,
          },
          hover: {
            dynamicRegistration: false,
            contentFormat: ['markdown', 'plaintext'],
          },
          definition: {
            dynamicRegistration: false,
            linkSupport: true,
          },
          references: {
            dynamicRegistration: false,
          },
          documentSymbol: {
            dynamicRegistration: false,
            hierarchicalDocumentSymbolSupport: true,
          },
        },
        general: {
          positionEncodings: ['utf-16'],
        },
      },
      workspaceFolders: [
        {
          uri: workspaceUri,
          name: workspaceFolder.split(/[/\\]/).pop() ?? 'workspace',
        },
      ],
    };
  }

  // ─── Internal helper for health checks ───────────────────────────────────

  function performHealthCheck(serverName: string, instance: ServerInstance): void {
    if (instance.state !== 'running' || !instance.client?.isInitialized) {
      return;
    }

    const now = Date.now();
    const lastCheck = lastHealthCheck.get(serverName) ?? 0;
    if (now - lastCheck < HEALTH_CHECK_INTERVAL_MS) {
      return;
    }
    lastHealthCheck.set(serverName, now);

    // Simple health check: try a workspace/symbol request with empty query
    // If this fails, the crash handler in the client will set state to error
    instance.client
      .sendRequest<SymbolInformation[]>('workspace/symbol', { query: '' })
      .catch(() => {
        // Health check failures are handled by the client's crash handler
      });
  }

  // ─── Internal helper for starting a single server ────────────────────────

  async function startServer(serverName: string, instance: ServerInstance): Promise<void> {
    if (instance.state === 'running' || instance.state === 'starting') {
      return;
    }

    // Enforce maxRestarts limit with exponential backoff
    const maxRestarts = instance.config.maxRestarts ?? 3;
    if (instance.restartCount >= maxRestarts) {
      instance.state = 'error';
      instance.lastError = new Error(
        `Server "${serverName}" exceeded max restarts (${maxRestarts}) — restartCount=${instance.restartCount}`,
      );
      return;
    }

    // Exponential backoff: 1s, 2s, 4s, 8s... capped at 30s
    if (instance.restartCount > 0) {
      const delay = Math.min(1000 * Math.pow(2, instance.restartCount - 1), 30_000);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    instance.state = 'starting';
    instance.lastError = null;

    try {
      const client = createLspClient(serverName, (error: Error) => {
        instance.state = 'error';
        instance.lastError = error;
        instance.restartCount++;
      });

      const workspaceFolder = instance.config.workspaceFolder ?? process.cwd();

      const startOptions: { env?: Record<string, string>; cwd?: string } = {
        cwd: workspaceFolder,
      };
      if (instance.config.env !== undefined) {
        startOptions.env = instance.config.env;
      }
      await client.start(instance.config.command, instance.config.args, startOptions);

      const initParams = buildInitializeParams(workspaceFolder);
      initParams.initializationOptions = instance.config.initializationOptions;

      const initPromise = client.initialize(initParams);
      const timeout = instance.config.startupTimeout ?? 30_000;

      let initTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          initPromise,
          new Promise<never>((_, reject) => {
            initTimer = setTimeout(
              () => reject(new Error(`Server "${serverName}" init timed out after ${timeout}ms`)),
              timeout,
            );
          }),
        ]);
      } finally {
        if (initTimer !== undefined) clearTimeout(initTimer);
      }

      instance.client = client;
      instance.state = 'running';
      instance.startTime = Date.now();
      instance.restartCount = 0;

      // Set up periodic health check
      instance.healthCheckTimer = setInterval(() => {
        performHealthCheck(serverName, instance);
      }, HEALTH_CHECK_INTERVAL_MS);
    } catch (error) {
      instance.state = 'error';
      instance.lastError = error instanceof Error ? error : new Error(String(error));

      // Clean up the failed client
      if (instance.client) {
        instance.client.stop().catch(() => {});
      }
      instance.client = null;

      throw error;
    }
  }

  // ─── Manager Public API ─────────────────────────────────────────────────

  return {
    async initialize(): Promise<void> {
      const configs = loadConfig();

      for (const [name, config] of Object.entries(configs)) {
        const instance: ServerInstance = {
          name,
          config,
          client: null,
          state: 'stopped',
          startTime: null,
          lastError: null,
          restartCount: 0,
          openFiles: new Map(),
          healthCheckTimer: null,
        };

        servers.set(name, instance);

        // Map file extensions to this server
        for (const ext of config.fileExtensions) {
          const normalized = ext.toLowerCase();
          // Only register if not already mapped to another server
          if (!extensionMap.has(normalized)) {
            extensionMap.set(normalized, name);
          }
        }
      }
    },

    async shutdown(): Promise<void> {
      const errors: string[] = [];

      for (const [name, instance] of servers) {
        if (instance.healthCheckTimer) {
          clearInterval(instance.healthCheckTimer);
          instance.healthCheckTimer = null;
        }

        if (instance.client) {
          try {
            await instance.client.stop();
          } catch (error) {
            errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }

        instance.state = 'stopped';
        instance.client = null;
        instance.openFiles.clear();
      }

      servers.clear();
      extensionMap.clear();
      lastHealthCheck.clear();

      if (errors.length > 0) {
        throw new Error(`LSP shutdown errors: ${errors.join('; ')}`);
      }
    },

    async ensureServerForFile(filePath: string): Promise<ServerInstance | null> {
      // Check extension-based mapping first
      const ext = extname(filePath).toLowerCase();
      const serverName = extensionMap.get(ext);

      if (!serverName) {
        // Try to determine language and see if we have a matching server
        const languageId = extensionToLanguageId(filePath);
        if (!languageId) return null;

        // Search by languageId in configs
        for (const [name, instance] of servers) {
          if (instance.config.languageId === languageId) {
            // Found by language — dynamically register the extension
            extensionMap.set(ext, name);
            await startServer(name, instance);
            return instance;
          }
        }
        return null;
      }

      const instance = servers.get(serverName);
      if (!instance) return null;

      // Start the server if not running
      if (instance.state !== 'running') {
        try {
          await startServer(serverName, instance);
        } catch {
          return null;
        }
      }

      return instance;
    },

    async sendRequest<T>(
      filePath: string,
      method: string,
      params: unknown,
    ): Promise<T | undefined> {
      const instance = await this.ensureServerForFile(filePath);
      if (!instance?.client || instance.state !== 'running') {
        return undefined;
      }

      try {
        return await instance.client.sendRequest<T>(method, params);
      } catch {
        return undefined;
      }
    },

    async openFile(filePath: string, content: string): Promise<void> {
      const instance = await this.ensureServerForFile(filePath);
      if (!instance?.client || instance.state !== 'running') return;

      const fileUri = pathToFileURL(filePath).href;

      // Skip if already open
      if (instance.openFiles.has(fileUri)) return;

      const languageId = extensionToLanguageId(filePath) ?? 'plaintext';

      try {
        await instance.client.sendNotification('textDocument/didOpen', {
          textDocument: {
            uri: fileUri,
            languageId,
            version: 1,
            text: content,
          },
        });
        instance.openFiles.set(fileUri, languageId);
      } catch {
        // Open failed — will be retried on next request
      }
    },

    isFileOpen(filePath: string): boolean {
      const fileUri = pathToFileURL(filePath).href;
      for (const [, instance] of servers) {
        if (instance.openFiles.has(fileUri)) return true;
      }
      return false;
    },

    async closeFile(filePath: string): Promise<void> {
      const fileUri = pathToFileURL(filePath).href;

      for (const [, instance] of servers) {
        if (instance.openFiles.has(fileUri) && instance.client) {
          try {
            await instance.client.sendNotification('textDocument/didClose', {
              textDocument: { uri: fileUri },
            });
          } catch {
            // Best-effort close
          }
          instance.openFiles.delete(fileUri);
        }
      }
    },

    getAllServers(): Map<string, ServerInstance> {
      return servers;
    },

    getServer(name: string): ServerInstance | undefined {
      return servers.get(name);
    },
  };
}
