# Desktop remaining implementation and qualification

Status: implementation snapshot, 2026-10-15. This branch is unfinished and is not a release candidate. No complete work package or acceptance scenario has been signed off end to end.

## Implemented foundations

Local implementation includes truthful terminal/tool states, project-free conversation and scoped trust, retained rich history and pagination/search, drafts and background-close foundations, catalog/support distinctions, protected Desktop credential storage, durable objective/attempt admission, mode lineage, and additive acceptance capture. These are bounded implementations with local evidence; they do not establish installed usability or the complete Desktop requirements.

The shared completion kernel now requires an owned criterion context in addition to the existing honesty and proof gates. It checks the current frozen contract, run and physical project. That checkpoint received two independent source reviews. Its private evidence graph has no execution publisher: ordinary required criteria cannot yet reach verified task completion. A finished answer can therefore remain unverified.

## Verifier repair and remaining qualification

The experimental Node filesystem evaluator and its executable assertion path have been retired from [ownedFileAssertion.ts](../../babel-cli/src/authority/ownedFileAssertion.ts). The pure manifest parser remains. Legacy direct invocation returns a bounded `unsupported` result and exit code 2 without opening argument-selected files. There is no automatic native or host fallback.

The former Node parent/ABA tests failed before executing their intended mock attack on the current runtime. Those failures do not independently establish the earlier outside-read claim. Filesystem qualification now exercises the actual native boundary; pure parser tests remain separate.

A replacement [Windows native oracle](../../babel-cli/src/authority/ownedFileAssertion.windows.ps1) remains unintegrated with trusted completion. It uses retained directory handles and single-component relative native opens on local Windows/NTFS. It now admits leaf type, size and hardlink count through an attribute-only retained handle before requesting data access, then checks that the data handle identifies the admitted file. A baseline/candidate experiment using a synthetic hardlink observed one outside data-access notification before this change and zero after it; both versions ultimately refused the assertion.

The earlier race harness dot-sourced the oracle without preserving colliding PowerShell argument names. Its rename and attribute-race results are withdrawn as evidence of the intended boundary. The corrected harness retains the arguments and includes a positive control that must successfully read through the native oracle itself and trigger the outside-file watcher. Native data/path/encoding/size/link/malformed-manifest cases, real red/edit/green/external-edit checks, hardlink refusal, concurrent rename/ABA and reparse mutation now use that boundary. The canonical CLI build copies the exact native script into `dist`; tests execute that copy and check byte equality. These are synthetic local tests with an explicitly selected system PowerShell host, not bundled-host or installed-product qualification.

Before accepting this backend:

1. Retain the retired Node evaluator's fail-closed behavior and the corrected native positive/negative controls. Do not restore the unsafe reader to support another platform.
2. Finish remaining native negative cases, manifest/parser parity, filesystem/root identities, lock/storage stalls, owned-process deadlines and cleanup. Preserve explicit unsupported outcomes for unqualified platforms, roots and filesystems.
3. Qualify the packaged script's PowerShell/runtime/compiler/assembly closure. Copying the script asset does not supply a bundled PowerShell host. Do not use host fallback, execution-policy overrides or weaker isolation to obtain a passing result.
4. Run canonical typecheck/build/architecture checks and affected consumers on the final source. Obtain fresh independent review of the complete repaired backend. The new native prototype has not received acceptance.

## Complete strict criterion verification

- Define local user-authorized verifier binding as a frozen contract revision with canonical source evidence. Bind exact task, expected head, criterion and prior specification. Preserve criterion meaning, requiredness, order, all other checks, execution authority and budgets. Ambiguous or inferred meaning needs an explicit supported resolution.
- Compile a supported owned oracle without treating a generic green command as evidence for arbitrary prose. Freeze oracle/manifest, interpreter, script/package/config dependencies, actual arguments, working directory, environment policy and execution profile separately from mutable candidate inputs.
- Assign genuine private supervisor authority before the actual governed spawn, after policy/path/isolation checks and durable intent. Validate the final prepared invocation, including Windows shell wrapping and environment provenance.
- Publish evidence only after real execution, governance reconciliation, current-owner checks and durable capture. Reject simulation, cancellation, timeout, persistence failure, replay, old heads, wrong roots, fabricated producers and definition drift. Cold restore must not turn serialized historical assertions into current trust.
- Observe actual candidate revisions and recheck them at completion. Demonstrate a real governed red assertion, authorized edit, green assertion, kernel acceptance, then rejection after an external edit. Exercise streaming and nonstreaming Chat, actual Deep, and Plan controls.
- Project objective, criterion status, historical/current evidence and next action into Desktop through the shared runtime. Desktop must not become another completion authority.

## Work packages still open

| Package | Remaining delivery and qualification |
|---|---|
| WP-01 — Truthful presentation | Finish producer/bridge/renderer/reopen parity; malformed, duplicate, missing and stale events; terminal/exit races; readable ordinary responses; actual installed clipboard behavior. |
| WP-02 — Conversation and trust | Qualify first-run project-free chat through the real CLI, trusted coding, revocation with pending effects, root replacement/rebinding and non-Git projects in installed Desktop. |
| WP-03 — Objective and modes | Finish strict criterion evidence above, real Deep controller handoff/resume, user-visible task/check/next-action state, and crash/recovery qualification across conversation/objective/attempt/workspace identities. |
| WP-04 — Queue and steering | Implement durable queue identity/order/edit/remove/delivery, explicit targeted steering, guarded second activation, acknowledgments, expected-turn fencing, restart-safe deduplication and distinct stop/pause/cancel operations. |
| WP-05 — Providers and routes | Complete official discovery and capability distinctions for all five providers, local control commands, per-chat next-turn route selection, immutable active routes, durable switch markers and selected/observed identity. Qualify each supported wire family. |
| WP-06 — History and context | Complete route-aware context adaptation, essential-omission choices, attachment preview/removal/limits/data authority, durable per-chat drafts/routes, rich reopen and large-history performance. |
| WP-07 — Spend and pricing | Implement optional per-chat and overall period caps, atomic concurrent reservations, timezone/reset rules, late/unknown settlement, priced metadata-first recovery and bounded research. Replace remaining Go grant assumptions without deleting safeguards. |
| WP-08 — Recovery and resources | Integrate measured host-wide RAM/CPU/disk/GPU admission where relevant; bounded retries/sleep/wake recovery; ownership and uncertain-effect reconciliation; checkout/common-Git coordination across chats and workers. |
| WP-09 — Review and attention | Implement revision-specific file/hunk review, conflict-aware restoration with preserved snapshots, stale-proof handling, one integration owner and task attention/navigation/notifications. |
| WP-10 — Credentials and diagnostics | Finish standalone protected CLI credential access, scoped approval lifecycle, redacted typed errors and useful diagnostic export. Qualify credential replacement/removal/migration failures and malicious-input IPC boundaries. |
| WP-11 — Updates and distribution | Complete safe update admission during work, compatibility negotiation, atomic migration/rollback, installer/upgrade/profile preservation, bundled runtime qualification and public-download retesting. No release activation is established by this branch. |
| WP-12 — Daily usability | Finish keyboard/screen-reader/focus/IME/zoom/minimum-window behavior, non-drag queue controls, streaming scroll stability, attention flows, attachment usability and bounded rendering/memory performance. |

## Acceptance scenarios still requiring sign-off

All scenario IDs below remain open. Partial source/tests do not close a row whose installed or end-to-end journey remains untested.

| Scenarios | Required remaining evidence |
|---|---|
| A-01–A-02 | Clean-profile installation/setup, project-free greeting, then authorized real project read/edit/test. |
| A-03–A-07 | Renderer and installed terminal/tool/event/error/clipboard behavior, including transport and exit races. |
| A-08–A-09 | Durable scoped trust, revocation, replaced/renamed/junction roots, legacy identity and non-Git projects. |
| A-10–A-12 | Durable objective/status/continue, actual mode controllers, required tests and current-versus-stale criterion proof. |
| A-13–A-16 | Accessible durable queue/steer delivery, fencing/deduplication, scoped approvals, distinct cancellation and recovery. |
| A-17–A-19 | Five-provider discovery/support/access distinctions, per-chat control commands/routes and valid context adaptation. |
| A-20–A-21 | Crash-point ownership/effect recovery, long archive search/pagination/continuation and rich restoration. |
| A-22–A-25 | No arbitrary product cap, optional concurrent period caps, unknown-price recovery, liability and late settlement. |
| A-26–A-28 | Network/provider/sleep/crash recovery, measured resource admission, workspace/Git ownership and revision-bound integration. |
| A-29–A-31 | Supported protocol stream/error/tool/usage behavior, safe diagnostics, provider headers/locality and data-destination authority. |
| A-32–A-33 | Durable drafts and attachments; keyboard, IME, accessibility, zoom, layout and streaming scroll. |
| A-34–A-35 | Close/background/update/migration behavior; conflict-safe review/restore and exact task attention. |
| A-36–A-37 | Credential/IPC adversarial and migration checks; fresh installer/upgrade plus real bundled CLI coding/reopen workflow. |

## Qualification and integration limits

Representative installed coding workflows remain unqualified for OpenRouter, DeepSeek, DeepInfra, OpenCode Go and Ollama. Discovery, fixture responses, local native helper tests and catalog presence are separate evidence. Live paid qualification requires its own authorized budget; do not substitute providers or infer live success.

The completion checkpoint's recorded local suites passed 465 tests with two platform skips and 139 tests with three skips. Those are historical receipts, not verification of the current candidate. The former Node regressions and native race-harness limitations are described above; earlier passing counts must not override them. No aggregate CLI full-suite, installer, live-provider, release or deployment success is claimed. The repaired backend has not received independent acceptance.

Next implementation order: finish the native read boundary; complete frozen binding/compiler and actual trusted execution/publication; demonstrate real kernel acceptance and stale rejection; expose truthful task state; complete queue/route/context/spend/recovery/review flows; then qualify accessibility, updates and installed provider journeys. Run publication and repository checks separately from product acceptance. This snapshot is suitable for continued implementation and review, not merging or releasing as completed Desktop work.
