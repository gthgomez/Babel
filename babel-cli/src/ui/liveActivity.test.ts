import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  activityFromToolCall,
  classifyLiveActivity,
  formatLiveActivity,
  getLastLiveActivity,
  recordLiveActivity,
  resetLiveActivityForTests,
} from './liveActivity.js';

describe('live activity — real events only', () => {
  it('classifies reading, editing, shell, verification, thinking, waiting, cancelled', () => {
    assert.equal(classifyLiveActivity({ tool: 'read_file', target: 'a.ts' }), 'reading');
    assert.equal(classifyLiveActivity({ tool: 'str_replace', target: 'a.ts' }), 'editing');
    assert.equal(classifyLiveActivity({ tool: 'run_command', target: 'npm test' }), 'shell');
    assert.equal(classifyLiveActivity({ tool: 'verify', target: 'npm test' }), 'verification');
    assert.equal(classifyLiveActivity({ thinking: true }), 'thinking');
    assert.equal(classifyLiveActivity({ blocked: true }), 'waiting');
    assert.equal(classifyLiveActivity({ cancelled: true }), 'cancelled');
  });

  it('does not fabricate activity from an empty event', () => {
    assert.equal(classifyLiveActivity({}), null);
    assert.equal(classifyLiveActivity({ type: '', tool: '' }), null);
  });

  it('records last activity from a real tool event', () => {
    resetLiveActivityForTests();
    assert.equal(recordLiveActivity({ tool: 'write_file', target: 'a.ts' }), 'editing');
    assert.equal(getLastLiveActivity()?.kind, 'editing');
    assert.match(getLastLiveActivity()?.line ?? '', /Editing/);
  });

  it('formats a compact tree from real targets', () => {
    const line = formatLiveActivity('editing', ['src/foo.ts', 'src/foo.test.ts']);
    assert.match(line, /● Editing/);
    assert.match(line, /src\/foo\.ts/);
    const fromTool = activityFromToolCall('read_file', 'src/foo.ts');
    assert.equal(fromTool?.kind, 'reading');
    assert.match(fromTool?.line ?? '', /Inspecting/);
  });
});
