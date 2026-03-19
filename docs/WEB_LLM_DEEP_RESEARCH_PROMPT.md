# Web LLM Deep Research Prompt

Use this prompt with a web-only LLM when you want an external research pass on the current state of ChatGPT, Claude, Gemini, and Grok web products, specifically for autonomous coding and instruction-system design.

## Prompt

You are conducting a deep research pass for a prompt operating system called Babel.

Your task is to research the current web-product capabilities of:
- ChatGPT
- Claude
- Gemini
- Grok

The goal is not to rank the models generally.

The goal is to understand how their current web products support or limit:
- autonomous coding
- persistent instruction systems
- project/workspace memory
- file and repo ingestion
- connectors/integrations
- approval and safety boundaries
- privacy and training implications
- shareable outputs or artifacts

### Research Rules

1. Use official vendor sources first.
2. Prefer help centers, official docs, pricing/business pages, or official product docs.
3. If an official answer is missing, say so explicitly.
4. Distinguish verified facts from inference.
5. Include exact URLs and the apparent publish/update date when available.
6. Do not rely on random blog posts unless you are filling a gap left by official documentation, and if you do, label them secondary.
7. Be especially careful with features that may differ by plan, region, workspace type, or business tier.

### Focus Questions

For each platform, research:

1. Does it support projects, workspaces, or equivalent persistent context containers?
2. Can it store project-specific instructions or reusable instruction wrappers?
3. Can it ingest codebases or GitHub repositories?
4. If it can ingest repos, is that:
   - snapshot import
   - selective sync
   - full integration
   - unclear
5. Does it support connectors, apps, or integrations with external systems?
6. Does it support browser-based agentic action, terminal use, or tool-based autonomous workflows?
7. What actions require explicit user approval?
8. What privacy, retention, human review, or training implications are documented?
9. Does it expose a shareable output surface such as artifacts, apps, canvases, or project sharing?
10. What would this imply for designing a reusable instruction control plane like Babel?

### Deliverable Format

Return the result in this structure:

#### 1. Executive Summary
- 5 to 10 bullet points

#### 2. Capability Matrix

Use a table with these columns:
- Platform
- Workspace / Project Layer
- Instruction Persistence
- Repo / Codebase Ingestion
- Connectors / Integrations
- Agentic / Multi-Step Tool Use
- Approval Checkpoints
- Shareable Output Surface
- Privacy / Training Signal
- Best Use Pattern For Autonomous Coding
- Confidence

#### 3. Platform Deep Dives

For each platform:
- Verified capabilities
- Important constraints
- Privacy / safety concerns
- What Babel should learn from this platform
- Official sources

#### 4. Cross-Platform Patterns

Answer:
- What features appear across all four products?
- What features are only strong in one or two products?
- What capabilities matter most for autonomous coding?
- Which features should Babel model explicitly in its architecture?

#### 5. Recommendations For Babel

Give concrete recommendations for:
- router changes
- new overlays
- platform-specific invocation guidance
- privacy guidance
- trust-tier modeling
- research gaps requiring another pass

#### 6. Open Questions

List unresolved items that need follow-up.

### Output Constraints

- Use concise but specific language.
- Do not give vague product summaries.
- Separate verified facts from inference.
- Use dates where possible.
- Prefer primary sources over confident speculation.

### Optional Extra

If you find strong evidence of platform features that should directly influence Babel, propose:
- one new Babel doc
- one new task overlay
- one new router field

and explain why.
