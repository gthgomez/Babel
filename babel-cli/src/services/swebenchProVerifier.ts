/**
 * SWE-Bench Pro (Scale AI) campaign runner — standalone path for shadow scoreboard data.
 *
 * - Does not reuse Verified docker eval (`swebench.harness`)
 * - V1 verifier: semantic gold_diff when gold patch present
 * - Early-stop: abort after N consecutive identical failure signatures
 * - Harvests policy_events for offline shadow precision/recall
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { parseSweStringList } from './agentBenchmarkHarness.js';
import { type CampaignPhase, type SwebenchProInstanceRow } from './swebenchProCampaign.js';

/** How campaign `status=pass` is decided (default gold for continuity). */
export type SweProPassMode = 'gold' | 'ftp' | 'both';

/** W1 D: host fail_to_pass outcome class (not just ok/false). */
export type FailToPassClass =
  | 'pass'
  | 'assert_fail'
  | 'collect_error'
  | 'env_error'
  | 'timeout'
  | 'skipped'
  | 'unknown';

const FAIL_TO_PASS_TIMEOUT_MS = 180_000;


export function validateNonNegativeTimeout(name: string, value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

/** Normalize a finished cell into a stable early-stop signature. */
export function classifyCampaignFailureSignature(input: {
  phase: CampaignPhase;
  infraOk?: boolean;
  infraError?: string;
  cliExitCode?: number | null;
  /** Prefer CLI `status` (ENV_BLOCKED / BLOCKED / …). */
  statusText?: string | null;
  /**
   * Prefer CLI `terminal_outcome` (BLOCKED_EXTERNAL / BLOCKED_POLICY / …).
   * When present, outranks noisy stdout blob heuristics (Pri-3).
   */
  terminalOutcome?: string | null;
  /** Explicit payload.env_blocked when known. */
  envBlocked?: boolean | null;
  patchBytes?: number;
  goldDiffOk?: boolean | null;
  stdoutStderr?: string;
  missingApiKey?: boolean;
  /** W1 C/D: host fail_to_pass class when known. */
  failToPassClass?: FailToPassClass | null;
}): string {
  if (input.missingApiKey || /missing.?api.?key|DEEPSEEK_API_KEY/i.test(input.infraError ?? '')) {
    return 'infra:missing_api_key';
  }
  if (input.phase === 'infra') {
    if (input.infraOk) return 'infra:ok';
    const err = (input.infraError ?? '').toLowerCase();
    if (err.includes('docker') || err.includes('pull')) return 'infra:docker_pull_failed';
    if (err.includes('clone') || err.includes('checkout') || err.includes('git')) {
      return 'infra:checkout_failed';
    }
    return `infra:failed:${slug(input.infraError ?? 'unknown')}`;
  }

  const blob = input.stdoutStderr ?? '';
  const status = (input.statusText ?? '').trim();
  const terminal = (input.terminalOutcome ?? '').trim();

  if (/HTTP 402|positive balance|insufficient.?credit/i.test(blob)) {
    return 'agent:provider_error:billing';
  }
  if (/401|unauthorized|invalid.?api.?key|authentication/i.test(blob)) {
    return 'agent:provider_error:auth';
  }
  if (
    status === 'BUDGET_EXCEEDED' ||
    terminal === 'BUDGET_EXHAUSTED' ||
    /budget.?exceeded|harness_timeout|process timed out/i.test(blob)
  ) {
    // Distinguish outer harness timeout from in-agent cost ceiling when possible.
    if (/harness_timeout|process timed out after/i.test(blob)) {
      return 'agent:harness_timeout';
    }
    return 'agent:budget_exhausted';
  }

  // W1 C/D: production patch + collect-only fail → failed_with_evidence (not thrash/env).
  if (
    (input.patchBytes ?? 0) > 0 &&
    (input.failToPassClass === 'collect_error' ||
      terminal === 'AGENT_FAILURE' ||
      /verifier_collect|failed_with_evidence|collect_error/i.test(
        `${status}\n${terminal}\n${blob}`,
      ))
  ) {
    if (input.failToPassClass === 'collect_error') {
      return 'agent:verifier_collect_error';
    }
  }

  // Pri-3: structured fields first — do not let ImportError text in a
  // policy-killed transcript re-label investigate_hard_cap as env_blocked.
  if (input.envBlocked === true || status === 'ENV_BLOCKED') {
    return 'agent:env_blocked';
  }
  if (terminal === 'BLOCKED_POLICY' || status === 'BLOCKED_POLICY') {
    return 'agent:blocked_policy';
  }
  // W1 C: after a production patch, BLOCKED_EXTERNAL from collect soft-deps
  // is failed-with-evidence — not a pure env quarantine (hasAnyWrites path).
  if (
    terminal === 'BLOCKED_EXTERNAL' &&
    (input.patchBytes ?? 0) > 0 &&
    input.failToPassClass === 'collect_error'
  ) {
    return 'agent:verifier_collect_error';
  }
  if (terminal === 'BLOCKED_EXTERNAL') {
    // External without env_blocked flag → generic external (permission, etc.)
    return 'agent:blocked_external';
  }
  if (status === 'BLOCKED') {
    // Legacy generic BLOCKED: prefer policy unless blob is clearly env-only
    // and no policy markers — still require clear env signal in blob.
    // Never override an explicit envBlocked=false (in-agent policy may log
    // "env_blocked:" wording without host quarantine).
    if (
      input.envBlocked !== false &&
      /env_blocked|importerror|modulenotfound|while loading conftest/i.test(blob) &&
      !/investigate.?hard.?cap|zero.?write|blocked_policy|progress_terminal/i.test(blob)
    ) {
      return 'agent:env_blocked';
    }
    return 'agent:blocked_policy';
  }
  // Structured non-env terminals with zero production patch: empty_patch beats
  // blob "env_blocked" noise from progress-policy shadow logs (mock openlibrary).
  if (
    input.envBlocked === false &&
    (input.patchBytes ?? 0) === 0 &&
    (status === 'NEEDS_MORE_CONTEXT' ||
      terminal === 'AGENT_FAILURE' ||
      terminal === 'BLOCKED_EXTERNAL' ||
      terminal === 'BLOCKED_POLICY')
  ) {
    return 'agent:empty_patch';
  }
  // Blob heuristics only when structured status/outcome were absent AND
  // envBlocked was not explicitly false.
  if (
    input.envBlocked !== false &&
    !status &&
    !terminal &&
    /env_blocked|importerror|modulenotfound|while loading conftest/i.test(blob)
  ) {
    return 'agent:env_blocked';
  }
  if (status === 'NEEDS_MORE_CONTEXT' || /blocked_policy|BLOCKED_POLICY/i.test(blob)) {
    return 'agent:blocked_policy';
  }
  if ((input.patchBytes ?? 0) === 0 && input.goldDiffOk !== true) {
    if (input.cliExitCode !== 0 && input.cliExitCode != null) {
      return `agent:cli_nonzero:${input.cliExitCode}`;
    }
    return 'agent:empty_patch';
  }
  if (input.goldDiffOk === true) return 'agent:task_pass';
  if (input.cliExitCode !== 0 && input.cliExitCode != null) {
    return `agent:cli_nonzero:${input.cliExitCode}`;
  }
  return 'agent:task_fail';
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 48) || 'unknown';
}

/**
 * W1.3: pass_mode for live_pass / cell.status only.
 * Capability primary remains host fail_to_pass; gold is diagnostic (multi-file PR ref).
 * Default `gold` keeps historical scoreboard; canaries force `both`.
 * Set BABEL_SWE_PRO_PASS_MODE=ftp|both|gold to change cell.status aggregation.
 */
export function resolveSweProPassMode(
  env: NodeJS.ProcessEnv = process.env,
): SweProPassMode {
  const raw = (env['BABEL_SWE_PRO_PASS_MODE'] ?? 'gold').trim().toLowerCase();
  if (raw === 'ftp' || raw === 'fail_to_pass') return 'ftp';
  if (raw === 'both' || raw === 'gold+ftp') return 'both';
  return 'gold';
}

/**
 * cell.status aggregation only — does not redefine dual axes.
 * Prefer reporting host_fail_to_pass_ok and gold_diagnostic_ok separately.
 */
export function cellPassesByMode(
  goldDiffOk: boolean | null,
  failToPassOk: boolean | null | undefined,
  mode: SweProPassMode,
): boolean {
  const gold = goldDiffOk === true;
  const ftp = failToPassOk === true;
  if (mode === 'ftp') return ftp;
  if (mode === 'both') return gold && ftp;
  return gold;
}

export interface FailToPassCheckResult {
  ok: boolean | null;
  command: string | null;
  exitCode: number | null;
  skippedReason?: string;
  /** W1 D */
  failToPassClass: FailToPassClass;
  /** Captured stdout/stderr slice for classification. */
  outputSnippet?: string;
  /** Interpreter used (W1 B). */
  pythonBin?: string;
}

/**
 * Classify host fail_to_pass output. Pure — collect_error ≠ assert_fail (W1 D).
 */
export function classifyFailToPassResult(input: {
  exitCode: number | null;
  output?: string | null;
  skippedReason?: string | null;
}): FailToPassClass {
  if (input.skippedReason) {
    if (/timeout|signal_/i.test(input.skippedReason)) return 'timeout';
    if (/python_missing|disabled|no_fail_to_pass/i.test(input.skippedReason)) {
      return input.skippedReason === 'disabled' || input.skippedReason === 'no_fail_to_pass'
        ? 'skipped'
        : 'env_error';
    }
    return 'env_error';
  }
  if (input.exitCode === 0) return 'pass';
  const blob = (input.output ?? '').toLowerCase();
  if (
    /\bimporterror\b/.test(blob) ||
    /\bmodulenotfounderror\b/.test(blob) ||
    /\bwhile loading conftest\b/.test(blob) ||
    /\bno module named\b/.test(blob) ||
    /\berror collecting\b/.test(blob) ||
    /\bno tests ran\b/.test(blob) ||
    /\bcollected 0 items\b/.test(blob) ||
    // pytest exit 4 = usage error; often collect/import path failures
    (input.exitCode === 4 && blob.length > 0) ||
    input.exitCode === 5
  ) {
    // exit 5 = no tests collected; exit 4 with import noise = collect_error
    if (
      /\bimporterror\b/.test(blob) ||
      /\bmodulenotfounderror\b/.test(blob) ||
      /\bwhile loading conftest\b/.test(blob) ||
      /\bno module named\b/.test(blob) ||
      /\berror collecting\b/.test(blob) ||
      input.exitCode === 5 ||
      input.exitCode === 4
    ) {
      return 'collect_error';
    }
  }
  if (input.exitCode === 1) return 'assert_fail';
  if (input.exitCode == null) return 'unknown';
  return 'assert_fail';
}

/**
 * Best-effort host fail_to_pass after the agent. Does not throw.
 * Skip with BABEL_SWE_PRO_FTP_CHECK=0.
 * W1 B: prefer preflight pythonBin / BABEL_WORKSPACE_PYTHON over bare `python`.
 */
export function runFailToPassCheck(
  workspaceRoot: string,
  instance: SwebenchProInstanceRow,
  env: NodeJS.ProcessEnv = process.env,
  options?: { pythonBin?: string | null; timeoutMs?: number },
): FailToPassCheckResult {
  const disabled = (env['BABEL_SWE_PRO_FTP_CHECK'] ?? '1').trim() === '0';
  if (disabled) {
    return {
      ok: null,
      command: null,
      exitCode: null,
      skippedReason: 'disabled',
      failToPassClass: 'skipped',
    };
  }
  const targets = parseSweStringList(instance.fail_to_pass).slice(0, 5);
  if (targets.length === 0) {
    return {
      ok: null,
      command: null,
      exitCode: null,
      skippedReason: 'no_fail_to_pass',
      failToPassClass: 'skipped',
    };
  }
  const pythonBin =
    options?.pythonBin?.trim() ||
    env['BABEL_WORKSPACE_PYTHON']?.trim() ||
    (process.platform === 'win32' ? 'python' : 'python3');
  const command = `${pythonBin} -m pytest ${targets.join(' ')} -q --tb=short`;
  try {
    const timeoutMs = validateNonNegativeTimeout(
      'failToPassTimeoutMs',
      options?.timeoutMs ?? FAIL_TO_PASS_TIMEOUT_MS,
    );
    // Prefer argv form without shell so venv pythonBin paths with spaces work.
    const result = spawnSync(pythonBin, ['-m', 'pytest', ...targets, '-q', '--tb=short'], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      env,
      ...(timeoutMs === undefined || timeoutMs === 0 ? {} : { timeout: timeoutMs }),
      windowsHide: true,
    });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return {
          ok: null,
          command,
          exitCode: null,
          skippedReason: 'python_missing',
          failToPassClass: 'env_error',
          pythonBin,
          outputSnippet: result.error.message.slice(0, 300),
        };
      }
      return {
        ok: null,
        command,
        exitCode: null,
        skippedReason: result.error.message.slice(0, 120),
        failToPassClass: 'env_error',
        pythonBin,
      };
    }
    if (result.status === null && result.signal) {
      return {
        ok: false,
        command,
        exitCode: null,
        skippedReason: `signal_${result.signal}`,
        failToPassClass: 'timeout',
        pythonBin,
        outputSnippet: output.slice(0, 500),
      };
    }
    const exitCode = typeof result.status === 'number' ? result.status : null;
    const failToPassClass = classifyFailToPassResult({ exitCode, output });
    return {
      ok: exitCode === 0,
      command,
      exitCode,
      failToPassClass,
      pythonBin,
      outputSnippet: output.slice(0, 800),
    };
  } catch (err) {
    return {
      ok: null,
      command,
      exitCode: null,
      skippedReason: err instanceof Error ? err.message.slice(0, 120) : String(err),
      failToPassClass: 'env_error',
      pythonBin,
    };
  }
}
