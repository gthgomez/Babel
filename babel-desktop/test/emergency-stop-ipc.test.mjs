import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

test('preload exposes emergencyStopSharedRun distinct from cancel', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../native/preload.cjs', import.meta.url)),
    'utf8',
  );
  assert.match(source, /emergencyStopSharedRun:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('babel:emergency-stop-shared-run'\)/);
  assert.match(source, /cancel:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('babel:cancel'\)/);
});
