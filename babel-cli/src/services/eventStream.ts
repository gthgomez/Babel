import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { BabelEventBus } from '../pipeline.js';
import {
  buildRuntimeProtocolContract,
  type BabelRuntimeEvent,
} from '../runtime/protocol.js';

export const BABEL_EVENT_STREAM_SCHEMA_VERSION = 3;

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
    approval_actions: 'not_supported';
  };
}

export interface JsonEventStream {
  path: string;
  write(event: string, data?: Record<string, unknown>): void;
  close(final?: Record<string, unknown>): void;
}

export function buildEventStreamContract(): EventStreamContract {
  return {
    schema_version: 1,
    contract_id: 'babel.event_stream',
    event_schema_version: BABEL_EVENT_STREAM_SCHEMA_VERSION,
    format: 'jsonl',
    read_only: true,
    run_command_flag: '--events-jsonl <path>',
    required_fields: ['schema_version', 'source', 'sequence', 'ts', 'event', 'event_type', 'payload'],
    event_types: [
      'babel.stream.started',
      'babel.stage.changed',
      'babel.agent.changed',
      'babel.log.line',
      'babel.runtime.event',
      'babel.run.result',
      'babel.run.error',
      'babel.stream.ended',
    ],
    payload_contracts: {
      'babel.stream.started': [],
      'babel.stage.changed': ['stage'],
      'babel.agent.changed': ['agent_id'],
      'babel.log.line': ['line'],
      'babel.runtime.event': ['protocol_version', 'event_type', 'payload'],
      'babel.run.result': ['run_dir', 'status'],
      'babel.run.error': ['error'],
      'babel.stream.ended': ['status', 'run_dir'],
    },
    bridge_policy: {
      intended_consumers: ['ide_extension', 'local_webview', 'static_evidence_viewer'],
      mutates_workspace: false,
      mutates_git: false,
      remote_side_effects: false,
      approval_actions: 'not_supported',
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
  let sequence = 0;

  const write = (event: string, data: Record<string, unknown> = {}): void => {
    appendFileSync(resolvedPath, `${JSON.stringify({
      schema_version: BABEL_EVENT_STREAM_SCHEMA_VERSION,
      source: 'babel-cli',
      sequence: ++sequence,
      ts: new Date().toISOString(),
      event,
      event_type: event,
      ...(options.runLabel ? { run_label: options.runLabel } : {}),
      payload: data,
    })}\n`, 'utf8');
  };

  const onStage = (stage: number): void => write('babel.stage.changed', { stage });
  const onAgent = (agent_id: string): void => write('babel.agent.changed', { agent_id });
  const onLog = (line: string): void => write('babel.log.line', { line });
  const onRuntimeEvent = (event: BabelRuntimeEvent): void => write('babel.runtime.event', {
    protocol_version: event.protocol_version,
    event_type: event.event_type,
    payload: event.payload,
  });

  options.bus?.on('stage', onStage);
  options.bus?.on('agent_id', onAgent);
  options.bus?.on('log', onLog);
  options.bus?.on('runtime_event', onRuntimeEvent);

  write('babel.stream.started');
  let closed = false;

  return {
    path: resolvedPath,
    write,
    close(final: Record<string, unknown> = {}) {
      if (closed) {
        return;
      }
      closed = true;
      write('babel.stream.ended', final);
      options.bus?.off('stage', onStage);
      options.bus?.off('agent_id', onAgent);
      options.bus?.off('log', onLog);
      options.bus?.off('runtime_event', onRuntimeEvent);
    },
  };
}
