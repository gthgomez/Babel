/**
 * Normalized agent action protocol — stable Wave 1 contract for Lite agent loop.
 *
 * Provider models emit JSON; `parseAgentActions()` normalizes aliases and returns
 * `AgentAction[]`. Execution mapping to `executeTool` lives in `toolExecutor.ts`.
 */

import { z } from 'zod';

import { extractJson } from '../utils/extractJson.js';

/** Canonical agent actions — coordinate changes with provider adapter (Agent C). */
export type AgentAction =
  | { type: 'read_file'; path: string }
  | { type: 'list_dir'; path: string }
  | { type: 'search'; query: string }
  | { type: 'grep'; pattern: string; path?: string }
  | { type: 'glob'; pattern: string }
  | { type: 'write_file'; path: string; content: string }
  | { type: 'apply_patch'; patch: string }
  | { type: 'run_command'; command: string; cwd?: string }
  | {
      type: 'git_context';
      format?: 'summary' | 'files' | 'diff';
      path?: string;
      max_lines?: number;
    }
  | { type: 'test_run'; command: string; cwd?: string; timeout_seconds?: number }
  | { type: 'finish'; summary: string; verification: string[] }
  | { type: 'ask_approval'; reason: string; requested_action: AgentAction }
  | { type: 'workspace_map'; max_depth?: number; max_files?: number };

export interface ActionParser {
  parse(output: string): AgentAction[];
}

export class AgentActionParseError extends Error {
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AgentActionParseError';
  }
}

// ── Shared base action schemas — single source of truth for agent tool shapes.
// ChatToolActionSchema (chat mode) and AgentActionSchema (governed pipeline) both
// compose from these. Keep transforms out of the base schemas so they compose
// without unintended side effects.

export const BaseReadFileSchema = z.object({
  type: z.literal('read_file'),
  path: z.string().min(1),
});

export const BaseListDirSchema = z.object({
  type: z.literal('list_dir'),
  path: z.string().min(1),
});

export const BaseGrepSchema = z.object({
  type: z.literal('grep'),
  pattern: z.string().min(1),
  path: z.string().min(1).optional(),
});

export const BaseGlobSchema = z.object({
  type: z.literal('glob'),
  pattern: z.string().min(1),
});

export const BaseWriteFileSchema = z.object({
  type: z.literal('write_file'),
  path: z.string().min(1),
  content: z.string(),
});

export const BaseApplyPatchSchema = z.object({
  type: z.literal('apply_patch'),
  patch: z.string().min(1),
});

export const BaseRunCommandSchema = z.object({
  type: z.literal('run_command'),
  command: z.string().min(1),
  cwd: z.string().min(1).optional(),
});

export const BaseSemanticSearchSchema = z.object({
  type: z.literal('semantic_search'),
  query: z.string().min(1),
  limit: z.number().int().optional(),
});

export const BaseGitContextSchema = z.object({
  type: z.literal('git_context'),
  format: z.enum(['summary', 'files', 'diff']).optional(),
  path: z.string().optional(),
  max_lines: z.number().int().optional(),
});

export const BaseTestRunSchema = z.object({
  type: z.literal('test_run'),
  command: z.string().min(1),
  cwd: z.string().min(1).optional(),
  timeout_seconds: z.number().int().optional(),
});

const AgentActionSchema = z.lazy(() =>
  z.discriminatedUnion('type', [
    BaseReadFileSchema,
    BaseListDirSchema,
    z.object({
      type: z.literal('search'),
      query: z.string().min(1),
    }),
    BaseGrepSchema.transform(({ path, type, pattern }) =>
      path ? { type, pattern, path } : { type, pattern },
    ),
    BaseGlobSchema,
    BaseWriteFileSchema,
    BaseApplyPatchSchema,
    BaseRunCommandSchema.transform(({ cwd, type, command }) =>
      cwd ? { type, command, cwd } : { type, command },
    ),
    BaseGitContextSchema,
    BaseTestRunSchema.transform(({ cwd, type, command, timeout_seconds }) => ({
      type,
      command,
      ...(cwd ? { cwd } : {}),
      ...(timeout_seconds !== undefined ? { timeout_seconds } : {}),
    })),
    z.object({
      type: z.literal('finish'),
      summary: z.string().min(1),
      verification: z.array(z.string()).default([]),
    }),
    z.object({
      type: z.literal('ask_approval'),
      reason: z.string().min(1),
      requested_action: AgentActionSchema,
    }),
    z.object({
      type: z.literal('workspace_map'),
      max_depth: z.number().int().optional(),
      max_files: z.number().int().optional(),
    }),
  ]),
) as z.ZodType<AgentAction>;

const ProviderActionEnvelopeSchema = z.union([
  z.array(AgentActionSchema),
  z.object({ actions: z.array(AgentActionSchema).min(1) }),
  z.object({ action: AgentActionSchema }),
  AgentActionSchema,
]);

type RawActionRecord = Record<string, unknown>;

function asRecord(value: unknown): RawActionRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RawActionRecord)
    : null;
}

function readString(record: RawActionRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function normalizeProviderAction(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) {
    return value;
  }

  const type = readString(record, ['type', 'action', 'tool']);
  if (!type) {
    return value;
  }

  const normalizedType = type.trim().toLowerCase();
  const next: RawActionRecord = { ...record, type: normalizedType };

  switch (normalizedType) {
    case 'file_read':
      next.type = 'read_file';
      if (next.path === undefined) {
        next.path = readString(record, ['file', 'filepath', 'target']);
      }
      break;
    case 'directory_list':
      next.type = 'list_dir';
      if (next.path === undefined) {
        next.path = readString(record, ['dir', 'directory']) ?? '.';
      }
      break;
    case 'semantic_search':
    case 'web_search':
      next.type = 'search';
      if (next.query === undefined) {
        next.query = readString(record, ['q', 'text']);
      }
      break;
    case 'grep':
    case 'ripgrep':
    case 'file_grep':
      next.type = 'grep';
      if (next.pattern === undefined) {
        next.pattern = readString(record, ['query', 'q', 'text']);
      }
      if (next.path === undefined) {
        next.path = readString(record, ['target', 'file', 'filepath']);
      }
      break;
    case 'glob':
    case 'glob_file':
    case 'glob_paths':
      next.type = 'glob';
      if (next.pattern === undefined) {
        next.pattern = readString(record, ['query', 'q', 'path', 'target']);
      }
      break;
    case 'file_write':
      next.type = 'write_file';
      if (next.path === undefined) {
        next.path = readString(record, ['file', 'filepath', 'target']);
      }
      if (next.content === undefined && typeof record.body === 'string') {
        next.content = record.body;
      }
      break;
    case 'shell_exec':
    case 'test_run':
      next.type = 'run_command';
      if (next.command === undefined) {
        next.command = readString(record, ['cmd', 'shell']);
      }
      if (next.cwd === undefined) {
        next.cwd = readString(record, ['working_directory', 'workdir']);
      }
      break;
    case 'ask_approval':
      if (next.requested_action === undefined && record.request !== undefined) {
        next.requested_action = record.request;
      }
      break;
    case 'finish':
      if (!Array.isArray(next.verification)) {
        const commands = record.verification_commands ?? record.commands;
        if (Array.isArray(commands)) {
          next.verification = commands.filter(
            (entry): entry is string => typeof entry === 'string',
          );
        }
      }
      break;
    default:
      break;
  }

  if (next.requested_action !== undefined) {
    next.requested_action = normalizeProviderAction(next.requested_action);
  }

  return next;
}

function normalizeProviderEnvelope(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeProviderAction(entry));
  }

  const record = asRecord(value);
  if (!record) {
    return value;
  }

  if (Array.isArray(record.actions)) {
    return {
      ...record,
      actions: record.actions.map((entry) => normalizeProviderAction(entry)),
    };
  }

  if (record.action !== undefined) {
    return {
      ...record,
      action: normalizeProviderAction(record.action),
    };
  }

  return normalizeProviderAction(record);
}

function unwrapActionEnvelope(value: unknown): AgentAction[] {
  const parsed = ProviderActionEnvelopeSchema.parse(value);
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if ('actions' in parsed) {
    return parsed.actions;
  }
  if ('action' in parsed) {
    return [parsed.action];
  }
  return [parsed];
}

/**
 * Parse provider JSON (raw string or pre-parsed value) into normalized actions.
 */
export function parseAgentActions(output: string | unknown): AgentAction[] {
  let payload: unknown;
  if (typeof output === 'string') {
    try {
      payload = extractJson(output);
    } catch (error) {
      throw new AgentActionParseError('Provider output did not contain parseable JSON.', error);
    }
  } else {
    payload = output;
  }

  const normalized = normalizeProviderEnvelope(payload);

  try {
    return unwrapActionEnvelope(normalized);
  } catch (error) {
    throw new AgentActionParseError('Provider JSON did not match the AgentAction protocol.', error);
  }
}

export const AgentActionsEnvelopeSchema = z.object({
  actions: z.array(AgentActionSchema).min(1).max(12),
});

export type AgentActionsEnvelope = z.infer<typeof AgentActionsEnvelopeSchema>;

export const agentActionParser: ActionParser = {
  parse(output: string): AgentAction[] {
    return parseAgentActions(output);
  },
};

/** @deprecated Use `agentActionParser` or `parseAgentActions()` instead. */
export const placeholderActionParser: ActionParser = agentActionParser;
