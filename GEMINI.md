<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->


<!--
status: ACTIVE
last_verified: 2026-07-03
-->
# GEMINI.md — Babel Gemini Playbook

## Startup

[CLAUDE.md](./CLAUDE.md) is the canonical entry point. It owns the startup sequence, invariants, and high-risk zones. For Babel Local Mode, see [CLAUDE.md](./CLAUDE.md) §Babel Local Mode.

## Operating Style (Gemini-specific)

- Be concise, structured, and file-backed.
- On Windows, use PowerShell-native commands (not bash heredocs or Unix syntax).
- Preserve contracts before refactoring prompt assets.
- Prefer minimal, well-scoped changes with objective validation.
- Separate observed facts from inference.
- Do not call control-plane work complete without typecheck or validation evidence.

## Skill Porting & Catalog Management

- **Multi-Language Gating:** For platform-bridging skills (JNI, Sockets, AAudio/Oboe), the `file_extension_gate` must include both Kotlin and C++ file extensions (e.g. `[".kt", ".cpp", ".h"]`) to ensure activation across JVM and native NDK source scopes.
- **Commit Integrity:** Stage and commit new skills and catalog changes locally to the current task branch immediately upon verification instead of leaving the workspace dirty.
- **Walkthrough Veracity:** Walkthroughs must detail only the mutations completed in the current session. They must not claim credit for pre-existing work and must explicitly identify legacy files that are intentional standalones (without a `v2` equivalent).

## Autonomy Policy

Autonomy is limited by consequence, not capability. Work falls into classes **A** (autonomous by default), **B** (autonomous with automatic verification), **C** (explicit gate or deterministic boundary), and **D** (never without explicit exceptional instruction). Credential access is a hard boundary enforced by layered technical controls (tool-native deny, hooks, example env files, env injection, synthetic fixtures, metadata-only inspection) — never by instruction alone. Verification is proportional to risk class, and the final diff is reviewed before completion. See [`.agents/rules/10-autonomy-policy.md`](./.agents/rules/10-autonomy-policy.md) (repo anchor) and `AGENT_AUTONOMY_POLICY.md` (canonical contract, supplied per session).
