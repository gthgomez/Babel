import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { attachDaemonDiagnosticStream, createDaemonStartupDiagnostics } from './diagnosticStream.js';

test('daemon diagnostics are complete lines, not interleaved transport fragments', async () => {
  const stream = new PassThrough();
  const lines: string[] = [];
  attachDaemonDiagnosticStream(stream, 'stderr', (channel, line) => lines.push(`${channel}:${line}`));
  stream.write('startup ');
  assert.deepEqual(lines, []);
  stream.write('message\nnext ');
  assert.deepEqual(lines, ['stderr:startup message']);
  stream.end('line');
  await new Promise((resolve) => stream.on('end', resolve));
  assert.deepEqual(lines, ['stderr:startup message', 'stderr:next line']);
});
test('failed diagnostic persistence retains bounded redacted startup context', () => {
  const capture = createDaemonStartupDiagnostics(() => false);
  capture.receive('stderr', '\x1b[31mPermission denied; password=fixture-value');
  for (let i = 0; i < 50; i++) capture.receive('stderr', 'Synthetic stack '.repeat(30));
  const message = capture.failureMessage('Daemon exited.');
  assert.match(message, /Permission denied/);
  assert.doesNotMatch(message, /fixture-value|\x1b/);
  assert.ok(message.length < 3200);
});
