/**
 * End-to-end tests for runMutationAgentLoop with a real LLM.
 *
 * These tests exercise the live LLM dispatch path (DeepInfraApiRunner via
 * runWithPrimaryOnlyFallback) rather than the deterministic mock path.
 *
 * ALL tests are conditionally skipped when no API key is available — they
 * are safe to include in CI even without credentials.
 *
 * Costs are bounded: each test uses maxRounds=5 with a cheap primary-tier
 * model (LLaMA 4 Scout via DeepInfra). Expected cost per full run is ~$0.10-0.30.
 *
 * Each test creates its own temp directory that is cleaned up in `finally`.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runMutationAgentLoop } from './runMutationAgentLoop.js';
import type { WorktreeRollbackSummary } from '../../services/worktreeSafety.js';
import type { ToolCallLog } from '../../schemas/agentContracts.js';

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Check whether a tool call log entry's `tool` field matches a given name.
 *
 * The mutation loop stores *action type* names (e.g. `"read_file"`, `"write_file"`)
 * in the `tool` field via a cast (`as ToolCallLog['tool']`), but the TypeScript
 * type for `tool` is a union of *tool execution* names (e.g. `"file_read"`,
 * `"file_write"`).  This helper bridges the gap with a string-level comparison.
 */
function toolIs(entry: ToolCallLog, name: string): boolean {
  return (entry.tool as string) === name;
}

/**
 * Check whether a real LLM provider is available in the environment.
 * The executor waterfall uses DeepInfra (DEEPINFRA_API_KEY) as its primary tier.
 */
function hasLiveProvider(): boolean {
  return Boolean(
    process.env['DEEPINFRA_API_KEY'] || process.env['DEEPSEEK_API_KEY'],
  );
}

/** Create a temp directory with known fixtures for a single test. */
function createE2eEnv(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'babel-mut-e2e-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'output'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'data.txt'),
    'The sky is blue.\nThe grass is green.\n',
    'utf-8',
  );
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Build a fresh ToolContext for a test. */
function createToolContext(root: string, agentId: string) {
  return {
    agentId,
    runId: 'e2e',
    runDir: join(root, '.babel', 'runs', 'agents', agentId),
    babelRoot: root,
  };
}

/** Long timeout for real LLM calls (2 min). */
const E2E_TIMEOUT = 120_000;

// ─── Tests ─────────────────────────────────────────────────────────────────────

test(
  'completes a simple write task with the real LLM',
  { skip: !hasLiveProvider(), timeout: E2E_TIMEOUT },
  async () => {
    const { root, cleanup } = createE2eEnv();
    try {
      const agentId = `e2e-write-${randomUUID().slice(0, 8)}`;
      const result = await runMutationAgentLoop({
        agentId,
        task:
          'Write a file named output/hello.txt containing the exact text "Hello from the real LLM!"',
        projectRoot: root,
        writeScope: ['output'],
        workspaceRoot: root,
        toolContext: createToolContext(root, agentId),
        maxRounds: 5,
        useDeterministicMock: false,
      });

      assert.ok(result.success, `Expected success, got error: ${result.error}`);
      assert.ok(result.changedFiles.length > 0, 'Expected at least one changed file');

      const helloPath = join(root, 'output', 'hello.txt');
      assert.ok(
        existsSync(helloPath),
        `output/hello.txt should exist on disk at ${helloPath}`,
      );
      const content = readFileSync(helloPath, 'utf-8');
      assert.ok(
        content.includes('Hello from the real LLM'),
        `Expected file to contain "Hello from the real LLM", got: ${JSON.stringify(content)}`,
      );
    } finally {
      cleanup();
    }
  },
);

test(
  'performs a read-then-write flow with the real LLM',
  { skip: !hasLiveProvider(), timeout: E2E_TIMEOUT },
  async () => {
    const { root, cleanup } = createE2eEnv();
    try {
      const agentId = `e2e-rw-${randomUUID().slice(0, 8)}`;
      const result = await runMutationAgentLoop({
        agentId,
        task:
          'Read src/data.txt and write a file output/summary.txt containing a one-line summary of what the data says',
        projectRoot: root,
        writeScope: ['output'],
        workspaceRoot: root,
        toolContext: createToolContext(root, agentId),
        maxRounds: 5,
        useDeterministicMock: false,
      });

      assert.ok(result.success, `Expected success, got error: ${result.error}`);

      const summaryPath = join(root, 'output', 'summary.txt');
      assert.ok(
        existsSync(summaryPath),
        `output/summary.txt should exist on disk at ${summaryPath}`,
      );

      // The tool call log should contain at least one read action and one write action.
      // The loop stores action type names (e.g. 'read_file', 'write_file') as the
      // `tool` value; the `toolIs` helper bridges the TS type gap.
      const readActions = result.toolCallLog.filter(
        (e) => toolIs(e, 'read_file') || toolIs(e, 'file_read'),
      );
      const writeActions = result.toolCallLog.filter(
        (e) => toolIs(e, 'write_file') || toolIs(e, 'file_write'),
      );
      assert.ok(
        readActions.length >= 1,
        `Expected at least 1 read action, got ${readActions.length}. Log: ${JSON.stringify(result.toolCallLog)}`,
      );
      assert.ok(
        writeActions.length >= 1,
        `Expected at least 1 write action, got ${writeActions.length}. Log: ${JSON.stringify(result.toolCallLog)}`,
      );
    } finally {
      cleanup();
    }
  },
);

test(
  'performs multi-round exploration with the real LLM',
  { skip: !hasLiveProvider(), timeout: E2E_TIMEOUT },
  async () => {
    const { root, cleanup } = createE2eEnv();
    try {
      const agentId = `e2e-explore-${randomUUID().slice(0, 8)}`;
      const result = await runMutationAgentLoop({
        agentId,
        task:
          'Explore the src/ directory, read what you find, and write output/report.txt with your findings',
        projectRoot: root,
        writeScope: ['output'],
        workspaceRoot: root,
        toolContext: createToolContext(root, agentId),
        maxRounds: 5,
        useDeterministicMock: false,
      });

      assert.ok(result.success, `Expected success, got error: ${result.error}`);
      assert.ok(
        result.stepsExecuted >= 2,
        `Expected at least 2 steps executed (explore + write), got ${result.stepsExecuted}`,
      );

      // The tool call log should show exploration actions (list_dir, read_file)
      const exploreActions = result.toolCallLog.filter(
        (e) =>
          toolIs(e, 'list_dir') ||
          toolIs(e, 'directory_list') ||
          toolIs(e, 'read_file') ||
          toolIs(e, 'file_read'),
      );
      assert.ok(
        exploreActions.length >= 1,
        `Expected at least 1 exploration action in log, got ${exploreActions.length}. Log: ${JSON.stringify(result.toolCallLog)}`,
      );

      const reportPath = join(root, 'output', 'report.txt');
      assert.ok(
        existsSync(reportPath),
        `output/report.txt should exist at ${reportPath}`,
      );
      const reportContent = readFileSync(reportPath, 'utf-8');
      assert.ok(
        reportContent.length > 0,
        `Expected report.txt to have content, got empty`,
      );
    } finally {
      cleanup();
    }
  },
);

test(
  'respects write scope when writing to allowed paths',
  { skip: !hasLiveProvider(), timeout: E2E_TIMEOUT },
  async () => {
    const { root, cleanup } = createE2eEnv();
    try {
      const agentId = `e2e-scope-ok-${randomUUID().slice(0, 8)}`;
      const result = await runMutationAgentLoop({
        agentId,
        task:
          'Write a file named output/allowed.txt containing "This is within write scope."',
        projectRoot: root,
        writeScope: ['output'],
        workspaceRoot: root,
        toolContext: createToolContext(root, agentId),
        maxRounds: 5,
        useDeterministicMock: false,
      });

      assert.ok(
        result.success,
        `Expected write-scope-compliant task to succeed, got error: ${result.error}`,
      );

      const allowedPath = join(root, 'output', 'allowed.txt');
      assert.ok(
        existsSync(allowedPath),
        `output/allowed.txt should exist at ${allowedPath}`,
      );
    } finally {
      cleanup();
    }
  },
);

test(
  'blocks writes outside the declared write scope',
  { skip: !hasLiveProvider(), timeout: E2E_TIMEOUT },
  async () => {
    const { root, cleanup } = createE2eEnv();
    try {
      const agentId = `e2e-scope-block-${randomUUID().slice(0, 8)}`;
      const result = await runMutationAgentLoop({
        agentId,
        task:
          'Write a file named /tmp/outside.txt containing "This should be blocked by write scope."',
        projectRoot: root,
        writeScope: ['output'],
        workspaceRoot: root,
        toolContext: createToolContext(root, agentId),
        maxRounds: 5,
        useDeterministicMock: false,
      });

      // Two possible outcomes:
      // 1. The LLM is instructed to stay within scope and refuses with success: true and no changes
      // 2. The LLM tries and the loop blocks it -> success: false with write-scope error
      if (result.success) {
        assert.strictEqual(
          result.changedFiles.length,
          0,
          'Expected no changed files when LLM refused out-of-scope write',
        );
      } else {
        assert.ok(
          result.error?.toLowerCase().includes('write scope') ||
            result.error?.toLowerCase().includes('not allowed') ||
            result.error?.toLowerCase().includes('outside'),
          `Expected error about write scope, got: ${result.error}`,
        );
      }

      // The out-of-scope file must NOT exist on disk
      assert.ok(
        !existsSync('/tmp/outside.txt'),
        '/tmp/outside.txt must not be written to disk',
      );
    } finally {
      cleanup();
    }
  },
);

test(
  'cancels via AbortController with real LLM',
  { skip: !hasLiveProvider(), timeout: E2E_TIMEOUT },
  async () => {
    const { root, cleanup } = createE2eEnv();
    try {
      const abortController = new AbortController();

      // Abort after a short delay — the LLM is still generating,
      // so this tests mid-request cancellation.
      setTimeout(() => abortController.abort(), 500);

      const agentId = `e2e-abort-${randomUUID().slice(0, 8)}`;
      const result = await runMutationAgentLoop({
        agentId,
        task:
          'Write a detailed exploration report of everything in this project in output/report.txt',
        projectRoot: root,
        writeScope: ['output'],
        workspaceRoot: root,
        toolContext: createToolContext(root, agentId),
        maxRounds: 5,
        abortSignal: abortController.signal,
        useDeterministicMock: false,
      });

      assert.ok(!result.success, 'Expected aborted execution to return success=false');
      assert.ok(
        result.error === null ||
          result.error!.toLowerCase().includes('abort') ||
          result.error!.toLowerCase().includes('cancel'),
        `Expected error to mention abort/cancel, got: ${result.error}`,
      );
    } finally {
      cleanup();
    }
  },
);

test(
  'handles read-only mode (empty writeScope) with real LLM',
  { skip: !hasLiveProvider(), timeout: E2E_TIMEOUT },
  async () => {
    const { root, cleanup } = createE2eEnv();
    try {
      const agentId = `e2e-ro-${randomUUID().slice(0, 8)}`;
      const result = await runMutationAgentLoop({
        agentId,
        task: 'List the files in the src/ directory and report what you see',
        projectRoot: root,
        writeScope: [],
        workspaceRoot: root,
        toolContext: createToolContext(root, agentId),
        maxRounds: 5,
        useDeterministicMock: false,
      });

      // In read-only mode, the agent should either:
      // 1. Finish successfully with no mutations (only reads/exploration)
      // 2. Fail because it tries a mutation action which is blocked
      if (result.success) {
        assert.strictEqual(
          result.changedFiles.length,
          0,
          'Read-only mode should not produce changed files',
        );
      } else {
        assert.ok(
          result.error?.toLowerCase().includes('no write scope') ||
            result.error?.toLowerCase().includes('read-only') ||
            result.error?.toLowerCase().includes('not allowed'),
          `Expected read-only error, got: ${result.error}`,
        );
      }
    } finally {
      cleanup();
    }
  },
);

test(
  'rollback function returns a valid summary after successful write',
  { skip: !hasLiveProvider(), timeout: E2E_TIMEOUT },
  async () => {
    const { root, cleanup } = createE2eEnv();
    try {
      const agentId = `e2e-rollback-${randomUUID().slice(0, 8)}`;
      const result = await runMutationAgentLoop({
        agentId,
        task:
          'Write a file named output/rollback-test.txt containing "This will be rolled back."',
        projectRoot: root,
        writeScope: ['output'],
        workspaceRoot: root,
        toolContext: createToolContext(root, agentId),
        maxRounds: 5,
        useDeterministicMock: false,
      });

      // Only test rollback if the write succeeded
      if (result.success && result.changedFiles.length > 0) {
        const rollbackSummary: WorktreeRollbackSummary = await result.rollback();

        assert.ok(rollbackSummary, 'rollback() must return a summary object');
        assert.ok(
          typeof rollbackSummary.status === 'string',
          `rollback summary must have a status string, got ${typeof rollbackSummary.status}`,
        );
        assert.ok(
          Array.isArray(rollbackSummary.restored_files),
          `rollback summary must have restored_files array, got ${typeof rollbackSummary.restored_files}`,
        );
        assert.ok(
          Array.isArray(rollbackSummary.removed_files),
          `rollback summary must have removed_files array, got ${typeof rollbackSummary.removed_files}`,
        );

        // The written file should have been removed or reverted by rollback
        const rolledBackPath = join(root, 'output', 'rollback-test.txt');
        const fileExists = existsSync(rolledBackPath);
        assert.ok(
          !fileExists ||
            rollbackSummary.removed_files.length > 0 ||
            rollbackSummary.restored_files.length > 0,
          `Expected rollback to either remove or restore the file. File exists: ${fileExists}. Summary: ${JSON.stringify(rollbackSummary)}`,
        );
      } else {
        // If the write failed, rollback should still work as a no-op
        const rollbackSummary: WorktreeRollbackSummary = await result.rollback();
        assert.ok(rollbackSummary, 'rollback() must return a summary even on failed write');
        assert.ok(
          rollbackSummary.status === 'rollback_not_needed' ||
            typeof rollbackSummary.status === 'string',
          `Expected valid rollback status, got: ${rollbackSummary.status}`,
        );
      }
    } finally {
      cleanup();
    }
  },
);
