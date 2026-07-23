/**
 * Tests for memoryStore.ts — CRUD operations, frontmatter parsing, dedup.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';

import {
  sanitizeGitRoot,
  resolveMemoryRoot,
  parseMemoryFrontmatter,
  scanMemoryDirectory,
  readMemoryIndex,
  findByName,
  writeMemory,
  deleteMemory,
} from './memoryStore.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'babel-mem-store-'));
}

function writeMemoryFile(dir: string, name: string, content: string): void {
  const fs = require('node:fs');
  fs.writeFileSync(join(dir, name), content, 'utf-8');
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('memoryStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = createTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('sanitizeGitRoot', () => {
    it('replaces Windows drive letter', () => {
      const result = sanitizeGitRoot('/tmp/My-Project/.git');
      assert.ok(!result.includes(':'));
    });

    it('replaces invalid characters with hyphens', () => {
      const result = sanitizeGitRoot('/path/to/<invalid>:chars|?');
      assert.ok(!result.includes('<'));
      assert.ok(!result.includes('>'));
      assert.ok(!result.includes(':'));
      assert.ok(!result.includes('|'));
      assert.ok(!result.includes('?'));
    });

    it('produces a lowercase slug', () => {
      const result = sanitizeGitRoot('/PATH/TO/PROJECT');
      assert.equal(result, result.toLowerCase());
    });

    it('handles empty segments', () => {
      const result = sanitizeGitRoot('///');
      assert.equal(result.length, 0);
    });
  });

  describe('parseMemoryFrontmatter', () => {
    it('parses valid frontmatter with string fields', () => {
      const raw = `---
name: my-memory
description: A test memory about configuration
metadata:
  type: reference
---

Body content here.`;
      const parsed = parseMemoryFrontmatter(raw);
      assert.ok(parsed !== null);
      assert.equal(parsed.frontmatter.name, 'my-memory');
      assert.equal(parsed.frontmatter.description, 'A test memory about configuration');
      assert.equal(parsed.frontmatter.metadata.type, 'reference');
      assert.equal(parsed.body.trim(), 'Body content here.');
    });

    it('parses inline type field (legacy format)', () => {
      const raw = `---
name: user-role
description: About the user
type: user
---

User content.`;
      const parsed = parseMemoryFrontmatter(raw);
      assert.ok(parsed !== null);
      assert.equal(parsed.frontmatter.metadata.type, 'user');
    });

    it('returns null for missing frontmatter', () => {
      const raw = 'Just body text without frontmatter.';
      assert.equal(parseMemoryFrontmatter(raw), null);
    });

    it('returns null for incomplete frontmatter', () => {
      const raw = `---
name: incomplete
`;
      assert.equal(parseMemoryFrontmatter(raw), null);
    });

    it('returns null for invalid type field', () => {
      const raw = `---
name: bad-type
description: invalid type test
metadata:
  type: invalid_type
---

Body.`;
      assert.equal(parseMemoryFrontmatter(raw), null);
    });

    it('handles body with no extra content', () => {
      const raw = `---
name: empty-body
description: No body
metadata:
  type: reference
---`;
      const parsed = parseMemoryFrontmatter(raw);
      assert.ok(parsed !== null);
      assert.equal(parsed.body.trim(), '');
    });
  });

  describe('writeMemory / scanMemoryDirectory / findByName', () => {
    it('writes a memory file and updates index', () => {
      const ok = writeMemory(dir, {
        name: 'test-note',
        description: 'A test note about the codebase',
        metadata: { type: 'project' },
      }, 'Important: the test runner is vitest.\n');
      assert.ok(ok);

      // File should exist
      const filePath = join(dir, 'test-note.md');
      assert.ok(existsSync(filePath));

      // Content should include frontmatter
      const content = readFileSync(filePath, 'utf-8');
      assert.ok(content.includes('name: test-note'));
      assert.ok(content.includes('type: project'));
      assert.ok(content.includes('Important: the test runner is vitest'));

      // MEMORY.md index should exist
      const indexPath = join(dir, 'MEMORY.md');
      assert.ok(existsSync(indexPath));
      const indexContent = readFileSync(indexPath, 'utf-8');
      assert.ok(indexContent.includes('test-note'));
      assert.ok(indexContent.includes('A test note about the codebase'));
    });

    it('finds a memory by name', () => {
      writeMemory(dir, {
        name: 'find-me',
        description: 'Memory to be found',
        metadata: { type: 'reference' },
      }, 'Some content.');

      const found = findByName(dir, 'find-me');
      assert.ok(found !== null);
      assert.equal(found.frontmatter.name, 'find-me');
      assert.equal(found.frontmatter.metadata.type, 'reference');
    });

    it('returns null for unknown name', () => {
      assert.equal(findByName(dir, 'non-existent'), null);
    });

    it('scans directory and returns all memories', () => {
      writeMemory(dir, { name: 'mem-a', description: 'First', metadata: { type: 'user' } }, 'A');
      writeMemory(dir, { name: 'mem-b', description: 'Second', metadata: { type: 'feedback' } }, 'B');

      const memories = scanMemoryDirectory(dir);
      assert.equal(memories.length, 2);
    });

    it('excludes MEMORY.md from scan results', () => {
      writeMemory(dir, { name: 'only-me', description: 'Only one', metadata: { type: 'project' } }, 'X');

      const memories = scanMemoryDirectory(dir);
      const names = memories.map((m) => m.path);
      assert.ok(!names.includes('MEMORY.md'));
      assert.equal(memories.length, 1);
    });

    it('rejects invalid write input (bad type)', () => {
      const ok = writeMemory(dir, {
        name: 'bad',
        description: 'bad',
        // @ts-expect-error testing runtime validation
        type: 'not-a-valid-type',
      }, 'body');
      assert.equal(ok, false);
    });
  });

  describe('deleteMemory', () => {
    it('deletes a memory file and removes from index', () => {
      writeMemory(dir, { name: 'delete-me', description: 'To be deleted', metadata: { type: 'project' } }, 'bye');

      assert.ok(existsSync(join(dir, 'delete-me.md')));

      const deleted = deleteMemory(dir, 'delete-me');
      assert.ok(deleted);
      assert.ok(!existsSync(join(dir, 'delete-me.md')));

      // Index should no longer reference it
      const index = readMemoryIndex(dir);
      const names = index.entries.map((e) => e.name);
      assert.ok(!names.includes('delete-me'));
    });

    it('returns false for non-existent memory', () => {
      assert.equal(deleteMemory(dir, 'never-existed'), false);
    });
  });

  describe('readMemoryIndex', () => {
    it('returns empty index when no MEMORY.md exists', () => {
      const index = readMemoryIndex(dir);
      assert.equal(index.entries.length, 0);
    });

    it('parses existing MEMORY.md', () => {
      writeMemory(dir, { name: 'index-test', description: 'Index test', metadata: { type: 'project' } }, 'test');

      const index = readMemoryIndex(dir);
      assert.equal(index.entries.length, 1);
      assert.equal(index.entries[0]?.name, 'index-test');
    });
  });

  describe('resolveMemoryRoot', () => {
    it('returns non-null path for a valid project root', () => {
      const memoryRoot = resolveMemoryRoot(dir);
      assert.ok(memoryRoot !== null);
      assert.ok(existsSync(memoryRoot));
    });

    it('creates the memory directory', () => {
      const nested = join(dir, 'nested', 'project');
      const memoryRoot = resolveMemoryRoot(nested);
      assert.ok(memoryRoot !== null);
      assert.ok(existsSync(memoryRoot));
    });
  });
});
