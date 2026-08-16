/**
 * ciRepair.ts — bounded CI autonomous repair controller (V2 authority).
 *
 * Pure state machine. Guarantees termination: every PRODUCT repair round
 * requires (a) a real product-code change and (b) local verification before a
 * push is authorized; budget exhaustion → escalate. SECURITY_GATE failures can
 * never be "fixed" by the controller (no workflow/test-config mutation).
 *
 * Budgets come from the lease; defaults: 3 product rounds, 1 transient rerun.
 */

export type CiFailureClass =
  | 'PRODUCT_FAILURE'
  | 'TRANSIENT_INFRA_FAILURE'
  | 'BASELINE_FAILURE'
  | 'POLICY_FAILURE'
  | 'OUT_OF_SCOPE'
  | 'SECURITY_GATE';

export type CiControllerState =
  | 'local_verified'
  | 'pushed'
  | 'pr_open'
  | 'reading_ci'
  | 'classifying'
  | 'repairing'
  | 'rerunning'
  | 'final_review'
  | 'escalated'
  | 'blocked';

export interface CiBudgets {
  productRepairRounds: number;
  transientReruns: number;
}

export interface CiController {
  state: CiControllerState;
  budgets: CiBudgets;
  productRoundsUsed: number;
  transientRerunsUsed: number;
  /** True once any required check is green (for readiness claims). */
  requiredChecksGreen: boolean;
  lastClass?: CiFailureClass;
}

export function createCiController(budgets: Partial<CiBudgets> = {}): CiController {
  return {
    state: 'local_verified',
    budgets: {
      productRepairRounds: budgets.productRepairRounds ?? 3,
      transientReruns: budgets.transientReruns ?? 1,
    },
    productRoundsUsed: 0,
    transientRerunsUsed: 0,
    requiredChecksGreen: false,
  };
}

/**
 * Classify a CI failure. `baselineEvidence` = the failure also reproduces on
 * clean current main. `touchesGovernance` = the failing check involves
 * workflow/test-config/security surfaces (repair must NOT touch them).
 */
export function classifyCiFailure(opts: {
  failingChecks: readonly string[];
  baselineEvidence: boolean;
  touchesGovernance: boolean;
  transientSignals: readonly string[];
}): CiFailureClass {
  const { failingChecks, baselineEvidence, touchesGovernance, transientSignals } = opts;

  if (touchesGovernance) {
    // Secret scan / content policy / branch rules / workflow config are
    // policy or security gates — never silently "repaired".
    if (failingChecks.some((c) => /secret|content|policy|ruleset|workflow|security/i.test(c))) {
      return 'SECURITY_GATE';
    }
    return 'POLICY_FAILURE';
  }

  if (baselineEvidence) return 'BASELINE_FAILURE';

  const transient = transientSignals.some((s) =>
    /runner|timeout|network|fetch|flaky|infra|5\d\d|unavailable/i.test(s),
  );
  if (transient && failingChecks.length > 0) return 'TRANSIENT_INFRA_FAILURE';

  return 'PRODUCT_FAILURE';
}

export type CiControllerAction =
  | { kind: 'commit_and_push_repair' }
  | { kind: 'rerun_transient' }
  | { kind: 'read_ci' }
  | { kind: 'final_review' }
  | { kind: 'escalate'; reason: string }
  | { kind: 'block'; reason: string };

/**
 * Advance the controller after a CI read. Pure transition:
 *   GREEN → final_review
 *   PRODUCT → repair (budget check) → repairing
 *   TRANSIENT → rerun (budget check) → rerunning
 *   BASELINE → escalate with evidence (no false attribution)
 *   POLICY → escalate (repair only if explicitly in scope — we choose escalate)
 *   SECURITY_GATE → block (never weaken controls)
 */
export function onCiRead(
  c: CiController,
  opts: {
    requiredChecksGreen: boolean;
    classification?: CiFailureClass;
    /** true if the last repair round changed product code (default false → PRODUCT blocks, fail-closed) */
    touchedProductCode?: boolean;
    /** true if local verification passed after the change (default false → PRODUCT blocks) */
    locallyVerified?: boolean;
  },
): CiControllerAction {
  if (opts.requiredChecksGreen) {
    return { kind: 'final_review' };
  }

  const cls = opts.classification ?? 'PRODUCT_FAILURE';

  switch (cls) {
    case 'TRANSIENT_INFRA_FAILURE': {
      if (c.transientRerunsUsed >= c.budgets.transientReruns) {
        return {
          kind: 'escalate',
          reason: `Transient rerun budget exhausted (${c.transientRerunsUsed}/${c.budgets.transientReruns})`,
        };
      }
      return { kind: 'rerun_transient' };
    }
    case 'PRODUCT_FAILURE': {
      if (c.productRoundsUsed >= c.budgets.productRepairRounds) {
        return {
          kind: 'escalate',
          reason: `Product repair budget exhausted (${c.productRoundsUsed}/${c.budgets.productRepairRounds})`,
        };
      }
      if (!opts.touchedProductCode || !opts.locallyVerified) {
        return {
          kind: 'block',
          reason: 'Repair round requires a real product-code change AND local verification before push',
        };
      }
      return { kind: 'commit_and_push_repair' };
    }
    case 'BASELINE_FAILURE':
      return {
        kind: 'escalate',
        reason: 'Failure reproduces on clean main — evidence recorded, not attributed to this branch',
      };
    case 'POLICY_FAILURE':
      return {
        kind: 'escalate',
        reason: 'Policy failure — repair only with explicit human authorization and task scope',
      };
    case 'SECURITY_GATE':
      return {
        kind: 'block',
        reason: 'Security gate — controller never weakens security controls to pass CI',
      };
    default:
      return { kind: 'escalate', reason: `Unclassified CI failure (${cls})` };
  }
}

/** Commit the controller state after taking an action. */
export function advanceController(
  c: CiController,
  action: CiControllerAction,
): CiController {
  switch (action.kind) {
    case 'commit_and_push_repair':
      return { ...c, state: 'repairing', productRoundsUsed: c.productRoundsUsed + 1 };
    case 'rerun_transient':
      return { ...c, state: 'rerunning', transientRerunsUsed: c.transientRerunsUsed + 1 };
    case 'read_ci':
      return { ...c, state: 'reading_ci' };
    case 'final_review':
      return { ...c, state: 'final_review', requiredChecksGreen: true };
    case 'escalate':
      return { ...c, state: 'escalated' };
    case 'block':
      return { ...c, state: 'blocked' };
  }
}
