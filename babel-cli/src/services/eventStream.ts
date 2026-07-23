import { createWriteStream, type WriteStream, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { BabelEventBus } from '../pipeline.js';
import { buildRuntimeProtocolContract, type BabelRuntimeEvent } from '../runtime/protocol.js';

export const BABEL_EVENT_STREAM_SCHEMA_VERSION = 3;

export type EventStreamApprovalActions = 'not_supported' | 'session_only' | 'supported';
export type EventStreamHostMode = 'enhanced_repl' | 'external_host_pending';

export interface EventStreamContract {
  schema_version: 1;
  contract_id: 'babel.event_stream';
  event_schema_version: typeof BABEL_EVENT_STREAM_SCHEMA_VERSION;
  format: 'jsonl';
  read_only: true;
  run_command_flag: '--events-jsonl <path>';
  required_fields: string[];
  event_types: string[];
  payload_contracts: Record<string, string[]>;
  bridge_policy: {
    intended_consumers: string[];
    mutates_workspace: false;
    mutates_git: false;
    remote_side_effects: false;
    host_mode: EventStreamHostMode;
    approval_actions: EventStreamApprovalActions;
    approval_semantics: string;
  };
}

export interface JsonEventStream {
  path: string;
  write(event: string, data?: Record<string, unknown>): void;
  close(final?: Record<string, unknown>): void | Promise<void>;
}

export function buildEventStreamContract(): EventStreamContract {
  return {
    schema_version: 1,
    contract_id: 'babel.event_stream',
    event_schema_version: BABEL_EVENT_STREAM_SCHEMA_VERSION,
    format: 'jsonl',
    read_only: true,
    run_command_flag: '--events-jsonl <path>',
    required_fields: [
      'schema_version',
      'source',
      'sequence',
      'ts',
      'event',
      'event_type',
      'payload',
    ],
    event_types: [
      'babel.stream.started',
      'babel.stage.changed',
      'babel.agent.changed',
      'babel.log.line',
      'babel.assistant.chunk',
      'babel.runtime.event',
      'babel.run.result',
      'babel.run.error',
      'babel.stream.ended',
      'babel.policy.decision',
      'babel.policy.violation',
      'babel.hook.fired',
    ],
    payload_contracts: {
      'babel.stream.started': [],
      'babel.stage.changed': ['stage'],
      'babel.agent.changed': ['agent_id'],
      'babel.log.line': ['line'],
      'babel.assistant.chunk': ['chunk', 'turn_id'],
      'babel.runtime.event': ['protocol_version', 'event_type', 'payload'],
      'babel.run.result': ['run_dir', 'status'],
      'babel.run.error': ['error'],
      'babel.stream.ended': ['status', 'run_dir'],
      'babel.policy.decision': ['decision', 'tool', 'reason'],
      'babel.policy.violation': ['violation_type', 'tool', 'target', 'message'],
      'babel.hook.fired': ['hook_event', 'hook_id', 'decision', 'message'],
    },
    bridge_policy: {
      intended_consumers: ['ide_extension', 'local_webview', 'static_evidence_viewer'],
      mutates_workspace: false,
      mutates_git: false,
      remote_side_effects: false,
      host_mode: 'enhanced_repl',
      approval_actions: 'session_only',
      approval_semantics:
        'Approve/deny is available only inside the interactive REPL via the stdin coordinator and checklist pause-resume flow. JSONL consumers remain read-only and must not mutate workspace state.',
    },
  };
}

export function buildRuntimeEventStreamContract(): ReturnType<typeof buildRuntimeProtocolContract> {
  return buildRuntimeProtocolContract();
}

export function createJsonEventStream(
  path: string,
  options: {
    bus?: BabelEventBus;
    runLabel?: string;
  } = {},
): JsonEventStream {
  const resolvedPath = resolve(path);
  mkdirSync(dirname(resolvedPath), { recursive: true });
  const stream: WriteStream = createWriteStream(resolvedPath, { flags: 'a', encoding: 'utf-8' });
  let sequence = 0;
  let closed = false;
  let errored = false;

  // Prevent unhandled async I/O errors (disk full, permission denied) from
  // crashing the process. Once errored, all writes become no-ops.
  stream.on('error', (err) => {
    errored = true;
    console.warn('[eventStream] stream error:', (err as Error).message ?? err);
  });

  const write = (event: string, data: Record<string, unknown> = {}): boolean => {
    if (closed || errored) return false;
    try {
      return stream.write(
        `${JSON.stringify({
          schema_version: BABEL_EVENT_STREAM_SCHEMA_VERSION,
          source: 'babel-cli',
          sequence: ++sequence,
          ts: new Date().toISOString(),
          event,
          event_type: event,
          ...(options.runLabel ? { run_label: options.runLabel } : {}),
          payload: data,
        })}\n`,
        'utf-8',
      );
    } catch (err) {
      errored = true;
      console.warn('[eventStream] write error:', err);
      return false;
    }
  };

  const onStage = (stage: number): void => {
    void write('babel.stage.changed', { stage });
  };
  const onAgent = (agent_id: string): void => {
    void write('babel.agent.changed', { agent_id });
  };
  const onLog = (line: string): void => {
    void write('babel.log.line', { line });
  };
  const onAssistantChunk = (payload: { chunk: string; turn_id?: number }): void => {
    void write('babel.assistant.chunk', {
      chunk: payload.chunk,
      ...(payload.turn_id !== undefined ? { turn_id: payload.turn_id } : {}),
    });
  };
  const onRuntimeEvent = (event: BabelRuntimeEvent): void => {
    void write('babel.runtime.event', {
      protocol_version: event.protocol_version,
      event_type: event.event_type,
      payload: event.payload,
    });
  };

  options.bus?.on('stage', onStage);
  options.bus?.on('agent_id', onAgent);
  options.bus?.on('log', onLog);
  options.bus?.on('assistant_chunk', onAssistantChunk);
  options.bus?.on('runtime_event', onRuntimeEvent);

  write('babel.stream.started');

  return {
    path: resolvedPath,
    write,
    close(final: Record<string, unknown> = {}) {
      if (closed) return undefined;
      write('babel.stream.ended', final);
      closed = true;
      return new Promise<void>((resolve) => {
        options.bus?.off('stage', onStage);
        options.bus?.off('agent_id', onAgent);
        options.bus?.off('log', onLog);
        options.bus?.off('assistant_chunk', onAssistantChunk);
        options.bus?.off('runtime_event', onRuntimeEvent);
        stream.end(resolve);
      });
    },
  };
}
