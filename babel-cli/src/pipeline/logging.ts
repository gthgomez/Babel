import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import type { WriteStream } from 'node:fs';

import {
  makeRuntimeEvent,
  type BabelRuntimeEvent,
  type BabelRuntimeEventType,
} from '../runtime/protocol.js';

interface PipelineLogContext {
  stream: WriteStream;
  eventBus?: BabelEventBus;
}

const logContext = new AsyncLocalStorage<PipelineLogContext>();

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}

/**
 * Scoped event bus for a single runBabelPipeline invocation.
 */
export class BabelEventBus extends EventEmitter {
  stage(index: 1 | 2 | 3 | 4): void {
    this.emit('stage', index);
  }
  agentId(id: string): void {
    this.emit('agent_id', id);
  }
  logLine(line: string): void {
    this.emit('log', line);
  }
  runtimeEvent(eventType: BabelRuntimeEventType, payload: Record<string, unknown> = {}): void {
    this.emit('runtime_event', makeRuntimeEvent(eventType, payload));
  }
  runtimeProtocolEvent(event: BabelRuntimeEvent): void {
    this.emit('runtime_event', event);
  }
  promptPause(label: string): void {
    this.emit('prompt_pause', label);
  }
  promptResume(): void {
    this.emit('prompt_resume');
  }
}

export function log(msg: string): void {
  const t = new Date().toLocaleTimeString('en-US', { hour12: false });
  const line = `[babel] ${t}  ${msg}`;
  const store = logContext.getStore();
  if (store?.stream) {
    store.stream.write(`${stripAnsi(line)}\n`);
  }
  if (store?.eventBus) {
    store.eventBus.logLine(line);
  } else {
    console.log(line);
  }
}

export function logDetail(msg: string): void {
  const t = new Date().toLocaleTimeString('en-US', { hour12: false });
  const line = `[babel] ${t}    ${msg}`;
  const store = logContext.getStore();
  if (store?.stream) {
    store.stream.write(`${stripAnsi(line)}\n`);
  }
  if (store?.eventBus) {
    store.eventBus.logLine(line);
  } else {
    console.log(line);
  }
}

export function emitRuntimeEvent(eventType: BabelRuntimeEventType, payload: Record<string, unknown> = {}): void {
  logContext.getStore()?.eventBus?.runtimeEvent(eventType, payload);
}

export function runWithPipelineLogContext<T>(
  context: PipelineLogContext,
  runLogic: () => Promise<T>,
): Promise<T> {
  return logContext.run(context, runLogic);
}
