# Getting Started with OLS Compiler v4.5

**Quick practical guide** for using the new programmatic optimization and dynamic alignment features.

## 1. When Should You Use v4.5 Features?

| Situation                              | Recommended Module                  | Why |
|----------------------------------------|-------------------------------------|-----|
| High-reuse prompt or agent             | Signature + Optimizer              | Measurable quality & cost wins |
| Conversational / multi-turn agent      | Dynamic Alignment Engine           | Better consistency, less bloat |
| Complex stateful multi-agent system    | Enhanced Multi-Agent + Dynamic     | Control + runtime coherence |
| Improving the meta-tools themselves    | Optimizer (with strict rules)      | Self-improvement with safety |

**Rule of thumb**: Start with **one** module. Combine only when you genuinely need both automated evolution *and* runtime dynamic behavior.

## 2. Example 1: Optimize a Reusable Prompt (Signature + Optimizer)

**Goal**: Improve a compliance evidence extractor prompt used frequently in GPCGuard.

**Step-by-step**:

1. Request optimization from ols-compiler:
   > "Use v4.5 Signature + Optimizer on this compliance evidence extractor prompt. Here is a small set of 8 labeled examples and the metric: evidence_completeness + factual_accuracy."

2. The compiler will:
   - Convert your prompt into a `Signature`
   - Run the Reflection Optimizer
   - Return an optimized version + before/after comparison + suggested eval contract

3. Review the output (it will be marked `[INFERRED]` until you validate it).

**Expected outcome**: Clearer instructions, better few-shot examples, and measurable improvement on your eval set.

## 3. Example 2: Add Runtime Dynamic Alignment

**Goal**: Make a customer-facing compliance agent more consistent without making the system prompt huge.

**How**:

- Ask ols-compiler to compile the agent prompt with the **Dynamic Alignment Engine** enabled.
- Define key guidelines as condition → action pairs (e.g., "If user mentions financial terms → use technical depth and cite sources").
- The engine will automatically inject only the relevant guidelines at runtime.

**Benefit**: Much better consistency on edge cases while keeping the static prompt shorter and more maintainable.

## 4. Example 3: Self-Application (Advanced)

You can apply the Optimizer to improve parts of OLS itself.

**Requirements** (strictly enforced):
- Must use `FULL_DIAGNOSTIC` output mode
- Requires explicit human approval
- Must produce full audit trail
- Final change must be reviewed by `skill-auditor`

**Recommendation**: Only do this for non-critical sections first (e.g., example prompts or documentation), never on Authority Order or safety rules.

## 5. Quick Activation Commands

When talking to ols-compiler, you can say:

- "Activate v4.5 Signature + Optimizer..."
- "Compile this with Dynamic Alignment enabled..."
- "Use the v4.5 multi-agent patterns for this supervisor..."

The compiler will automatically load `ols-mcc-v4.5.md` when these are detected.

## 6. Next Actions

1. Pick one high-frequency prompt or agent you use often.
2. Try the **Signature + Optimizer** first — it usually gives the biggest immediate win.
3. Once comfortable, experiment with **Dynamic Alignment** on conversational flows.

---

*Part of the OLS Compiler v4.5 Hardened Release*