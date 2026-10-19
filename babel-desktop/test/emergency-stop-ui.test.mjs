import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

test('renderer exposes labeled emergency host stop distinct from ordinary stop', () => {
  const html = readFileSync(
    fileURLToPath(new URL('../src/index.html', import.meta.url)),
    'utf8',
  );
  const app = readFileSync(fileURLToPath(new URL('../src/app.mjs', import.meta.url)), 'utf8');
  assert.match(html, /data-action="emergency-host-stop"/);
  assert.match(html, /Emergency host stop/);
  assert.match(app, /emergencyHostStopRun/);
  assert.match(app, /emergencyStopSharedRun/);
  assert.match(app, /a==='stop'/);
});
