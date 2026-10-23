# Real-project coding diagnostic

Three frozen source tasks exercise repository understanding, a historical bug
repair, and a small feature. The operator tools prepare isolated workspaces,
grade captured candidate bytes, and validate reference and negative controls.
They run offline with Python 3.12.x and Node 24.x, without third-party packages.

| Case | Task | Acceptance |
| --- | --- | --- |
| BRPCB-A | Explain Babel Remote UI asset responses and service-worker caching. | Source probes plus human factual review of `ANSWER.md`. |
| BRPCB-B | Repair an inclusive UTC tariff-expiry boundary extracted from Prismatix. | Public tests and independent checks in two timezones. |
| BRPCB-C | Add stable ranked candidates around Babel's existing fuzzy scorer. | Public tests and independent comparisons, preserving the scorer. |

From this directory, using an existing scratch parent outside the package:

```sh
python3 scripts/bench.py doctor
python3 -m unittest discover -s tests -v
python3 scripts/validate.py --scratch-root /tmp --output /tmp/brpcb-validation.json
```

On Windows, select Python 3.12 explicitly when the default interpreter differs:

```powershell
py -3.12 scripts/bench.py doctor
py -3.12 -m unittest discover -s tests -v
py -3.12 scripts/validate.py --scratch-root $env:TEMP --output "$env:TEMP/brpcb-validation.json"
```

`toolchain.json` records the original exact Linux pins. Other supported patch
versions are explicit environment variations and require fixture revalidation.
The complete validator checks 164 expected command outcomes, including correct
alternatives, deliberately wrong patches, integrity failures, and six reset-byte
comparisons. It stops on an unexpected command outcome and saves accumulated
evidence and the failure in the requested JSON report. An unwritable report
destination still requires operator correction.

For an individual case, choose a nonexistent absolute workspace outside the
package. Only that prepared workspace belongs in the agent's context:

```sh
python3 scripts/bench.py prepare BRPCB-B --workspace /tmp/brpcb-b
# The evaluated agent works in /tmp/brpcb-b using the complete PROMPT.md.
python3 scripts/bench.py evaluate BRPCB-B --workspace /tmp/brpcb-b --scratch-root /tmp --output /tmp/brpcb-b-grade.json
# Preserve the candidate and transcript before resetting.
python3 scripts/bench.py reset BRPCB-B --workspace /tmp/brpcb-b
```

Use native absolute paths and `py -3.12` for the same operations on Windows.
Reset requires the exact case/path/baseline marker from preparation and refuses
unmarked directories. Keep reports outside the candidate. The package's LF
attributes preserve fixture byte identities across checkouts.

| Evaluation exit | Meaning |
| --- | --- |
| 0 | Code-case functional pass. |
| 1 | Known functional or permitted-change failure. |
| 2 | Setup, runtime, timeout, or evaluator uncertainty; correctness is unknown. |
| 3 | Case A needs human semantic review; mechanical checks do not award acceptance. |

Keep `oracle/`, `reference/`, negative controls, prior outputs, and package
history outside the evaluated agent's accessible context. Separate processes
and copied workspaces reduce accidental leakage; they do not establish hostile
code isolation. Normal sandbox protections still apply.

This standalone manifest is not a direct input to `../curated-eval/runner.mjs`.
Any later live qualification must identify its installed Babel artifact and
authorized provider route, retain every attempt, and record the separate
functional, terminal-completion, and transcript-truthfulness fields in
`results-template.json`. Missing measurements remain null. The tools here do
not launch Babel, choose a provider, or measure model performance.

Version 1.0.1 preserves the v1 task behavior while fixing Windows
home-variable propagation, JSON pipe encoding, and validation-report retention.
Case A's prompt header has a formatting/version update with new content digests.
Historical run logs and conversation exports are excluded from this source
package. See [provenance](PROVENANCE.md) and [licenses](LICENSES.md).
