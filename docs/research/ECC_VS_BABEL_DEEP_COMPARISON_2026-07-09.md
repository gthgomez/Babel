<!--
status: ACTIVE
last_verified: 2026-07-09
-->

# ECC vs Babel — Deep Comparison (Harness + Prompt OS)

> **Purpose**: File-backed competitive teardown of [Everything Claude Code (ECC)](https://github.com/affaan-m/ECC) against Babel, aimed at **improving Babel’s own harness and Prompt OS**.  
> **Method**: Local fork + shallow clone inspection + Babel source/docs verification.  
> **Not a market-parity claim.** Verdicts are `WIN` / `MIXED` / `VULNERABLE` / `UNVERIFIED` with confidence labels.

---

## 0. Local research assets

| Asset | Location |
|-------|----------|
| **Fork (your account)** | (personal fork of the upstream) |
| **Local clone** | `/workspace-root/research/ECC` (~70 MB working tree, shallow `main`) |
| **Remotes** | `origin` → `user/ECC`, `upstream` → `affaan-m/ECC` |
| **Upstream snapshot** | commit `[commit-hash]` (2026-07-09), package version **2.0.0** |
| **Babel root** | `./` (project root) |
| **This report** | `docs/research/ECC_VS_BABEL_DEEP_COMPARISON_2026-07-09.md` |

### Refresh the clone

```powershell
cd /workspace-root/research/ECC
git fetch upstream
git pull --ff-only upstream main
```

Do **not** vendor ECC inside the Babel repository without an explicit licensing or scrub decision. Keep research outside the product tree.

---

## 1. Category truth (read this first)

These products **do not compete on the same primary axis**.

```
┌────────────────────────────────────────────────────────────────┐
│  Host harnesses: Claude Code · Codex · Cursor · OpenCode · …   │
│         ▲                                                      │
│         │  ECC = portable operator pack (skills/hooks/rules)   │
│         │  install profiles · consult · doctor · instincts     │
└─────────┼──────────────────────────────────────────────────────┘
          │
          │  Babel = one of the harnesses (owned runtime)
          ▼
┌────────────────────────────────────────────────────────────────┐
│  babel CLI / TUI  (ChatEngine default)                         │
│  + Prompt OS deep pipeline (catalog → compiler → stages)       │
│  + sandbox · circuit breaker · runs/ evidence                  │
└────────────────────────────────────────────────────────────────┘
```

| | **ECC** | **Babel** |
|--|---------|-------------------|
| **Primary product** | Cross-harness **operator OS / plugin pack** | **Autonomous coding agent runtime** + optional **Prompt OS** |
| **Who executes tools** | Host agent | Babel ChatEngine / pipeline executor |
| **Who owns safety** | Host permissions + ECC hooks + AgentShield (config scan) | Babel sandbox + circuit breaker + policy + audit trail |
| **Distribution** | Plugin / npm / selective install into user harness dirs | Build & run local CLI; editor path via `BABEL_BIBLE.md` |
| **Maturity posture** | Public OSS “production-aimed plugin” narrative | Explicit prototype + claims matrix |

**Implication for Babel strategy**: Steal ECC’s **operator packaging, installability, continuous learning UX, hook density, and multi-surface skill portability**. Do **not** abandon Babel’s **owned loop, typed governance, and evidence discipline**.

---

## 2. Quantitative surface (local counts)

### ECC (`/workspace-root/research/ECC`)

| Surface | Count / status |
|---------|----------------|
| Skills (`skills/*/`) | **278** |
| Agents (`agents/*.md`) | **67** |
| Commands (`commands/*.md`) | **94** |
| Rule language packs (`rules/*/`) | **22** dirs (common + lang/framework) |
| Hook event types | PreToolUse, PreCompact, SessionStart, PostToolUse, PostToolUseFailure, Stop, SessionEnd |
| Named hook IDs | **29** |
| Hook implementation scripts (`scripts/hooks/*.js`) | **47** |
| Install modules | **32** |
| Install profiles | minimal, opencode, core, developer, security, research, full |
| Schemas (install/hooks/state/plugin/…) | **10** |
| Scripts (`scripts/**/*.js`) | **203** |
| Runtime deps | `@iarna/toml`, `ajv`, `sql.js` (light) |
| Control plane | `ecc2/` Rust alpha + Node `ecc` CLI |
| Stars (gh API at research time) | ~228k (popularity signal only) |

### Babel (local)

| Surface | Count / status |
|---------|----------------|
| Catalog IDs (`prompt_catalog.yaml`) | **~189** |
| Skill markdown under `02_Skills/` (ex-archive) | **~137** |
| Domain architects | **~10** live files |
| Model adapters | **7** |
| CLI TS sources (`babel-cli/src/**/*.ts`) | **~828** |
| Runtime shape | Full TypeScript harness: agent, pipeline, TUI, daemon, sandbox, doctor, learning, plugins |
| Modes | chat (default), plan, deep |
| Evidence | `runs/`, doctor, benchmarks, claims matrix |

Counts alone are **not quality**. ECC wins **breadth and install packaging**. Babel wins **runtime depth and governance machinery**.

---

## 3. Architecture deep dive

### 3.1 ECC architecture (verified locally)

**Source of truth layout**

| Path | Role |
|------|------|
| `skills/*/SKILL.md` | Portable workflow unit (YAML frontmatter + When/How/Examples) |
| `agents/*.md` | Subagent prompts (name, tools, model) for host delegation |
| `commands/*.md` | Slash-entry compatibility surface |
| `rules/{common,lang}/` | Always-on guidelines (copy/install, not always plugin-shippable) |
| `hooks/hooks.json` + `scripts/hooks/` | Deterministic lifecycle automation on host events |
| `manifests/install-*.json` + schemas | Selective install graph (modules, profiles, components, state) |
| `scripts/ecc.js`, `doctor.js`, `consult.js`, `install-apply.js` | Operator lifecycle CLI |
| `.claude-plugin/`, `.codex-plugin/`, `.cursor/`, `.opencode/`, … | Thin harness adapters |
| `ecc2/` | Alpha multi-session control plane (Rust) |
| `agent.yaml` | gitagent-style export of skill catalog |

**Portability model** (from `docs/architecture/cross-harness.md`): durable behavior lives in skills/rules/hooks/scripts; adapters only load/map events/commands. `SKILL.md` is the unit that “travels unchanged.”

**Install philosophy**

- Profiles (`minimal` → `full`) compose modules.
- Modules declare `targets` (claude, cursor, codex, opencode, zed, hermes, …), dependencies, cost, stability.
- `npx ecc consult "…"` recommends components before install.
- `doctor` / `repair` / `uninstall` operate on **install-state** (idempotent lifecycle).
- Explicit anti-pattern: do not stack plugin + full installer (documented extensively).

**Hook philosophy**

- Hooks fire **100%** of the time; skills are treated as probabilistic.
- Profiles: `ECC_HOOK_PROFILE=minimal|standard|strict` + `ECC_DISABLED_HOOKS`.
- SessionStart injects capped context/instincts; Pre/Post observe for continuous learning; Stop evaluates session and tracks cost.
- Gate patterns: config-protection (don’t weaken linters), gateguard fact-force (investigate before first write), MCP health checks, bash quality dispatcher.

**Learning philosophy (`continuous-learning-v2`)**

```
tool events (hooks, deterministic)
  → observations.jsonl (project-scoped by git remote hash)
  → background observer (Haiku)
  → atomic instincts (trigger/action/confidence/evidence/scope)
  → /evolve clusters → skills/commands/agents
  → /promote project → global when multi-project evidence
```

Privacy: observations local; export instincts not raw sessions.

### 3.2 Babel architecture (verified locally)

**Prompt OS layers** (runtime stack)

1. Behavioral OS (`01_Behavioral_OS/`, live `behavioral_core_v11`)
2. Domain Architect (`02_Domain_Architects/`) — one per task
3. Skills (`02_Skills/`) — zero+ catalogued skills
4. Model Adapter (`03_Model_Adapters/`)
5. Project Overlay / Task Overlay
6. Catalog registry: `prompt_catalog.yaml`
7. Compiler/resolver: `babel-cli/src/compiler.ts`, `control-plane/stackResolver.ts`
8. Deep pipeline: Orchestrator → SWE → QA → Executor (`pipeline.ts` + modules)
9. Chat path: ChatEngine bypasses deep stages; minimal stack only

**Harness ownership**

| Concern | Babel mechanism |
|---------|-----------------|
| Tool loop | `agent/chatEngine.ts`, `toolExecutor.ts`, mutation tools |
| Safety | `sandbox.ts`, circuit breaker, enterprise policy, hard network denials in chat |
| Hooks | `runtime/hooks.ts` (internal PreToolUse / BeforeComplete / Session*) + plugin hook events in `services/plugins.ts` |
| Plugins | Trust-gated (`metadata` → `external_network`), enterprise allow/deny |
| Memory | Chronicle store (sqlite/json), session checkpoints, handoffs, `runs/` |
| Learning | `services/learning.ts` — failure records → lesson candidates → shadow → mutation packages (proof-first) |
| Doctor | Broad workspace/runtime health (`doctor.ts`) |
| Meta prompt quality | OLS-MCC triad (compiler / prompt-tester / skill-auditor) |

**Design invariant Babel has and ECC largely does not encode as product law**: *behavior (how) stays separate from domain knowledge (what)*.

---

## 4. Axis-by-axis teardown

Legend: **ECC better** | **Babel better** | **Mixed** | confidence in parentheses.

### 4.1 Product control point

| Question | ECC | Babel | Winner |
|----------|-----|-------|--------|
| Owns end-to-end tool execution? | No (host) | Yes | **Babel** (high) |
| Improves any popular host tomorrow? | Yes | No (own CLI + editor bible) | **ECC** (high) |
| Can enforce fail-closed without host cooperation? | Partial (hooks if host supports) | Yes | **Babel** (high) |

**Babel takeaway**: Keep owned runtime. Add *export adapters* so Babel layers can also ride Claude/Codex/Cursor when users won’t switch CLIs.

### 4.2 Skill / instruction systems

| | ECC | Babel |
|--|-----|-------|
| Format | `SKILL.md` + frontmatter (`name`, `description`, `origin`, optional `tools`) | Layered catalog entries + domain defaults + token budgets |
| Selection | Host skill discovery + consult + install modules | Deterministic stack resolver + purpose mode + budget diagnostics |
| Breadth | 278 skills across eng, ops, media, markets, healthcare, … | ~137 skills, governance-heavy |
| Authoring gate | CI validators + skill-stocktake | OLS-MCC triad + Role_Creation_Gate |
| Composition law | Practical (install modules) | Architectural (behavior ≠ knowledge) |

| Winner | |
|--------|---|
| **ECC** — breadth, install modularity, portable unit format | high |
| **Babel** — composition discipline, budget-aware resolution, co-evolution with runtime contracts | high |

**Steal for Babel**

1. Normalize skill packaging toward portable `SKILL.md`-like envelopes *while* remaining catalog-registered.
2. Install/export **profiles** (`minimal|developer|security|full`) for chat stacks — not only full catalog presence.
3. `babel consult "<need>"` that previews stack IDs the way `ecc consult` previews components.

### 4.3 Hooks & deterministic automation

| | ECC | Babel |
|--|-----|-------|
| Hook density | 29 named hooks, 47 scripts, multi-event lifecycle | Internal runtime hooks + plugin event schema |
| Determinism ethos | “hooks 100%, skills probabilistic” | Circuit breaker / sandbox / capability rewrite |
| Operator knobs | `ECC_HOOK_PROFILE`, `ECC_DISABLED_HOOKS`, session char caps | Execution profiles, enterprise policy, tool capabilities |
| Continuous observation | Pre/Post observe → instincts | Run evidence + learning from completed runs |

| Winner | |
|--------|---|
| **ECC** for *productized* host-lifecycle automation UX | high |
| **Babel** for *owned* fail-closed tool policy | high |
| **VULNERABLE**: Babel chat path underuses event-hook density ECC users expect | medium |

**Steal for Babel**

1. Expose first-class hook profiles: `minimal | standard | strict` for chat Pre/Post tool + stop-session.
2. Productize post-edit quality loops (format/typecheck/console.warn) as optional standard hooks with evidence events.
3. SessionStart stack injection caps (ECC’s `ECC_SESSION_START_MAX_CHARS`) as Babel context budget product feature, not only internal budget policy.

### 4.4 Orchestration & multi-agent

| | ECC | Babel |
|--|-----|-------|
| Specialists | 67 markdown agents (reviewer/build-resolver per language) | Subagents + pipeline stages + workflowEngine DAG |
| User surface | `/plan`, language `/go-review`, `orch-*` skills, multi-* (external ccg) | `babel plan`, `babel deep`, REPL modes |
| Parallelism | Worktree lifecycle service, tmux orchestration scripts | Worktree-friendly patterns; less productized multi-session OS |
| Control plane | `ecc2` alpha multi-session | Daemon + sessions + TUI (more mature TS, less multi-host) |

| Winner | |
|--------|---|
| **ECC** language specialist swarm + operator multi-session direction | medium |
| **Babel** typed deep pipeline with adversarial QA | high |

**Steal for Babel**

1. Language/build-resolver agent pack (TS/Python/Go/…) as catalogued *read-only or scoped* subagents for chat.
2. Worktree lifecycle service (predict conflicts, GC stale trees) for parallel fan-out (pairs with existing parallel-fanout skill).
3. Do not copy ECC’s “multi-* needs external ccg-workflow” complexity without owning the runtime.

### 4.5 Learning & memory

| | ECC continuous-learning-v2 | Babel learning + chronicle |
|--|----------------------------|----------------------------|
| Observation | Every tool event via hooks | Run artifacts, tool logs, proof status |
| Atomic unit | Instinct (trigger/action/confidence/scope) | LearningFailureRecord → LessonCandidate |
| Promotion | Project → global with multi-project evidence | Candidate → shadow → mutation package (verifier/overlay) |
| Operator UX | `/instinct-status`, `/evolve`, import/export | `babel learn …` proof-oriented commands |
| Risk model | Confidence score | Explicit failure types, agent vs system fault, severity |

| Winner | |
|--------|---|
| **ECC** operator-facing continuous learning *product* | high |
| **Babel** proof-gated learning *discipline* | high |
| Ideal hybrid | ECC’s instinct UX + Babel’s evidence gates |

**Steal for Babel**

1. Project-scoped “instinct-like” lessons with confidence + evidence, stored outside sensitive paths.
2. SessionStop evaluator that proposes lessons without auto-mutating prompts until shadow pass.
3. Keep Babel’s failure taxonomy — it is more engineering-grade than freeform instincts.

### 4.6 Security

| | ECC | Babel |
|--|-----|-------|
| Config audit | AgentShield (static rules + optional multi-agent audit) | Enterprise plugin policy, secret redaction utils, sandbox |
| Runtime protection | gateguard, config-protection, bash dispatcher | Hard denies, capability rewrites, circuit breaker |
| Supply chain | IOC scan scripts, official-source warnings | Public scrub / export gates |

| Winner | **Mixed** (high confidence on categories) |
|--------|-------------------------------------------|
| ECC better at scanning *agent config surface area* | |
| Babel better at *runtime isolation of its own executor* | |

**Steal for Babel**: Ship `babel security-scan` for local CLAUDE.md/MCP/plugin/hook configs (AgentShield-class), plus keep sandbox as the differentiator.

### 4.7 Install, doctor, repair, packaging

| Capability | ECC | Babel |
|------------|-----|-------|
| Selective install | Profiles + modules + plan/apply | Mostly monorepo build |
| Consult before install | `ecc consult` | Weak / absent as product |
| Doctor | Install-state drift + repair | Deep runtime/workspace doctor |
| Uninstall | State-tracked | N/A (whole app) |
| Cross-platform scripts | Node rewrite of hooks | PowerShell tools + TS CLI |

| Winner | **ECC** for distribution ergonomics; **Babel** for runtime doctor depth |

**Steal for Babel**

1. “Stack profiles” for chat/deep: which layers load by default.
2. `babel doctor --scope install` style checks for catalog/path drift (exists) → add repair playbooks with one-command fix.
3. Public export already has scrub — pair with ECC-like “preview install plan” for adapters.

### 4.8 Evals & verification

| | ECC | Babel |
|--|-----|-------|
| Eval skill | `eval-harness` (EDD, pass@k, graders) | Benchmarks, verifier contracts, production/lite gates |
| Verification skill | `verification-loop` (build/type/lint/test/security/diff phases) | Executor completion gates, auto verifier discovery |
| Harness audit | Deterministic scoring script (`harness-audit.js`) categories: tools, context, quality, memory, eval, security, cost, cloud providers | doctor + claims matrix + architectural budget |

| Winner | **Mixed** |
|--------|-----------|
| ECC better at *operator-facing* EDD language and harness scorecard | |
| Babel better at *runtime-enforced* verifier contracts and claim ledger | |

**Steal for Babel**: Productize a `/quality-gate` or `babel verify` playbook that mirrors verification-loop phases as a chat mode command, driven by real tool execution (not only skill text).

### 4.9 Context & cost management

ECC productizes:

- SessionStart context caps
- instinct injection caps + confidence thresholds
- context monitor post-hook
- cost tracker on Stop
- MCP overload warnings in docs
- token optimization guide (longform)

Babel productizes:

- stack token budgets + actual token diagnostics in resolver
- cost tracker service
- chat compaction
- budget policy in deep mode

| Winner | **Mixed** — ECC wins user-facing knobs; Babel wins compiler budget math |

**Steal**: Export budget diagnostics into TUI statusline (ctx%, cost) the way ECC’s statusline culture expects.

### 4.10 GTM, docs, community

| | ECC | Babel |
|--|-----|-------|
| Docs | Shortform + longform + security guides; multi-language READMEs | Strong internal bible/architecture; less consumer marketing |
| Onboarding | 2-minute plugin install | Build CLI + provider keys |
| Community | Discord, sponsors, marketplace app | Private lab |
| Honesty | Aggressive “production-aimed” | Explicit non-parity claims |

| Winner | **ECC** (high) for distribution; **Babel** (high) for claim discipline |

---

## 5. What ECC does better (steal list for Babel)

Prioritized by leverage on Babel’s harness + OS (not vanity features).

### P0 — High leverage, fits Babel architecture

| # | ECC pattern (evidence) | Why it matters | Babel adaptation |
|---|------------------------|----------------|------------------|
| 1 | **Selective install profiles/modules** (`manifests/install-*.json`) | Users drown in full stacks | Chat stack profiles: `minimal|core|developer|security` mapping catalog IDs |
| 2 | **Consult before load** (`scripts/consult.js`) | Right skill without full context tax | `babel consult` / TUI: “recommended stack for this task” from catalog tags |
| 3 | **Hook profile knobs** (`ECC_HOOK_PROFILE`, disabled IDs) | Same binary, tunable strictness | Chat engine hook profiles + evidence traces (extend `runtime/hooks.ts` + plugins) |
| 4 | **Deterministic post-edit quality gates** (Stop format/typecheck, post quality-gate) | Catches mistakes without relying on model memory | Optional PostToolUse format/typecheck with circuit-breaker-friendly failure messages |
| 5 | **SessionStart capped memory inject** | Continuity without context blowups | Bounded inject from chronicle/handoff/instincts into chat preamble |
| 6 | **Portable skill unit** (`SKILL.md` frontmatter + When to Use) | Cross-surface reuse | Dual-export: catalog path + portable SKILL envelope for editor harnesses |
| 7 | **Harness audit scorecard** (`harness-audit.js`) | Operators know readiness | `babel harness-audit` scoring tools/context/memory/security/cost against declared contracts |
| 8 | **Config protection / fact-force gates** | Stops agents “fixing” by weakening lint or writing before reading | Productize as standard PreWrite hooks (Babel already has safety pieces — make them product defaults) |

### P1 — Strong product differentiators if integrated carefully

| # | ECC pattern | Babel adaptation |
|---|-------------|------------------|
| 9 | Continuous learning instincts (project-scoped, confidence) | Layer instinct UX on `services/learning.ts` without auto-promoting prompts |
| 10 | Language reviewer + build-resolver agent matrix | Catalogued specialist agents for chat delegation |
| 11 | Worktree lifecycle service | Parallel fan-out safety for multi-agent edits |
| 12 | AgentShield-class config scanner | `babel security-scan` for MCP/plugins/settings |
| 13 | `ecc status` portable operator handoff | Merge handoff + doctor + work items into one markdown status artifact |
| 14 | Verification-loop skill as user ritual | First-class `babel verify` / `/verify` using real tools |
| 15 | Eval-harness EDD language (pass@k) | Align marketing + dogfood with existing benchmarks |

### P2 — Valuable later / lower priority for core wedge

| # | Pattern | Note |
|---|---------|------|
| 16 | Multi-language rule packs (22) | Expand domain/rules carefully; avoid context bloat |
| 17 | Business/content/media skill packs | Only if Babel expands beyond coding agent |
| 18 | `ecc2` multi-session Rust plane | Babel daemon/TUI may already cover; watch for multi-host session adapter ideas |
| 19 | GitHub App skill generation | Nice OSS growth loop; not core harness quality |
| 20 | Dashboard GUI | Optional; TUI is Babel’s primary surface |

---

## 6. What Babel does better (double-down, do not dilute)

| # | Babel strength | Evidence | Why not copy ECC blindly |
|---|----------------|----------|---------------------------|
| 1 | **Owned ChatEngine + TUI** | `babel-cli/src/agent/*`, `ui/*` | ECC has no peer full agent loop |
| 2 | **Deep governed pipeline** | Orchestrator → SWE → QA → Executor + contracts | ECC orchestration is skill/agent text + host |
| 3 | **Behavior ≠ knowledge layering** | ARCHITECTURE.md invariants | ECC rules/skills/agents blur this |
| 4 | **Catalog as SoT + co-evolution** | `prompt_catalog.yaml` + agentContracts | ECC catalogs more packaging-oriented |
| 5 | **Token budget diagnostics at resolve time** | `stackResolver.ts` | Deeper than SessionStart char caps |
| 6 | **Proof-first learning** | `services/learning.ts` failure taxonomy | Instincts alone can invent folklore |
| 7 | **Sandbox + circuit breaker autonomy model** | README product lock | Different UX bet than approval prompts |
| 8 | **Claims matrix honesty** | `docs/status/claims-matrix.md` | Protects product integrity |
| 9 | **Plugin trust levels** | `services/plugins.ts` | Enterprise-shaped extensibility |
| 10 | **Meta prompt quality loop** | OLS-MCC triad | ECC has CI validation; Babel has adversarial prompt craft |

**Do not** become “just another ECC-style plugin pack.” That concedes the control point Babel’s whole architecture assumes.

---

## 7. Gap matrix (Babel relative to ECC)

| Capability | Babel today | Gap severity | Notes |
|------------|-------------|--------------|-------|
| Cross-harness skill export | Editor bible only | **High** | Users live in Claude/Cursor |
| Install profiles / consult | Missing product surface | **High** | Catalog exists; no consumer profiles |
| Hook density & knobs | Present but internal | **High** | Needs operator-facing profiles |
| Continuous learning UX | Proof learning exists | **Medium** | Needs instinct-like UX |
| Specialist agent swarm | Partial | **Medium** | Language matrix thin vs ECC 67 |
| Harness readiness scorecard | doctor fragments | **Medium** | No single harness-audit rubric |
| Config security scanner | Partial | **Medium** | AgentShield-class missing |
| Worktree multi-agent OS | Patterns only | **Medium** | ECC has lifecycle service direction |
| Skill breadth | Narrower | **Low–Med** | Breadth without budgets is toxic |
| Public install GTM | Private lab | **High (GTM)** | Not required for technical quality |
| Owned runtime | Strong | — | ECC weaker |
| Typed deep QA pipeline | Strong | — | ECC weaker |
| Evidence / claims discipline | Strong | — | ECC weaker |

---

## 8. Recommended Babel roadmap (actionable)

### Track A — Harness productization (next 2–4 weeks)

1. **Stack profiles** for chat: map profiles → catalog ID sets; wire ChatEngine load path.
2. **`babel consult`** (or REPL `/consult`) returning recommended stack + token estimate.
3. **Hook profiles** `minimal|standard|strict` with enable/disable list and run evidence events.
4. **`babel verify`** command implementing verification-loop phases via real tools + artifact.
5. **`babel harness-audit`** scorecard (tools, context, memory, security, cost, quality gates).

### Track B — Prompt OS portability (parallel)

1. **Export adapter**: compile a Babel stack → portable `SKILL.md` / `AGENTS.md` / rules bundle for Claude/Cursor/Codex.
2. Dual-write skill authoring guidelines: catalog fields + portable frontmatter.
3. Document “Babel deep vs Babel-in-Claude” when each is correct.

### Track C — Learning loop hybrid

1. Session-end observation capture (deterministic) → lesson candidates with confidence.
2. Project-scoped storage keyed by git remote hash (ECC idea).
3. Require shadow eval before any prompt overlay mutation (Babel discipline).

### Track D — Safety productization

1. Config protection defaults (block weakening lint/format configs without explicit user intent).
2. Fact-force optional mode: first write to a file requires prior read/search evidence.
3. `babel security-scan` for MCP/plugins/settings (AgentShield-inspired).

### Explicit non-goals (near term)

- Cloning ECC’s 278-skill firehose into default chat context.
- Abandoning owned CLI for “plugin-only” distribution.
- Marketing parity with Claude Code/Codex without benchmarks.
- Shipping `ecc2`-style second control plane when Babel daemon/TUI already covers core needs — *unless* multi-host session federation becomes a goal.

---

## 9. Concrete file maps (for implementers)

### ECC files worth reading first (local clone)

| Topic | Path |
|-------|------|
| Cross-harness model | `docs/architecture/cross-harness.md` |
| Install profiles | `manifests/install-profiles.json` |
| Install modules | `manifests/install-modules.json` |
| Hooks surface | `hooks/hooks.json` |
| Hook impls | `scripts/hooks/*.js` |
| Consult | `scripts/consult.js` |
| Doctor lifecycle | `scripts/doctor.js`, `scripts/lib/install-lifecycle.js` |
| Harness audit | `scripts/harness-audit.js` |
| Continuous learning | `skills/continuous-learning-v2/SKILL.md` |
| Verification ritual | `skills/verification-loop/SKILL.md` |
| Eval ritual | `skills/eval-harness/SKILL.md` |
| Agent format | `agents/code-reviewer.md` |
| Control plane alpha | `ecc2/README.md` |
| Identity | `AGENTS.md`, `CLAUDE.md`, `SOUL.md` |

### Babel files that are the adaptation surface

| Topic | Path |
|-------|------|
| Chat loop | `babel-cli/src/agent/chatEngine.ts` |
| Stack resolve | `babel-cli/src/control-plane/stackResolver.ts` |
| Catalog | `prompt_catalog.yaml`, `babel-cli/src/control-plane/catalog.ts` |
| Runtime hooks | `babel-cli/src/runtime/hooks.ts` |
| Plugins/hooks schema | `babel-cli/src/services/plugins.ts` |
| Learning | `babel-cli/src/services/learning.ts` |
| Chronicle memory | `babel-cli/src/tools/chronicleMemory.ts` |
| Pipeline | `babel-cli/src/pipeline.ts`, `babel-cli/src/pipeline/*` |
| Sandbox | `babel-cli/src/sandbox.ts` |
| Doctor | `babel-cli/src/doctor.ts` |
| Product lock / claims | `docs/status/BABEL_PRODUCT_DECISION_LOCK.md`, `docs/status/claims-matrix.md` |
| Architecture | `docs/architecture/ARCHITECTURE.md` |

---

## 10. Side-by-side “same problem, different solution”

| User need | ECC approach | Babel approach | Prefer for Babel core? |
|-----------|--------------|----------------|------------------------|
| Daily coding | Host agent + ECC skills/hooks | `babel` chat | Own chat; export skills |
| Plan first | `/plan` + planner agent | `babel plan` / `/mode plan` | Keep Babel plan |
| High stakes | quality-gate + reviewers + hooks | `babel deep` QA stage | Keep deep |
| Remember preferences | Instincts via hooks | Learning + chronicle + overlays | Hybrid |
| Don’t bloat context | Install minimal profile + disable MCPs | Token budget resolver | Both |
| Parallel agents | worktrees + multi-* + ecc2 | workflowEngine + fan-out skills | Worktree service |
| Trust install | doctor/repair/uninstall state | doctor + scrub export | Install-state for adapters |

---

## 11. Confidence & limits

| Statement | Confidence |
|-----------|------------|
| Category difference (plugin OS vs owned harness) | **High** — both repos + local tree |
| Local ECC counts (278/67/94/29 hooks) | **High** — measured on clone |
| Babel catalog/skill/TS counts | **High** — measured locally |
| ECC star quality / download authenticity | **Low** as quality signal |
| Live SWE quality either product | **Unverified** — no shared head-to-head bench run in this study |
| `ecc2` readiness | **Medium** — alpha by their own README |
| Babel live deep-governance obedience | **Medium** — self-documented under-proven |

---

## 12. Bottom line

**ECC is the best-in-class open operator pack** for making *existing* coding harnesses productive: selective install, consult, dense hooks, instincts, specialist agents, verification/eval rituals, multi-harness packaging.

**Babel is a different product**: an **owned autonomous coding agent** with a **governed Prompt OS**, typed pipeline, sandbox autonomy, and evidence-first claims.

### Strategic synthesis

```
Babel should become:

  [ Owned harness (keep) ]
       +
  [ ECC-grade operator packaging (steal) ]
       +
  [ Portable skill export to host harnesses (new wedge) ]
       +
  [ Hybrid learning: instinct UX × proof gates (unique) ]
```

If Babel only copies skills, it becomes a weaker ECC.  
If Babel only keeps deep governance without installability and hook productization, it remains a powerful lab that few operators can adopt.

**Winning shape**: *Babel runs the critical path; Babel also ships the portable OS layers that make every other harness better — without surrendering the control point.*

---

## Appendix A — Fork/clone provenance

```
Fork:     gh repo fork affaan-m/ECC → user/ECC
Clone:    /workspace-root/research/ECC  (depth 1, single-branch main)
Upstream: https://github.com/affaan-m/ECC
Origin:   (personal fork)
License:  MIT (upstream)
```

## Appendix B — Suggested next research sessions

1. Map top 30 ECC skills → Babel catalog gaps (presence / quality / token cost).
2. Diff ECC hook set vs Babel `runtime/hooks.ts` + plugin events (line-level gap list).
3. Prototype `babel consult` against `prompt_catalog.yaml` tags.
4. Export one Babel deep stack to Claude rules pack and dogfood side-by-side.
5. Run harness-audit style scoring against Babel itself as a dogfood target.
