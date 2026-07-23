import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runReportLane } from './reportLane.js';
import { stripAnsi } from '../../ui/theme.js';

const hasDeepSeekKey = !!process.env['DEEPSEEK_API_KEY'];
const originalFetch = globalThis.fetch;
const originalDeepSeekKey = process.env['DEEPSEEK_API_KEY'];
const originalDeepInfraKey = process.env['DEEPINFRA_API_KEY'];

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
  if (originalDeepSeekKey === undefined) {
    delete process.env['DEEPSEEK_API_KEY'];
  } else {
    process.env['DEEPSEEK_API_KEY'] = originalDeepSeekKey;
  }
  if (originalDeepInfraKey === undefined) {
    delete process.env['DEEPINFRA_API_KEY'];
  } else {
    process.env['DEEPINFRA_API_KEY'] = originalDeepInfraKey;
  }
}

describe('runReportLane', () => {
  it('writes a deterministic offline compare report with concrete findings', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'babel-report-lane-compare-'));
    try {
      writeFileSync(join(repo, 'AGENTS.md'), '# Agents\n', 'utf-8');
      writeFileSync(join(repo, 'PROJECT_CONTEXT.md'), '# Context\n', 'utf-8');
      writeFileSync(
        join(repo, 'package.json'),
        JSON.stringify({ scripts: { test: 'node --test' } }),
        'utf-8',
      );
      writeFileSync(
        join(repo, 'terminal-output.ts'),
        'export const terminalOutput = true;\n',
        'utf-8',
      );
      writeFileSync(join(repo, 'output-choices.md'), '# Output Choices\n', 'utf-8');

      const result = await runReportLane({
        task: 'compare terminal output choices',
        projectRoot: repo,
        provider: 'mock',
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.payload.status, 'REPORT_READY');
      const runDir = result.payload.run_dir ?? '';
      const report = readFileSync(join(runDir, 'report.md'), 'utf-8');
      const progress = readFileSync(join(runDir, 'progress.jsonl'), 'utf-8');
      const modelReport = JSON.parse(readFileSync(join(runDir, 'model_report.json'), 'utf-8')) as {
        answer: string;
        findings: string[];
      };

      assert.equal(modelReport.findings.length >= 2, true);
      assert.match(modelReport.answer, /compare/i);
      assert.match(modelReport.findings.join('\n'), /Compared direct evidence/i);
      assert.match(modelReport.findings.join('\n'), /tradeoffs/i);
      assert.doesNotMatch(
        modelReport.findings.join('\n'),
        /Primary evidence source|No mutation was requested/i,
      );
      assert.match(report, /Suggested verification:/);
      assert.doesNotMatch(report, /\nVerification:/);
      assert.match(progress, /Report started/);
      assert.match(progress, /Contract inspected/);
      assert.match(progress, /Report ready/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('writes a deterministic offline diagnostic report with evidence and limitations', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'babel-report-lane-diagnostic-'));
    try {
      writeFileSync(join(repo, 'AGENTS.md'), '# Agents\n', 'utf-8');
      writeFileSync(join(repo, 'PROJECT_CONTEXT.md'), '# Context\n', 'utf-8');
      writeFileSync(
        join(repo, 'pipeline-diagnostic.ts'),
        'export const diagnostic = true;\n',
        'utf-8',
      );

      const result = await runReportLane({
        task: 'diagnose pipeline diagnostic risk',
        projectRoot: repo,
        provider: 'mock',
      });

      assert.equal(result.exitCode, 0);
      const modelReport = JSON.parse(
        readFileSync(join(result.payload.run_dir ?? '', 'model_report.json'), 'utf-8'),
      ) as {
        findings: string[];
        limitations: string[];
        verification: string[];
      };
      assert.equal(
        modelReport.findings.some((finding) =>
          /Observed scope signal|Evidence is concentrated|Recommended validation/.test(finding),
        ),
        true,
      );
      assert.equal(modelReport.limitations.length >= 1, true);
      assert.equal(modelReport.verification.length >= 0, true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('writes a read-only report with normalized provider arrays', { skip: !hasDeepSeekKey }, async () => {
    const repo = mkdtempSync(join(tmpdir(), 'babel-report-lane-'));
    try {
      writeFileSync(join(repo, 'README.md'), '# Test Repo\n', 'utf-8');
      process.env['DEEPSEEK_API_KEY'] = 'sk-test-key';
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    schema_version: 1,
                    status: 'REPORT_READY',
                    summary: 'Compared the reliability paths.',
                    answer:
                      'The evidence shows target consistency and output review are separate reliability paths, with latest pointers acting as inspection routing evidence.',
                    findings: [
                      { finding: 'Target consistency guards path drift before execution.' },
                      { description: 'Output review catches contradictions in human summaries.' },
                    ],
                    inspected: [{ path: 'README.md' }],
                    limitations: [{ summary: 'Only shallow contract context was available.' }],
                    verification: [{ command: 'npm test' }],
                    next: [{ next: 'Use bl plan for follow-up implementation.' }],
                  }),
                },
              },
            ],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 50,
              total_tokens: 150,
            },
          }),
          { status: 200 },
        )) as typeof fetch;

      // Provide both API keys so the live-provider path can proceed;
      // fetch is mocked above to return a deterministic response.
      process.env['DEEPINFRA_API_KEY'] = 'test-key';

      const result = await runReportLane({
        task: 'compare implementation paths for target drift and output review',
        projectRoot: repo,
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.payload.status, 'REPORT_READY');
      assert.equal(result.payload.selected_lane, 'lite_report');
      const humanText = stripAnsi(result.humanText);
      assert.match(humanText, /^Babel Read-only report Ready/);
      assert.match(humanText, /\nMode:\nRead-only report/);
      assert.match(humanText, /\nAnswer:\n/);
      assert.match(humanText, /target consistency/);
      assert.match(humanText, /output review/);
      // Verify read-only lane detected zero changes (no Changed section in output)
      assert.doesNotMatch(humanText, /\nChanged:\n/);
      assert.equal(existsSync(join(result.payload.run_dir ?? '', 'report.md')), true);
      assert.match(
        readFileSync(join(result.payload.run_dir ?? '', 'report.md'), 'utf-8'),
        /Target consistency guards path drift/,
      );
      const modelReport = JSON.parse(
        readFileSync(join(result.payload.run_dir ?? '', 'model_report.json'), 'utf-8'),
      ) as {
        findings: string[];
        inspected: string[];
        verification: string[];
      };
      assert.deepEqual(modelReport.findings, [
        'Target consistency guards path drift before execution.',
        'Output review catches contradictions in human summaries.',
      ]);
      assert.deepEqual(modelReport.inspected, ['README.md']);
      assert.deepEqual(modelReport.verification, ['npm test']);
    } finally {
      restoreFetch();
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
