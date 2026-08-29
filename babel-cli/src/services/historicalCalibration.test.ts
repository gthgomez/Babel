import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHistoricalCalibrationCorpus,
  LEGACY_CALIBRATION_CORPUS_VERSION,
  writeHistoricalCalibrationCorpus,
} from './historicalCalibration.js';
import {
  appendSessionEvent,
  createSessionEventLog,
  rewriteSessionEventLog,
} from '../agent/sessionEvents.js';

test('historical corpus re-scores session evidence without changing raw bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-historical-'));
  const run = join(root, 'glm-c01');
  const log = createSessionEventLog('historical-session');
  appendSessionEvent(log, { kind: 'user_submitted', turn_id: 'turn-1', task_preview: 'historical fixture' });
  rewriteSessionEventLog(run, log);
  writeFileSync(join(run, 'canary-report.json'), JSON.stringify({ task_id: 'C01', outcome: 'blocked' }));
  const rawBefore = readFileSync(join(run, 'session-events.jsonl'), 'utf8');

  const build = buildHistoricalCalibrationCorpus({ sourceRoots: [root], now: '2026-08-28T00:00:00.000Z' });
  assert.equal(build.corpus.corpus_version, LEGACY_CALIBRATION_CORPUS_VERSION);
  assert.equal(build.corpus.entries.length, 1);
  assert.equal(build.analyses[0]?.new_causal_report.status, 'ok');
  assert.equal(build.analyses[0]?.impossible_or_unknown_facts.some((fact) => fact.fact === 'task_feasible'), true);

  const output = mkdtempSync(join(tmpdir(), 'babel-derived-'));
  const written = writeHistoricalCalibrationCorpus(build, output, [root]);
  assert.equal(readFileSync(join(run, 'session-events.jsonl'), 'utf8'), rawBefore);
  assert.equal(readFileSync(written.manifestPath, 'utf8').includes(LEGACY_CALIBRATION_CORPUS_VERSION), true);
  assert.equal(written.analysisPaths.length, 1);
});

test('historical corpus refuses to write inside raw evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-historical-'));
  assert.throws(
    () => writeHistoricalCalibrationCorpus(
      { corpus: { schema_version: 1, kind: 'babel_historical_calibration_corpus', corpus_version: LEGACY_CALIBRATION_CORPUS_VERSION, analyzer_version: 'causal-analyzer-v1', created_at: '2026-08-28T00:00:00.000Z', source_roots: [root], raw_sources_readonly: true, entries: [] }, analyses: [] },
      join(root, 'derived'),
      [root],
    ),
    /outside raw evidence root/,
  );
});

test('historical corpus preserves report-only evidence as UNKNOWN', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-historical-report-only-'));
  writeFileSync(join(root, 'C01-cli.json'), JSON.stringify({ task_id: 'C01', status: 'blocked' }));
  const build = buildHistoricalCalibrationCorpus({ sourceRoots: [root] });
  assert.equal(build.corpus.entries.length, 1);
  assert.equal(build.corpus.entries[0]?.analyzer_can_fully_interpret, false);
  assert.equal(build.analyses[0]?.new_causal_report.status, 'unknown');
});
