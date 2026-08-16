# ADR-009: Hybrid TUI Rendering Paradigm

<!--
status: ACTIVE
last_verified: 2026-08-15
-->
**Status:** Accepted  
**Date:** 2026-06-26  
**Deciders:** Babel team  

## Context

Babel's TUI has three rendering paradigms that coexist in the codebase:

1. **Component tree** (`component.ts` + `primitives.ts`): A class hierarchy where `Component` is the
   abstract base, and concrete subclasses (Box, Text, Stack, Spacer, plus 6 other custom widgets)
   compose into a tree. Rendering is pull-based — the framework calls `render()` on dirty components
   and collects a string. Design is modelled on Ratatui's Widget trait, not React/Ink. Used by
   dialogs, overlays, diff views, agent progress panels, and model-picker popups.

2. **Standalone renderers** (`waterfall.ts`): Classes that manage their own rendering loop
   independently of the component tree. `WaterfallRenderer` (governed pipeline HUD),
   `ConversationalRenderer` (chat output), and `AppendOnlyRenderer` (non-TTY fallback) each own
   their state, register with `FrameScheduler` for periodic ticks, and write directly to stdout
   via `logUpdate()` or `OutputBuffer`. Rendering is push-based — events, timer ticks, and state
   transitions trigger immediate screen updates.

3. **Function-based renderers** (`renderers.ts`, `timeline.ts`, `tables.ts`, `sections.ts`,
   `statusLine.ts`, `progress.ts`, `badges.ts`, etc.): Stateless pure functions that accept data
   and return a rendered string. These compose into both the component tree and standalone
   renderers. They are not part of the paradigm question — they are the shared rendering
   vocabulary that both paradigms consume.

The coexistence of paradigms (1) and (2) raises a natural architectural question: should the
standalone renderers be refactored into Component subclasses, giving the TUI a single unified
rendering model?

## Decision

**Do NOT unify the two paradigms.** Keep the hybrid approach:

- **Component tree** for pull-based, on-demand, stateful widgets (dialogs, overlays, panels)
- **Standalone renderers** for push-based, streaming, live-updating output (chat, HUD)
- **Function-based renderers** as the shared rendering vocabulary used by both

Each paradigm targets fundamentally different rendering requirements. A unification would add
complexity without eliminating any real cost — the two call sites do not overlap, and there is no
code that would benefit from being able to treat a WaterfallRenderer as a Component.

## Rationale

### 1. The two paradigms serve different rendering models

The Component tree is **pull-based**: the framework decides when frames are produced, walks the
tree, calls `render()` on dirty nodes, and assembles a string. This works well for widgets that
change in response to user input (keyboard navigation, toggle states, scroll position) but is a
poor fit for streaming output where bytes arrive asynchronously and must reach the terminal with
minimal latency.

Standalone renderers are **push-based**: events (assistant_thought, log, runtime_event, tool
callbacks) and timer ticks drive rendering directly. The `ConversationalRenderer` streams markdown
through a `ChunkCoalescer` at 60 FPS. The `WaterfallRenderer` updates stage progress, activity
lines, and cost in response to orchestrator events at 50ms intervals. These have no natural place
in a pull-based tree traversal.

### 2. Streaming output is inherently imperative

Chat and HUD output is a sequential stream: text arrives in chunks, must be rendered incrementally
(not re-rendered from scratch), and carries cursor-position state across writes. A pull-based model
would require the stream to buffer all output and re-render the entire frame on each tick — an
O(n^2) cost in accumulated output length. The current push-based approach appends deltas and
updates in place, which is O(1) per chunk.

### 3. The two paradigms do not share call sites

No code path ever needs to treat a WaterfallRenderer as a Component or mount a Component inside a
chat stream. The renderer selection happens once at startup (`createLiveRunRenderer`) and the
component tree is assembled at the TUI shell level. They coexist at different layers of the
architecture and never interact.

### 4. Unification would add complexity without benefit

To unify, we would need to either (a) make `Component.render()` accept streaming data (breaking
its contract), (b) add a push-based rendering path to the Component base class (blurring its
abstraction), or (c) introduce a separate streaming Component subclass hierarchy (proliferating
types). All three options add surface area and testing burden with zero payoff in code reuse or
runtime behavior.

### 5. The shared rendering vocabulary already works

Function-based renderers (`renderers.ts`, `timeline.ts`, etc.) are consumed by both paradigms with
no impedance mismatch. They return plain strings, which either paradigm can write to stdout. This
is the right level of sharing — not the rendering engine, but the rendering primitives.

## Alternatives Considered

### Unify via virtual DOM / diffing

A React/Ink-style virtual DOM with diffing and reconciliation could theoretically support both
streaming and declarative widgets. This was rejected because: (a) it would require a complete
rewrite of the TUI, (b) terminal rendering is cheap enough that diffing buys little,
(c) streaming chat output needs append-only semantics that a vDOM diff loop would fight against,
and (d) the existing implementation explicitly documents "no virtual DOM" as a design principle.

### Unify via the StateStore

Making all renderers feed through a shared `StateStore<TuiState, TuiMutation>` was considered.
The `ConversationalRenderer` already uses a StateStore (via `createTuiStore`) for mutation-driven
state synchronization. Extending this to the Component tree would create a formal data layer
shared across paradigms while preserving their rendering differences. This direction is worth
exploring but is not part of this decision — see "Migration Path" below.

### Make Component tree push-capable

Adding push-based rendering methods to the Component base class was rejected because it would
break the clean `render(): string` contract, add lifecycle complexity, and create ambiguity about
when pull vs push rendering applies.

## Consequences

### When to use each paradigm

| Situation | Paradigm | Example |
|-----------|----------|---------|
| Dialog, overlay, popup, form | Component tree | Model picker, diff overlay, settings panel |
| Streaming chat output | Standalone renderer | `ConversationalRenderer` |
| Live pipeline HUD | Standalone renderer | `WaterfallRenderer` |
| Non-TTY log output | Standalone renderer | `AppendOnlyRenderer` |
| Pure string formatting | Function renderer | `renderSection()`, `renderBadge()` |
| Widget with keyboard focus | Component tree | Prompt input, scrollable lists |
| Real-time agent progress | Standalone renderer | AgentStreamManager output |

### What NOT to do

1. **Do not** add standalone-renderer features (streaming, FrameScheduler ticks) to `Component`.
2. **Do not** wrap standalone renderers in Component subclasses for the sake of "unification."
3. **Do not** convert Component subclasses to standalone renderers — they have different event
   models (keyboard input via `handleKey()` vs event-bus listeners).
4. **Do not** add a virtual DOM or diffing layer to the TUI.
5. **Do not** expect function-based renderers to own state — they are pure.

### Recommended investment: StateStore migration

The most impactful cross-paradigm improvement is not unification but shared state management.
Currently:
- `ConversationalRenderer` uses `StateStore<TuiState, TuiMutation>` for mutation-driven state sync
  (paused, thoughtCollapsed, thoughtText, tool state, file changes).
- `WaterfallRenderer` manages state entirely in instance fields with no state store.
- Component tree widgets manage state internally via dirty flags and instance properties.

Migrating `WaterfallRenderer` to use the same `StateStore` pattern would:
- Enable cross-renderer state inspection and debugging.
- Prepare for a shared `TuiState` shape that the component tree can also subscribe to.
- Eliminate the last manual state-management site in the standalone renderers.
- Preserve the rendering paradigm difference (push vs pull) while unifying the data layer.

## Compliance

- New TUI widgets should select their paradigm based on the table above.
- No new code should attempt to bridge or unify the two paradigms.
- Function-based renderers remain the shared vocabulary — prefer adding a function renderer over
  adding a new Component or renderer when the output is purely data-driven string formatting.
- The `StateStore` migration path is tracked separately. When that work begins, the
  rendering paradigm boundary must remain intact.

## Current status (2026-08-15)

The hybrid paradigm holds after the TUI polish work: component tree → pull-based
widgets/dialogs (`babel-cli/src/ui/component.ts`), standalone renderers → push-based
streaming/live output (`chunkCoalescer`, renderer streaming), function renderers → shared
formatting vocabulary. State management evolved with `stateMutationBus` /
`thinkingState`; the paradigm boundary was not reopened.
