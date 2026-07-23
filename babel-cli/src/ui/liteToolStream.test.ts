import assert from 'node:assert/strict';
import test from 'node:test';

import { BabelEventBus } from '../pipeline/logging.js';
import { createLiteToolStreamSink } from './liteToolStream.js';

test('createLiteToolStreamSink forwards tool events to progress and event bus', () => {
  const progressEvents: string[] = [];
  const bus = new BabelEventBus();
  const runtimeEvents: Array<{ event_type: string; payload: Record<string, unknown> }> = [];
  const logLines: string[] = [];

  bus.on('runtime_event', (event) => {
    runtimeEvents.push(event);
  });
  bus.on('log', (line) => {
    logLines.push(line);
  });

  const sink = createLiteToolStreamSink({
    progress: {
      reportToolCall(event) {
        progressEvents.push(`${event.tool}:${event.status}`);
      },
    },
    eventBus: bus,
  });

  sink.emit({ tool: 'file_read', target: 'src/math.js', status: 'running', phase: 'discover' });
  sink.emit({ tool: 'file_read', target: 'src/math.js', status: 'pass', phase: 'discover' });

  assert.deepEqual(progressEvents, ['file_read:running', 'file_read:pass']);
  assert.equal(runtimeEvents.length, 2);
  assert.equal(runtimeEvents[0]?.event_type, 'tool.requested');
  assert.equal(runtimeEvents[1]?.event_type, 'tool.completed');
  assert.equal(runtimeEvents[1]?.payload['status'], 'pass');
  assert.ok(logLines.some((line) => line.includes('file_read')));
});

test('createLiteToolStreamSink falls back to discover stage when reportToolCall is absent', () => {
  const discoverLines: string[] = [];
  const sink = createLiteToolStreamSink({
    progress: {
      report(stage: string, detail?: string) {
        discoverLines.push(`${stage}:${detail ?? ''}`);
      },
    } as import('./liteToolStream.js').LiteToolStreamConsumer & {
      report(stage: string, detail?: string): void;
    },
  });

  sink.emit({ tool: 'grep', target: 'add', status: 'fail' });

  assert.equal(discoverLines.length, 1);
  assert.match(discoverLines[0] ?? '', /grep add \(fail\)/);
});
