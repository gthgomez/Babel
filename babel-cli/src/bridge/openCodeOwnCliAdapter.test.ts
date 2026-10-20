import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildOpenCodeAdapterDescriptor,
  OPENCODE_OWN_CLI_HAPPY_FIXTURE,
  replayOpenCodeFixture,
} from './openCodeOwnCliAdapter.js';

describe('openCodeOwnCliAdapter', () => {
  it('disables start capabilities when installation is missing', () => {
    const descriptor = buildOpenCodeAdapterDescriptor({ state: 'missing' });
    assert.equal(descriptor.version, 'not-installed');
    assert.equal(descriptor.capabilities.start, false);
    assert.equal(descriptor.capabilities.attachLive, false);
    assert.match(descriptor.unsupportedReason ?? '', /not installed/i);
  });

  it('enables own-CLI capabilities when installation is verified', () => {
    const descriptor = buildOpenCodeAdapterDescriptor({
      state: 'verified',
      executable: '/usr/local/bin/opencode',
      version: '1.2.3',
    });
    assert.equal(descriptor.version, '1.2.3');
    assert.equal(descriptor.capabilities.start, true);
    assert.equal(descriptor.capabilities.attachLive, false);
    assert.match(descriptor.unsupportedReason ?? '', /Unmanaged live TUI attach/i);
  });

  it('replays the deterministic protocol fixture transcript', async () => {
    const transcript: string[] = [];
    const stdin = OPENCODE_OWN_CLI_HAPPY_FIXTURE
      .filter((line) => line.direction === 'stdin')
      .map((line) => JSON.stringify(line.message));
    let readIndex = 0;
    await replayOpenCodeFixture(OPENCODE_OWN_CLI_HAPPY_FIXTURE, {
      write(line) {
        transcript.push(line.trimEnd());
      },
      async readLine() {
        const next = stdin[readIndex++];
        if (!next) throw new Error('unexpected read');
        return `${next}\n`;
      },
    });
    assert.equal(transcript.length, 2);
    assert.match(transcript[0] ?? '', /"sessionId":"fixture-session-1"/);
    assert.match(transcript[1] ?? '', /"stopReason":"end_turn"/);
  });
});
