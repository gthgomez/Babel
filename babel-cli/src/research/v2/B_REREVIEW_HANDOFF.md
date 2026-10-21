# Agent A → Agent B reciprocal rereview handoff

## Active coordination (2026-10-21)

| Track | Draft PR | Published head (exact GitHub) | Owner |
|-------|----------|-------------------------------|--------|
| Agent A integration | [#406](https://github.com/gthgomez/Babel/pull/406) | `9d97448a`+ (`cursor/research-v2-post-review-settlement-fc31`) | Combined runtime, CLI/engine, registry wiring, **web discover**, **pdfjs/canvas pack**, **G-L1 campaign fixture** |
| Agent B extraction/tests | [#404](https://github.com/gthgomez/Babel/pull/404) | `b590e115` (engine reciprocal vs #406; 6/6 offline) | Read/HTML/PDF extraction, reciprocal integration tests |

**Discover contract on #406:** `GeneralWebAdapter.discover` delegates to `access.search` and maps hits to web candidates (`generalWebAdapter.test.ts`). **Do not** replace `generalWebAdapter.ts` with B80, whose discover returns `not_supported` without search. `GeneralDocumentAdapter.discover` remains honestly `not_supported` (mission-selected documents).

B `c470f0cb` reciprocal tests assume B80 discover for **both** catalog adapters; when B rebases tests onto #406, web discover expectations should follow A search-backed behavior while read/HTML/PDF/cancellation cases stay B-owned.

Review uses exact published heads; no manual patch-export gate. Credentials unchanged.

---

**Supersedes for review:** `59cd561b2414fcc32253de568c70285517eae1cd` (BLOCKED)  
**Published draft head (PR #405):** `17838c028c0a8a80f9745b01d1525983752e0eae` on branch `cursor/research-v2-contract-a-fc31` (tree `2ad1a8b0fbd448828327a261b78b87d97e28fdaf` at last publication)  
**Contract version:** `2026.10.20-checkpoint.3.1` (composition FIX + verbatim B corpus; base `d51418b3`)  
**Baseline:** `d9e42b14b00b6dba25f0415ae16b084363386a01`

Remote publication and dependent coding remain **held** until B and independent exact-head rereview approve this patch.

**Coordinator guards:** Missing supplemental scrub policy blocks **maintainer pre-merge** (`validate-public-release.ps1 -RequireSupplementalPolicy`), not local contract repair, tests, or export review. **No campaign waiver; no merge authority.** Remote writes stay held until release after exact-head review.

**Shared checklist:** `SHARED_REVIEW_CHECKLIST.md` — includes mandatory B fixture-path verification; Agent A’s first peer pass missed broken B paths; **`#404` FIX is controlling and not waived.**

## B BLOCK findings → repair mapping

| B finding (59cd561b) | Repair in checkpoint.2 |
|----------------------|-------------------------|
| `sourceAdapter.ts` discover-only | `SourceAdapter.read()` + `SourceAdapterReadResult` (`ports/sourceAdapter.ts`) |
| `researchStore.ts` operation event names without append APIs | `appendExternalOperationIntent/Completed/Reconciled` (`ports/researchStore.ts`, `fixtures/fakePorts.ts`) |
| `listEvents` loses evidence | `MissionWriteContext` on every write; mission id on all events |
| Typed search cancel vs zero hits | `SourceSearchResult` status `ok \| failed \| cancelled` (`ports/sourceAccessPort.ts`) |
| Integrity enum conflated with semantic | `SourceIntegrityStateSchema` vs `SemanticSupportStatusSchema` (`contracts/findings.ts`) |

## Nine-point independent review (authoritative scope)

All nine items are addressed in this single local revision; see `CHECKPOINT.md` and `contracts/contract-regression.test.ts`.

## Inspect patch (no shared filesystem)

```bash
git fetch origin cursor/research-v2-contract-a-fc31   # after coordinator publishes
git diff 59cd561b2414fcc32253de568c70285517eae1cd..HEAD -- babel-cli/src/research/v2
```

Or apply from coordinator-supplied bundle when released.

## B verification commands (isolated worktree)

```bash
cd babel-cli
npm ci
npm run typecheck
node --import tsx --test $(node scripts/research-v2-collect-test-files.mjs)
npm run test:research-v2-pdfjs-staged-package-smoke
```

**Expected:** research v2 manifest **259** tests pass (collector output; not a bare `src/research/v2/**/*.test.ts` glob — that pattern does not expand reliably and is not the full suite). Staged PDF smoke prints resolved `module_paths` JSON under `--omit=dev --omit=optional` plus explicit canvas platform binding.

### Validation evidence (Agent A)

| Check | Command | Outcome |
|-------|---------|---------|
| Build + typecheck | `npm run build` && `npm run typecheck` | **ok** @ `9d97448a` (logs: `review-artifacts/readiness-9d97448a-build-typecheck.log`) |
| Research v2 manifest | `node scripts/research-v2-collect-test-files.mjs \| tr '\\n' '\\0' \| xargs -0 node --import tsx --test` | **268** pass / 0 fail, 121 suites (incl. raw transport provenance regression) |
| CLI routes (in manifest) | `researchV2CliRoutes.test.ts`, `researchV2Commands.live.test.ts` | included in manifest above |
| B reciprocal receipt | `npm run test:research-v2-production-package-reciprocal` | `probe_ok`, `canvas_package_json_present=true` @ prior heads (Linux; not re-run this pass) |
| Incorrect / hung-style glob | `node --test src/research/v2/**/*.test.ts` | **Do not use** — shell leaves literal `**` or runs a partial set; not authoritative |
| Packaged PDF runtime (A smoke) | `npm run test:research-v2-pdfjs-staged-package-smoke` | Isolated lockfile `npm ci` + platform binding + pdfjs text extract |
| B reciprocal packaging (authoritative) | `npm run test:research-v2-production-package-reciprocal` | Same flags as Windows pack; copies **dist** + B probes; `canvas_package_json_present=true` + PDF probe ok |
| Campaign OpenRouter lane | `npm run test:research-v2-openrouter-route-smoke` | `openrouter` / `deepseek/deepseek-v4-flash-0731` / `deepseek-v4-flash-openrouter` (`review-artifacts/readiness-9d97448a-openrouter-route.log`) |
| Campaign G-L1 preflight (no network) | `npm run test:research-v2-campaign-preflight` | public-fact Node.js @ `as_of=2026-10-21`, domains `nodejs.org` + DuckDuckGo (`review-artifacts/readiness-g-l1-campaign-preflight-corrected.log`) |
| Full Research v2 manifest (prior receipt) | `node scripts/research-v2-collect-test-files.mjs \| tr '\\n' '\\0' \| xargs -0 node --import tsx --test` | **268** pass / 0 fail @ provenance head (unchanged by G-L1 input-only fix); later heads **269** with B `1693fb0d` regression |
| CLI model route | `node bin/babel.js research v2 model-route --json` | same policy route as smoke (`review-artifacts/readiness-9d97448a-model-route.json`) |
| Live gate (this run) | `node bin/babel.js research v2 live-status --json` | `live_api_enabled: false` until `BABEL_RESEARCH_V2_ALLOW_LIVE_API=1` + operator credentials |

**Effective OpenRouter (policy default, no env override):** provider `openrouter`, model `deepseek/deepseek-v4-flash-0731`, route key `deepseek-v4-flash-openrouter`, policy `/workspace/config/model-policy.json`, `backend_key` `research-v2-cli`.

**Canonical G-L1 (document only — do not execute live until provenance/cancel review clears):**

```bash
cd babel-cli
npm run build
npm run test:research-v2-openrouter-route-smoke
npm run test:research-v2-campaign-preflight

export BABEL_RESEARCH_V2_ALLOW_LIVE_API=1
# Operator sets OPENROUTER_API_KEY (presence only; not in repo)

node bin/babel.js research v2 run \
  --store /path/to/g-l1-store \
  --mission-file src/research/v2/fixtures/campaign/G-L1-mission.json \
  --discover-query "What is the latest stable Node.js release version as of 2026-10-21 according to official" \
  --json

# Post-run usage/cost: inspect store events / terminal receipt (usage_settlement on completions)
node bin/babel.js research v2 inspect --store /path/to/g-l1-store --mission-id mission-g-l1-general-live --json
node bin/babel.js research v2 report --store /path/to/g-l1-store --mission-id mission-g-l1-general-live --json
```

Optional: `BABEL_RESEARCH_V2_G_L1_DISCOVER_QUERY` overrides the discover string used by `test:research-v2-campaign-preflight` only.

**Canvas packaging (A owns lock/runtime):** direct `@napi-rs/canvas@0.1.80` + `pdfjs-dist@5.4.296` in `dependencies` (aligned with B `b3a6861b5` intent, reconciled with explicit platform-binding install for `--omit=optional` trees). B reciprocal PDF tests should copy runtime into staged `node_modules` and report resolved paths the same way — `NODE_PATH` to checkout `dist` is not packaged proof.

## B consumption notes

- General profile fields (`as_of`, `jurisdiction`, `intended_decision`) unchanged in shape; use `normalizeGeneralMissionBrief()` for corpus JSON — **no casts**.
- Structured decision criteria remain profile-owned; normalization flattens object `constraints` to string[] for V2 host validation.
- Document/HTML parsing: `access.fetchContent()` then adapter `read()` — **no raw fetch**.

## Rereview outcome (B fills in)

| Field | Value |
|-------|--------|
| Reviewed HEAD | _pending_ (await B relay of A `d51418b3`) |
| Verdict | APPROVE / BLOCK |
| Notes | _pending_ |

## Agent A reciprocal review of B fixture repair (2026-10-20)

| Field | Value |
|-------|--------|
| B head reviewed | `b2572ca844c21f444e79f253fc60b9295a67cb05` (patch verified; read-only snapshot) |
| Verdict | **APPROVE manifest/fixture slice only** — **NOT** campaign acceptance |
| Evidence | `review-artifacts/B_RECIPROCAL_REVIEW_A.md` (complete); A `74ee4276` at `review-artifacts/agent-a-frozen-74ee4276/` |
| A hold | `d51418b3` verified, **not accepted** — composition defects to consolidated native report; **no piecemeal repair** until then |
