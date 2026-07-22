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

This skill covers reusable patterns for multi-agent code-review pipelines. Project overlays supply implementation-specific modules, providers, thresholds, and policy. It applies whenever building or modifying:

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
        self.model_id = model_policy.for_agent(self.name)
        self.client = ProviderClient(self.model_id)
        self.deadlines = deadline_policy.for_agent(self.name)

    @abstractmethod
    def _get_agent_name(self) -> str: ...

    @abstractmethod
    def _get_system_prompt(self) -> str: ...

    async def review(self, diff: str, context: dict) -> AgentExecutionResult:
        # Provider and outer deadlines come from one validated policy.
        provider_timeout = self.deadlines.provider
        outer_timeout = self.deadlines.outer

        try:
            response = await asyncio.wait_for(
                self.client.review(prompt=..., timeout=provider_timeout),
                timeout=outer_timeout,
            )
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
- The outer deadline must exceed the provider deadline by a configured cleanup margin. Validate this relationship at startup.
- Return `AgentExecutionResult` with explicit `ExecutionState` — never return raw dicts, never raise from `review()`. Callers aggregate results by state; an unhandled exception breaks the aggregation.
- Validate all agent output through the Pydantic `AgentReport` model before returning `OK` state.

---

## 3. Deadline Propagation

Use one validated policy for the provider deadline, outer deadline, and cleanup margin:

```
deadline policy
    → BaseAgent.review()
        → provider request deadline
        → outer cancellation deadline
```

**Rules:**
- Derive deadlines from measured latency and payload size; do not publish or copy environment-specific values into this skill.
- Reject invalid or missing deadline relationships during configuration validation.
- Adding an agent requires a measured deadline policy before release.
- Never hardcode a provider deadline at a call site.

---

## 4. Aggregation Weights

```python
weights = weight_policy.for_enabled_agents()
assert math.isclose(sum(weights.values()), 1.0)
```

**Rules:**
- Configured weights must sum to 1.0 before dispatch.
- Normalize only across enabled, successful agents.
- Weight priority is a project policy backed by risk analysis, tests, and approval; this generic skill does not prescribe product-specific values.

---

## 5. Smart Routing — Only Dispatch Relevant Agents

```python
ROUTING_RULES = {
    "web/components/**": ["frontend", "accessibility", "performance"],
    "service/**":        ["backend", "security"],
    "migrations/**":     ["backend", "security", "operations"],
    "*.env*":            ["security", "operations"],
    "**":                enabled_agents,
}
```

**Rules:**
- Only dispatch agents that are relevant to the changed file types. Dispatching all agents for a CSS-only change wastes quota and increases latency.
- The `**` fallback always dispatches all agents. Narrower patterns above it take priority.
- Adding a new agent requires adding it to the relevant routing rules — a new `compliance` agent that is never dispatched does nothing.

---

## 6. Context Budgeting

Large diffs can exceed provider limits. Define per-agent context budgets from observed payload tolerance and exclude generated artifacts through project configuration.

**Rules:**
- Always exclude generated/build artifacts before sending a diff to agents. Lock files and minified bundles add tokens but zero review signal.
- When an agent's diff is truncated, inject a `CONTEXT BUDGET NOTICE` section into the prompt explaining what was omitted and why.
- If an agent repeatedly times out, compare its configured context budget with measured provider latency and payload limits.

---

## 7. Learning Pipeline Guardrails

If a project allows agents to propose prompt changes, proposal generation and automatic application must be separate, independently governed capabilities:

```python
# config.py — these must remain False unless explicitly authorized
FEATURE_FLAGS = {
    "learning_modifications_enabled": False,  # enables modification generation
    "learning_auto_apply":            False,  # enables auto-apply after approval
    "ci_learning_hook_mode":          "dry_run",  # off | dry_run | canary | enabled
}
```

**Rules:**
- Never flip `learning_modifications_enabled` or `learning_auto_apply` to `True` without explicit authorization and a regression test gate passing clean.
- Keep CI learning hooks non-mutating unless a reviewed rollout explicitly authorizes another mode.
- `prompt_regression_tests_enabled` must remain `True`. It is the safety net that catches behavioral regressions before they reach production.
- Treat changes to these controls as high blast radius.

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

**Coverage gate:** Emit `NEEDS_REVISION` when successful reviewer coverage falls below the project-configured, evidence-backed minimum.

---

## 9. Quality Guards and Consolidation

**Rules:**
- Require evidence before retaining elevated severity; derive confidence policy from calibrated project tests.
- Consolidate overlapping findings with a tested, project-configured policy.
- Never remove the consolidation step — without it, six agents produce six reports with significant overlap, overwhelming the consumer.

---

## 10. Adding a New Agent (Checklist)

Before submitting a new agent:

- [ ] File: `agents/{name}_agent.py` inheriting `BaseAgent`
- [ ] Model policy configured through the project provider abstraction
- [ ] Deadline policy based on measured latency
- [ ] `WEIGHTS["{name}"]` added and all weights re-normalized to sum 1.0
- [ ] `ROUTING_RULES` updated with relevant path patterns for the new agent
- [ ] `CONTEXT_BUDGETS["{name}"]` set if the agent has different payload tolerance
- [ ] Tests cover at least: OK result, timeout result, and output-schema validation
- [ ] Regression test golden diff added covering the new agent's domain
