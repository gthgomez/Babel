import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildMemoryCandidates,
  proposeProjectMemoryWriteback,
  readProjectMemory,
  sanitizeMemoryText,
  BABEL_MD_PROPOSED_NAME,
} from './projectMemory.js';

describe('projectMemory (P-4.2)', () => {
  let dir: string;
  const prev = process.env['BABEL_MEMORY_WRITEBACK'];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'babel-mem-'));
    delete process.env['BABEL_MEMORY_WRITEBACK'];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prev === undefined) delete process.env['BABEL_MEMORY_WRITEBACK'];
    else process.env['BABEL_MEMORY_WRITEBACK'] = prev;
  });

  it('readProjectMemory returns null when missing', () => {
    assert.equal(readProjectMemory(dir), null);
  });

  it('buildMemoryCandidates empty without files', () => {
    assert.deepEqual(
      buildMemoryCandidates({ projectRoot: dir, taskSummary: 'x', changedFiles: [] }),
      [],
    );
  });

  it('proposeProjectMemoryWriteback writes BABEL.md.proposed', () => {
    const r = proposeProjectMemoryWriteback({
      projectRoot: dir,
      taskSummary: 'Fix auth token refresh',
      changedFiles: ['src/auth.ts', 'src/auth.test.ts'],
      verifierSummary: 'npm test → exit 0',
      nowIso: '2026-07-09T12:00:00.000Z',
    });
    assert.equal(r.wrote, true);
    const path = join(dir, BABEL_MD_PROPOSED_NAME);
    assert.ok(existsSync(path));
    const body = readFileSync(path, 'utf8');
    assert.ok(body.includes('Proposed 2026-07-09'));
    assert.ok(body.includes('src/auth.ts'));
    assert.ok(body.includes('npm test'));
  });

  it('disabled via env', () => {
    process.env['BABEL_MEMORY_WRITEBACK'] = '0';
    const r = proposeProjectMemoryWriteback({
      projectRoot: dir,
      taskSummary: 'x',
      changedFiles: ['a.ts'],
    });
    assert.equal(r.wrote, false);
    assert.equal(r.reason, 'disabled');
  });

  it('sanitizeMemoryText strips control chars and redacts secret-shaped tokens', () => {
    const raw = 'Fix auth\u0000 with sk-your_XXXXXXXXXXXXXXXXXXXX and more';
    const cleaned = sanitizeMemoryText(raw, 200);
    assert.ok(!cleaned.includes('\u0000'));
    assert.ok(cleaned.includes('[redacted]'));
    assert.ok(!cleaned.includes('sk-your_XXXXXXXXXXXXXXXXXXXX'));
  });

  it('buildMemoryCandidates sanitizes task summary', () => {
    const lines = buildMemoryCandidates({
      projectRoot: dir,
      taskSummary: 'Use token sk-your_XXXXXXXXXXXXXXXXXXXX please',
      changedFiles: ['a.ts'],
    });
    const joined = lines.join('\n');
    assert.ok(joined.includes('[redacted]'));
    assert.ok(!joined.includes('sk-your_XXXXXXXXXXXXXXXXXXXX'));
  });
});
