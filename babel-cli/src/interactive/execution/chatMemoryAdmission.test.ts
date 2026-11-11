/**
 * Contract: default chat stack compile does not auto-enable structured memory (Gap-2).
 * memoryContext remains an explicit caller hook; this documents production admission.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { compileChatStackForRun } from './chatCore.js';
import { resolveMemoryRoot, writeMemory } from '../../services/memory/memoryStore.js';

describe('chat memory admission (read-only contract)', () => {
  let stateDir: string;
  let prevStateDir: string | undefined;
  let projectRoot: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'babel-chat-mem-admission-state-'));
    projectRoot = mkdtempSync(join(tmpdir(), 'babel-chat-mem-admission-proj-'));
    prevStateDir = process.env['BABEL_STATE_DIR'];
    process.env['BABEL_STATE_DIR'] = stateDir;
    mkdirSync(join(projectRoot, '.git'));
    writeFileSync(join(projectRoot, 'AGENTS.md'), '# Test\n', 'utf-8');
    const memoryDir = resolveMemoryRoot(projectRoot);
    assert.ok(memoryDir);
    writeMemory(memoryDir, {
      name: 'auto-wire-probe',
      description: 'must not appear in default chat stack',
      metadata: { type: 'project' },
    }, 'SENSITIVE_MEMORY_BODY_SHOULD_NOT_AUTO_LOAD');
  });

  afterEach(() => {
    if (prevStateDir === undefined) delete process.env['BABEL_STATE_DIR'];
    else process.env['BABEL_STATE_DIR'] = prevStateDir;
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('compileChatStackForRun omits typed memory unless memoryContext is passed explicitly', () => {
    const stack = compileChatStackForRun({
      projectRoot,
      task: 'fix lint',
    });
    assert.doesNotMatch(stack.system_context, /SENSITIVE_MEMORY_BODY_SHOULD_NOT_AUTO_LOAD/);
    assert.equal(
      stack.selected_entries.some((e) => e.id === 'project:memory'),
      false,
    );
  });
});
