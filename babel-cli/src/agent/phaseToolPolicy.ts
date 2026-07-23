/**
 * T3.4 — Phase-gated tool exposure (task-class aware).
 *
 * When enabled, the harness soft-blocks tools that are out-of-phase:
 *   investigate → no write tools
 *   verify      → no new exploration reads (grep/glob blocked; run verifier instead)
 *
 * Enablement (first match wins):
 *   1. BABEL_PHASE_GATED_TOOLS=0|false|off → always off (explicit A/B opt-out)
 *   2. BABEL_PHASE_GATED_TOOLS=1|true|on  → always on
 *   3. Else task-class default (governance / investigate → on; general_swe → off)
 *
 * Policy is by **task shape**, not by benchmark cell.
 */

import type { ChatPhase } from './chatPhaseNudge.js';
import { isDirectMutationTool } from './mutationTools.js';
import { resolveChatTaskTune } from '../config/chatTaskClass.js';

export function isPhaseGatedToolsEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const v = env['BABEL_PHASE_GATED_TOOLS']?.trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'off') return false;
  if (v === '1' || v === 'true' || v === 'on') return true;
  // Unset → task-class default (autoClassify only when task text is passed elsewhere)
  return resolveChatTaskTune({ env, autoClassify: false }).phaseGatedToolsDefault;
}

export interface PhaseToolGateResult {
  blocked: boolean;
  observation?: string;
}

export function evaluatePhaseToolGate(opts: {
  toolName: string;
  phase: ChatPhase | null;
  enabled?: boolean;
  isMutationSubAgent?: boolean;
}): PhaseToolGateResult {
  if (!(opts.enabled ?? isPhaseGatedToolsEnabled())) {
    return { blocked: false };
  }
  if (!opts.phase) return { blocked: false };

  const name = opts.toolName;
  const mutation = isDirectMutationTool(name) || opts.isMutationSubAgent === true;

  if (opts.phase === 'investigate' && mutation) {
    return {
      blocked: true,
      observation:
        `### ${name}\nexit_code: 1\n` +
        `Error: phase-gate blocked write — still in investigate. Prefer read/grep/glob ` +
        `until localization is solid; phase advances to mutate after enough context ` +
        `(or disable BABEL_PHASE_GATED_TOOLS for execute-class tasks).`,
    };
  }

  // verify: discourage broad search thrash — still allow run_command / test_run
  if (opts.phase === 'verify' && (name === 'grep' || name === 'glob' || name === 'semantic_search')) {
    return {
      blocked: true,
      observation:
        `### ${name}\nexit_code: 1\n` +
        `Error: phase-gated tools — in verify. Run the verifier (run_command / test_run) ` +
        `instead of opening a new search. Re-read only the files you changed if needed.`,
    };
  }

  return { blocked: false };
}
