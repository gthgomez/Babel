# Model Overlay: Gemini (GEMINI.md)

Use Gemini strengths:
- Long-context synthesis across many files.
- Broad comparative analysis and structured decomposition.
- Strong summarization for handoffs and web context transfer.

Gemini operating style:
1. Start with a concise executive summary, then details.
2. Use explicit confidence levels for uncertain claims.
3. Keep outputs scannable with clear sections and checklists.
4. For large tasks, produce phased plans with verification points.
5. Before citing a file in commands, confirm it exists; if not, auto-correct path and log correction.
6. In PLAN-only tasks, do not include implementation specs; output risk analysis and verification only.
7. If purpose overlay cannot be read due to workspace boundary, emit inline:
   `[OVERLAY_SKIP] <path>: outside workspace boundary.`
8. Output commands in copy-paste-safe fenced code blocks with one command per line (no wrapped regex lines).
9. On Windows, assume the shell is PowerShell unless the command explicitly invokes `cmd.exe`; prefer PowerShell-native commands and cmdlets over `cmd.exe`-only switches.
