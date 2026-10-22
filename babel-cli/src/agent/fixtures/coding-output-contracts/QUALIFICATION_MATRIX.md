# Coding output contracts — qualification matrix

| Check | Result | Evidence |
|-------|--------|----------|
| Source ref | pass | `185efbe2819bc1ec223caf50a39cf4700810f535` (PR #411 head) |
| Isolated branch | pass | `cursor/verify-coding-output-contracts-e2ce` |
| `executeChatAwaitCommandAction` stale fence (logs/callbacks/artifacts) | pass | `chatEngine.codingOutputContracts.test.ts` — stale await via executor |
| Repeated await (running `timed_out` + null exit, then complete) | pass | same file |
| >32k error recovered via `read_artifact` without rerun | pass | same file |
| Cross-owner / cross-session artifact denial | pass | same file |
| `read_file` production wrapper (byte cap, full-read counts, cache) | pass | same file |
| Missing artifact access (`babel-artifact-unavailable`) | pass | same file |
| Retention cap / immutable snapshot identity | pass | same file + `runOutputArtifacts.test.ts` |
| Chat stream lifecycle (background artifact, long-line read) | pass | `chatEngine.lifecycleQualification.test.ts` (PR #411) |
| Installed OpenRouter acceptance cases prepared | pass | `babel-cli/fixtures/coding-output-acceptance/` (not executed) |
| Live OpenRouter / paid API | unknown | Out of scope for this packet |
| Live-model usability | unknown | Scripted mechanics only |

## Commands (this qualification run)

```bash
git rev-parse HEAD && git rev-parse HEAD^{tree}
cd babel-cli && node --import tsx --test src/agent/chatEngine.codingOutputContracts.test.ts
cd babel-cli && node --import tsx --test src/agent/chatEngine.lifecycleQualification.test.ts
```

Record exit codes from the commands above in the PR checkpoint.
