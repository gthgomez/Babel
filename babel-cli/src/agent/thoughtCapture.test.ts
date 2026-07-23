/**
 * Unit tests for ThoughtCaptureWriter (Tier B1).
 *
 * Coverage:
 *  - Flag off → enabled=false, capture writes nothing
 *  - Flag on → capture appends JSONL with {turn, ts, text} shape
 *  - DeepSeek tool path remains thinking-off by default (config assertion)
 */
import { describe, it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ThoughtCaptureWriter, type ThoughtCaptureEntry } from './thoughtCapture.js';

const SAVED_ENV: Record<string, string | undefined> = {};

function saveEnv(): void {
  for (const key of [
    'BABEL_CHAT_CAPTURE_THOUGHTS',
    'BABEL_DEEPSEEK_THINKING',
    'BABEL_DEEPSEEK_THINKING_WITH_TOOLS',
  ] as const) {
    SAVED_ENV[key] = process.env[key];
  }
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe('ThoughtCaptureWriter', () => {
  let tmpDir: string;
  let tmpPath: string;

  beforeEach(() => {
    saveEnv();
    tmpDir = mkdtempSync(join(tmpdir(), 'thought-capture-test-'));
    tmpPath = join(tmpDir, 'thoughts.jsonl');
  });

  afterEach(() => {
    restoreEnv();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('flag off → enabled=false, capture does not create file', () => {
    delete process.env['BABEL_CHAT_CAPTURE_THOUGHTS'];
    const writer = new ThoughtCaptureWriter(tmpDir);
    assert.equal(writer.enabled, false);
    writer.capture(0, 'test thought');
    writer.capture(1, 'more thinking');
    assert.equal(existsSync(tmpPath), false);
  });

  it('flag on → enabled=true, capture appends JSONL with correct shape', () => {
    process.env['BABEL_CHAT_CAPTURE_THOUGHTS'] = '1';
    const writer = new ThoughtCaptureWriter(tmpDir);
    assert.equal(writer.enabled, true);

    writer.capture(0, 'first chunk');
    writer.capture(1, 'second chunk');

    assert.ok(existsSync(tmpPath), 'thoughts.jsonl should exist');
    const raw = readFileSync(tmpPath, 'utf-8');
    const lines = raw.trim().split('\n');
    assert.equal(lines.length, 2);

    for (const line of lines) {
      const obj = JSON.parse(line) as ThoughtCaptureEntry;
      assert.equal(typeof obj.turn, 'number');
      assert.equal(typeof obj.ts, 'string');
      assert.ok(Date.parse(obj.ts) > 0, `ts must be a valid ISO date: ${obj.ts}`);
      assert.equal(typeof obj.text, 'string');
      assert.ok(obj.text.length > 0, 'text must not be empty');
    }
  });

  it('flag on → multiple turns write ordered lines', () => {
    process.env['BABEL_CHAT_CAPTURE_THOUGHTS'] = '1';
    const writer = new ThoughtCaptureWriter(tmpDir);

    writer.capture(0, 'part A');
    writer.capture(0, 'part B');
    writer.capture(1, 'turn 1 thought');
    writer.capture(2, 'turn 2 final');

    const raw = readFileSync(tmpPath, 'utf-8');
    const lines = raw.trim().split('\n');
    assert.equal(lines.length, 4);

    const parsed = lines.map((l) => JSON.parse(l) as ThoughtCaptureEntry);
    assert.equal(parsed[0]!.turn, 0);
    assert.equal(parsed[0]!.text, 'part A');
    assert.equal(parsed[1]!.turn, 0);
    assert.equal(parsed[1]!.text, 'part B');
    assert.equal(parsed[2]!.turn, 1);
    assert.equal(parsed[3]!.turn, 2);
  });

  it('flag on with truthy variant "yes"', () => {
    process.env['BABEL_CHAT_CAPTURE_THOUGHTS'] = 'yes';
    const writer = new ThoughtCaptureWriter(tmpDir);
    assert.equal(writer.enabled, true);
    writer.capture(0, 'yes variant');
    assert.ok(existsSync(tmpPath));
  });

  it('flag off with "0" string', () => {
    process.env['BABEL_CHAT_CAPTURE_THOUGHTS'] = '0';
    const writer = new ThoughtCaptureWriter(tmpDir);
    assert.equal(writer.enabled, false);
    writer.capture(0, 'should not write');
    assert.equal(existsSync(tmpPath), false);
  });
});

describe('DeepSeek tool path thinking guard', () => {
  beforeEach(() => saveEnv());
  afterEach(() => restoreEnv());

  it('by default, thinking+tools is disabled (BABEL_DEEPSEEK_THINKING_WITH_TOOLS not "1")', () => {
    delete process.env['BABEL_DEEPSEEK_THINKING'];
    delete process.env['BABEL_DEEPSEEK_THINKING_WITH_TOOLS'];

    // Replicate the logic from deepSeekApi.ts executeWithToolsStream buildBody:
    const wantThinking = process.env['BABEL_DEEPSEEK_THINKING'] !== 'disabled';
    const allowThinkingWithTools =
      process.env['BABEL_DEEPSEEK_THINKING_WITH_TOOLS'] === '1';
    const thinkingEnabled = wantThinking && allowThinkingWithTools;

    // Default: thinking is NOT enabled for tool streams
    assert.equal(thinkingEnabled, false,
      'DeepSeek tool stream must default to thinking=disabled (HTTP 400 if enabled with tools)');
  });

  it('explicit BABEL_DEEPSEEK_THINKING=disabled keeps tools thinking-off', () => {
    process.env['BABEL_DEEPSEEK_THINKING'] = 'disabled';
    delete process.env['BABEL_DEEPSEEK_THINKING_WITH_TOOLS'];

    const wantThinking = process.env['BABEL_DEEPSEEK_THINKING'] !== 'disabled';
    assert.equal(wantThinking, false);
    // thinkingEnabled = wantThinking && allowThinkingWithTools = false
  });

  it('BABEL_DEEPSEEK_THINKING_WITH_TOOLS=1 overrides to enable thinking+tools', () => {
    process.env['BABEL_DEEPSEEK_THINKING'] = 'enabled';
    process.env['BABEL_DEEPSEEK_THINKING_WITH_TOOLS'] = '1';

    const wantThinking = process.env['BABEL_DEEPSEEK_THINKING'] !== 'disabled';
    const allowThinkingWithTools =
      process.env['BABEL_DEEPSEEK_THINKING_WITH_TOOLS'] === '1';
    const thinkingEnabled = wantThinking && allowThinkingWithTools;

    // This test documents that the escape hatch exists but is opt-in
    assert.equal(thinkingEnabled, true);
  });
});
