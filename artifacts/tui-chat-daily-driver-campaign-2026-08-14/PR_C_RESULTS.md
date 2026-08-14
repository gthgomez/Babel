# PR-C Results: Canonical Session & Event Projection

## Executive Summary
PR-C introduces a canonical typed event model and pure functional view projector, eliminating divergence between runtime truth, status bar, review card, and transcript rendering.

## Work Completed

### 1. State-Duplication Archaeology
- Documented `STATE_DUPLICATION_ARCHAEOLOGY.md`:
  - Mapped 8 core concepts (Terminal Outcome, Active Model, Context Telemetry, Session Cumulative Tokens, Verification State, Tool Call Lifecycle, Changed Files, and Cancellation).
  - Identified sources of truth, copies, mutation points, and rendering consumers.

### 2. Canonical Typed Event Stream
- Created `babel-cli/src/interactive/projection/canonicalEvents.ts`:
  - 12 strongly-typed event variants:
    - `turn_started`, `provider_request_started`, `provider_usage_recorded`, `assistant_chunk_received`, `tool_started`, `tool_progressed`, `tool_completed`, `policy_intervention_triggered`, `verification_evaluated`, `turn_terminal_resolved`, `model_switched`, `context_compacted`.

### 3. Canonical View Projector
- Created `babel-cli/src/interactive/projection/turnViewProjector.ts`:
  - Pure reducer `projectTurnViewState(events, initialSessionTokens, initialSessionCost, initialTurnCount)`:
    - Projects `StatusBarProjection` (model, modelId, activeContextTokens, cumulativeSessionTokens, cost, turnCount, statusLabel).
    - Projects `ReviewCardProjection` (title, terminalOutcome, verifiedBadge, verifierCommand, changedFiles, hasMutations, showPatchActions).
    - Projects `TranscriptCellProjection` (turnId, userInput, assistantAnswer, terminalOutcome, toolCalls, policyInterventions).

### 4. Projection Consistency Certification
- Created `babel-cli/src/interactive/projection/turnViewProjector.test.ts`:
  - Asserts honest `Cancelled` review state on cancellation without patch actions.
  - Asserts `Verification failed` on red verifiers, prohibiting false-green claims.
  - Asserts zero mutation state and no patch actions on read-only tasks.
  - Asserts helper-model usage does not overwrite active conversation model context meters.
  - Asserts atomic model name and model ID updates on model switches.
- Added `test:projection` script to `package.json`.

## Test Results
- `npm run typecheck`: **0 errors (PASS)**
- `npm run test:projection`: **5/5 tests PASS**
- `npm run test:chat-perf`: **4/4 tests PASS**
- `npm run test:daily-driver`: **48/48 tests PASS**
- `npm run test:tier0`: **206/206 tests PASS**
