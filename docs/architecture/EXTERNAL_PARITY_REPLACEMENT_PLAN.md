# Portable external parity replacement plan

Status: planned; external Python/Android parity is unverified. No replacement audit has executed or passed.

On October 2, 2026, the owner approved removing the stale external audit command from Babel's canonical test suite and planning its replacement. The referenced script was already absent from public main; the historical implementation depended on external workspaces, skipped missing projects, and contained a mocked Python result. Removing that command corrects suite ownership and availability; it does not prove cross-project parity. Preserve Git history, prior blocked campaign reports, failed hosted logs, and the implementation/review evidence for this change.

## Required inputs

Before implementation, obtain public or publication-approved, license-compatible fixtures and a versioned behavior contract for each real implementation. Specify the exact inputs and observable outputs, units, rounding rules, error cases, and allowed numeric tolerance. Record the authoritative origin of expected results. Do not invent business rules or derive the oracle solely by copying one implementation's output.

## Bounded implementation

1. Keep Babel's current unit, portable package, architecture, Linux, Windows and isolated smoke coverage. Add the replacement as an explicitly owned external integration lane once its dependencies and fixtures exist.
2. Use small synthetic datasets and relative fixture paths in fresh temporary workspaces. No personal machine paths, private sibling repositories, ambient credentials or network inference should be needed.
3. Execute the actual Python and Android model implementations. Prefer a headless model or command adapter for deterministic JSON input/output; never substitute a constant, mock result, or expected value for an implementation run. An Android UI/emulator comparison, if required by the behavior contract, needs its own explicitly scoped lane rather than a claim from a pure model test.
4. Compare independently specified expected outcomes and normalized outputs from both real engines. Cover normal, boundary, malformed, rounding, ordering and error cases with deterministic seeds. Label the tested model/runtime surface precisely; model equality alone is not Android UI or deployment parity.
5. Record fixture/contract digests, both implementation revisions, toolchain versions, selected cases, actual commands and exit codes, and raw output. Retain these artifacts on failure as well as success.
6. Missing fixtures, unavailable engines, zero executed cases, unsupported schema, execution errors or mismatched revisions must be reported as BLOCKED/NOT_RUN or failures. They must not produce a passing parity receipt. A deliberately changed output and an unavailable-engine negative control must prove the comparison and execution guards reject bad evidence.
7. Run the supported platform matrix on standard hosted runners with pinned tooling and explicit dependency installation. Require real Linux/Windows parity where supported; report any unsupported platform separately. Preserve isolated execution and existing permissions; obtain approval for any new credentials, paid runner, emulator or host execution boundary.
8. Obtain independent exact-head review of the implementation and its negative controls, then require a fully green hosted run with nonempty real execution artifacts before describing parity as verified.

## Separate test-overlap audit

The parent is assigning an adversarial read-only audit separately from the four-PR repair. Similar names, fixture text or assertions are not deletion evidence. For each proposed consolidation, map the behavior, failure injection, loader/runtime mode, platform, authority boundary and protected gate. Demonstrate that the retained test detects the same failures on every required platform, preserve unique negative controls and artifacts, and independently review any deletion. Keep audit recommendations separate until that evidence exists; no broad test deletion is authorized by this plan.
