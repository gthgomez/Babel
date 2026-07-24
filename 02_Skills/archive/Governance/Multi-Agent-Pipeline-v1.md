<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Multi-Agent Pipeline (v1.0)
**Category:** Governance / Systems
**Status:** Active

---

## 1. What This Covers

This skill covers the patterns used in example_saas_backend's multi-agent code review pipeline (`internal_monitoring_module/`). It applies whenever building or modifying:

- Multi-agent review systems (parallel LLM agent dispatch, result aggregation)
- Learning pipelines with approval gates (prompt modification lifecycle)
- CI hooks that run agent pipelines non-blockingly
- Agent base classes with explicit execution state tracking

---

## 2. Agent Base Class Contract

Every agent inherits from a shared abstract base that enforces the timeout chain and explicit state model:

```python
class BaseAgent(ABC):
    def __init__(self):
        self.name = self._get_agent_name()
        self.model_tier = AGENT_MODELS.get(self.name, "flash")
        self.model_id = MODELS[self.model_tier]
        self.client = GeminiClient(self.model_id)

    @abstractmethod
    def _get_agent_name(self) -> str: ...

    @abstractmethod
    def _get_system_prompt(self) -> str: ...

    async def review(self, diff: str, context: dict) -> AgentExecutionResult:
        # Timeout chain: config → agent → api (always -5s buffer)
        agent_timeout = AGENT_TIMEOUTS.get(self.name, AGENT_TIMEOUT)
        api_timeout = agent_timeout - 5  # 5s buffer for retry overhead

        try:
            response = await self.client.review(prompt=..., timeout=api_timeout)
            report = AgentReport(**response)  # Pydantic validation
            return AgentExecutionResult(state=ExecutionState.OK, report=report.model_dump(), ...)

        except asyncio.TimeoutError:
            return AgentExecutionResult(state=ExecutionState.TIMEOUT, ...)
        except json.JSONDecodeError:
            return AgentExecutionResult(state=ExecutionState.PARSE_ERROR, ...)
        except Exception:
            return AgentExecutionResult(state=ExecutionState.PROVIDER_ERROR, ...)
```

**Rules:**
- Every agent must inherit `BaseAgent`. Never implement `review()` from scratch in a subclass — only override `_get_agent_name()` and `_get_system_prompt()`.
- `api_timeout = agent_timeout - 5` is the invariant. If you add a new agent and set its timeout in `AGENT_TIMEOUTS`, the 5s buffer is applied automatically — do not re-apply it manually in the client call.
- Return `AgentExecutionResult` with explicit `ExecutionState` — never return raw dicts, never raise from `review()`. Callers aggregate results by state; an unhandled exception breaks the aggregation.
- Validate all agent output through the Pydantic `AgentReport` model before returning `OK` state.

---

## 3. Timeout Chain (The Prior Incident Rule)

The original incident: agents had a default timeout hardcoded in the API client, but the orchestrator set a different timeout in config. The two values got out of sync — the API timed out first but the agent timeout hadn't fired, leaving the system in a hung state for 40% of reviews.

**The fix — a propagation chain with validation:**

```
config.py (AGENT_TIMEOUTS)
    → BaseAgent.review() (agent_timeout = AGENT_TIMEOUTS[name])
        → api_timeout = agent_timeout - 5
            → GeminiClient.review(timeout=api_timeout)
```

```python
# config.py — AGENT_TIMEOUTS is the single source of truth
AGENT_TIMEOUTS = {
    "security":    90,   # Gemini Pro + comprehensive review
    "backend":     60,   # Flash, complex Edge Function analysis
    "frontend":   120,   # Flash, large React/Next.js diffs frequently exceed 70s
    "performance": 90,
    "ui_ux":       70,
    "devops":      60,
}
AGENT_TIMEOUT = 60  # Default for any agent not in AGENT_TIMEOUTS
```

**Rules:**
- Minimum timeout: 10s (raise `ValueError` if lower). Maximum: 180s (log warning).
- Base timeouts on **observed p95 latency + ≥20s margin**. Never guess.
- Adding a new agent requires adding its timeout to `AGENT_TIMEOUTS` before it goes to production. A new agent that uses the default 60s timeout may time out under realistic diff sizes.
- Never hardcode `timeout=30` in a GeminiClient call. Always propagate from config.

---

## 4. Aggregation Weights

```python
# config.py — weights must sum to 1.0
WEIGHTS = {
    "security":    0.25,  # Highest — privacy compliance product
    "backend":     0.20,
    "frontend":    0.15,
    "performance": 0.15,
    "devops":      0.15,
    "ui_ux":       0.10,
}
```

**Rules:**
- Weights must sum exactly to 1.0. The aggregator normalizes dynamically based on which agents are active (skipped/unavailable agents have their weight redistributed), but the base weights must sum to 1.0 in config.
- Security agent is always the highest weight — this is a compliance product. Do not reduce it below the second-highest weight without explicit product approval.
- Any weight change requires updating this config AND updating the comment documentation explaining the rationale.

---

## 5. Smart Routing — Only Dispatch Relevant Agents

```python
# config.py — ROUTING_RULES determines which agents see which diffs
ROUTING_RULES = {
    "example_saas_backend-dashboard/src/components/**": ["frontend", "ui_ux", "performance"],
    "supabase/functions/**":               ["backend", "security", "devops"],
    "supabase/migrations/**":              ["backend", "devops", "security"],
    "*.env*":                              ["security", "devops"],
    "**":                                  ["backend", "frontend", "ui_ux", "security", "performance", "devops"],
}
```

**Rules:**
- Only dispatch agents that are relevant to the changed file types. Dispatching all agents for a CSS-only change wastes quota and increases latency.
- The `**` fallback always dispatches all agents. Narrower patterns above it take priority.
- Adding a new agent requires adding it to the relevant routing rules — a new `compliance` agent that is never dispatched does nothing.

---

## 6. Context Budgeting

Large diffs cause API timeouts. The system truncates diffs per-agent based on observed limits:

```python
# config.py
CONTEXT_BUDGETS = {
    "security":    {"max_diff_bytes": 100_000, "max_hunks": 50},
    "frontend":    {"max_diff_bytes": 120_000, "max_hunks": 60},  # large React diffs
    "backend":     {"max_diff_bytes":  80_000, "max_hunks": 40},
    "devops":      {"max_diff_bytes":  60_000, "max_hunks": 30},
}

# Excluded from all diffs — no review value, bloats payload
EXCLUDED_PATTERNS = [
    "*lock*", "*.min.js", "*.min.css", "dist/*", "build/*",
    ".next/*", "node_modules/*", "__pycache__/*", "*.pyc", "*.map",
]
```

**Rules:**
- Always exclude generated/build artifacts before sending a diff to agents. Lock files and minified bundles add tokens but zero review signal.
- When an agent's diff is truncated, inject a `CONTEXT BUDGET NOTICE` section into the prompt explaining what was omitted and why.
- If an agent keeps timing out on realistic diffs, the first diagnostic step is checking whether its `max_diff_bytes` limit is correctly set.

---

## 7. Learning Pipeline Guardrails (Always Locked)

The learning pipeline (Phase 3c) allows agents to propose modifications to their own prompts based on build failure patterns. These guardrails are **always locked in production**:

```python
# config.py — these must remain False unless explicitly authorized
FEATURE_FLAGS = {
    "learning_modifications_enabled": False,  # enables modification generation
    "learning_auto_apply":            False,  # enables auto-apply after approval
    "ci_learning_hook_mode":          "dry_run",  # off | dry_run | canary | enabled
}
```

**Why they are locked:** Prior to the guardrails, an experimental run auto-applied a security agent prompt modification that changed severity classification behavior. The modification passed approval but caused the security agent to downgrade real vulnerabilities for two weeks before the regression was caught via the regression test suite.

**Rules:**
- Never flip `learning_modifications_enabled` or `learning_auto_apply` to `True` without explicit authorization and a regression test gate passing clean.
- The CI learning hook (`ci_learning_hook_mode`) must be `dry_run` or `off` — never `enabled` in production without a formal rollout plan.
- `prompt_regression_tests_enabled` must remain `True`. It is the safety net that catches behavioral regressions before they reach production.
- Any code that touches these flags is HIGH blast radius — treat like a production config change.

---

## 8. Execution States and the Aggregator

The aggregator collects `AgentExecutionResult` objects and computes a weighted score. Agents that return non-`OK` states are handled gracefully:

```python
class ExecutionState(str, Enum):
    OK             = "ok"
    TIMEOUT        = "timeout"
    PARSE_ERROR    = "parse_error"
    PROVIDER_ERROR = "provider_error"
    SKIPPED        = "skipped"
```

- `OK` — contributes to weighted score normally
- `TIMEOUT` / `PROVIDER_ERROR` — marked as unavailable; weight redistributed to active agents
- `PARSE_ERROR` — logged with the raw response; weight redistributed
- `SKIPPED` — routing determined this agent is irrelevant; excluded from aggregation

**SLO gates:** If any agent's unavailability rate across a consensus run exceeds 34%, the aggregator emits `NEEDS_REVISION` rather than approving. This prevents approving code when the review was fundamentally incomplete.

---

## 9. Quality Guards and Consolidation

```python
# config.py
QUALITY_GUARDS = {
    "downgrade_without_evidence_min_severity": "MEDIUM",
    "downgrade_confidence_threshold":          0.85,
    "warn_on_medium_issue_count":              2,
}

CONSOLIDATION_THRESHOLDS = {
    "same_location_similarity": 0.23,  # same file + same line dedup threshold
    "same_type_similarity":     0.78,
    "max_line_distance":         2,
}
```

**Rules:**
- MEDIUM/HIGH/CRITICAL findings below 0.85 confidence with no supporting evidence are automatically downgraded to LOW. This suppresses speculative warnings without removing high-confidence findings.
- Duplicate detection uses similarity thresholds, not exact matching. Two agents flagging the same line with slightly different wording are merged into one consolidated finding.
- Never remove the consolidation step — without it, six agents produce six reports with significant overlap, overwhelming the consumer.

---

## 10. Adding a New Agent (Checklist)

Before submitting a new agent:

- [ ] File: `agents/{name}_agent.py` inheriting `BaseAgent`
- [ ] `AGENT_MODELS["{name}"]` set in `config.py` (flash/pro/lite)
- [ ] `AGENT_TIMEOUTS["{name}"]` set in `config.py` (based on p95 test, not a guess)
- [ ] `WEIGHTS["{name}"]` added and all weights re-normalized to sum 1.0
- [ ] `ROUTING_RULES` updated with relevant path patterns for the new agent
- [ ] `CONTEXT_BUDGETS["{name}"]` set if the agent has different payload tolerance
- [ ] Pytest test in `scanners/tests/` covering at least: OK result, TIMEOUT result, output schema validation
- [ ] Regression test golden diff added covering the new agent's domain
