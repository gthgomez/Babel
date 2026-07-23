import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  consumeLiteSchemaNormalizations,
  deriveSummaryFromAnswer,
  LitePlanAnswerSchema,
  LiteReportAnswerSchema,
  normalizeLiteReadOnlyAnswer,
  normalizeLiteStatus,
} from './liteReadOnlyAnswers.js';

describe('liteReadOnlyAnswers', () => {
  it('normalizes NEED_MORE_CONTEXT to NEEDS_MORE_CONTEXT for plan', () => {
    consumeLiteSchemaNormalizations();
    const parsed = LitePlanAnswerSchema.parse({
      schema_version: 1,
      status: 'NEED_MORE_CONTEXT',
      summary: '',
      answer: 'I need AGENTS.md before planning.',
      steps: [],
      likely_files: [],
      risks: [],
      verification: [],
      next: ['Provide AGENTS.md'],
    });
    assert.equal(parsed.status, 'NEEDS_MORE_CONTEXT');
    assert.ok(parsed.summary.length > 0);
    const normalizations = consumeLiteSchemaNormalizations();
    assert.ok(normalizations.some((entry) => entry.includes('NEEDS_MORE_CONTEXT')));
  });

  it('derives summary from answer when summary is empty', () => {
    const record: Record<string, unknown> = {
      answer: 'First sentence here. Second sentence follows.',
      summary: '',
    };
    deriveSummaryFromAnswer(record);
    assert.equal(record['summary'], 'First sentence here.');
  });

  it('unwraps single-object array wrappers', () => {
    consumeLiteSchemaNormalizations();
    const parsed = LitePlanAnswerSchema.parse([
      {
        schema_version: 1,
        status: 'PLAN_READY',
        summary: 'Ready plan.',
        answer: 'Do the smallest safe change.',
        steps: [],
        likely_files: [],
        risks: [],
        verification: [],
        next: [],
      },
    ]);
    assert.equal(parsed.status, 'PLAN_READY');
    assert.ok(consumeLiteSchemaNormalizations().includes('unwrap_single_object_array'));
  });

  it('normalizes report READY alias to REPORT_READY', () => {
    assert.equal(normalizeLiteStatus('READY', 'report'), 'REPORT_READY');
    const normalized = normalizeLiteReadOnlyAnswer(
      {
        schema_version: 1,
        status: 'READY',
        summary: 'Report summary.',
        answer: 'Completed report body.',
        findings: [],
        inspected: [],
        limitations: [],
        verification: [],
        next: [],
      },
      'report',
    ) as Record<string, unknown>;
    const parsed = LiteReportAnswerSchema.parse(normalized);
    assert.equal(parsed.status, 'REPORT_READY');
  });
});
