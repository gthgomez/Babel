# Negative control rationale — BRPCB-A

The `incomplete/` and `unsupported/` directories are answer-only overlays.
They remain outside every solver workspace. They are newly authored deliberately
incorrect answers, not captured model failures.

**Human adjudication is required.** The mechanical oracle must return exit 3
for each when overlaid on the valid source fixture. The expected human rejection
reasons below are a rubric guide, not an automatic semantic-detection claim.

| Control | Expected factual review | Rubric reasons |
|---|---|---|
| `incomplete/ANSWER.md` | Insufficient explanation | A1–A2 omit allowlist/path checks and directory discovery; A3–A4 omit the body/MIME details, CSP, and worker header; A5 omits directory/read exceptions and unknown-path ordering; A6–A9 omit the policy/worker relationship, bypasses, rejection-only fallback, and offline/authentication limits. Its few correct facts are insufficient. |
| `unsupported/ANSWER.md` | Material contradictions and unsupported assurances | A5 contradicts uncaught directory/read failures and invents 404 writes. A6/A9 invent authentication. A7 falsely includes the worker script in worker SHELL. A8 falsely asserts cache-first, writes after successful fetch, and HTTP-error fallback. A9/A10 claim unconditional full-app offline support despite synthetic/incomplete assets and no browser test. |

Do not reject an answer merely because it shares words with one of these
controls; evaluate the meaning and its relationship to the source. An accurate
answer that quotes a wrong claim to refute it is not itself wrong.
