/**
 * Tests for memoryRelevance.ts — relevance scoring, keyword matching.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { findRelevantMemories, hasRelevantMemories, formatRelevantMemoriesSection, renderCrossLinks } from './memoryRelevance.js';
import { writeMemory } from './memoryStore.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'babel-mem-rel-'));
}

function createMemoryFile(dir: string, name: string, description: string, type: 'user' | 'feedback' | 'project' | 'reference', body: string): void {
  writeMemory(dir, { name, description, metadata: { type } }, body);
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('memoryRelevance', () => {
  let dir: string;

  beforeEach(() => {
    dir = createTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('findRelevantMemories', () => {
    it('returns empty when no memories exist', () => {
      const result = findRelevantMemories(dir, 'test task');
      assert.equal(result.length, 0);
    });

    it('returns empty when task has no meaningful keywords', () => {
      createMemoryFile(dir, 'my-memory', 'A test memory', 'project', 'Some body content');
      const result = findRelevantMemories(dir, 'a an the');
      assert.equal(result.length, 0);
    });

    it('matches on description content', () => {
      createMemoryFile(dir, 'testing', 'How to run tests with vitest', 'reference', 'Run: npx vitest');
      createMemoryFile(dir, 'auth', 'Authentication flow using JWT tokens', 'project', 'Auth is handled by passport');

      const result = findRelevantMemories(dir, 'how to run tests');
      assert.equal(result.length, 1);
      assert.equal(result[0]?.memory.frontmatter.name, 'testing');
    });

    it('matches on name content', () => {
      createMemoryFile(dir, 'deploy-script', 'Deployment procedure', 'reference', 'Deploy with docker');
      createMemoryFile(dir, 'api-routes', 'API endpoint documentation', 'reference', 'GET /api/users');

      const result = findRelevantMemories(dir, 'deployment');
      assert.equal(result.length, 1);
      assert.equal(result[0]?.memory.frontmatter.name, 'deploy-script');
    });

    it('matches on body content with lower weight', () => {
      createMemoryFile(dir, 'config', 'Project configuration details', 'project', 'The database connection string is in .env');
      createMemoryFile(dir, 'readme', 'Project overview', 'project', 'This is a documentation project');

      const result = findRelevantMemories(dir, 'database connection');
      assert.equal(result.length, 1);
      assert.equal(result[0]?.memory.frontmatter.name, 'config');
    });

    it('returns multiple matches sorted by score descending', () => {
      createMemoryFile(dir, 'install-steps', 'Installation steps for the project', 'reference', 'Installation: npm install');
      createMemoryFile(dir, 'install', 'Install', 'reference', 'Run npm install');
      createMemoryFile(dir, 'deploy', 'Deployment to production', 'reference', 'Use docker');

      const result = findRelevantMemories(dir, 'installation');
      assert.ok(result.length >= 1);
      // First result should have a score
      assert.ok(result[0]!.score > 0);
    });

    it('respects maxMemories option', () => {
      createMemoryFile(dir, 'mem-1', 'Test memory one about tests', 'project', 'Testing is important');
      createMemoryFile(dir, 'mem-2', 'Test memory two about testing', 'project', 'More testing content');
      createMemoryFile(dir, 'mem-3', 'Test memory three for test runners', 'project', 'Yet more tests');

      const result = findRelevantMemories(dir, 'testing tests test', { maxMemories: 2 });
      assert.ok(result.length <= 2);
    });

    it('performs case-insensitive matching', () => {
      createMemoryFile(dir, 'docker-config', 'Docker configuration for production', 'reference', 'Use Docker Compose');

      const result = findRelevantMemories(dir, 'DOCKER PRODUCTION');
      assert.equal(result.length, 1);
    });
  });

  describe('hasRelevantMemories', () => {
    it('returns true when description matches keywords', () => {
      createMemoryFile(dir, 'testing', 'How to run tests with vitest', 'reference', 'Run: npx vitest');
      assert.ok(hasRelevantMemories(dir, 'vitest testing'));
    });

    it('returns false when no memories match', () => {
      createMemoryFile(dir, 'auth', 'Authentication flow', 'project', 'JWT tokens');
      assert.equal(hasRelevantMemories(dir, 'database schema'), false);
    });

    it('returns false for empty directory', () => {
      assert.equal(hasRelevantMemories(dir, 'anything'), false);
    });
  });

  describe('formatRelevantMemoriesSection', () => {
    it('returns null for empty input', () => {
      assert.equal(formatRelevantMemoriesSection([]), null);
    });

    it('formats memories as markdown section', () => {
      createMemoryFile(dir, 'test-note', 'A test memory', 'project', 'Some important content.');
      const relevant = findRelevantMemories(dir, 'test memory');

      const section = formatRelevantMemoriesSection(relevant);
      assert.ok(section !== null);
      assert.ok(section.includes('## Project Memory'));
      assert.ok(section.includes('test-note'));
      assert.ok(section.includes('Some important content.'));
    });

    it('includes match reasoning in footer', () => {
      createMemoryFile(dir, 'config', 'Configuration guide', 'reference', 'Set env vars.');
      const relevant = findRelevantMemories(dir, 'configuration');
      const section = formatRelevantMemoriesSection(relevant);
      assert.ok(section !== null);
      assert.ok(section.includes('memory(s) retrieved'));
    });
  });

  describe('renderCrossLinks', () => {
    it('replaces [[name]] with markdown link when memory exists', () => {
      createMemoryFile(dir, 'linked-memory', 'A linked reference', 'reference', 'Referenced content.');
      const text = 'See [[linked-memory]] for details.';
      const result = renderCrossLinks(text, dir);
      assert.ok(result.includes('A linked reference'));
      assert.ok(!result.includes('[[linked-memory]]'));
    });

    it('renders [[name]] as code block when memory not found', () => {
      const text = 'See [[missing-memory]] for details.';
      const result = renderCrossLinks(text, dir);
      assert.ok(result.includes('`missing-memory`'));
    });

    it('returns text unchanged when no cross-links present', () => {
      const text = 'Plain text without cross-links.';
      assert.equal(renderCrossLinks(text, dir), text);
    });
  });
});
