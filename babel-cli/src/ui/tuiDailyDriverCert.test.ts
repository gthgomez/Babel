import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { resetInterruptHostForTests } from './interruptHost.js';
import { runDailyDriverScenarios, scenarioById } from './tuiDailyDriverCert.js';

afterEach(() => {
  resetInterruptHostForTests();
});

describe('TUI daily-driver cert T01–T24', () => {
  it('runs the fixture matrix with honest statuses', async () => {
    const first = await runDailyDriverScenarios({
      ptyAvailable: false,
      windowsTerminalAutomation: false,
    });
    const second = await runDailyDriverScenarios({
      ptyAvailable: false,
      windowsTerminalAutomation: false,
    });

    const ids = first.scenarios.map((s) => s.id);
    assert.deepEqual(
      ids,
      Array.from({ length: 24 }, (_, i) => `T${String(i + 1).padStart(2, '0')}`),
    );

    for (const s of first.scenarios) {
      assert.ok(
        s.status === 'PASS' || s.status === 'FAIL' || s.status === 'BLOCKED' || s.status === 'NOT_APPLICABLE',
        s.id,
      );
      if (s.id !== 'T24') {
        assert.notEqual(s.status, 'FAIL', `${s.id}: ${s.detail}`);
      }
    }

    const t24 = scenarioById(first, 'T24');
    assert.equal(t24?.status, 'BLOCKED');
    assert.match(t24?.detail ?? '', /Windows Terminal/);

    const t23 = scenarioById(first, 'T23');
    assert.equal(t23?.status, 'PASS');
    assert.equal(first.tasksAttempted, 10);
    assert.equal(first.tuiFailures, 0);
    assert.equal(first.restartsRequired, 0);
    assert.equal(first.stateCorruptionEvents, 0);
    assert.equal(first.falseVerifiedSuccessEvents, 0);
    assert.equal(first.cancelFailures, 0);

    assert.deepEqual(
      second.scenarios.map((s) => s.status),
      first.scenarios.map((s) => s.status),
    );
  });
});
