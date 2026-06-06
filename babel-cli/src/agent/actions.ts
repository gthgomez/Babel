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
  | { type: 'write_file'; path: string; content: string }
  | { type: 'apply_patch'; patch: string }
  | { type: 'run_command'; command: string; cwd?: string }
  | { type: 'finish'; summary: string; verification: string[] }
  | { type: 'ask_approval'; reason: string; requested_action: AgentAction };

export interface ActionParser {
  parse(output: string): AgentAction[];
}

export class AgentActionParseError extends Error {
  constructor(message: string, readonly details?: unknown) {
    super(message);
    this.name = 'AgentActionParseError';
  }
}

const AgentActionSchema = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('read_file'),
      path: z.string().min(1),
    }),
    z.object({
      type: z.literal('list_dir'),
      path: z.string().min(1),
    }),
    z.object({
      type: z.literal('search'),
      query: z.string().min(1),
    }),
    z.object({
      type: z.literal('write_file'),
      path: z.string().min(1),
      content: z.string(),
    }),
    z.object({
      type: z.literal('apply_patch'),
      patch: z.string().min(1),
    }),
    z
      .object({
        type: z.literal('run_command'),
        command: z.string().min(1),
        cwd: z.string().min(1).optional(),
      })
      .transform(({ cwd, type, command }) => (
        cwd
          ? { type, command, cwd }
          : { type, command }
      )),
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
    ? value as RawActionRecord
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
          next.verification = commands.filter((entry): entry is string => typeof entry === 'string');
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

export const agentActionParser: ActionParser = {
  parse(output: string): AgentAction[] {
    return parseAgentActions(output);
  },
};

/** @deprecated Use `agentActionParser` or `parseAgentActions()` instead. */
export const placeholderActionParser: ActionParser = agentActionParser;
