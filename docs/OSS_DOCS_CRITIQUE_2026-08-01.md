<!-- License: MIT — see LICENSE -->

<!--
status: ACTIVE
last_verified: 2026-08-01
role: PUBLIC_DOCS_POSITIONING_REVIEW
-->

# OSS docs critique and positioning review

**Date:** 2026-08-01  
**Scope:** Root README, onboarding docs, CLI docs, and the public product story

## Executive verdict

Babel’s documentation was accurate about the Prompt OS, but it made the
Prompt OS look like the product and the coding agent look like an implementation
detail. That is backwards for a first-time OSS visitor.

The public story should be:

> Babel is an open-source agent harness for software work. Start with the
> default chat coding loop; move to plan or deep when the task needs stronger
> gates; inspect the Prompt OS when you want to understand or customize how the
> harness works.

This is a positioning correction, not a parity claim. Babel should borrow the
clarity of Codex, Grok Build, and OpenCode while keeping its own evidence and
governance boundaries explicit.

## What peer READMEs do well

The current reference set was reviewed on 2026-08-01:

- [OpenAI Codex](https://github.com/openai/codex) opens with the product identity,
  local execution model, and an immediately usable install path.
- [Grok Build](https://github.com/xai-org/grok-build) leads with the terminal
  agent and names its interactive, headless, and editor-embedded surfaces before
  explaining the repository layout.
- [OpenCode](https://opencode.ai/docs) leads with the user outcome—an open-source
  terminal coding agent—then organizes the guide around installation, providers,
  tools, commands, and integrations.
- [OpenHarness](https://github.com/HKUDS/OpenHarness) explains the harness
  explicitly: the model provides intelligence while the harness provides tools,
  memory, coordination, and safety boundaries.

The shared pattern is simple:

1. Identify the product in one sentence.
2. Show the first useful command.
3. Name the main interaction surfaces.
4. Explain the architecture after the reader understands the value.
5. Link to deeper documentation and state limitations near the claim.

## Critique of the previous Babel docs

### 1. The lead was technically strong but product-weak

“Open-source coding agent” was present, but the first paragraphs emphasized
instruction stacks, catalogs, and source-of-truth mechanics. A new visitor had
to infer that Babel now has a daily conversational agent loop.

### 2. Chat existed but was not showcased

The mode table listed `chat`, but the first runnable examples prioritized
validation and stack previews. Those are valuable proof surfaces, not the first
product experience. The README now starts with interactive chat and links to the
dedicated [chat-mode contract](./CHAT_MODE.md).

### 3. The docs mixed product layers

The root README, `START_HERE.md`, `docs/CLI_QUICKSTART.md`, and
`docs/CHAT_MODE.md` each described part of the runtime. The result was accurate
but repetitive, and some examples used legacy mode names. The root README now
owns the product story; the CLI quickstart owns command detail; chat mode owns
the routing contract; the Prompt OS remains the architecture underneath.

### 4. The strongest differentiation was buried

Babel’s useful distinction is not “we have prompts.” It is that the agent
harness makes context selection, behavior, tools, modes, permissions, and
evidence inspectable. The revised README names that harness directly and
connects it to concrete commands such as `doctor`, stack preview, `mcp`, and
`undo`.

### 5. The honesty posture needed a better location

The claims matrix was careful, but a first-time reader should not need to find
it to understand the product boundary. The revised README puts the pre-1.0 and
non-parity note near the top, then links to the evidence ledger for detail.

## Public information architecture

The docs should now divide responsibility this way:

| Surface | Job |
|---|---|
| `README.md` | Product identity, first command, modes, harness differentiator, honest status |
| `START_HERE.md` | No-credentials proof path: validate, preview, then try runtime |
| `docs/CLI_QUICKSTART.md` | Copy-paste command reference |
| `docs/CHAT_MODE.md` | Default chat runtime and routing contract |
| `docs/architecture/` | How the harness and Prompt OS are built |
| `docs/audit/` | Competitive comparisons and implementation gaps |
| `docs/status/claims-matrix.md` | Evidence-backed claim boundaries |

## Editorial decisions made in this pass

- Rename the top-level product story around the **agent harness**.
- Make **chat** the first runtime path and explicitly call it the default.
- Present plan and deep as graduated controls, not separate products.
- Explain the Prompt OS as a harness layer that users can inspect and extend.
- Keep the no-credentials preview path because it is a genuine Babel strength.
- State that Babel is not yet claiming Codex/Grok/OpenCode market parity.
- Add direct links to the chat contract, competitive teardown, and claims matrix.

## Follow-up backlog

This README pass does not claim to solve the remaining product gaps. The next
high-value documentation work is:

- add a short, sanitized terminal recording or screenshot to the README when a
  stable public demo fixture is available;
- give `babel setup` and provider configuration one canonical public guide;
- publish one end-to-end chat example that shows inspect → edit → verify;
- keep command examples synchronized with CLI help and remove legacy aliases
  from new docs; and
- refresh this review after the next install/distribution milestone.

The implementation and parity backlog remains in the
[four-way harness teardown](./audit/BABEL_VS_CODEX_GROK_OPENCODE_HARNESS_TEARDOWN_2026-07-24.md),
not in the README.
