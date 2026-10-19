import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildCommandCodeAdapterDescriptor,
  COMMAND_CODE_OWN_CLI_HAPPY_FIXTURE,
  replayCommandCodeFixture,
} from './commandCodeOwnCliAdapter.js';

describe('commandCodeOwnCliAdapter', () => {
  it('disables start capabilities when installation is missing', () => {
    const descriptor = buildCommandCodeAdapterDescriptor({ state: 'missing' });
    assert.equal(descriptor.version, 'not-installed');
    assert.equal(descriptor.capabilities.start, false);
    assert.equal(descriptor.capabilities.attachLive, false);
    assert.match(descriptor.unsupportedReason ?? '', /not installed/i);
  });

  it('enables own-CLI capabilities when installation is verified', () => {
    const descriptor = buildCommandCodeAdapterDescriptor({
      state: 'verified',
      executable: '/usr/local/bin/command-code',
      version: '1.2.3',
    });
    assert.equal(descriptor.version, '1.2.3');
    assert.equal(descriptor.capabilities.start, true);
    assert.equal(descriptor.capabilities.attachLive, false);
    assert.match(descriptor.unsupportedReason ?? '', /Unmanaged live TUI attach/i);
  });

  it('replays the deterministic protocol fixture transcript', async () => {
    const transcript: string[] = [];
    const stdin = COMMAND_CODE_OWN_CLI_HAPPY_FIXTURE
      .filter((line) => line.direction === 'stdin')
      .map((line) => JSON.stringify(line.message));
    let readIndex = 0;
    await replayCommandCodeFixture(COMMAND_CODE_OWN_CLI_HAPPY_FIXTURE, {
      write(line) {
        transcript.push(line.trimEnd());
      },
      async readLine() {
        const next = stdin[readIndex++];
        if (!next) throw new Error('unexpected read');
        return `${next}\n`;
      },
    });
    assert.equal(transcript.length, 3);
    assert.match(transcript[0] ?? '', /"session_id":"fixture-session-1"/);
  });
});
