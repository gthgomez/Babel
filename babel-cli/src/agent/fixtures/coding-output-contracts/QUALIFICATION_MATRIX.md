# Coding output contracts — qualification matrix

| Check | Result | Evidence |
|-------|--------|----------|
| Source ref (qualified) | pass | `185efbe2819bc1ec223caf50a39cf4700810f535` (PR #411 head) |
| Qualification branch | pass | `cursor/verify-coding-output-contracts-e2ce` (tests only; base tree `d20d9be15a595b1d8591c86ad3f9c852d0709c5c`) |
| `executeChatAwaitCommandAction` stale fence (logs/callbacks/spill store) | pass | `chatEngine.codingOutputContracts.test.ts` — spill-sized bg + `tool-output-artifacts` count |
| Repeated await (`timed_out`: top-level `exit_code: null`, log/callback `1`, then `0`) | pass | same file + `observationCompiler` null exit semantics |
| >32k error recovered via `read_artifact` without rerun | pass | same file |
| Cross-owner / cross-session artifact denial | pass | same file |
| `read_file` production wrapper (byte cap, full-read counts; **no readCache enrollment claim**) | pass | same file |
| Missing artifact access (`babel-artifact-unavailable`) | pass | same file |
| Retention cap / immutable snapshot identity | pass | same file + `runOutputArtifacts.test.ts` |
| Chat stream lifecycle (background artifact, long-line read) | pass | `chatEngine.lifecycleQualification.test.ts` (PR #411) |
| Installed OpenRouter acceptance cases prepared | pass | `babel-cli/fixtures/coding-output-acceptance/` (not executed) |
| Multi-file operator grader (hash-guarded tests + invoke) | pass | `oracle/multi-file/grader.selftest.mjs` + `codingOutputAcceptanceOracle.test.ts` |
| Live OpenRouter / paid API | unknown | Out of scope for this packet |
| Live-model usability | unknown | Scripted mechanics only |

## Commands (this qualification run)

```bash
git rev-parse HEAD && git rev-parse HEAD^{tree}
cd babel-cli && node --import tsx --test src/agent/chatEngine.codingOutputContracts.test.ts
cd babel-cli && node --import tsx --test src/agent/codingLoop/observationCompiler.test.ts
cd babel-cli && node --import tsx --test src/agent/codingOutputAcceptanceOracle.test.ts
cd babel-cli && node fixtures/coding-output-acceptance/oracle/multi-file/grader.selftest.mjs
cd babel-cli && node --import tsx --test src/agent/chatEngine.lifecycleQualification.test.ts
```

Recorded exits (CDT, Oct 21, 2026): contracts **0**; observationCompiler **0**; acceptance oracle **0**; grader.selftest **0**; lifecycle **0**.
