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

  it('fails unknown tool/type events to neutral instead of confident Running', () => {
    assert.equal(classifyLiveActivity({ tool: 'mystery_plugin', type: 'custom_unknown' }), null);
    assert.equal(classifyLiveActivity({ type: 'frobnicate' }), null);
    assert.equal(activityFromToolCall('mystery_plugin'), null);
    assert.notEqual(classifyLiveActivity({ tool: 'run_command' }), null);
  });

  it('ConversationalRenderer records known tool activity and ignores unknown tools', async () => {
    const { ConversationalRenderer } = await import('./waterfall.js');
    resetLiveActivityForTests();
    const renderer = new ConversationalRenderer({ isTTY: false, verboseMode: false });
    renderer.start();
    renderer.onToolCallStart('str_replace', 'src/ui/statusBar.ts');
    assert.equal(getLastLiveActivity()?.kind, 'editing');
    renderer.onToolCallStart('mystery_plugin', 'payload');
    assert.equal(getLastLiveActivity()?.kind, 'editing', 'unknown tool must not overwrite with shell/Running');
    renderer.stop();
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
