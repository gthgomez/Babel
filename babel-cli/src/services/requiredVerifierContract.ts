import { join } from 'node:path';

import type { ToolCallLog } from '../schemas/agentContracts.js';
import { isVerifierCommand, type TerminalStatus } from './terminalStatus.js';

export type VerifierState =
  | 'planned'
  | 'running'
  | 'passed'
  | 'failed'
  | 'skipped_optional'
  | 'skipped_due_to_prior_required_failure'
  | 'skipped_forbidden'
  | 'missing';

export type VerifierSource =
  | 'user_required'
  | 'discovered'
  | 'default_project'
  | 'optional';

interface ParsedVerifierCommand {
  executable: string;
  args: string[];
}

export interface VerifierExecutionRecord {
  step: number;
  tool: 'shell_exec' | 'test_run';
  command: string;
  state: Exclude<VerifierState, 'planned' | 'running' | 'skipped_optional' | 'skipped_due_to_prior_required_failure' | 'missing'>;
  exitCode: number;
  stdoutSummary: string | null;
  stderrSummary: string | null;
  selected: boolean;
}

export interface VerifierContractEntry {
  id: string;
  command: string;
  cwd: string | null;
  required: boolean;
  state: VerifierState;
  exitCode: number | null;
  stdoutSummary: string | null;
  stderrSummary: string | null;
  startedAt: string | null;
  endedAt: string | null;
  skipReason: string | null;
  source: VerifierSource;
  blocksComplete: boolean;
  executionHistory: VerifierExecutionRecord[];
}

export interface VerifierContractSummary {
  schema_version: 1;
  artifact_type: 'babel_verifier_execution_summary';
  requiredVerifierCount: number;
  requiredVerifierPassedCount: number;
  requiredVerifierFailedCount: number;
  requiredVerifierSkippedCount: number;
  verifierCompletionSatisfied: boolean;
  missingRequiredVerifiers: string[];
  skippedRequiredVerifiers: string[];
  failedRequiredVerifiers: string[];
  completionBlockingStatus: TerminalStatus | null;
  verifiers: VerifierContractEntry[];
}

export interface VerifierContractArtifacts {
  plan: {
    schema_version: 1;
    artifact_type: 'babel_verifier_plan';
    verifiers: VerifierContractEntry[];
  };
  summary: VerifierContractSummary;
  artifactPaths: {
    verifier_plan: string;
    verifier_execution_summary: string;
  };
}

export function buildVerifierContractArtifacts(input: {
  task: string;
  toolCallLog?: readonly ToolCallLog[];
  runDir: string;
}): VerifierContractArtifacts {
  const planned = buildVerifierPlan(input.task);
  const executed = reconcileVerifierPlan(planned, input.toolCallLog ?? []);
  const summary = summarizeVerifierContract(executed);
  return {
    plan: {
      schema_version: 1,
      artifact_type: 'babel_verifier_plan',
      verifiers: planned,
    },
    summary,
    artifactPaths: {
      verifier_plan: join(input.runDir, 'verifier_plan.json'),
      verifier_execution_summary: join(input.runDir, 'verifier_execution_summary.json'),
    },
  };
}

export function buildVerifierPlan(task: string): VerifierContractEntry[] {
  const required = extractRequiredVerifierCommands(task);
  const optional = extractOptionalVerifierCommands(task)
    .filter(command => !required.some(item => sameCommand(item, command)));
  return [
    ...required.map((command, index) => makePlannedEntry(command, index + 1, true, 'user_required')),
    ...optional.map((command, index) => makePlannedEntry(command, required.length + index + 1, false, 'optional')),
  ];
}

export function reconcileVerifierPlan(
  plan: readonly VerifierContractEntry[],
  toolCallLog: readonly ToolCallLog[],
): VerifierContractEntry[] {
  const commandEntries = toolCallLog.filter(entry =>
    (entry.tool === 'shell_exec' || entry.tool === 'test_run') &&
    isVerifierCommand(entry.target)
  );
  let priorRequiredFailed = false;
  return plan.map(entry => {
    const matches = commandEntries.filter(item => sameCommand(item.target, entry.command));
    const finalMatch = matches.at(-1);
    if (!finalMatch) {
      if (!entry.required) {
        return {
          ...entry,
          state: 'skipped_optional',
          skipReason: 'Optional verifier was not run.',
        };
      }
      if (priorRequiredFailed) {
        return {
          ...entry,
          state: 'skipped_due_to_prior_required_failure',
          skipReason: 'Skipped because an earlier required verifier failed.',
          blocksComplete: true,
        };
      }
      return {
        ...entry,
        state: 'missing',
        skipReason: 'Required verifier was planned but no matching tool execution was recorded.',
        blocksComplete: true,
      };
    }

    const forbidden = finalMatch.exit_code === 126 && Boolean(finalMatch.denial);
    const failed = finalMatch.exit_code !== 0;
    const state: VerifierState = forbidden
      ? 'skipped_forbidden'
      : failed
        ? 'failed'
        : 'passed';
    if (entry.required && state !== 'passed') {
      priorRequiredFailed = true;
    }
    return {
      ...entry,
      cwd: null,
      state,
      exitCode: finalMatch.exit_code,
      stdoutSummary: summarizeVerifierStream(finalMatch.stdout),
      stderrSummary: summarizeVerifierStream(finalMatch.stderr),
      startedAt: null,
      endedAt: null,
      skipReason: forbidden
        ? finalMatch.denial?.message ?? 'Required verifier was forbidden by tool policy.'
        : null,
      blocksComplete: entry.required && state !== 'passed',
      executionHistory: matches.map(match => {
        const matchForbidden = match.exit_code === 126 && Boolean(match.denial);
        const matchState: VerifierExecutionRecord['state'] = matchForbidden
          ? 'skipped_forbidden'
          : match.exit_code === 0
            ? 'passed'
            : 'failed';
        return {
          step: match.step,
          tool: match.tool as 'shell_exec' | 'test_run',
          command: match.target,
          state: matchState,
          exitCode: match.exit_code,
          stdoutSummary: summarizeVerifierStream(match.stdout),
          stderrSummary: summarizeVerifierStream(match.stderr),
          selected: match === finalMatch,
        };
      }),
    };
  });
}

export function summarizeVerifierContract(verifiers: readonly VerifierContractEntry[]): VerifierContractSummary {
  const required = verifiers.filter(entry => entry.required);
  const missing = required.filter(entry => entry.state === 'missing').map(entry => entry.command);
  const skipped = required
    .filter(entry => entry.state === 'skipped_due_to_prior_required_failure' || entry.state === 'skipped_forbidden')
    .map(entry => entry.command);
  const failed = required.filter(entry => entry.state === 'failed').map(entry => entry.command);
  const requiredPassed = required.filter(entry => entry.state === 'passed').length;
  const verifierCompletionSatisfied =
    required.length === 0 ||
    required.every(entry => entry.state === 'passed');
  return {
    schema_version: 1,
    artifact_type: 'babel_verifier_execution_summary',
    requiredVerifierCount: required.length,
    requiredVerifierPassedCount: requiredPassed,
    requiredVerifierFailedCount: failed.length,
    requiredVerifierSkippedCount: skipped.length + missing.length,
    verifierCompletionSatisfied,
    missingRequiredVerifiers: missing,
    skippedRequiredVerifiers: skipped,
    failedRequiredVerifiers: failed,
    completionBlockingStatus: verifierCompletionSatisfied
      ? null
      : missing.length > 0
        ? 'REQUIRED_VERIFIER_MISSING'
        : skipped.length > 0
          ? 'REQUIRED_VERIFIER_SKIPPED'
          : failed.length > 0
            ? 'REQUIRED_VERIFIER_FAILED'
            : 'VERIFIER_CONTRACT_UNSATISFIED',
    verifiers: [...verifiers],
  };
}

function makePlannedEntry(
  command: string,
  index: number,
  required: boolean,
  source: VerifierSource,
): VerifierContractEntry {
  return {
    id: `verifier_${String(index).padStart(2, '0')}`,
    command,
    cwd: '.',
    required,
    state: 'planned',
    exitCode: null,
    stdoutSummary: null,
    stderrSummary: null,
    startedAt: null,
    endedAt: null,
    skipReason: null,
    source,
    blocksComplete: required,
    executionHistory: [],
  };
}

function extractRequiredVerifierCommands(task: string): string[] {
  const commands: string[] = [];
  for (const line of task.split(/\r?\n/)) {
    const match = line.match(/\bVerifier commands?\s*:\s*(.+)$/i);
    if (match?.[1]) {
      commands.push(...splitCommandList(trimTrailingTaskLabels(match[1])));
    }
  }
  const runBeforePattern = /\bRun\s+([^\n.;]+?)\s+before\s+completing\b/gi;
  for (const match of task.matchAll(runBeforePattern)) {
    if (match[1]) commands.push(cleanCommand(match[1]));
  }
  const verifierIsPattern = /\bverifier\s+(?:is|:)\s*([^\n.;]+)/gi;
  for (const match of task.matchAll(verifierIsPattern)) {
    if (match[1]) commands.push(cleanCommand(match[1]));
  }
  return uniqueCommands(commands.filter(command => isVerifierCommand(command)));
}

function extractOptionalVerifierCommands(task: string): string[] {
  const commands: string[] = [];
  const optionalPattern = /\bRun\s+([^\n.;]+?)\s+if\s+possible\b/gi;
  for (const match of task.matchAll(optionalPattern)) {
    if (match[1]) commands.push(cleanCommand(match[1]));
  }
  return uniqueCommands(commands.filter(command => isVerifierCommand(command)));
}

function splitCommandList(raw: string): string[] {
  return raw
    .split(/\s+&&\s+|;\s+/)
    .map(cleanCommand)
    .filter(Boolean);
}

function trimTrailingTaskLabels(raw: string): string {
  return raw.replace(
    /\s+\b(?:Expected outcome|Allowed files?|Allowed director(?:y|ies)|Forbidden files?|Risk rating|Task id)\s*:.*$/i,
    '',
  );
}

function cleanCommand(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/\s+from\s+(?:the\s+)?[A-Za-z0-9_.\\/-]+(?:\s+(?:directory|folder|subdirectory))?$/i, '')
    .replace(/[.。]\s*$/, '')
    .trim();
}

function sameCommand(left: string, right: string): boolean {
  return normalizeCommand(left) === normalizeCommand(right);
}

function normalizeCommand(command: string): string {
  const parsed = parseCanonicalVerifierCommand(command);
  if (!parsed) {
    return cleanCommand(command).toLowerCase();
  }
  const executable = parsed.executable;
  const args = parsed.args;
  if (executable === 'npm') {
    const normalizedArgs = skipLeadingOptions(args);
    if (normalizedArgs[0] === 'test') {
      return 'npm test';
    }
    if (normalizedArgs[0] === 'run' && normalizedArgs[1]) {
      return `npm run ${normalizedArgs[1]}`;
    }
    return cleanCommand(command).toLowerCase();
  }
  if (executable === 'node' && args.includes('--test')) {
    return 'node --test';
  }
  if (executable === 'tsc') {
    return args.includes('-b') ? 'tsc -b' : 'tsc';
  }
  if (executable === 'vitest') {
    return normalizedVerifierName('vitest', normalizedArgsOrRun(args));
  }
  if (executable === 'pytest' || executable === 'jest') {
    return executable;
  }
  if (executable === 'go' && skipLeadingOptions(args)[0] === 'test') {
    return 'go test';
  }
  if (executable === 'cargo' && skipLeadingOptions(args)[0] === 'test') {
    return 'cargo test';
  }
  if (executable === 'gradle' && skipLeadingOptions(args)[0] === 'test') {
    return 'gradle test';
  }
  if (executable === 'gradlew' && skipLeadingOptions(args)[0] === 'test') {
    return 'gradlew test';
  }
  return cleanCommand(command).toLowerCase();
}

function uniqueCommands(commands: readonly string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const command of commands.map(cleanCommand).filter(Boolean)) {
    const normalized = normalizeCommand(command);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      output.push(command);
    }
  }
  return output;
}

function parseCanonicalVerifierCommand(command: string): ParsedVerifierCommand | null {
  const tokens = tokenizeCommand(command);
  if (tokens.length === 0) {
    return null;
  }
  const firstToken = tokens[0];
  if (!firstToken) {
    return null;
  }
  const executable = normalizeCommandExecutable(firstToken);
  if (!executable) {
    return null;
  }
  return {
    executable,
    args: tokens.slice(1).map(token => normalizeCommandArg(token)),
  };
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i += 1) {
    const char = command.charAt(i);
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && /\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

function normalizeCommandExecutable(token: string): string {
  const trimmed = token.replace(/^['"]|['"]$/g, '').trim();
  const normalized = trimmed.split(/[\\/]/).at(-1) ?? '';
  return normalized
    .toLowerCase()
    .replace(/\.(cmd|bat|exe)$/i, '')
    .replace(/\.cmd$/i, '');
}

function normalizeCommandArg(token: string): string {
  return token.replace(/^['"]|['"]$/g, '').trim().toLowerCase();
}

function skipLeadingOptions(args: readonly string[]): string[] {
  const normalized = [...args];
  while (normalized.length > 0 && (normalized[0] ?? '').startsWith('-')) {
    normalized.shift();
  }
  return normalized;
}

function normalizedVerifierName(executable: string, args: readonly string[]): string {
  if (args.length > 0 && args[0] === 'run') {
    return `${executable} run`;
  }
  return executable;
}

function normalizedArgsOrRun(args: readonly string[]): string[] {
  const normalized = skipLeadingOptions(args);
  const first = normalized[0];
  return first ? [first] : [];
}

function summarizeVerifierStream(text: string | null | undefined): string | null {
  const normalized = String(text ?? '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .slice(-12)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length > 0
    ? normalized.slice(0, 700)
    : null;
}
