# Coding output acceptance (prepared, not executed)

Prepared installed-build OpenRouter acceptance for packet **coding-output-contracts**.
No live API calls, credential reads, or provider substitutions are performed from this packet.

## Layout

| Path | Agent-visible at run time |
|------|---------------------------|
| `workspaces/*` | Yes — copy into an isolated run directory |
| `oracle/*` | **No** — keep on the operator host; score after the run |
| `manifest.json` | Operator metadata only |

## Minimal procedure (operator)

1. Build/install Babel from the qualified source tree (`npm --prefix babel-cli run build`).
2. For each case in `manifest.json`, copy `workspaces/<case>` to a fresh directory (the agent workspace).
3. Run the installed agent against the workspace with the case `agent_prompt` and `model_route` (OpenRouter) using normal admission/profile/Docker/cwd/cancellation settings — **do not** mount `oracle/`.
4. After the agent stops, score independently (oracle stays off the agent checkout):

```bash
node babel-cli/fixtures/coding-output-acceptance/oracle/ordinary-bug/score.mjs /path/to/workspace
node babel-cli/fixtures/coding-output-acceptance/oracle/multi-file/score.mjs /path/to/workspace
```

The multi-file grader hashes immutable visible tests/decoys, then invokes `formatGreeting` via `invoke-greeting.mjs` (not `npm test` alone). Operator regression:

```bash
node babel-cli/fixtures/coding-output-acceptance/oracle/multi-file/grader.selftest.mjs
```

5. Record three scores per case: **functional_success** (oracle exit 0), **strict_completion** (terminal outcome matches oracle), **truthful_claims** (manual review of truncated-read / artifact claims vs transcript).

A correct first attempt is success; do not force a wrong repair pass.

## Plan-only dry run

```bash
node -e "const m=require('./babel-cli/fixtures/coding-output-acceptance/manifest.json'); console.log(JSON.stringify(m,null,2))"
```
