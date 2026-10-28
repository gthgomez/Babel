import { createHash } from 'node:crypto'
import { nativeNodeResultCounts } from './nativeTestResultCounts.js'
import { compileObservation } from './codingLoop/observationCompiler.js'
import { parseExecutedTestCounts } from './completionGatePolicy.js'

/** Settled host facts only. Physical IDs, clocks and display formatting are absent. */
export function verifierSemanticProgress(input: {
  executionContextKey: string; candidateRevision: string; exitCode: number; stdout: string; stderr: string; command: string
}): string {
  const observation = compileObservation({ tool: 'test_run', target: input.command, command: input.command,
    exitCode: input.exitCode, stdout: input.stdout, stderr: input.stderr, denyRawSpill: true })
  const stableMessage = (message: string) => message.replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|milliseconds|seconds|secs)\b/gi, '<duration>')
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, '<timestamp>')
  const failures = observation.failures.map(failure => [failure.parser, failure.file ?? '', failure.line ?? null,
    failure.column ?? null, failure.test ?? '', stableMessage(failure.message)]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  const output = `${input.stdout}\n${input.stderr}`
  const counts = nativeNodeResultCounts(input.command, output) ?? parseExecutedTestCounts(output, input.command)
  const failedLabels = [...output.matchAll(/^\s*(?:not ok\s+\d+\s*[-:]?|✖)\s+(.+)$/gm)]
    .map(match => stableMessage(match[1]!).replace(/\s*\(<duration>\)\s*$/, '')).sort()
  return createHash('sha256').update(JSON.stringify([input.executionContextKey, input.candidateRevision, 'exited', input.exitCode,
    failures, failedLabels, counts])).digest('hex')
}
