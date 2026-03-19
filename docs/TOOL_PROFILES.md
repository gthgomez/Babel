# Tool Profiles

## Purpose

These profiles describe how Babel Local should adapt to the real strengths and limits of each client surface.

Use them to guide:
- kickoff prompt length
- memory strategy
- expected repo visibility
- trust in tool execution
- recommended Babel defaults

## `codex_extension`

- Primary use: implementation, refactors, code review, deterministic repo edits
- Memory surfaces: layered `AGENTS.md` files and repo context
- Repo visibility: strong in local repo sessions
- Ideal kickoff style: short and direct
- Recommended Babel default: `adapter_codex_balanced` unless the task is narrow and schema-heavy
- Good at:
  - multi-file edits
  - verification-oriented implementation
  - deterministic stack-following
- Watch for:
  - over-compression if pushed into ultra-terse mode too early
  - missing UX nuance on design-heavy tasks
- Recommended startup phrase:
  - `Read BABEL_BIBLE.md, use Babel for this task, then plan and execute using the selected instruction stack.`

## `claude_code`

- Primary use: architecture-sensitive coding, careful planning, high-judgment refactors
- Memory surfaces: `CLAUDE.md`, `.claude/CLAUDE.md`, user memory, hooks
- Repo visibility: strong when run in the target repo
- Ideal kickoff style: slightly more explicit than Codex, but still compact
- Recommended Babel default: keep overlays narrow and rely on repo-local invariants when present
- Good at:
  - structured plans
  - nuanced reasoning
  - preserving architectural constraints
- Watch for:
  - excess verbosity
  - prompt bloat if too many overlays are loaded
- Recommended startup phrase:
  - `Read BABEL_BIBLE.md and follow Babel before planning. Load the relevant Babel layers for this task, then proceed.`

## `gemini_cli`

- Primary use: research, long-context synthesis, repo analysis, CLI-assisted workflows
- Memory surfaces: hierarchical `GEMINI.md`, `/memory` commands, config-driven context files
- Repo visibility: good, especially for document-heavy or multi-file reading
- Ideal kickoff style: compact but explicit about the task category
- Recommended Babel default: use for research, analysis, and wide repo inspection before implementation
- Good at:
  - long-context reading
  - synthesis
  - CLI-oriented workflows
- Watch for:
  - weaker fit for high-risk direct edits than Codex or Claude Code
  - drift if the session context gets too broad without refresh
- Recommended startup phrase:
  - `Read BABEL_BIBLE.md first and use Babel to assemble the correct instruction stack before analyzing or completing the task.`

## `vscode_chat`

- Primary use: lightweight repo Q&A, quick planning, low-friction iteration inside the editor
- Memory surfaces: editor-managed context and repo files visible to the extension
- Repo visibility: variable by extension and chat mode
- Ideal kickoff style: very short
- Recommended Babel default: prefer one domain layer, one adapter, and the thinnest applicable overlay set
- Good at:
  - fast iteration
  - quick follow-up questions
  - short planning passes
- Watch for:
  - context truncation
  - weaker persistence than dedicated CLI tools
- Recommended startup phrase:
  - `Read BABEL_BIBLE.md first, use Babel to choose the right instructions, then keep the working set minimal.`

## `chatgpt_web`

- Primary use: planning, research, and project work inside ChatGPT Projects
- Memory surfaces: project files, chats, project instructions, custom instructions
- Repo visibility: file-upload or project-scoped, not a full local working tree by default
- Ideal kickoff style: explicit and minimal
- Recommended Babel default: use the Bible doc plus uploaded context files; do not assume live repo sync
- Good at:
  - planning
  - summarization
  - project-level context reuse
- Watch for:
  - stale uploads
  - weaker deterministic execution than local coding tools

## `claude_web`

- Primary use: planning, research, artifact generation, repo discussion via uploaded or synced context
- Memory surfaces: Projects, knowledge, Artifacts, GitHub integration depending on plan
- Repo visibility: better than generic chat when Projects/GitHub are enabled, but still not the same as local CLI use
- Ideal kickoff style: explicit about repo-local invariants
- Recommended Babel default: pair the Bible doc with the repo's own collaboration system when available
- Good at:
  - thoughtful planning
  - long-form reasoning
  - artifact generation
- Watch for:
  - prompt sprawl
  - mismatch between uploaded context and live repo state

## `gemini_web`

- Primary use: research, synthesis, large-doc analysis, Gems-based custom behavior
- Memory surfaces: Gems, uploads, connected apps, Deep Research flows
- Repo visibility: snapshot-oriented unless explicitly connected/imported
- Ideal kickoff style: simple and bounded
- Recommended Babel default: use for research and cross-checking, not as the primary direct-edit surface
- Good at:
  - long-context research
  - comparison work
  - external information gathering
- Watch for:
  - repo snapshot drift
  - noisy context if too many connected sources are enabled

## `other`

- Use the thinnest viable Babel stack.
- Start with the Bible doc.
- Prefer repo-local collaboration files over assumptions.
- Log the session so Babel can learn whether the surface is worth formalizing.

## Profile Rules

- Prefer shorter kickoff prompts as the client gets weaker persistence.
- Prefer stronger repo-local handoff when the client lacks deterministic repo context.
- Prefer deterministic scripts or hooks over repeated prompt reminders when the client supports them.
- Record real outcomes with `tools/log-local-session.ps1` so these profiles can be refined from evidence.

## Launch Helper Defaults

`tools/launch-babel-local.ps1` uses these deterministic defaults unless overridden:
- `codex` -> `codex_extension`
- `claude` -> `claude_code`
- `gemini` -> `gemini_cli`

It reuses `tools/start-local-session.ps1` and emits copy-paste launch prompts for `plan` and `act` modes.
