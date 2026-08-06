/**
 * Unit tests for PipelineEpisodeSink extracted module.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { loadEpisodeEventLogFromDir } from '../evidence/episodeStream.js';
import { createPipelineEpisodeLifecycle } from './pipelineEpisodeLifecycle.js';
import { PipelineEpisodeSink } from './pipelineEpisodeSink.js';

describe('PipelineEpisodeSink', () => {
  test('initializes log and dual-writes stage, tool, and completion events', () => {
    const dir = mkdtempSync(join(tmpdir(), 'babel-pipeline-sink-'));
    try {
      const created = PipelineEpisodeSink.create({ runDir: dir, sessionId: 'pipe-sess-1' });
      if (!created.ok) throw new Error(created.error.message);
      const sink = created.value;
      assert.equal(sink.log.sessionId, 'pipe-sess-1');

      sink.recordStageTransition('Stage 1 Scope', 'started', { target: 'clean_swe' });
      sink.recordToolCall('fileRead', { path: 'src/main.ts' }, { length: 120 });
      sink.recordStageTransition('Stage 1 Scope', 'completed');
      sink.recordCompletion('VERIFIED_COMPLETE', 'All verification checks passed');

      const loaded = loadEpisodeEventLogFromDir(dir);
      assert.ok(loaded);
      assert.equal(loaded.events.length, 5); // LEGACY_MIGRATION_GENESIS + 4 events
      assert.equal(loaded.events[1]!.type, 'PIPELINE_STAGE_STARTED');
      assert.equal(loaded.events[2]!.type, 'TOOL_FILEREAD');
      assert.equal(loaded.events[3]!.type, 'PIPELINE_STAGE_COMPLETED');
      assert.equal(loaded.events[4]!.type, 'PIPELINE_COMPLETION');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('factory rejects an existing stream in new mode and preserves one sink chain', () => {
    const dir = mkdtempSync(join(tmpdir(), 'babel-pipeline-sink-factory-'));
    try {
      const first = PipelineEpisodeSink.create({ runDir: dir, sessionId: 'factory-sess', mode: 'new' });
      if (!first.ok) throw new Error('expected first sink creation to succeed');
      first.value.recordStageTransition('orchestrator', 'completed');

      const duplicate = PipelineEpisodeSink.create({ runDir: dir, sessionId: 'factory-sess', mode: 'new' });
      if (duplicate.ok) throw new Error('expected duplicate new sink creation to fail');
      assert.equal(duplicate.error.code, 'already_exists');

      const resumed = PipelineEpisodeSink.create({ runDir: dir, sessionId: 'factory-sess', mode: 'resume' });
      if (!resumed.ok) throw new Error('expected resumed sink creation to succeed');
      resumed.value.recordToolCall('shell_exec', { step: 2 }, { exit_code: 0 });
      const loaded = loadEpisodeEventLogFromDir(dir);
      assert.ok(loaded);
      assert.deepEqual(
        loaded.events.map((event) => event.seq),
        loaded.events.map((_event, index) => index),
      );
      assert.equal(loaded.events.at(-1)!.type, 'TOOL_SHELL_EXEC');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('later persistence failure degrades the sink and disables further writes', () => {
    const parent = mkdtempSync(join(tmpdir(), 'babel-pipeline-sink-degraded-'));
    const runDir = join(parent, 'run-as-file');
    try {
      writeFileSync(runDir, 'not a directory', 'utf-8');
      const warnings: string[] = [];
      const created = PipelineEpisodeSink.create({
        runDir,
        sessionId: 'degraded-sess',
        onDegraded: (warning) => warnings.push(warning),
      });
      if (!created.ok) throw new Error('expected degraded sink creation to return a sink');
      const sink = created.value;
      assert.equal(sink.status, 'degraded');
      assert.equal(warnings.length, 1);
      const warningCount = sink.warnings.length;
      sink.recordCompletion('EXECUTOR_HALTED', 'persistence test');
      assert.equal(sink.warnings.length, warningCount);
      assert.equal(warnings.length, 1);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('serialization and degradation callback failures never escape the sink', () => {
    const dir = mkdtempSync(join(tmpdir(), 'babel-pipeline-sink-serialization-'));
    let callbackCalls = 0;
    try {
      const created = PipelineEpisodeSink.create({
        runDir: dir,
        sessionId: 'serialization-sess',
        onDegraded: () => {
          callbackCalls++;
          throw new Error('callback failure');
        },
      });
      if (!created.ok) throw new Error(created.error.message);
      const sink = created.value;

      assert.doesNotThrow(() => {
        sink.recordToolCall('serialization_probe', { value: 1n });
      });
      assert.equal(sink.status, 'degraded');
      assert.equal(sink.warnings.length, 1);
      assert.match(sink.warnings[0]!, /append failed/u);
      assert.equal(callbackCalls, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('lifecycle finalization is idempotent and writes one warning artifact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'babel-pipeline-lifecycle-'));
    const warningFiles: string[] = [];
    try {
      const lifecycle = createPipelineEpisodeLifecycle({
        runDir: dir,
        sessionId: 'lifecycle-sess',
        mode: 'new',
        writeWarning: (warning) => warningFiles.push(warning),
      });
      lifecycle.recordPhase('swe_planning', 'started', { attempt: 1 });
      lifecycle.recordFinalization('COMPLETE', 'done');
      lifecycle.recordFinalization('COMPLETE', 'duplicate call');
      const loaded = loadEpisodeEventLogFromDir(dir);
      assert.ok(loaded);
      assert.equal(loaded.events.filter((event) => event.type === 'PIPELINE_COMPLETION').length, 1);
      assert.equal(loaded.events.some((event) => event.payload['phase'] === 'orchestrator'), false);
      assert.equal(loaded.events.some((event) => event.payload['phase'] === 'qa_review'), false);
      assert.equal(loaded.events.some((event) => event.payload['phase'] === 'executor'), false);
      assert.equal(loaded.events.some((event) => event.type === 'PIPELINE_PHASE_FAILED' && event.payload['phase'] === 'swe_planning'), true);
      assert.equal(warningFiles.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
