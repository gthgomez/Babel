# G-L1 readiness pack for Agent B (Agent A — no live execution)

**Effective 2026-10-21:** Agent **B** is the **sole executor** for the one general G-L1 diagnostic live run, using B's existing OpenRouter credential against A's reviewed published runtime on [#406](https://github.com/gthgomez/Babel/pull/406). **Agent A must not** run `research v2 run` live, live model smoke, or set `BABEL_RESEARCH_V2_ALLOW_LIVE_API=1` for campaign purposes.

Coordinator issues the single live command to **B only** after mission/route validation. Supersedes any prior conditional live-run authority for Agent A in this campaign.

## Mission (canonical)

- **File:** `babel-cli/src/research/v2/fixtures/campaign/G-L1-mission.json`
- **mission_id:** `mission-g-l1-general-live`
- **profile:** `general`
- **Task (verbatim `primary_question`):** As of the run's UTC date, what is the latest stable Python release and its release date? Distinguish stable releases from prereleases, cite the official Python release/download page, and report uncertainty if official pages disagree or cannot be read.

## Domains

| Role | Hosts |
|------|--------|
| Evidence (official) | `python.org`, `www.python.org`, `docs.python.org` |
| Search transport | `duckduckgo.com`, `html.duckduckgo.com` |

## Model route (verified, unchanged)

- **provider:** `openrouter`
- **model_id:** `deepseek/deepseek-v4-flash-0731`
- **route_key:** `deepseek-v4-flash-openrouter`
- **policy:** `config/model-policy.json`, `backend_key` `research-v2-cli`

## Non-secret preflight (A captured)

```bash
cd babel-cli
npm run test:research-v2-openrouter-route-smoke
npm run test:research-v2-campaign-preflight
```

- Log: `review-artifacts/readiness-g-l1-python-campaign-preflight.log`
- OpenRouter log: `review-artifacts/readiness-g-l1-python-openrouter-route.log`

**Discover query (preflight default, 12 words):** `As of the run's UTC date, what is the latest stable Python`

## Callable command template (B executes when coordinator authorizes)

```bash
cd babel-cli
npm run build
npm run test:research-v2-openrouter-route-smoke
npm run test:research-v2-campaign-preflight

export BABEL_RESEARCH_V2_ALLOW_LIVE_API=1
# OPENROUTER_API_KEY — B operator secret (not in repo)

node bin/babel.js research v2 run \
  --store /path/to/g-l1-store \
  --mission-file src/research/v2/fixtures/campaign/G-L1-mission.json \
  --discover-query "As of the run's UTC date, what is the latest stable Python release and" \
  --json

node bin/babel.js research v2 inspect --store /path/to/g-l1-store --mission-id mission-g-l1-general-live --json
node bin/babel.js research v2 report --store /path/to/g-l1-store --mission-id mission-g-l1-general-live --json
```

## Prior candidate proof (A — not rebound)

Full Research v2 manifest **268 pass / 0 fail / exit 0** @ provenance head (`review-artifacts/readiness-9d97448a-research-v2-tests.log`). Later A heads add B `1693fb0d` regression (**269** tests) and G-L1 input-only edits without replacing that receipt.

## Agent A parallel work (no G-L1 live)

Technical `repository_file` raw transport provenance; offline operation ids scoped by writer generation (`1693fb0d` regression). No further G-L1 mission prep required in A.
