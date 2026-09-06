import { mkdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { cellInvalidReasons, type CellResult, type PairResult } from './comparison-contract.js'

const text = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v)).replaceAll('|', '\\|').replaceAll('\n', ' ')

/** Render both arms from their canonical cell records. */
export function pairMarkdown(pair: PairResult, reportDir = '.'): string {
  const rows: Array<[string, (c: CellResult) => unknown]> = [
    ['Provider/model', c => `${c.REQUESTED_PROVIDER}/${c.REQUESTED_MODEL} → ${c.OBSERVED_PROVIDER}/${c.OBSERVED_MODEL}; fallback=${c.fallback}`],
    ['Harness/version', c => `${c.harness} ${c.contract?.arms?.[c.harness]?.version ?? 'UNKNOWN'}`],
    ['Capability parity', c => c.CAPABILITY_DIGEST],
    ['Execution', c => c.EXECUTION_SUCCESS], ['Semantic correctness', c => c.TASK_CORRECTNESS],
    ['Frozen verifier', c => `${c.VERIFIER_ID} ${c.VERIFIER_DIGEST} ${c.VERIFIER_RESULT} (${c.VERIFIER_PRODUCER})`],
    ['First failure', c => c.FAILURES_ENCOUNTERED[0] ?? 'UNKNOWN'],
    ['Diagnostic quality', c => c.ACTIONABLE_DIAGNOSTICS_OBSERVED], ['Retries', c => c.RETRIES],
    ['Recovery', c => c.RECOVERY_SUCCESS], ['Cause identification', c => c.CAUSE_IDENTIFICATION],
    ['Harness effect', c => c.HARNESS_EFFECT], ['Timeout/cancellation', c => c.termination],
    ['Wall time (ms)', c => c.metrics.wallTimeMs], ['Model/tool calls', c => `${c.metrics.modelCalls}/${c.metrics.toolCalls}`],
    ['Cost/tokens', c => `${c.metrics.cost}; input=${c.metrics.inputTokens}; output=${c.metrics.outputTokens}`],
    ['Changed files', c => c.changedFiles],
  ]
  const links = (c: CellResult): string => Object.entries(c.evidence).map(([name, path]) => path === 'UNKNOWN' ? `${name}: UNKNOWN` : `[${name}](<${relative(reportDir, path).replaceAll('\\', '/')}>)`).join(' · ')
  return `# ${text(pair.pairId)}\n\nDimension | Claude Code harness | Babel harness\n--- | --- | ---\n${rows.map(([label, get]) => `${label} | ${text(get(pair.claude))} | ${text(get(pair.babel))}`).join('\n')}\nEvidence | ${links(pair.claude)} | ${links(pair.babel)}\n\nPAIR_VALIDITY=${pair.PAIR_VALIDITY}\n\nPAIR_VERDICT=${pair.PAIR_VERDICT}\n\nReasons: ${pair.reasons.map(text).join(', ') || 'none'}\n`
}

/** Aggregate counts exclude invalid pairs from all win/loss/tie totals. */
export function aggregateResults(pairs: PairResult[]): Record<string, unknown> {
  const cells = pairs.flatMap(p => [p.claude, p.babel])
  const count = (v: PairResult['PAIR_VERDICT']): number => pairs.filter(p => p.PAIR_VERDICT === v).length
  const timeouts: Record<string, number> = {}
  for (const c of cells) if (c.termination.kind !== 'NORMAL') timeouts[c.termination.kind] = (timeouts[c.termination.kind] ?? 0) + 1
  return {
    totalCellsAttempted: cells.filter(c => c.attempted).length,
    validCells: cells.filter(c => c.attempted && cellInvalidReasons(c).length === 0).length,
    matchedValidPairs: pairs.filter(p => p.PAIR_VALIDITY === 'VALID').length,
    invalidComparisons: count('INVALID_COMPARISON'), inconclusiveComparisons: count('INCONCLUSIVE'),
    claudeWins: count('CLAUDE_WIN'), babelWins: count('BABEL_WIN'), ties: count('TIE'),
    modelProviderMismatches: cells.filter(c => c.attempted && ((c.OBSERVED_MODEL !== 'UNKNOWN' && c.OBSERVED_MODEL !== c.REQUESTED_MODEL) || (c.OBSERVED_PROVIDER !== 'UNKNOWN' && c.OBSERVED_PROVIDER !== c.REQUESTED_PROVIDER))).length,
    modelProviderUnknownCells: cells.filter(c => c.attempted && (c.OBSERVED_MODEL === 'UNKNOWN' || c.OBSERVED_PROVIDER === 'UNKNOWN')).length,
    fallbackEvents: cells.filter(c => c.fallback === true).length,
    fallbackUnknownCells: cells.filter(c => c.attempted && c.fallback === 'UNKNOWN').length,
    capabilityMismatches: pairs.filter(p => p.reasons.includes('INVALID_CAPABILITY_MISMATCH')).length,
    verifierInvalidCells: cells.filter(c => c.VERIFIER_RESULT === 'INVALID' || c.invalidReasons.includes('INVALID_VERIFIER')).length,
    terminationsByProvenance: timeouts,
    recoveryAttempts: cells.filter(c => typeof c.RETRIES === 'number' && c.RETRIES > 0).length,
    recoverySuccesses: cells.filter(c => c.RECOVERY_SUCCESS === true).length,
    recoveryUnknownCells: cells.filter(c => c.RECOVERY_SUCCESS === 'UNKNOWN').length,
    pairs: pairs.map(p => ({ pairId: p.pairId, validity: p.PAIR_VALIDITY, verdict: p.PAIR_VERDICT, reasons: p.reasons, evidence: { claude: p.claude.evidence, babel: p.babel.evidence } })),
  }
}

/** Write JSON and Markdown together, never replacing an existing report. */
export function writeComparisonReports(outputDir: string, pairs: PairResult[]): void {
  mkdirSync(outputDir, { recursive: true })
  const summary = aggregateResults(pairs)
  pairs.forEach((pair, i) => {
    writeFileSync(join(outputDir, `pair-${i + 1}.json`), `${JSON.stringify(pair, null, 2)}\n`, { flag: 'wx' })
    writeFileSync(join(outputDir, `pair-${i + 1}.md`), pairMarkdown(pair, outputDir), { flag: 'wx' })
  })
  writeFileSync(join(outputDir, 'aggregate.json'), `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' })
  writeFileSync(join(outputDir, 'aggregate.md'), `# Experiment results\n\n${Object.entries(summary).filter(([k]) => k !== 'pairs').map(([k, v]) => `- ${k}: ${text(v)}`).join('\n')}\n\n${pairs.map((p, i) => `- [${text(p.pairId)}](pair-${i + 1}.md) · [packet](pair-${i + 1}.json): ${p.PAIR_VERDICT}`).join('\n')}\n`, { flag: 'wx' })
}
