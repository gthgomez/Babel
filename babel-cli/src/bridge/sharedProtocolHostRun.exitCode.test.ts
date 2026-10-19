import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  mintDesktopControllerClientId,
  mintDesktopControllerProofKey,
} from './desktopControllerAuth.js';
import { executeSharedProtocolHostRun } from './sharedProtocolHostRun.js';

describe('executeSharedProtocolHostRun exit codes', () => {
  const desktopId = mintDesktopControllerClientId();
  const desktopProofKey = mintDesktopControllerProofKey();

  it('returns nonzero when transport setup fails before turn settlement', async () => {
    const lines: string[] = [];
    const code = await executeSharedProtocolHostRun(
      {
        port: 9,
        projectRoot: process.cwd(),
        task: 'fail fast',
        runId: 'exit-code-1',
        desktopClientId: desktopId,
        desktopProofKey: desktopProofKey,
        fetchImpl: async () => {
          throw new Error('unreachable host');
        },
      },
      (event) => {
        lines.push(JSON.stringify(event));
      },
    );
    assert.equal(code, 1);
    assert.ok(lines.some((line) => line.includes('"type":"run_error"')));
    assert.equal(lines.filter((line) => line.includes('"type":"run_complete"')).length, 0);
  });
});
