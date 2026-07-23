import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path';

import { z } from 'zod';

import { BABEL_ROOT } from '../cli/constants.js';
import {
  describeEnterprisePolicySource,
  evaluatePluginPolicy,
  formatEnterprisePolicyDecision,
  loadEnterprisePolicy,
  type EnterprisePolicyDecision,
} from '../config/enterprisePolicy.js';
import type { McpServerConfig } from '../config/mcpServers.js';
import type { ToolResult } from '../sandbox.js';

const PluginIdSchema = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9_-]+$/);
const TrustLevelSchema = z.enum(['metadata', 'read_only', 'local_mutating', 'external_network']);
const HookEventSchema = z.enum([
  'PreRun',
  'PostOrchestrator',
  'PostPlan',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PreWrite',
  'PostRun',
]);

const PluginToolSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('static_json'),
    name: z
      .string()
      .min(1)
      .regex(/^[a-zA-Z0-9_-]+$/),
    description: z.string().min(1),
    trust_level: TrustLevelSchema.default('read_only'),
    payload: z.unknown().optional(),
  }),
  z.object({
    kind: z.literal('static_text'),
    name: z
      .string()
      .min(1)
      .regex(/^[a-zA-Z0-9_-]+$/),
    description: z.string().min(1),
    trust_level: TrustLevelSchema.default('read_only'),
    text: z.string(),
  }),
]);

const PluginSlashCommandSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('static_text'),
    name: z
      .string()
      .min(1)
      .regex(/^[a-zA-Z0-9_-]+$/),
    description: z.string().min(1),
    text: z.string(),
  }),
  z.object({
    kind: z.literal('static_json'),
    name: z
      .string()
      .min(1)
      .regex(/^[a-zA-Z0-9_-]+$/),
    description: z.string().min(1),
    payload: z.unknown(),
  }),
]);

const PluginPromptSkillSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9_-]+$/),
  title: z.string().min(1),
  description: z.string().min(1),
  content: z.string().min(1),
});

const PluginMcpServerSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9_-]+$/),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
});

const PluginHookSchema = z.object({
  event: HookEventSchema,
  tool: z.string().min(1).optional(),
  action: z.enum(['trim_trailing_whitespace']),
  description: z.string().optional(),
  trust_level: TrustLevelSchema.default('local_mutating'),
  dry_run_supported: z.boolean().default(true),
});

const PluginManifestSchema = z.object({
  schema_version: z.literal(1),
  id: PluginIdSchema,
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().optional(),
  trust_level: TrustLevelSchema.default('read_only'),
  tools: z.array(PluginToolSchema).default([]),
  slash_commands: z.array(PluginSlashCommandSchema).default([]),
  prompt_skills: z.array(PluginPromptSkillSchema).default([]),
  mcp_servers: z.array(PluginMcpServerSchema).default([]),
  hooks: z.array(PluginHookSchema).default([]),
});

const PluginConfigSchema = z.object({
  schema_version: z.literal(1).default(1),
  runtime_plugins_enabled: z.boolean().default(false),
  enabled_plugin_ids: z.array(PluginIdSchema).default([]),
  allowed_trust_levels: z.array(TrustLevelSchema).default(['metadata', 'read_only']),
  plugin_roots: z.array(z.string()).default([]),
});

export type PluginTrustLevel = z.infer<typeof TrustLevelSchema>;
export type PluginHookEvent = z.infer<typeof HookEventSchema>;
export type PluginManifest = z.infer<typeof PluginManifestSchema>;
export type PluginConfig = z.infer<typeof PluginConfigSchema>;

export interface PluginRuntimeOptions {
  babelRoot?: string;
  configPath?: string;
  pluginRoots?: string[];
}

export interface PluginDiagnostic {
  severity: 'info' | 'warn' | 'fail';
  code: string;
  message: string;
  plugin_id?: string | undefined;
  path?: string | undefined;
  event?: PluginHookEvent | undefined;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  manifest_path: string;
  active: boolean;
  enabled: boolean;
  blocked_reason?: string | undefined;
}

export interface PluginRegistry {
  status: 'ok' | 'warn' | 'fail';
  config_path: string;
  plugin_roots: string[];
  config: PluginConfig;
  plugins: LoadedPlugin[];
  diagnostics: PluginDiagnostic[];
}

export interface PluginHookContext {
  runId?: string | undefined;
  runDir?: string | undefined;
  babelRoot?: string | undefined;
  projectRoot?: string | undefined;
  shadowRoot?: string | null | undefined;
  dryRun?: boolean | undefined;
  stage?: string | undefined;
  status?: string | undefined;
  attempt?: number | undefined;
  task?: string | undefined;
  tool?: Record<string, unknown> | undefined;
  toolResult?: ToolResult | undefined;
  manifest?: unknown;
  plan?: unknown;
  error?: string | undefined;
}

export interface PluginHookRunResult {
  event: PluginHookEvent;
  diagnostics: PluginDiagnostic[];
  records: Array<Record<string, unknown>>;
}

export interface PluginToolCallRequest {
  tool: 'plugin_tool';
  plugin: string;
  name: string;
  input?: Record<string, unknown> | undefined;
}

function getBabelRoot(options: PluginRuntimeOptions = {}): string {
  return options.babelRoot ?? process.env['BABEL_ROOT'] ?? BABEL_ROOT;
}

function evaluatePluginPolicyForRoot(
  pluginId: string,
  trustLevel: PluginTrustLevel,
  options: PluginRuntimeOptions = {},
): EnterprisePolicyDecision {
  const loaded = loadEnterprisePolicy(getBabelRoot(options));
  if (loaded.errors.length > 0) {
    return {
      allowed: false,
      reason: `enterprise policy failed to load: ${loaded.errors[0]}`,
      policy_source: describeEnterprisePolicySource(loaded),
      fix_hint: 'Fix or remove the malformed enterprise policy source before retrying.',
    };
  }
  const decision = evaluatePluginPolicy(pluginId, trustLevel, loaded.policy);
  return decision.allowed
    ? decision
    : {
        ...decision,
        policy_source: describeEnterprisePolicySource(loaded),
      };
}

export function getPluginConfigPath(options: PluginRuntimeOptions = {}): string {
  return (
    options.configPath ??
    process.env['BABEL_PLUGINS_CONFIG'] ??
    join(getBabelRoot(options), 'babel-cli', 'config', 'plugins.json')
  );
}

function getDefaultPluginRoot(options: PluginRuntimeOptions = {}): string {
  return join(getBabelRoot(options), 'babel-cli', 'plugins');
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values.map((value) => resolve(value)))];
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
}

export function readPluginConfig(options: PluginRuntimeOptions = {}): PluginConfig {
  const configPath = getPluginConfigPath(options);
  if (!existsSync(configPath)) {
    return PluginConfigSchema.parse({});
  }

  try {
    const parsed = PluginConfigSchema.safeParse(readJsonFile(configPath));
    if (!parsed.success) {
      return PluginConfigSchema.parse({});
    }
    return parsed.data;
  } catch {
    return PluginConfigSchema.parse({});
  }
}

export function writePluginConfig(
  config: PluginConfig,
  options: PluginRuntimeOptions = {},
): PluginConfig {
  const configPath = getPluginConfigPath(options);
  const parsed = PluginConfigSchema.parse(config);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf-8');
  return parsed;
}

function getPluginRoots(config: PluginConfig, options: PluginRuntimeOptions = {}): string[] {
  const envRoots = process.env['BABEL_PLUGIN_ROOTS']
    ? process.env['BABEL_PLUGIN_ROOTS'].split(delimiter).filter(Boolean)
    : [];
  const explicitRoots = options.pluginRoots ?? [];
  const configRoots = config.plugin_roots.map((root) => resolve(getBabelRoot(options), root));
  return uniqueValues([
    getDefaultPluginRoot(options),
    ...configRoots,
    ...envRoots,
    ...explicitRoots,
  ]);
}

function discoverManifestPaths(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  const stats = statSync(root);
  if (!stats.isDirectory()) {
    return [];
  }

  const directManifest = join(root, 'plugin.json');
  if (existsSync(directManifest)) {
    return [directManifest];
  }

  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name, 'plugin.json'))
    .filter((path) => existsSync(path));
}

function worstRegistryStatus(diagnostics: PluginDiagnostic[]): 'ok' | 'warn' | 'fail' {
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'fail')) return 'fail';
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'warn')) return 'warn';
  return 'ok';
}

function pushDuplicateSurfaceDiagnostics(
  diagnostics: PluginDiagnostic[],
  manifest: PluginManifest,
  manifestPath: string,
): void {
  const surfaces = [
    { label: 'tool', values: manifest.tools.map((tool) => tool.name) },
    { label: 'slash_command', values: manifest.slash_commands.map((command) => command.name) },
    { label: 'prompt_skill', values: manifest.prompt_skills.map((skill) => skill.id) },
    { label: 'mcp_server', values: manifest.mcp_servers.map((server) => server.name) },
  ];

  for (const surface of surfaces) {
    const seen = new Set<string>();
    for (const value of surface.values) {
      if (seen.has(value)) {
        diagnostics.push({
          severity: 'warn',
          code: 'duplicate_plugin_surface',
          message: `Plugin "${manifest.id}" declares duplicate ${surface.label} name "${value}".`,
          plugin_id: manifest.id,
          path: manifestPath,
        });
        continue;
      }
      seen.add(value);
    }
  }
}

export function loadPluginRegistry(options: PluginRuntimeOptions = {}): PluginRegistry {
  const configPath = getPluginConfigPath(options);
  const config = readPluginConfig(options);
  const roots = getPluginRoots(config, options);
  const diagnostics: PluginDiagnostic[] = [];
  const seen = new Set<string>();
  const plugins: LoadedPlugin[] = [];

  for (const root of roots) {
    for (const manifestPath of discoverManifestPaths(root)) {
      try {
        const parsed = PluginManifestSchema.safeParse(readJsonFile(manifestPath));
        if (!parsed.success) {
          diagnostics.push({
            severity: 'fail',
            code: 'invalid_manifest',
            message: parsed.error.issues
              .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
              .join('; '),
            path: manifestPath,
          });
          continue;
        }

        const manifest = parsed.data;
        pushDuplicateSurfaceDiagnostics(diagnostics, manifest, manifestPath);
        if (seen.has(manifest.id)) {
          diagnostics.push({
            severity: 'warn',
            code: 'duplicate_plugin_id',
            message: `Duplicate plugin id "${manifest.id}" skipped.`,
            plugin_id: manifest.id,
            path: manifestPath,
          });
          continue;
        }
        seen.add(manifest.id);

        const enabled = config.enabled_plugin_ids.includes(manifest.id);
        let active = config.runtime_plugins_enabled && enabled;
        let blockedReason: string | undefined;
        if (active && !config.allowed_trust_levels.includes(manifest.trust_level)) {
          active = false;
          blockedReason = `trust_level ${manifest.trust_level} is not allowed by plugin config`;
          diagnostics.push({
            severity: 'warn',
            code: 'plugin_trust_blocked',
            message: `Plugin "${manifest.id}" is enabled but blocked because ${blockedReason}.`,
            plugin_id: manifest.id,
            path: manifestPath,
          });
        }
        if (active) {
          const enterpriseDecision = evaluatePluginPolicyForRoot(
            manifest.id,
            manifest.trust_level,
            options,
          );
          if (!enterpriseDecision.allowed) {
            active = false;
            blockedReason = formatEnterprisePolicyDecision(enterpriseDecision);
            diagnostics.push({
              severity: 'warn',
              code: 'plugin_enterprise_policy_blocked',
              message: `Plugin "${manifest.id}" is enabled but blocked because ${blockedReason}.`,
              plugin_id: manifest.id,
              path: manifestPath,
            });
          }
        }
        if (enabled && !config.runtime_plugins_enabled) {
          blockedReason = 'runtime_plugins_enabled is false';
        }

        plugins.push({
          manifest,
          manifest_path: manifestPath,
          active,
          enabled,
          ...(blockedReason ? { blocked_reason: blockedReason } : {}),
        });
      } catch (error) {
        diagnostics.push({
          severity: 'fail',
          code: 'manifest_read_error',
          message: error instanceof Error ? error.message : String(error),
          path: manifestPath,
        });
      }
    }
  }

  for (const id of config.enabled_plugin_ids) {
    if (!plugins.some((plugin) => plugin.manifest.id === id)) {
      diagnostics.push({
        severity: 'warn',
        code: 'enabled_plugin_missing',
        message: `Plugin "${id}" is enabled in config but no manifest was discovered.`,
        plugin_id: id,
      });
    }
  }

  return {
    status: worstRegistryStatus(diagnostics),
    config_path: configPath,
    plugin_roots: roots,
    config,
    plugins,
    diagnostics,
  };
}

export function enablePlugin(
  id: string,
  options: PluginRuntimeOptions & { allowTrust?: PluginTrustLevel | undefined } = {},
): PluginConfig {
  const registry = loadPluginRegistry(options);
  const plugin = registry.plugins.find((candidate) => candidate.manifest.id === id);
  if (!plugin) {
    throw new Error(`Plugin "${id}" was not found.`);
  }

  const enterpriseDecision = evaluatePluginPolicyForRoot(
    plugin.manifest.id,
    plugin.manifest.trust_level,
    options,
  );
  if (!enterpriseDecision.allowed) {
    throw new Error(`[ENTERPRISE_POLICY] ${formatEnterprisePolicyDecision(enterpriseDecision)}`);
  }

  const allowedTrust = new Set(registry.config.allowed_trust_levels);
  if (!allowedTrust.has(plugin.manifest.trust_level)) {
    if (options.allowTrust !== plugin.manifest.trust_level) {
      throw new Error(
        `Plugin "${id}" requires trust_level "${plugin.manifest.trust_level}". ` +
          `Re-run with --allow-trust ${plugin.manifest.trust_level}.`,
      );
    }
    allowedTrust.add(plugin.manifest.trust_level);
  }

  return writePluginConfig(
    {
      ...registry.config,
      runtime_plugins_enabled: true,
      enabled_plugin_ids: [...new Set([...registry.config.enabled_plugin_ids, id])],
      allowed_trust_levels: [...allowedTrust],
    },
    options,
  );
}

export function disablePlugin(id: string, options: PluginRuntimeOptions = {}): PluginConfig {
  const config = readPluginConfig(options);
  return writePluginConfig(
    {
      ...config,
      enabled_plugin_ids: config.enabled_plugin_ids.filter((candidate) => candidate !== id),
    },
    options,
  );
}

function pluginErrorResult(code: string, message: string, pluginId?: string): ToolResult {
  return {
    exit_code: 1,
    stdout: '',
    stderr: `[PLUGIN_ERROR] ${JSON.stringify({
      status: 'fail',
      code,
      message,
      ...(pluginId ? { plugin_id: pluginId } : {}),
    })}`,
  };
}

function renderTemplate(text: string, args: string[] = []): string {
  return text.replace(/\{args\}/g, args.join(' ')).replace(/\{arg_count\}/g, String(args.length));
}

function findActivePlugin(id: string, options: PluginRuntimeOptions = {}): LoadedPlugin | null {
  return (
    loadPluginRegistry(options).plugins.find(
      (plugin) => plugin.manifest.id === id && plugin.active,
    ) ?? null
  );
}

export async function handlePluginTool(
  req: PluginToolCallRequest,
  options: PluginRuntimeOptions = {},
): Promise<ToolResult> {
  const plugin = findActivePlugin(req.plugin, options);
  if (!plugin) {
    return pluginErrorResult(
      'plugin_not_active',
      `Plugin "${req.plugin}" is not active.`,
      req.plugin,
    );
  }

  const tool = plugin.manifest.tools.find((candidate) => candidate.name === req.name);
  if (!tool) {
    return pluginErrorResult(
      'plugin_tool_not_found',
      `Plugin tool "${req.name}" was not found.`,
      req.plugin,
    );
  }

  if (tool.kind === 'static_text') {
    return {
      exit_code: 0,
      stdout: renderTemplate(tool.text, []),
      stderr: '',
    };
  }

  return {
    exit_code: 0,
    stdout: JSON.stringify(
      {
        status: 'success',
        plugin_id: plugin.manifest.id,
        tool: tool.name,
        input: req.input ?? {},
        output: tool.payload ?? null,
      },
      null,
      2,
    ),
    stderr: '',
  };
}

export async function runPluginCommand(
  pluginId: string,
  commandName: string,
  args: string[] = [],
  options: PluginRuntimeOptions = {},
): Promise<ToolResult> {
  const plugin = findActivePlugin(pluginId, options);
  if (!plugin) {
    return pluginErrorResult('plugin_not_active', `Plugin "${pluginId}" is not active.`, pluginId);
  }

  const command = plugin.manifest.slash_commands.find(
    (candidate) => candidate.name === commandName,
  );
  if (!command) {
    return pluginErrorResult(
      'plugin_command_not_found',
      `Plugin command "${commandName}" was not found.`,
      pluginId,
    );
  }

  if (command.kind === 'static_text') {
    return {
      exit_code: 0,
      stdout: renderTemplate(command.text, args),
      stderr: '',
    };
  }

  return {
    exit_code: 0,
    stdout: JSON.stringify(
      {
        status: 'success',
        plugin_id: plugin.manifest.id,
        command: command.name,
        args,
        output: command.payload,
      },
      null,
      2,
    ),
    stderr: '',
  };
}

function appendPluginHookRecord(runDir: string | undefined, record: Record<string, unknown>): void {
  if (!runDir) {
    return;
  }
  mkdirSync(runDir, { recursive: true });
  appendFileSync(join(runDir, '09_plugin_events.jsonl'), `${JSON.stringify(record)}\n`, 'utf-8');
}

function resolveHookTargetPath(context: PluginHookContext): string {
  const rawPath = context.tool?.['path'];
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    throw new Error('trim_trailing_whitespace hook requires a tool.path string.');
  }

  const projectRoot = resolve(context.projectRoot ?? process.cwd());
  const projectPath = resolve(projectRoot, rawPath);
  const relativePath = relative(projectRoot, projectPath);
  if (relativePath.startsWith('..') || relativePath === '..' || relativePath === '') {
    if (relativePath === '') {
      return context.shadowRoot ? resolve(context.shadowRoot) : projectRoot;
    }
    throw new Error(`Hook target escapes project root: ${rawPath}`);
  }

  return context.shadowRoot ? resolve(context.shadowRoot, relativePath) : projectPath;
}

function trimTrailingWhitespace(content: string): { content: string; changed: boolean } {
  const normalized = content.replace(/[ \t]+(\r?\n)/g, '$1').replace(/[ \t]+$/g, '');
  return {
    content: normalized,
    changed: normalized !== content,
  };
}

function runTrimTrailingWhitespaceHook(context: PluginHookContext): Record<string, unknown> {
  const targetPath = resolveHookTargetPath(context);
  if (context.toolResult && context.toolResult.exit_code !== 0) {
    return {
      status: 'skipped',
      reason: 'tool_failed',
      target_path: targetPath,
    };
  }
  if (context.dryRun && !context.shadowRoot) {
    return {
      status: 'skipped',
      reason: 'dry_run_without_shadow_root',
      target_path: targetPath,
    };
  }
  if (!existsSync(targetPath)) {
    return {
      status: 'skipped',
      reason: 'target_missing',
      target_path: targetPath,
    };
  }

  const content = readFileSync(targetPath, 'utf-8');
  const formatted = trimTrailingWhitespace(content);
  const beforeHash = hashContent(content);
  const afterHash = hashContent(formatted.content);
  const beforeBytes = Buffer.byteLength(content, 'utf8');
  const afterBytes = Buffer.byteLength(formatted.content, 'utf8');
  if (!formatted.changed) {
    return {
      status: 'unchanged',
      target_path: targetPath,
      before_hash: beforeHash,
      after_hash: afterHash,
      changed_bytes: 0,
    };
  }
  // Phase 3d: Resolve symlinks and verify containment before writing.
  // Previously writeFileSync bypassed SafeExecutor entirely — a symlink
  // could redirect the write outside the project root.
  let resolvedTarget: string;
  try {
    resolvedTarget = realpathSync(targetPath);
  } catch {
    // File doesn't exist or can't be resolved — use the original path.
    // The existence check above guarantees the file is present, so
    // realpathSync failure means a broken symlink or permission issue.
    resolvedTarget = targetPath;
  }
  // Use shadow root as containment boundary when set (dry-run mode);
  // otherwise use project root.
  const containmentRoot = resolve(context.shadowRoot ?? context.projectRoot ?? process.env['BABEL_PROJECT_ROOT'] ?? process.cwd());
  if (!resolvedTarget.startsWith(containmentRoot + sep) && resolvedTarget !== containmentRoot) {
    return {
      status: 'skipped',
      reason: 'path_containment_violation',
      target_path: targetPath,
    };
  }

  writeFileSync(resolvedTarget, formatted.content, 'utf-8');
  return {
    status: 'changed',
    target_path: targetPath,
    before_hash: beforeHash,
    after_hash: afterHash,
    changed_bytes: Math.abs(afterBytes - beforeBytes),
  };
}

export async function runPluginHooks(
  event: PluginHookEvent,
  context: PluginHookContext,
  options: PluginRuntimeOptions = {},
): Promise<PluginHookRunResult> {
  const registry = loadPluginRegistry(options);
  const records: Array<Record<string, unknown>> = [];
  const diagnostics: PluginDiagnostic[] = [];
  if (!registry.config.runtime_plugins_enabled) {
    return { event, diagnostics, records };
  }

  for (const plugin of registry.plugins.filter((candidate) => candidate.active)) {
    for (const hook of plugin.manifest.hooks) {
      if (hook.event !== event) {
        continue;
      }
      if (hook.tool && hook.tool !== context.tool?.['tool']) {
        continue;
      }
      if (context.dryRun && !hook.dry_run_supported) {
        continue;
      }

      const baseRecord = {
        ts: new Date().toISOString(),
        event,
        plugin_id: plugin.manifest.id,
        hook_action: hook.action,
        tool: context.tool?.['tool'] ?? null,
        run_id: context.runId ?? null,
      };

      try {
        const outcome =
          hook.action === 'trim_trailing_whitespace'
            ? runTrimTrailingWhitespaceHook(context)
            : { status: 'skipped', reason: 'unsupported_action' };
        const record = {
          ...baseRecord,
          outcome,
        };
        records.push(record);
        appendPluginHookRecord(context.runDir, record);
      } catch (error) {
        const diagnostic: PluginDiagnostic = {
          severity: 'warn',
          code: 'plugin_hook_error',
          message: error instanceof Error ? error.message : String(error),
          plugin_id: plugin.manifest.id,
          event,
        };
        diagnostics.push(diagnostic);
        const record = {
          ...baseRecord,
          outcome: {
            status: 'failed',
            diagnostic,
          },
        };
        records.push(record);
        appendPluginHookRecord(context.runDir, record);
      }
    }
  }

  return { event, diagnostics, records };
}

export function readActivePluginMcpServers(
  options: PluginRuntimeOptions = {},
): Record<string, McpServerConfig> {
  const registry = loadPluginRegistry(options);
  const servers: Record<string, McpServerConfig> = {};
  if (!registry.config.runtime_plugins_enabled) {
    return servers;
  }

  for (const plugin of registry.plugins.filter((candidate) => candidate.active)) {
    for (const server of plugin.manifest.mcp_servers) {
      servers[`${plugin.manifest.id}_${server.name}`] = {
        command: server.command,
        args: server.args,
      };
    }
  }
  return servers;
}

export function formatPluginListHuman(registry: PluginRegistry): string {
  const lines = [
    'Babel Plugins',
    `Status: ${registry.status}`,
    `Runtime enabled: ${registry.config.runtime_plugins_enabled}`,
    `Config: ${registry.config_path}`,
    '',
  ];

  for (const plugin of registry.plugins) {
    const state = plugin.active ? 'active' : plugin.enabled ? 'enabled-blocked' : 'disabled';
    lines.push(
      `${plugin.manifest.id.padEnd(24)} ${state.padEnd(15)} ${plugin.manifest.trust_level}  ${plugin.manifest.name}`,
    );
    if (plugin.blocked_reason) {
      lines.push(`  - ${plugin.blocked_reason}`);
    }
  }
  if (registry.plugins.length === 0) {
    lines.push('(no plugin manifests discovered)');
  }
  return lines.join('\n');
}

export function formatPluginInspectHuman(plugin: LoadedPlugin): string {
  const manifest = plugin.manifest;
  return [
    `Plugin: ${manifest.id}`,
    `Name: ${manifest.name}`,
    `Version: ${manifest.version}`,
    `Trust: ${manifest.trust_level}`,
    `State: ${plugin.active ? 'active' : plugin.enabled ? 'enabled-blocked' : 'disabled'}`,
    `Path: ${plugin.manifest_path}`,
    manifest.description ? `Description: ${manifest.description}` : null,
    `Tools: ${manifest.tools.map((tool) => tool.name).join(', ') || '(none)'}`,
    `Slash commands: ${manifest.slash_commands.map((command) => command.name).join(', ') || '(none)'}`,
    `Prompt skills: ${manifest.prompt_skills.map((skill) => skill.id).join(', ') || '(none)'}`,
    `MCP bundles: ${manifest.mcp_servers.map((server) => server.name).join(', ') || '(none)'}`,
    `Hooks: ${manifest.hooks.map((hook) => `${hook.event}:${hook.action}`).join(', ') || '(none)'}`,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

export function formatPluginDoctorHuman(registry: PluginRegistry): string {
  const lines = [
    'Babel Plugin Doctor',
    `Status: ${registry.status}`,
    `Runtime enabled: ${registry.config.runtime_plugins_enabled}`,
    `Allowed trust: ${registry.config.allowed_trust_levels.join(', ')}`,
    `Discovered plugins: ${registry.plugins.length}`,
    '',
  ];
  for (const diagnostic of registry.diagnostics) {
    lines.push(`${diagnostic.severity.toUpperCase()} ${diagnostic.code}: ${diagnostic.message}`);
  }
  if (registry.diagnostics.length === 0) {
    lines.push('No plugin diagnostics.');
  }
  return lines.join('\n');
}
