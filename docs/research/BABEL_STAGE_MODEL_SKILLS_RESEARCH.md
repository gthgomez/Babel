<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE
-->


<!--
status: ACTIVE
last_verified: 2026-07-03
-->
# Babel Stage Model Research

This note captures two things:

1. What each active Babel CLI stage model is officially positioned for.
2. Whether Babel can support stage-specific skills keyed by the model used at that stage.

## Model Fit

| Model | Current Babel use | Official positioning | Babel fit |
|-------|-------------------|----------------------|-----------|
| `Step 3.5 Flash` | Orchestrator first, planning/QA rescue, executor fallback | StepFun describes it as a flagship reasoning model for deep logic, tool calls, advanced software engineering, long-context agents, and large datasets, with 256K context and native agent capabilities. Source: https://platform.stepfun.ai/docs/en/llm/reasoning | Good for Stage 1 structured routing and cheap recovery lanes where fast JSON plus tool-awareness matter more than maximal judgment depth. |
| `MiniMax M2.5` | Planning primary, QA secondary | MiniMax positions M2.5 as SOTA in coding and agent work, trained in large numbers of real-world environments, with strong spec-writing, search/tool use, and multilingual coding results. Source: https://www.minimax.io/news/minimax-m25 and https://www.minimax.io/models/text | Strongest fit for Stage 2 planning, because Babel wants explicit decomposition, software-architect behavior, and efficient multi-step task shaping before execution. |
| `Nemotron 3 Super` | QA primary, orchestrator second, executor fallback | NVIDIA positions Nemotron 3 Super as an open hybrid MoE model with up to 1M context, optimized for agentic reasoning, coding, planning, tool calling, collaborative agents, and long-context reasoning. Source: https://build.nvidia.com/nvidia/nemotron-3-super-120b-a12b and https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-FP8 | Strong fit for Stage 3 QA because long context, reasoning control, and adversarial review pair well with cold-plan inspection and failure finding. |
| `Qwen3-32B` | Executor primary | Qwen describes Qwen3 as a hybrid thinking/non-thinking family with improved coding and agentic capabilities, MCP support, and 128K context for the 32B dense model. Source: https://qwenlm.github.io/blog/qwen3/ | Good Stage 4 executor fit because Babel wants cheap, controllable, structured tool-call turns, and executor work benefits from switching between quick response and deeper reasoning. |
| `DeepSeek V3.2` | Last-resort fallback for all stages, escalation alias | DeepSeek positions V3.2 as an efficient reasoning and agentic model with long-context optimization, scalable RL, and explicit “thinking with tools” support. Source: https://huggingface.co/deepseek-ai/DeepSeek-V3.2 | Good general fallback because it is broad, tool-aware, and comparatively cheap, but its custom chat/template requirements make it better as a controlled fallback than the first-choice lane. |

## Architecture Reality

| Area | What the code does now | Impact on stage/model-specific skills |
|------|-------------------------|---------------------------------------|
| Stack resolution | Babel resolves one shared typed `instruction_stack` into one compiled `prompt_manifest` before Stage 2 planning begins. | Skills currently belong to the task stack, not to an individual runtime stage or backend model. |
| Stage 2 planning | The SWE agent compiles from `manifest.prompt_manifest`, which comes from the resolved task stack. | Planning is the easiest place to add model-aware skill guidance because it already consumes the compiled stack. |
| Stage 3 QA | QA compiles from fixed `QA_PATHS`, not from the resolved task stack. | A normal skill added to the task stack will not automatically reach QA today. |
| Stage 4 executor | Executor compiles from fixed `EXECUTOR_PATHS`, then runs a turn loop. | A normal skill added to the task stack will not automatically reach executor today. |
| Model selection timing | Worker model policy is resolved in the pipeline at runtime after the orchestrator emits the stack. | The router does not currently know the exact backend runner when selecting skills, so “skill by concrete backend model” is not first-class. |

## Can Babel Add Stage-Specific Skills?

Yes, but not cleanly with the current skill model alone.

### What works today with minimal change

| Option | Feasibility | Notes |
|--------|-------------|-------|
| Add planning-only guidance as ordinary skills | `High` | Because Stage 2 already uses the resolved task stack. This is the most natural first slice. |
| Add QA/executor guidance by editing `QA_Adversarial_Reviewer-v1.0.md` and `CLI_Executor-v1.0.md` directly | `High` | Works immediately, but it is stage prompt authoring, not true skill composition. |
| Add stage-specific entries as new `pipeline_stage` dependencies in the catalog/resolver | `Medium` | This is the cleanest path if Babel wants reusable stage add-ons without overloading ordinary task skills. |

### What does not fit cleanly today

| Idea | Why it does not fit cleanly yet |
|------|---------------------------------|
| Route ordinary skills by exact backend model (`step-3.5-flash`, `Qwen3-32B`, etc.) | The orchestrator selects adapters, not concrete backend runners, and the final backend is resolved later by runtime policy/waterfall. |
| Expect one task skill to automatically follow a prompt through planning, QA, and executor | QA and executor do not compile from `manifest.prompt_manifest`; they use dedicated stage prompt files. |

## Recommended Design

| Priority | Recommendation | Why |
|----------|----------------|-----|
| `1` | Keep ordinary skills task/domain-focused. | This preserves Babel's current layer discipline and avoids binding general skills to volatile backend choices. |
| `2` | Introduce reusable stage add-ons as a new pattern under `pipeline_stage` composition, not as ordinary skills. | QA and executor already behave like special stages with dedicated prompts, so stage-targeted add-ons fit there better. |
| `3` | If model-aware behavior is needed, bind it to capability classes, not exact model names. | Example classes: `fast_structured_json`, `adversarial_reviewer`, `tool_call_executor`, `long_context_reasoner`. This survives waterfall changes better than hard-coding model IDs into skill routing. |
| `4` | Treat exact backend-specific tuning as runtime metadata, not catalog skill selection. | The concrete runner can change by policy, fallback, or outage, so catalog-level hard-coding would be brittle. |

## Practical Next Step

If we want to test this idea safely, the lowest-risk prototype is:

1. Add a small `pipeline_stage` companion for QA.
2. Add a small `pipeline_stage` companion for executor.
3. Extend the resolver so pipeline stages can declare additive dependencies, similar to how skills expand dependencies today.
4. Keep model policy separate, but allow a stage prompt to read capability flags such as `fast_json_bias=true` or `adversarial_depth=high` derived from the selected stage lane.

That would let Babel gain reusable stage-specific guidance without breaking the current domain/skill model or tying the system to one vendor/model name forever.
