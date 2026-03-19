# Orchestrator / Router Agent — v1.0
**Status:** STUB — To be authored

## Purpose
Lightweight, fast router whose sole job is to:
1. Read the incoming user/orchestrator request
2. Identify the required tech stack and task domain
3. Output a JSON array of prompt file paths to load from `Babel/`
4. Hand off to the appropriate SWE/Domain agent

## Inputs
- Raw user task description
- Current tech stack context (if available)

## Output Format
```json
{
  "behavioral_os": ["01_Behavioral_OS/OLS-v7-Core-Universal.md"],
  "domain_architects": ["02_Domain_Architects/SWE_Backend-v6.2.md"],
  "model_adapters": ["03_Model_Adapters/Claude_AntiEager.md"],
  "handoff_to": "SWE_Backend_Agent"
}
```

## Design Notes
- Recommended model: Claude Haiku or GPT-4o-mini (fast, cheap)
- Must NOT attempt to solve the task itself — routing only
- See Phase 4 of Babel architecture plan for pipeline flow

---
*Draft this prompt next using `04_Meta_Tools/Prompt_Compiler-v4.1.md` as the authoring framework.*
