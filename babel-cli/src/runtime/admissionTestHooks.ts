/**
 * P05 test-only admission fault seam.
 *
 * This module exists solely so tests can throw at an admission transaction
 * boundary to simulate a crash. Production code imports `admission.ts`, which
 * does **not** re-export the symbol below; enabling the seam requires a
 * deliberate import of this test-hooks module, so the capability is
 * structurally unreachable from ordinary production wiring.
 *
 * Do not import this module from any non-test source file.
 */

/** Transaction boundary where a test may inject a crash. */
export type AdmissionFaultPoint =
  | 'before_admission_commit'
  | 'after_admission_commit'
  | 'before_terminal_commit';

/** Opaque key under which a test may register an admission fault hook. */
export const ADMISSION_FAULT_HOOK: unique symbol = Symbol('babel.runtime.admission.faultHook');

/** Structural shape read by `openAdmissionStore`; keyed by the opaque symbol. */
export interface AdmissionFaultInjectionOptions {
  readonly [ADMISSION_FAULT_HOOK]?: (point: AdmissionFaultPoint) => void;
}
