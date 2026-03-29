<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Coding Assistant Prompt Improvement Research Plan

**Version:** 1.0  
**Date:** 2026-02-03  
**Purpose:** Systematic research, validation, and testing of prompt improvements before production deployment

---

## EXECUTIVE SUMMARY

This document provides a structured research plan to enhance a senior software engineer coding assistant prompt by incorporating validated best practices from:
- Battle-tested public prompts (Cursor, Cline, Aider)
- OLS v4.1 specialized production system
- Industry research on AI-assisted coding (2025-2026)

**Research Goal:** Identify, validate, and test 15+ specific improvements across 7 key dimensions before committing to production.

---

## SECTION 1: CURRENT STATE BASELINE

### What Exists Now

The current prompt is a **Senior Software Engineer** system prompt with:

**Strengths:**
- ✅ Context awareness behavior (explicit clearing guidance)
- ✅ Assumption surfacing with template format
- ✅ Confusion management with STOP protocol
- ✅ Test-first leverage patterns
- ✅ Scope discipline (surgical precision)
- ✅ 16 explicit failure modes
- ✅ Self-review behavior
- ✅ Documentation sync requirements
- ✅ Verification loops

**Architecture:**
- XML-based structure
- Priority levels (critical/high/medium)
- Behavior-focused (not just standards)
- Human-only output mode
- ~4,000 tokens estimated

**Target Use Case:**
- Supervised agentic coding
- Human monitoring in IDE
- 80/20 split (80% agent-driven, 20% human oversight)
- Production-quality code generation

---

## SECTION 2: IDENTIFIED IMPROVEMENT OPPORTUNITIES

### Category A: Workflow Architecture (CRITICAL)

#### A1. PLAN/ACT Mode Separation
**Source:** Cline system prompt  
**Priority:** HIGH  
**Status:** Missing from current prompt

**What It Is:**
Explicit separation between planning (read-only exploration) and execution (code changes).

**Research Questions:**
1. How does Cline implement PLAN/ACT mode technically?
2. What are the failure modes when planning and execution are mixed?
3. How do users trigger mode switches in practice?
4. Does this reduce iterations/rework compared to always-execute approach?
5. What's the optimal default mode (plan-first vs. act-first)?

**Validation Criteria:**
- [ ] Find 3+ real-world examples of PLAN/ACT usage
- [ ] Identify when planning-first hurts velocity (overhead cases)
- [ ] Define clear mode-switch triggers
- [ ] Document how to handle ambiguous requests

**Testing Strategy:**
```
TEST SCENARIO 1: Complex feature request
- Current: Agent immediately proposes code
- With PLAN/ACT: Agent explores, plans, then asks for ACT mode
- Measure: # of iterations, time to correct solution

TEST SCENARIO 2: Simple bug fix
- Current: Fix immediately
- With PLAN/ACT: Would planning add overhead?
- Measure: Time to resolution

TEST SCENARIO 3: Unclear requirements
- Current: Agent guesses and implements
- With PLAN/ACT: Agent plans, asks questions, clarifies
- Measure: # of misunderstandings caught early
```

**Integration Design:**
```xml
<operational_modes>
  <mode name="plan">
    [RESEARCH: How to describe plan mode behavior]
  </mode>
  <mode name="act">
    [RESEARCH: How to describe act mode behavior]
  </mode>
</operational_modes>
```

**Decision Point:**
- [ ] Include always (default plan-first)
- [ ] Include as optional (user triggers)
- [ ] Exclude (overhead not worth it)

---

#### A2. Exploration Phase Pattern
**Source:** Cline's "agentic exploration"  
**Priority:** MEDIUM  
**Status:** Implicit in current prompt, not explicit

**What It Is:**
Agent autonomously explores codebase before proposing changes (reads files, understands patterns, identifies conventions).

**Research Questions:**
1. What specific behaviors constitute "exploration"?
2. When does exploration help vs. create overhead?
3. How many files should agent read before claiming understanding?
4. How to prevent exploration from becoming aimless wandering?
5. Should exploration be automatic or user-triggered?

**Validation Criteria:**
- [ ] Find examples of exploration preventing mistakes
- [ ] Find examples of exploration wasting time
- [ ] Define optimal exploration scope (how many files?)
- [ ] Create exploration stopping conditions

**Testing Strategy:**
```
TEST SCENARIO 1: New codebase
- Prompt: "Add authentication"
- Without exploration: Agent guesses patterns
- With exploration: Agent reads auth examples first
- Measure: Pattern consistency, errors

TEST SCENARIO 2: Familiar codebase
- Prompt: "Fix typo in login.ts"
- Without exploration: Fix immediately
- With exploration: Reads multiple files first
- Measure: Unnecessary overhead?

TEST SCENARIO 3: Multi-file refactor
- Prompt: "Rename User to Account everywhere"
- Without exploration: Misses references
- With exploration: Maps all dependencies
- Measure: Completeness
```

**Integration Design:**
```xml
<pattern name="agentic_exploration">
  [RESEARCH: When to trigger, how to scope, stopping conditions]
</pattern>
```

**Decision Point:**
- [ ] Add as explicit phase before implementation
- [ ] Add as implicit guidance ("explore before changing")
- [ ] Exclude (existing guidance sufficient)

---

### Category B: Intelligence Systems (HIGH VALUE)

#### B1. Breaking Change Detection Protocol (BCDP)
**Source:** OLS v4.1  
**Priority:** HIGH (if applicable to project types)  
**Status:** Not in current prompt

**What It Is:**
Automated detection of type contract violations, schema mismatches, breaking changes BEFORE deployment.

**Research Questions:**
1. Is this specific to TypeScript + PostgreSQL or generalizable?
2. What's the minimum viable BCDP (simplified version)?
3. Can this work without explicit `/verify-types` command?
4. How to implement for non-schema-driven apps (React SPAs, CLIs)?
5. What are the false positive rates?

**Validation Criteria:**
- [ ] Identify which project types benefit most
- [ ] Find simplified versions that work without TCV automation
- [ ] Determine if manual checking guidance is sufficient
- [ ] Test if LLMs can detect breaking changes without formal protocol

**Testing Strategy:**
```
TEST SCENARIO 1: Schema change
- Task: "Add new column to database table"
- Current: Agent generates migration, might miss frontend impact
- With BCDP: Agent checks frontend types first
- Measure: Breaking changes caught before execution

TEST SCENARIO 2: API contract change
- Task: "Add required parameter to endpoint"
- Current: Agent adds parameter, breaks existing callers
- With BCDP: Agent identifies all call sites first
- Measure: Call sites identified correctly

TEST SCENARIO 3: Non-schema project (CLI tool)
- Task: "Change command-line argument format"
- With BCDP: Does it help or add overhead?
- Measure: Relevance to project type
```

**Integration Options:**

**Option A: Full BCDP (OLS-style)**
```xml
<protocol name="breaking_change_detection">
  [8-step workflow from OLS v4.1]
</protocol>
```

**Option B: Lightweight Guidance**
```xml
<behavior name="breaking_change_awareness">
Before changing interfaces, contracts, or schemas:
1. Identify all consumers of the changed component
2. Check if change is backward compatible
3. List breaking changes explicitly
4. Propose migration strategy
</behavior>
```

**Option C: Project-Type Conditional**
```xml
<conditional trigger="typescript + database">
  [Enable full BCDP]
</conditional>
<conditional trigger="other">
  [Enable lightweight guidance]
</conditional>
```

**Decision Point:**
- [ ] Include full BCDP (8-step protocol)
- [ ] Include lightweight version (4-step awareness)
- [ ] Include as optional enhancement (advanced users)
- [ ] Exclude (too specialized)

---

#### B2. Edge Case Analysis Framework (NAMIT)
**Source:** OLS v4.1  
**Priority:** MEDIUM  
**Status:** Not in current prompt

**What It Is:**
Systematic coverage of edge cases using mnemonic:
- **N**ull/missing data
- **A**rray boundaries (empty, single, overflow)
- **M**ultiplication (race conditions, concurrency)
- **I**nput validation (injection, type coercion)
- **T**iming (async, TTL, expiry)

**Research Questions:**
1. Does this improve edge case coverage measurably?
2. Is NAMIT better than generic "consider edge cases" guidance?
3. Are there edge case categories missing from NAMIT?
4. When does systematic analysis add overhead vs. value?
5. Can LLMs apply this without explicit prompting?

**Validation Criteria:**
- [ ] Compare edge case coverage with vs. without NAMIT
- [ ] Find research on systematic vs. ad-hoc edge case analysis
- [ ] Identify if NAMIT is domain-specific (backend vs. frontend)
- [ ] Test if simplified version works as well

**Testing Strategy:**
```
TEST SCENARIO 1: API endpoint
- Task: "Create user registration endpoint"
- Without NAMIT: Agent considers some edge cases
- With NAMIT: Agent systematically checks N-A-M-I-T
- Measure: Edge cases caught

TEST SCENARIO 2: Pure algorithm
- Task: "Implement binary search"
- Without NAMIT: Standard edge cases (empty array, not found)
- With NAMIT: Over-analysis?
- Measure: Overhead vs. value

TEST SCENARIO 3: Complex state machine
- Task: "Handle payment flow"
- Without NAMIT: Misses race conditions
- With NAMIT: Catches M (multiplication) issues
- Measure: Critical bugs prevented
```

**Integration Options:**

**Option A: Full NAMIT Framework**
```xml
<framework name="NAMIT_edge_cases">
For each implementation, systematically check:
- N: Null/missing data (undefined, null, empty string)
- A: Array boundaries (empty [], single [x], overflow)
- M: Multiplication (race conditions, concurrent access)
- I: Input validation (injection, type coercion, malformed)
- T: Timing (async, timeouts, TTL, expiry)
</framework>
```

**Option B: Embedded in Test-First**
```xml
<pattern name="test_first_with_edge_cases">
When writing tests, include edge cases for:
- Null/empty/missing inputs
- Boundary conditions (min/max/empty/overflow)
- Concurrent access scenarios
- Invalid/malicious inputs
- Timing-dependent behavior
</pattern>
```

**Decision Point:**
- [ ] Include full NAMIT framework with mnemonic
- [ ] Include simplified edge case checklist
- [ ] Embed in existing test-first pattern
- [ ] Exclude (generic guidance sufficient)

---

#### B3. Confidence Scoring
**Source:** Cline, OLS v4.1  
**Priority:** MEDIUM  
**Status:** Not in current prompt

**What It Is:**
Agent explicitly rates confidence (1-10 or categorical) for complex decisions, making uncertainty visible.

**Research Questions:**
1. Do confidence scores improve human oversight decisions?
2. What granularity works best (1-10 vs. categorical)?
3. Should confidence be required for all responses or just complex ones?
4. How to prevent agents from always saying "10/10" to appear confident?
5. Do calibrated confidence scores (learning from errors) work in practice?

**Validation Criteria:**
- [ ] Find research on AI confidence calibration effectiveness
- [ ] Identify situations where confidence scoring adds value
- [ ] Test if explicit confidence changes human review behavior
- [ ] Determine optimal confidence scale

**Testing Strategy:**
```
TEST SCENARIO 1: Uncertain diagnosis
- Task: "Why is this API failing?"
- Without confidence: Agent gives answer (seems certain)
- With confidence: "Likely the rate limit (6/10), but could be auth (4/10)"
- Measure: Does human verify more carefully?

TEST SCENARIO 2: Standard implementation
- Task: "Add CRUD endpoints"
- Without confidence: Agent implements
- With confidence: "High confidence (9/10) this follows standard patterns"
- Measure: Does confidence match actual correctness?

TEST SCENARIO 3: Novel problem
- Task: "Integrate with obscure legacy system"
- Without confidence: Agent proposes solution (untested)
- With confidence: "Low confidence (3/10), recommend prototyping first"
- Measure: Prevents premature commitment
```

**Integration Options:**

**Option A: Mandatory Confidence (Cline-style)**
```xml
<standard name="confidence_expression">
For non-trivial decisions, include confidence rating:
"I'm implementing X with confidence 8/10. Uncertainty is around Y because Z."

Scale:
- 9-10: VERIFIED (tested/documented evidence)
- 7-8: LIKELY (strong inference, standard patterns)
- 5-6: UNCERTAIN (educated guess, verify)
- 1-4: SPECULATIVE (low confidence, needs validation)
</standard>
```

**Option B: Epistemic Tagging (OLS-style)**
```xml
<standard name="epistemic_tagging">
Tag statements with evidence level:
- [CERTAIN] — Direct evidence (saw code/docs)
- [VERIFIED] — Tested and confirmed
- [LIKELY] — High confidence inference
- [SPECULATIVE] — Educated guess
- [UNKNOWN] — Cannot determine
</standard>
```

**Option C: Selective (Trigger-Based)**
```xml
<behavior name="express_uncertainty">
When answering complex questions or making architectural decisions:
- State your confidence level
- Explain the source of uncertainty
- Suggest verification steps

Don't use for routine implementations.
</behavior>
```

**Decision Point:**
- [ ] Mandatory confidence scores (1-10 scale)
- [ ] Epistemic tagging ([VERIFIED], [LIKELY], etc.)
- [ ] Selective confidence (complex decisions only)
- [ ] Exclude (adds overhead)

---

#### B4. Root Cause Tracing (RCT)
**Source:** OLS v4.1  
**Priority:** LOW (requires cross-session memory)  
**Status:** Not in current prompt

**What It Is:**
When bugs occur: Bug → What instruction was missing/wrong? → Add instruction to prevent recurrence.

**Research Questions:**
1. Can this work without persistent memory across sessions?
2. Is within-session learning sufficient (session-level RCT)?
3. How to implement without modifying the system prompt itself?
4. Does human recording RCT lessons work as well?
5. What's the ROI on RCT vs. just fixing bugs?

**Validation Criteria:**
- [ ] Determine if session-level RCT has value
- [ ] Identify practical implementation without prompt modification
- [ ] Test if explicit RCT changes debugging behavior
- [ ] Find examples of RCT preventing bug classes

**Testing Strategy:**
```
TEST SCENARIO 1: Repeated mistake
- Bug: Agent forgets to handle null case
- Without RCT: Fix bug, move on
- With RCT: "Missing instruction: Always check null before access"
- Measure: Does agent remember within session?

TEST SCENARIO 2: Cross-session learning
- Session 1: Bug + RCT analysis
- Session 2: Similar situation
- Measure: Can't test without persistent memory

TEST SCENARIO 3: Human-recorded RCT
- Bug occurs → Human adds to project notes
- Next session: Human references notes
- Measure: Workaround effectiveness
```

**Integration Options:**

**Option A: Within-Session RCT**
```xml
<behavior name="root_cause_tracing">
When fixing bugs:
1. Fix the immediate issue
2. Identify what instruction/check was missing
3. State: "Root cause: [missing instruction]"
4. Apply that pattern to similar code in this session

This improves within-session consistency.
</behavior>
```

**Option B: Human-Directed RCT**
```xml
<behavior name="bug_learning">
After fixing a bug, suggest:
"Add to project notes: [lesson learned] to prevent recurrence"

This helps maintain a bug prevention knowledge base.
</behavior>
```

**Decision Point:**
- [ ] Include within-session RCT
- [ ] Include human-directed RCT (suggest note-taking)
- [ ] Exclude (limited value without persistence)

---

### Category C: Output and Communication (MEDIUM)

#### C1. Dual Output Mode (Human/Agent)
**Source:** OLS v4.1 AACL  
**Priority:** LOW (unless integrating with automation)  
**Status:** Not in current prompt

**What It Is:**
Two output modes:
- **Human Mode**: Markdown, prose, explanations
- **Agent Mode**: Structured JSON for machine parsing

**Research Questions:**
1. When is structured JSON output actually needed?
2. Can this be an optional add-on vs. core feature?
3. What's the use case for AI-to-AI handoffs in practice?
4. Does dual mode add complexity without clear benefit?
5. Are there simpler ways to structure output?

**Validation Criteria:**
- [ ] Identify real use cases requiring JSON output
- [ ] Determine if `/agent` command pattern is intuitive
- [ ] Test if structured output quality matches prose
- [ ] Evaluate if this belongs in advanced tier vs. base prompt

**Testing Strategy:**
```
TEST SCENARIO 1: Automation integration
- Task: Generate test results for CI/CD parser
- Human mode: "3 tests passed, 2 failed..."
- Agent mode: {"passed": 3, "failed": 2, "failures": [...]}
- Measure: Which is actually needed?

TEST SCENARIO 2: Human consumption
- Task: Explain why code failed
- Human mode: Clear prose explanation
- Agent mode: Structured JSON
- Measure: Which is more helpful?

TEST SCENARIO 3: Mixed workflow
- User switches between modes mid-conversation
- Measure: Is this confusing or helpful?
```

**Integration Options:**

**Option A: Full Dual Mode**
```xml
<output_modes>
  <default>human</default>
  <command>/agent</command>
  [Full AACL specification]
</output_modes>
```

**Option B: Structured Blocks (Hybrid)**
```xml
<standard name="structured_sections">
For complex analysis, provide both:

Prose explanation for humans
+
Structured summary block for parsing

Example:
```
Analysis: The type mismatch occurs because...

SUMMARY:
- Issue: type_mismatch
- Entity: Site
- Field: gpc_policy
```
</standard>
```

**Option C: On-Demand Only**
```xml
User can request: "Give me that as JSON"
Agent reformats last response as JSON
</xml>
```

**Decision Point:**
- [ ] Include full dual mode with `/agent` command
- [ ] Include hybrid structured blocks
- [ ] On-demand reformatting only
- [ ] Exclude (human-only sufficient)

---

### Category D: Missing from Current Prompt

#### D1. Tool Selection Guidance
**Source:** Cline  
**Priority:** MEDIUM (if multi-tool environment)  
**Status:** Not in current prompt

**What It Is:**
When multiple tools/approaches are available, explicit guidance on which to use and why.

**Research Questions:**
1. What tools/approaches need selection guidance?
2. Is this environment-specific (IDE-specific)?
3. Can this be generalized across tools?
4. Does explicit guidance reduce trial-and-error?

**Example Scenarios:**
```
SCENARIO 1: File editing
- Options: write_file (full replacement) vs. str_replace (targeted)
- Guidance: "Default to str_replace for surgical edits, write_file for new files"

SCENARIO 2: Testing approach
- Options: Unit tests vs. integration tests vs. E2E
- Guidance: "Start with unit tests for business logic, integration for APIs"

SCENARIO 3: State management
- Options: useState vs. useReducer vs. context vs. external store
- Guidance: "Use useState for simple state, useReducer for complex..."
```

**Decision Point:**
- [ ] Add tool selection section (if applicable)
- [ ] Add as examples in existing patterns
- [ ] Exclude (too environment-specific)

---

#### D2. Git Integration Awareness
**Source:** Aider, Multiple sources  
**Priority:** LOW  
**Status:** Minimal in current prompt

**What It Is:**
Explicit awareness of version control and commit practices.

**Research Questions:**
1. Should agent be aware of git state (uncommitted changes, branch)?
2. Should agent suggest commit messages?
3. How much git guidance is needed vs. distracting?

**Integration Options:**
```xml
<behavior name="version_control_awareness">
Before major changes:
- Suggest creating a branch
- After completing task: "Ready to commit with message: [suggested]"
- After breaking changes: "This should be a separate commit"
</behavior>
```

**Decision Point:**
- [ ] Add git-awareness section
- [ ] Mention briefly in workflow
- [ ] Exclude (assume user handles git)

---

## SECTION 3: RESEARCH METHODOLOGY

### Phase 1: Information Gathering (Week 1)

**For Each Improvement Opportunity:**

1. **Literature Review**
   - Search: "[Feature] AI coding assistant best practices"
   - Search: "[Feature] LLM agent effectiveness research"
   - Look for: Academic papers, practitioner blog posts, GitHub discussions

2. **Example Collection**
   - Find 3-5 real prompts using this feature
   - Analyze implementation differences
   - Note what works/doesn't work

3. **Use Case Analysis**
   - List scenarios where feature helps
   - List scenarios where feature hurts
   - Determine feature scope (always, sometimes, never)

4. **Integration Design**
   - Draft XML structure
   - Consider interaction with existing features
   - Identify conflicts or redundancies

### Phase 2: Validation (Week 2)

**For Each Candidate Improvement:**

1. **Principle Test**
   - Does this align with core philosophy?
   - Does this improve code quality or just add complexity?
   - Is this generalizable or project-specific?

2. **Overhead Analysis**
   - Token cost (how many tokens does this add?)
   - Cognitive cost (does this confuse the agent?)
   - Execution cost (does this slow down responses?)

3. **Value Assessment**
   - What class of bugs/issues does this prevent?
   - How often does this situation occur?
   - What's the cost of NOT having this?

4. **Alternative Check**
   - Can existing features handle this?
   - Is there a simpler way to achieve the same goal?
   - Should this be external documentation vs. prompt?

### Phase 3: Testing (Week 3)

**Testing Framework:**

#### Test Suite Structure
```
TEST_CATEGORY: [Workflow/Intelligence/Communication]
FEATURE_TESTED: [Specific improvement]
BASELINE: [Current prompt behavior]
ENHANCED: [With improvement]

SCENARIO 1: [Simple case]
  Input: [Specific task]
  Expected: [Desired behavior]
  Baseline Result: [What happens now]
  Enhanced Result: [What happens with improvement]
  Metrics: [Quantitative measures]
  
SCENARIO 2: [Complex case]
  [Same structure]
  
SCENARIO 3: [Edge case]
  [Same structure]
```

#### Sample Test Cases

**Test Case: PLAN/ACT Mode**
```
FEATURE: Explicit PLAN/ACT separation

SCENARIO 1: Clear requirements
  Input: "Add user authentication with JWT"
  Baseline: Immediately proposes implementation
  Enhanced: Switches to PLAN, explores auth patterns, proposes strategy
  Metrics: 
    - # of clarifying questions asked
    - # of files explored before coding
    - # of iterations to correct solution
  
SCENARIO 2: Vague requirements  
  Input: "Make the app faster"
  Baseline: Asks what specifically, then proposes changes
  Enhanced: PLAN mode - asks questions, explores bottlenecks, proposes strategy
  Metrics:
    - # of misunderstandings
    - Relevance of proposed optimizations
    
SCENARIO 3: Obvious fix
  Input: "Fix typo in line 42"
  Baseline: Fixes immediately
  Enhanced: Should skip PLAN and fix immediately
  Metrics:
    - Overhead added for simple tasks
```

**Test Case: NAMIT Edge Cases**
```
FEATURE: Systematic edge case analysis

SCENARIO 1: API endpoint
  Input: "Create POST /users endpoint"
  Baseline: Handles standard cases
  Enhanced: Systematically checks N-A-M-I-T
  Metrics:
    - Edge cases identified (count)
    - Critical bugs prevented (security, crashes)
    
SCENARIO 2: Pure function
  Input: "Implement merge sort"
  Baseline: Standard implementation + basic tests
  Enhanced: NAMIT analysis → tests for empty, single, duplicate, large arrays
  Metrics:
    - Test coverage improvement
    - Overhead vs. value
```

#### Scoring Rubric

**For Each Test:**
Rate on 1-5 scale:
- **Correctness**: Does it produce better code?
- **Efficiency**: Does it reduce iterations?
- **Overhead**: Does it add unnecessary steps?
- **Clarity**: Is agent behavior more understandable?
- **Robustness**: Does it prevent more bugs?

**Overall Score**: (Correctness + Efficiency - Overhead + Clarity + Robustness) / 5

**Decision Threshold:**
- 4.0+: Include in production
- 3.0-3.9: Include with modifications
- 2.0-2.9: Make optional/advanced
- <2.0: Exclude

---

## SECTION 4: INTEGRATION PLANNING

### Versioning Strategy

**Current:** Improved Draft v1.0 (baseline)

**Proposed Versioning:**
- v1.1: Add 1-3 highest-value improvements (quick win)
- v1.2: Add 3-5 more validated improvements
- v1.3: Add advanced/specialized improvements
- v2.0: Major restructure if needed (OLS-level sophistication)

### Integration Priorities

**Tier 1: Must-Have (Include in v1.1)**
- [ ] PLAN/ACT mode separation (if validated)
- [ ] Breaking change awareness (lightweight version)
- [ ] Confidence scoring (selective)
- [ ] Exploration phase (if validated)

**Tier 2: High-Value (Include in v1.2)**
- [ ] NAMIT edge case framework (if validated)
- [ ] Tool selection guidance (if applicable)
- [ ] Structured output blocks (hybrid approach)
- [ ] Git awareness (light touch)

**Tier 3: Advanced (Include in v1.3+)**
- [ ] Full BCDP protocol (if specialized project)
- [ ] RCT learning (within-session)
- [ ] Dual output mode (if automation needed)
- [ ] Epistemic tagging (full system)

### Conflict Resolution

**Potential Conflicts:**
1. **PLAN/ACT vs. Immediate Execution**
   - Resolution: Default to PLAN for complex, ACT for simple
   
2. **Edge Case Analysis vs. Velocity**
   - Resolution: Apply NAMIT to critical paths only
   
3. **Confidence Scoring vs. Brevity**
   - Resolution: Confidence only for non-trivial decisions
   
4. **Documentation Sync vs. Iteration Speed**
   - Resolution: Docs updated at task completion, not every change

### Token Budget Management

**Current Prompt:** ~4,000 tokens estimated

**Target:** Stay under 8,000 tokens (avoid context saturation)

**Budget Allocation:**
- Core behaviors: 3,000 tokens (keep)
- New workflows: +1,500 tokens (PLAN/ACT, exploration)
- Intelligence systems: +1,500 tokens (BCDP-lite, NAMIT)
- Output/communication: +500 tokens (confidence, structured)
- Buffer: 1,500 tokens
- **Total: 8,000 tokens**

**If Over Budget:**
- Move advanced features to external documentation
- Create tiered prompts (base + advanced)
- Use conditional loading (project-type specific)

---

## SECTION 5: DELIVERABLES

### Final Research Report

**Template:**

```markdown
# Prompt Improvement Research Report
**Date:** [Date]
**Researcher:** [Name]
**Version:** v1.1 Candidates

## Executive Summary
[3-5 sentences: What was researched, key findings, recommendations]

## Improvements Analyzed
[List of all improvements researched]

## Detailed Findings

### Improvement 1: [Name]
**Status:** ✅ Recommended / ⚠️ Conditional / ❌ Not Recommended

**Evidence:**
- [Source 1]: [Key finding]
- [Source 2]: [Key finding]

**Testing Results:**
- Scenario 1: [Result + metrics]
- Scenario 2: [Result + metrics]
- Overall Score: X.X/5.0

**Integration:**
[XML structure or "Not applicable"]

**Reasoning:**
[Why include/exclude]

---

[Repeat for each improvement]

## Recommended Roadmap

**v1.1 (Immediate):**
- [ ] Improvement A (Score: 4.5)
- [ ] Improvement B (Score: 4.2)

**v1.2 (Next):**
- [ ] Improvement C (Score: 3.8)
- [ ] Improvement D (Score: 3.5)

**Future/Optional:**
- [ ] Improvement E (Score: 3.0, specialized)
- [ ] Improvement F (Score: 2.8, needs more research)

## Token Budget Analysis
- Current: 4,000 tokens
- With v1.1: 5,500 tokens (+1,500)
- With v1.2: 7,000 tokens (+1,500)
- Target: <8,000 tokens

## Next Steps
1. [Action 1]
2. [Action 2]
3. [Action 3]
```

### Revised Prompt Drafts

**Deliverable 1:** `senior-engineer-prompt-v1.1.xml`
- Current prompt + Tier 1 improvements
- Full XML structure ready for deployment
- Inline comments explaining new sections

**Deliverable 2:** `senior-engineer-prompt-v1.2.xml`
- v1.1 + Tier 2 improvements
- Alternative versions if branching paths exist

**Deliverable 3:** `senior-engineer-prompt-v2.0.xml` (aspirational)
- Full OLS-level sophistication
- May require significant restructuring

### Testing Results

**Deliverable:** `test-results-summary.md`

```markdown
# Prompt Testing Results
**Version Tested:** v1.1
**Test Date:** [Date]
**Test Environment:** [Claude/GPT/etc.]

## Test Suite Summary
- Total Tests: 25
- Tests Passed: 22 (88%)
- Tests Failed: 2 (8%)
- Inconclusive: 1 (4%)

## Feature Performance

### PLAN/ACT Mode
- Simple tasks: 4.5/5 ✅
- Complex tasks: 4.8/5 ✅
- Unclear tasks: 4.2/5 ✅
- **Overall: 4.5/5 - INCLUDE**

### NAMIT Edge Cases
- API endpoints: 4.0/5 ✅
- Pure functions: 3.2/5 ⚠️
- UI components: 3.8/5 ⚠️
- **Overall: 3.7/5 - INCLUDE WITH SCOPE LIMITS**

[Repeat for each feature]

## Failure Analysis
Test #7 (NAMIT on simple function): Over-analysis, 2x longer response
- Root cause: No complexity threshold
- Fix: Add conditional "Use NAMIT for complex logic only"

## Recommendations
1. Deploy v1.1 with [list of features]
2. Monitor for [specific metrics]
3. Iterate to v1.2 after [timeframe/milestone]
```

---

## SECTION 6: EXECUTION CHECKLIST

### Week 1: Research

**Day 1-2: Literature Review**
- [ ] Search academic papers on AI coding assistant effectiveness
- [ ] Review 10+ practitioner blog posts (Anthropic, OpenAI, practitioners)
- [ ] Analyze 5+ public system prompts (Cursor, Cline, Aider, others)
- [ ] Document key findings in research notes

**Day 3-4: Example Collection**
- [ ] Find real examples of PLAN/ACT mode usage
- [ ] Find real examples of edge case frameworks
- [ ] Find real examples of breaking change detection
- [ ] Collect failure stories (what doesn't work)

**Day 5-7: Integration Design**
- [ ] Draft XML structures for each improvement
- [ ] Identify conflicts and dependencies
- [ ] Estimate token costs
- [ ] Create integration decision tree

### Week 2: Validation

**Day 8-10: Principle Testing**
- [ ] Test each improvement against core philosophy
- [ ] Identify improvements that add complexity without value
- [ ] Rank improvements by value/overhead ratio
- [ ] Create validated shortlist (10-15 improvements)

**Day 11-12: Scenario Planning**
- [ ] Write 3 test scenarios per improvement (25-50 total scenarios)
- [ ] Define success metrics for each scenario
- [ ] Create baseline predictions (what current prompt would do)
- [ ] Prepare test prompts

**Day 13-14: Preliminary Filtering**
- [ ] Remove improvements with fatal flaws
- [ ] Combine redundant improvements
- [ ] Create priority tiers (T1/T2/T3)
- [ ] Draft v1.1 candidate prompt

### Week 3: Testing

**Day 15-17: Execution**
- [ ] Run all test scenarios with baseline prompt
- [ ] Run all test scenarios with v1.1 candidate
- [ ] Document results with metrics
- [ ] Note unexpected behaviors

**Day 18-19: Analysis**
- [ ] Score each improvement (1-5 rubric)
- [ ] Calculate overall scores
- [ ] Identify surprising results (better/worse than expected)
- [ ] Refine integration approach based on results

**Day 20-21: Finalization**
- [ ] Write final research report
- [ ] Create v1.1 production prompt
- [ ] Write testing results summary
- [ ] Prepare deployment plan

---

## SECTION 7: SUCCESS CRITERIA

### Research Phase Success

✅ **Complete:**
- 10+ sources reviewed per major improvement
- 3+ real-world examples found per feature
- All research questions answered
- Integration options drafted for each improvement

### Validation Phase Success

✅ **Complete:**
- All improvements scored on principle test
- Token budget calculated and within limits
- Conflicts identified and resolved
- Priority tiers established with clear reasoning

### Testing Phase Success

✅ **Complete:**
- 25+ test scenarios executed
- Quantitative metrics captured for each
- All improvements scored on 1-5 rubric
- Clear recommendation (include/exclude/modify) for each

### Overall Success

✅ **Ready for Production:**
- v1.1 prompt drafted and tested
- Research report documenting all decisions
- Testing results show improvement over baseline
- Token budget under 8,000
- No critical conflicts or issues
- Clear roadmap to v1.2 and beyond

---

## SECTION 8: RISK MITIGATION

### Risk 1: Analysis Paralysis
**Risk:** Spending too much time researching, never deploying
**Mitigation:** 
- 3-week hard deadline
- Ship v1.1 with 3-5 improvements, iterate to v1.2
- Perfect is enemy of good

### Risk 2: Over-Engineering
**Risk:** Adding features that sound good but add complexity
**Mitigation:**
- Strict 1-5 scoring rubric with 4.0+ threshold
- Token budget enforcement
- "If in doubt, leave it out" principle

### Risk 3: Testing Bias
**Risk:** Designing tests that confirm preconceptions
**Mitigation:**
- Include failure scenarios (when should feature NOT trigger)
- Test with real code, not toy examples
- Document surprises and counterintuitive results

### Risk 4: Context Loss
**Risk:** Another chat session loses context from this discussion
**Mitigation:**
- This document is self-contained
- All background included in Section 1
- Clear structure for independent execution

### Risk 5: Feature Bloat
**Risk:** Adding everything until prompt is unusable
**Mitigation:**
- 8,000 token hard limit
- Tiered versioning (v1.1 → v1.2 → v2.0)
- Conditional loading for specialized features

---

## SECTION 9: QUICK START

**If you're starting fresh in a new chat, here's how to use this document:**

### Step 1: Understand Context (10 min)
Read Section 1 (Current State Baseline) to understand what exists.

### Step 2: Pick Research Focus (5 min)
Choose 3-5 improvements from Section 2 to research first.
Suggestion: Start with Category A (Workflow Architecture) - highest impact.

### Step 3: Execute Research (Days 1-7)
For each chosen improvement:
1. Answer all Research Questions (search, read, analyze)
2. Find 3+ real examples
3. Draft integration XML
4. Document findings in Research Report template

### Step 4: Validate (Days 8-14)
1. Score each improvement on 1-5 rubric
2. Estimate token costs
3. Identify conflicts
4. Create priority list

### Step 5: Test (Days 15-21)
1. Write test scenarios (template in Section 3)
2. Run tests with baseline vs. enhanced prompt
3. Capture metrics
4. Score results

### Step 6: Deliver (Day 21)
1. Complete Research Report (Section 5 template)
2. Draft v1.1 prompt with validated improvements
3. Write Testing Results summary
4. Submit for review

---

## SECTION 10: RESEARCH PROMPTS

**Copy-paste these into your research chat:**

### Prompt 1: PLAN/ACT Mode Research
```
I'm researching the PLAN/ACT mode separation pattern for AI coding assistants, where the agent explicitly separates planning (read-only exploration) from execution (code changes).

Research questions:
1. How does Cline implement this technically?
2. What are the failure modes when planning and execution are mixed?
3. When does planning-first add overhead vs. value?
4. What's the optimal way to trigger mode switches?

Please search for:
- Cline system prompt implementation details
- User experiences with PLAN/ACT mode
- Research on planning effectiveness in AI agents
- Failure cases where immediate execution is better

Provide:
- Summary of findings
- 3+ real examples
- Pros/cons analysis
- Integration recommendation
```

### Prompt 2: NAMIT Edge Case Framework
```
I'm researching the NAMIT edge case analysis framework:
- N: Null/missing data
- A: Array boundaries
- M: Multiplication (concurrency)
- I: Input validation
- T: Timing

Research questions:
1. Does systematic edge case analysis improve coverage measurably?
2. Is NAMIT better than generic "consider edge cases" guidance?
3. When does this add overhead vs. value?

Please search for:
- Research on systematic vs. ad-hoc edge case analysis
- Examples of NAMIT or similar frameworks
- Failure cases where edge cases were missed

Provide summary, examples, and recommendation on whether to include.
```

### Prompt 3: Breaking Change Detection
```
I'm researching breaking change detection protocols for AI coding assistants, specifically detecting type contract violations, schema mismatches before deployment.

From OLS v4.1, this involves:
- Identifying contract boundaries (DB ↔ Backend ↔ Frontend)
- Extracting schemas (SQL + TypeScript)
- Cross-referencing types
- Generating migration plans

Research questions:
1. Is this generalizable beyond TypeScript + PostgreSQL?
2. What's a simplified version that works for more projects?
3. Can LLMs detect breaking changes without formal protocol?

Please search for:
- Tools/practices for breaking change detection
- Examples in AI coding assistants
- Lightweight alternatives

Provide implementation recommendations.
```

### Prompt 4: Confidence Scoring
```
I'm researching confidence scoring systems for AI agents, where the agent explicitly rates uncertainty (1-10 or categorical).

Research questions:
1. Do confidence scores improve human oversight?
2. What scale works best (1-10 vs. categorical)?
3. How to prevent agents from always claiming high confidence?

Please search for:
- Research on AI confidence calibration
- Examples in coding assistants (Cline's 1-10 scale, OLS epistemic tags)
- Human factors research on trust and confidence

Provide recommendation on whether to include and what format.
```

---

## APPENDIX A: COMPARISON SOURCES

These sources informed the improvement opportunities:

1. **Cline System Prompt** (10,000+ tokens)
   - Plan/Act mode separation
   - Tool selection guidance
   - Confidence scoring
   - Exploration phase

2. **OLS v4.1** (42KB specification)
   - BCDP (Breaking Change Detection Protocol)
   - TCV (Type Contract Verifier)
   - NAMIT (Edge case framework)
   - RCT (Root Cause Tracing)
   - Epistemic tagging
   - AACL (Agent mode)

3. **Cursor .cursorrules** (community examples)
   - Project-specific context
   - Tech stack specification
   - Testing emphasis

4. **Aider** (CLI-based assistant)
   - Precision prompting
   - Structured project context files
   - Repository maps

5. **Industry Research** (2025-2026)
   - Google Cloud best practices
   - Anthropic engineering practices
   - Community survey results

---

## APPENDIX B: TEMPLATE FILES

### Research Notes Template

```markdown
# Research Notes: [Feature Name]
**Date:** [Date]
**Status:** In Progress / Complete

## Sources Reviewed
1. [Source 1] - [Key takeaway]
2. [Source 2] - [Key takeaway]
3. [Source 3] - [Key takeaway]

## Research Questions Answered
Q1: [Question]
A1: [Answer + evidence]

Q2: [Question]
A2: [Answer + evidence]

## Examples Found
Example 1: [Description + link]
Example 2: [Description + link]
Example 3: [Description + link]

## Integration Draft
```xml
[XML structure]
```

## Recommendation
☐ Include in v1.1
☐ Include in v1.2
☐ Include in v2.0
☐ Exclude

**Reasoning:** [Why]

**Score:** X.X/5.0
- Correctness: X/5
- Efficiency: X/5
- Overhead: X/5 (inverted)
- Clarity: X/5
- Robustness: X/5
```

### Test Scenario Template

```markdown
# Test Scenario: [Feature] - [Scenario Name]

## Setup
**Feature Tested:** [Name]
**Complexity:** Simple / Medium / Complex
**Domain:** API / Frontend / Backend / Algorithm

## Scenario
**Input Prompt:**
```
[Exact prompt to give agent]
```

**Context:**
- Project type: [SaaS / CLI / Library / etc.]
- Files available: [List]
- Current state: [Description]

## Expected Behavior
**Baseline (Current Prompt):**
[What should happen with current prompt]

**Enhanced (With Feature):**
[What should happen with new feature]

## Actual Results
**Baseline:**
[What actually happened]

**Enhanced:**
[What actually happened]

## Metrics
| Metric | Baseline | Enhanced | Delta |
|--------|----------|----------|-------|
| Iterations | X | Y | +/- Z |
| Time | Xs | Ys | +/- Zs |
| Edge cases | X | Y | +Z |
| Errors | X | Y | -Z |

## Scoring
- Correctness: X/5 - [Why]
- Efficiency: X/5 - [Why]
- Overhead: X/5 - [Why]
- Clarity: X/5 - [Why]
- Robustness: X/5 - [Why]

**Overall:** X.X/5.0

## Notes
[Observations, surprises, concerns]

## Recommendation
☐ Feature works as expected
☐ Feature needs modification
☐ Feature adds overhead without value
```

---

**END OF RESEARCH PLAN**

---

## USAGE INSTRUCTIONS FOR NEW CHAT

1. Upload this document to a fresh chat session
2. Say: "I'm executing the Prompt Improvement Research Plan. I want to research [specific improvement] from Section 2. Please guide me through the research methodology in Section 3."
3. Work through each phase systematically
4. Use templates from Section 5 to document findings
5. Deliver final report and revised prompt at the end

**Estimated Time:** 3 weeks with focused effort, or execute in phases over longer period.

**Good luck! 🚀**
