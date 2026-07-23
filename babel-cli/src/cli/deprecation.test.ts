import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatDeprecatedSurfaceMessage, isDeprecatedSurfaceCommand } from './deprecation.js';

describe('deprecation', () => {
  it('flags removed surface commands', () => {
    for (const command of ['lite', 'l', 'full', 'bl', 'daily']) {
      assert.equal(isDeprecatedSurfaceCommand(command), true);
    }
    assert.equal(isDeprecatedSurfaceCommand('plan'), false);
    assert.equal(isDeprecatedSurfaceCommand('deep'), false);
    assert.equal(isDeprecatedSurfaceCommand('run'), false);
  });

  it('teaches canonical replacements', () => {
    assert.match(formatDeprecatedSurfaceMessage('lite'), /babel "<task>"/);
    assert.match(formatDeprecatedSurfaceMessage('full'), /babel deep/);
    assert.match(formatDeprecatedSurfaceMessage('bl'), /babel "<task>"/);
  });
});
