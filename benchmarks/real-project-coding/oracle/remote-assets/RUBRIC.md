# BRPCB-A factual review rubric — version 1.0.0

## What the mechanical evaluator establishes

`check.mjs /absolute/candidate/workspace` checks a nonempty UTF-8 `ANSWER.md`
and runs the canonical source probes against that workspace. Exit **1** means
missing/invalid submission or failed source probes. Exit **2** means invalid
invocation/runtime. Exit **3** means **needs human review**. There is deliberately
no exit-0 semantic pass. The root wrapper separately guards immutable files.
Exit-2 receipts classify setup/environment failures and leave
`functional_success` null; an invalid invocation does not assess task correctness.

A nonempty incorrect answer, including either supplied negative control, must
still receive exit 3 when its source workspace is valid. This is expected and
does not make that answer correct. The source probe count is not a prose score.

## Human adjudication

Read the answer, the pinned source, and the observed probe evidence. Record a
judgment for each critical criterion in `human-review-template.json`. Use
`satisfied`, `partially_satisfied`, `missing`, or `contradicted`, with a brief
reason and a source reference. Do not use exact wording, phrase matching,
keyword counts, embedding similarity, or reference-answer overlap as a proxy
for understanding. Equivalent accurate wording and evidence by symbol are
acceptable. Line numbers refer to the supplied frozen copy; the import notice
shifts the assets file's upstream line numbers by one.

A human factual pass requires all critical criteria satisfied, adequate
source-grounded evidence, and no material unsupported claim. Missing or
contradicted critical relationships make the explanation insufficient. Preserve
partial judgments rather than inventing an automatic numerical score. Source
preservation and session completion are separate axes, supplied by the wrapper
or future run evidence. A correct explanation does not establish that a model
session completed or that any production system was qualified.

| ID | Critical fact or relationship to evaluate | Source anchor |
|---|---|---|
| A1 | `/ui/` is rewritten to `/ui/index.html`; `/ui/sw.js` stays that path and is allowed by the policy list. The serving helper checks the allowlist before directory work, removes the `/ui` prefix, and rejects `..` or a changed normalized relative path. It is not an unrestricted file server. | `remoteUiAssets.ts:remoteUiFileForPath` lines 30–45; `remoteUiCachePolicy.ts` lines 6–18, 29–32 |
| A2 | Directory discovery checks an `index.html` sentinel beside the module first, then at `../../src/bridge/remote-ui`; neither candidate means an uncaught error. Discovery is distinct from checking the requested file. The served file is joined beneath the selected directory and tested for existence. | `remoteUiAssets.ts` lines 21–27, 41–43 |
| A3 | The index uses `text/html; charset=utf-8`, the worker uses `text/javascript; charset=utf-8`; extension lookup determines the MIME value. A successful write reads bytes synchronously, writes status 200, sends those bytes through `end`, and returns `true`. | `remoteUiAssets.ts` lines 13–18, 44–45, 48–63 |
| A4 | Both responses include `Content-Type`, `Cache-Control: no-store`, and the restrictive CSP; the worker response additionally has `Service-Worker-Allowed: /ui`. The exact CSP string need not be copied, but its presence must not be omitted or recast as authentication. | `remoteUiAssets.ts` lines 52–60 |
| A5 | An unknown/disallowed path or a missing allowed file produces `null` in resolution and `false` in the writer with no response emitted. Missing directory discovery throws; a file-read failure also propagates before `writeHead`/`end`. The caller's eventual status or catch behavior is unknown here. | `remoteUiAssets.ts` lines 27, 32–43, 49–62; public missing-directory/file/read-error probes |
| A6 | `shouldCacheRemoteUiRequest` accepts shell GETs, defaults/normalizes the method to GET/uppercase, and rejects authorization, other methods, and network-only runtime prefixes. These predicates do not implement user authentication. | `remoteUiCachePolicy.ts` lines 22–50 |
| A7 | The separate worker attempts `cache.addAll(SHELL)` in its install work, calls `skipWaiting`, and claims clients during activation. Its own literal `SHELL` list differs from the policy list: `/ui/sw.js` is served/allowed by the server but is not a worker-cached shell path. | `remote-ui/sw.js` lines 1–13, 33–44; policy lines 6–18 |
| A8 | The worker leaves non-GET, authorization-bearing, runtime-prefix, and non-shell requests unhandled by its fetch handler. For a permitted shell request it tries `fetch` first and calls `caches.match` only after promise rejection. A resolved HTTP failure does not trigger the catch. No successful-fetch cache update is shown. | `remote-ui/sw.js` lines 15–30, 46–59; VM probes |
| A9 | Server `no-store` and the worker's explicit precache/fallback code are distinct mechanisms. The answer does not infer guaranteed offline availability, complete browser installation, or security/authentication correctness from this extract. A cache match and successful installation remain conditions, not established runtime facts. | Source relationship plus fixture/VM limits in `PROMPT.md`; VM cache-miss probe |
| A10 | The answer supplies checkable local source paths with symbols and/or line references, distinguishes observations from inference, and accurately labels any tests it claims to have run. It acknowledges the synthetic HTML/app payloads and omitted caller/active application. | `SOURCE.json`, `NOTICE.md`, `PROMPT.md`, `tests/public.test.mjs` |

Optional details must not become hidden requirements: raw query handling,
enumerating every MIME entry, exact CSP transcription, `/pair` constants, and
exhaustive worker lifecycle edge cases. Material false optional claims should
still be recorded, with the source demonstrating the contradiction.

## Unsupported-claim checks

Record the exact material claim or a faithful paraphrase, its location, the
contradicting/missing evidence, and its impact. Examples of unacceptable claims:

- All failure cases cause this function to send a 404 or return `false`.
- The asset server validates credentials or establishes unauthenticated access is
  impossible; the presence of an authorization bypass establishes authentication.
- `no-store` establishes the worker never uses a cache, or the worker code establishes the
  entire production UI will work offline.
- Every HTTP error status triggers cache fallback, or a successful fetch is
  automatically stored by this handler.
- `/ui/sw.js` belongs to the worker's own `SHELL` list just because it appears in
  the TypeScript policy list.
- The VM stubs are a real browser/network test, the synthetic payloads are the
  full upstream app, or the source probes establish production authentication correctness.

These are factual criteria, not forbidden words. A warning against one of these
claims is not itself a violation. Use context and accept precise qualifications.
