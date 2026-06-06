import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  GovernanceBenchmarkResultSchema,
  type GovernanceBenchmarkResult,
} from './governanceBenchmark.js';

export interface GovernanceBenchmarkReportOptions {
  inputPath: string;
  outputPath: string;
}

export interface GovernanceBenchmarkReportSummary {
  input_path: string;
  output_path: string;
  result_count: number;
  tools: string[];
}

interface ToolSummary {
  tool_id: string;
  tool_name: string;
  total: number;
  completed: number;
  unavailable: number;
  task_success: number;
  false_complete: number;
}

export function loadBenchmarkResultsJsonl(inputPath: string): GovernanceBenchmarkResult[] {
  const raw = readFileSync(resolve(inputPath), 'utf8');
  return raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => GovernanceBenchmarkResultSchema.parse(JSON.parse(line)));
}

export function generateGovernanceBenchmarkReport(options: GovernanceBenchmarkReportOptions): GovernanceBenchmarkReportSummary {
  const results = loadBenchmarkResultsJsonl(options.inputPath);
  const markdown = formatGovernanceBenchmarkReport(results, resolve(options.inputPath));
  const outputPath = resolve(options.outputPath);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, markdown, 'utf8');
  return {
    input_path: resolve(options.inputPath),
    output_path: outputPath,
    result_count: results.length,
    tools: [...new Set(results.map(result => result.tool.id))].sort(),
  };
}

export function formatGovernanceBenchmarkReport(
  results: readonly GovernanceBenchmarkResult[],
  inputPath: string,
): string {
  const generatedAt = new Date().toISOString();
  const toolSummaries = summarizeByTool(results);
  const categories = [...new Set(results.map(result => result.category))].sort();
  const lines: string[] = [
    '# Babel Governance Benchmark Scorecard',
    '',
    `Generated: ${generatedAt}`,
    `Input: ${inputPath}`,
    '',
    '## Caveats',
    '',
    '- This scorecard is public-safe and intentionally does not rank tools globally.',
    '- Unavailable or pending external adapters are marked unavailable, not failed.',
    '- A Babel local deterministic canary is not live-provider proof and must not be used as a superiority claim.',
    '- Cost is reported only when an adapter supplies cost evidence; null means unavailable, not free.',
    '',
    '## Coverage',
    '',
    `- Records: ${results.length}`,
    `- Categories observed in this result file: ${categories.join(', ') || '(none)'}`,
    '',
    '## Tool Summary',
    '',
    '| Tool | Records | Completed | Unavailable | Task Success | False Complete |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
  ];

  for (const summary of toolSummaries) {
    lines.push(
      `| ${escapeMarkdown(summary.tool_name)} (${summary.tool_id}) | ${summary.total} | ${summary.completed} | ${summary.unavailable} | ${summary.task_success} | ${summary.false_complete} |`,
    );
  }

  lines.push(
    '',
    '## Records',
    '',
    '| Task | Category | Tool | Status | Terminal | Verifier | Trace | Caveat |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  );

  for (const result of results) {
    const verifier = result.metrics.verifier_passed === null
      ? 'n/a'
      : result.metrics.verifier_passed ? 'passed' : 'failed';
    lines.push(
      `| ${result.task_id} | ${result.category} | ${result.tool.id} | ${result.result_status} | ${result.metrics.normalized_terminal_status} | ${verifier} | ${result.metrics.audit_trace_quality} | ${escapeMarkdown(result.caveats[0] ?? '')} |`,
    );
  }

  lines.push(
    '',
    '## Interpretation Boundary',
    '',
    'This report can support narrow claims about the recorded benchmark harness run only. It cannot support superiority claims over Codex CLI, Claude Code, Gemini CLI, Aider, OpenHands, or any other coding agent until those adapters run real tasks under the same corpus and the resulting artifacts are reviewed.',
    '',
  );

  return `${lines.join('\n')}\n`;
}

function summarizeByTool(results: readonly GovernanceBenchmarkResult[]): ToolSummary[] {
  const map = new Map<string, ToolSummary>();
  for (const result of results) {
    const existing = map.get(result.tool.id) ?? {
      tool_id: result.tool.id,
      tool_name: result.tool.name,
      total: 0,
      completed: 0,
      unavailable: 0,
      task_success: 0,
      false_complete: 0,
    };
    existing.total += 1;
    if (result.result_status === 'completed') existing.completed += 1;
    if (result.result_status === 'unavailable') existing.unavailable += 1;
    if (result.metrics.task_success) existing.task_success += 1;
    if (result.metrics.false_complete) existing.false_complete += 1;
    map.set(result.tool.id, existing);
  }
  return [...map.values()].sort((a, b) => a.tool_id.localeCompare(b.tool_id));
}

function escapeMarkdown(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
