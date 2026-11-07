# September 26, 2026 audit: historical evidence summary

This summary preserves the provenance and useful findings of a dated public-source audit. It is a research snapshot, not a current release qualification or an instruction to execute its archived implementation prompts.

## Provenance

The audit examined `gthgomez/Babel` at baseline `bd155087e41a53599470b86859fe7f45c1036a47` on September 26, 2026. Its evidence included retrieved source, pull requests, issue records, CI logs, and seven isolated source-logic probes. The source snapshot reported PR #251 merged and PR #267 still open with the alternative shell disabled by default.

The original archive was introduced by commit `35cf5edf034d4854f6879850a575d54461573511`. Its bytes remain retrievable from the [historical archive](https://github.com/gthgomez/Babel/blob/35cf5edf034d4854f6879850a575d54461573511/docs/packets/Babel_Audit_Roadmap_2026-09-26.zip). SHA-256: `d7dfaf24fd5e68d94a819f83d76bb856fc642472a77537d9225d75a6ef8fc1c0`.

Inspection found 47 archive entries totaling 140,212 uncompressed bytes. The 46 listed content hashes matched the archive manifest. Entry names were relative and contained no parent-directory traversal. A limited pattern scan found no common credential, private-key, email, or private-repository markers. These checks describe the inspected bytes; they do not establish comprehensive disclosure clearance or authorize publication of other material.

## Findings to reconcile against current source

| Historical finding | Evidence and follow-up |
| --- | --- |
| Windows qualification was red | The snapshot recorded 892 passing tests, zero failing tests, and 13 skips against an allowance of 11. Reconcile current eligibility and skip reasons before changing the allowance. |
| Cache-aware pricing did not reach task settlement | Source inspection and an isolated calculation suggested accounting omitted cache-aware rates. Verify settlement through the native accounting path. |
| Compaction trigger and strategy eligibility disagreed | Source inspection and isolated probes identified inconsistent threshold decisions. Test the combined native decision path. |
| Read-cache identity could conflate distinct filenames | Isolated probes demonstrated normalization collisions. Native suppression and downstream model effects were not reproduced. |
| Request-byte identity did not establish exact token qualification | Source inspection identified token-estimation contract limitations and a null-precedence issue. Distinguish byte binding from calibrated token counts. |
| Auxiliary compaction calls needed lifecycle parity | Source inspection and an isolated probe suggested cancellation differences. Verify timeout, abort propagation, and cleanup through native calls. |

The audit also called for one TUI integration owner and preservation of the useful work shared by PRs #206 and #267. Real Windows/ConPTY and POSIX PTY evidence remained outstanding, including streaming resize, input methods, paste, scrolling, cancellation, draft preservation, truthful unknown cost/context, and non-TTY fallback.

## Limits

Native Babel tests, live-provider evaluations, and real terminal qualification were not performed for this audit. It inspected public sources and did not inspect a private repository. Its comparison snapshots were Codex `rust-v0.157.1` and MiMo Code `v0.1.15`; they do not establish a current comparative ranking. Later code, issue, PR, and CI changes require fresh reconciliation. Archive manifests and isolated probes are provenance evidence, not independent security certification or merge approval.
