<!--
status: ACTIVE
last_verified: 2026-07-08
role: SCOPE_AUDIT
planning: not a live backlog — clarify TUI-only vs system-wide before any impl
-->
# Voice Dictation Blueprint Audit — Against Babel Codebase

> **Date**: 2026-07-08  
> **Auditor**: Claude (session agent)  
> **Sources audited**:
> 1. `--Analysis Methodology & Sources--.md`
> 2. `Wispr Flow Technical Teardown.md`
> 3. `Voice Dictation Architecture Blueprint.md`
> 4. `# Production-Grade Prompt_ Black-Box Architecture ....md`
> **Status**: COMPLETE (scope audit — not an implementation backlog)  
> **Verdict**: YELLOW — Blueprints are high-quality but target the wrong architectural surface for Babel as-is. Significant adaptation required.
>
> **Related:** Ctrl+Shift+V hotkey plumbing exists in PromptInput; full mic→STT pipeline is still out of scope until product decision.

---

## Executive Summary

The four documents describe a **system-wide, cross-application voice dictation engine** modeled after Wispr Flow — a desktop application that captures microphone audio, streams it to cloud STT/LLM services, and injects polished text into any foreground application via OS-level hooks. The blueprints are thorough, well-sourced, and production-grade for that target.

**Babel is a terminal TUI coding agent harness**, not a desktop application with OS-level input hooks. The blueprints and Babel intersect at exactly one point: TypeScript/Node.js runtime. At every other layer — OS integration, audio pipeline, text injection, permission model — they describe a fundamentally different application surface.

**Bottom line**: These blueprints are an excellent reference for building a standalone voice dictation desktop app. They are NOT directly applicable as an implementation plan for adding voice input to Babel. However, significant portions of the pipeline architecture, inference composition, and state machine design are reusable if adapted to Babel's TUI-only scope.

---

## 1. Babel's Current Architecture (Reality Check)

### 1.1 What Babel Is

| Dimension | Reality |
|-----------|---------|
| **Runtime** | Node.js TypeScript CLI/TUI |
| **Rendering** | Terminal-based (Ink/React-style component tree in `src/ui/`) |
| **Input** | stdin + keybindings within the terminal (`src/ui/promptInput.ts`, `keybindings.test.ts`) |
| **Daemon** | IPC-based job queue for background agent tasks (`src/daemon/`) |
| **Clipboard** | Terminal-only: OSC 52 + native fallback (`src/ui/clipboard.ts`, `clipboard-native.ts`) |
| **Audio** | None — zero audio capture infrastructure |
| **OS Hooks** | None — no global keyboard hooks, no accessibility API usage |
| **Text Injection** | None — writes to own TUI only, never to other applications |
| **Native Addons** | None — pure Node.js with zero N-API/C++/Rust bindings |

### 1.2 What Babel Excels At (Relevant to Voice)

| Capability | Status | Relevance to Voice |
|------------|--------|-------------------|
| Prompt catalog & skill system | Production-grade (190 entries) | Voice commands could register as skills |
| Behavioral OS rule engine | v11 unified | Voice interaction rules fit naturally |
| Domain architect routing | Working | A "voice input" domain architect is feasible |
| Chat engine (multi-turn agent) | Production-grade | Could accept transcribed text as input |
| Daemon infrastructure | Phase 0-13 complete | Could host voice pipeline as background service |
| Streaming renderer | Production-grade | Could display transcription in real-time |
| Observability (OTLP, metrics) | Working | Voice pipeline observability fits existing patterns |

### 1.3 What's Missing (Voice Prerequisites)

| Capability | Gap Size | Notes |
|------------|----------|-------|
| Audio capture (mic → PCM) | **Massive** | No `node-record-lpcm16`, no MediaRecorder, no audio buffer |
| VAD (Voice Activity Detection) | **Massive** | No Silero, no WebRTC VAD, no ONNX runtime for audio |
| Global keyboard hooks | **Massive** | No CGEventTap, no SetWindowsHookEx, no uiohook-napi |
| Cross-app text injection | **Massive** | No nut-js, no robotjs, no accessibility API usage |
| Foreground app detection | **Massive** | No `active-win`, no NSWorkspace, no GetForegroundWindow |
| Streaming STT client | **None** | Would be new; relatively straightforward WebSocket code |
| LLM refinement pipeline | **Partial** | Existing ChatEngine/API client could be adapted |
| Dual-phase state machine | **None** | Would be new; TypeScript patterns are well-understood |

---

## 2. What the Blueprints Describe

### 2.1 Consensus Architecture (All Four Documents Agree)

```
Microphone (16kHz PCM16)
    → VAD (Silero/WebRTC, 20-40ms frames)
        → Streaming STT (Groq/Deepgram, 150-300ms)
            → [Phase 1] Raw text → immediate injection at caret (~400ms)
            → [Phase 2] Raw text + context → LLM refinement (200-300ms)
                → Safety check (no user typing/IME/focus change)
                    → Replace raw with refined text
                        → Restore clipboard state
```

### 2.2 Key Design Patterns

1. **Dual-Phase Text Insertion**: Raw STT output appears instantly; LLM-refined text replaces it asynchronously. This is the core UX trick for perceived sub-400ms latency.

2. **Clipboard Swap + Caret Algebra**: Rather than keystroke simulation (slow), backup clipboard → write text → simulate paste → restore backup. Track character counts for safe replacement even if user types during refinement.

3. **Foreground App Profiling**: Detect active window (VS Code, Slack, Terminal) → inject domain-specific formatting rules into LLM prompt.

4. **Graceful Degradation**: Cloud STT → local whisper.cpp fallback. Direct accessibility injection → clipboard swap → keystroke simulation. Raw text preserved on refinement failure.

5. **Personal Vocabulary Trie**: Client-side trie for instant snippet expansion, bypassing LLM latency for known terms.

### 2.3 Consensus Feasibility Verdict

**All four documents independently rate feasibility as YELLOW** for pure Node.js CLI/TUI. They all recommend a Tauri/Electron shell for production-grade OS integration. The blockers cited are identical across documents:

1. Wayland/macOS sandbox isolation blocks global input hooks from CLI processes
2. Node.js event loop can't reliably handle real-time audio + keyboard monitoring
3. Cross-app text injection is brittle without native accessibility API access

---

## 3. Gap Analysis: Blueprints vs. Babel

### 3.1 Architectural Surface Mismatch

```
Blueprints target:     Desktop App (Tauri/Electron shell)
                       ↓
                       OS-level hooks (keyboard, accessibility, clipboard)
                       ↓
                       Cross-application text injection
                       ↓
                       System-wide hotkey listening

Babel is:              Terminal TUI (Node.js process in a terminal emulator)
                       ↓
                       stdin/stdout + OSC 52 clipboard
                       ↓
                       Self-contained TUI rendering only
                       ↓
                       Terminal-scoped keybindings only
```

**The gap is not a missing module — it's a different application category.** The blueprints assume a desktop app with native shell; Babel is a terminal app. These are adjacent but not interchangeable.

### 3.2 What Transfers Well

| Blueprint Component | Transferability | Adaptation Needed |
|---------------------|----------------|-------------------|
| Dual-phase state machine | **High** | Same pattern works for TUI-internal text insertion |
| Inference pipeline composition | **High** | STT + LLM pipeline is runtime-agnostic |
| Streaming WebSocket client | **High** | Drop-in for cloud STT providers |
| Personal vocabulary trie | **High** | Same data structure, TUI-scoped |
| Observability architecture | **High** | Fits Babel's existing OTLP/metrics patterns |
| Latency budget framework | **High** | Same math applies to TUI voice input |
| Error/prompt type hierarchy | **Medium** | Patterns match Babel's existing error types |
| Foreground app detection | **Low** | TUI only needs to know its own context |
| OS-level keyboard hooks | **N/A** | Not needed for TUI-only voice input |
| Cross-app text injection | **N/A** | Not needed for TUI-only voice input |
| Tauri/Electron shell | **N/A** | Babel is a TUI; shell would be a different product |

### 3.3 What's Dangerous or Misleading

1. **"Designed TypeScript Modules"**: The code in all four documents uses `execSync` for AppleScript/PowerShell — this blocks the Node.js event loop. Babel's CLAUDE.md explicitly warns against this pattern (`execSync` blocking the event loop was Finding #4 in a prior PR code review). The daemon and clipboard modules use `execSync` only for quick-fire operations with short timeouts; voice dictation's sustained OS interaction would need async alternatives.

2. **"CLI/TUI Implementation Blueprint" framing**: Documents #2, #3, and #4 title themselves as CLI/TUI blueprints but describe a desktop application architecture. The `DualPhaseReplacementHandler` in Doc #2 navigates caret via AppleScript `key code` — this is desktop automation, not TUI rendering. A genuine TUI voice feature would insert text into Babel's own `promptInput.ts` component, not into an external app.

3. **Latency targets assume desktop OS integration**: The sub-700ms P99 targets include ~50ms for text injection. In a TUI, injection into your own prompt is near-instant (microseconds), making the budget easier to hit. But audio capture from within a terminal process adds complexity the blueprints don't address.

4. **Permission model is wrong for TUI**: The blueprints' permission flows (Accessibility, Input Monitoring, Screen Recording) are macOS desktop permission prompts. A TUI app needs only microphone permission — a much simpler flow.

---

## 4. Blueprint-by-Blueprint Assessment

### 4.1 Doc #1: `--Analysis Methodology & Sources--.md`

**Quality**: High. Best methodology disclosure and source labeling discipline (`[PUBLIC]`/`[INFERRED]`/`[THESIS]`). Good latency budget breakdown.

**Babel-relevant strengths**:
- `DualPhaseTextInjector` abstract class is well-designed; the `isReplacementSafe()` + activity monitoring pattern maps cleanly to Babel's existing `ChatEngine` event-driven architecture
- Error type hierarchy (`PermissionDeniedError`, `InjectionFailedError`, `ActivityConflictError`) follows patterns already used in Babel (`babel-cli/src/types/`)
- Latency budget table is actionable; a TUI-only version would be simpler (remove OS injection overhead)

**Babel-irrelevant or misleading**:
- `ForegroundAppDetector` is unnecessary for TUI-only voice
- Platform feasibility matrix over-emphasizes cross-app injection hurdles that don't apply
- Tauri/Electron recommendation is correct for their target but wrong for Babel's TUI

**Verdict**: Best reference for the dual-phase state machine and inference pipeline. Ignore the OS integration surface.

### 4.2 Doc #2: `Wispr Flow Technical Teardown.md`

**Quality**: High detail on caret algebra and clipboard mechanics. Most technically precise on the replacement math. Good sources (51 citations).

**Babel-relevant strengths**:
- Caret displacement algebra (P₀, P₁, P₂, N_raw, M, N_refined) is elegantly formalized — this is directly applicable to tracking cursor position in Babel's `promptInput.ts`
- Trie-based local expansion is a clean, self-contained module Babel could use
- ASR phonetic biasing pattern ("git diff" vs "get diff") is relevant for code-specific voice input
- Claude Code v2.1.83 regression note (§Fragility of Keystroke Simulation) is directly relevant — it documents exactly how terminal apps block simulated input

**Babel-irrelevant or misleading**:
- `DualPhaseReplacementHandler` navigates caret via AppleScript `key code 123`/`key code 124` — this only works for external apps, not within Babel's own TUI
- C++ `SetWindowsHookEx` examples are desktop-only
- Accessibility API scraping (AXUIElement, UI Automation) is overkill for TUI-only context

**Verdict**: Best reference for the caret algebra, trie expansion, and ASR biasing. The Claude Code regression note is a critical warning. Ignore the OS hook code.

### 4.3 Doc #3: `Voice Dictation Architecture Blueprint.md`

**Quality**: Solid. Good state machine table and permission resolution path. Most balanced trade-off analysis.

**Babel-relevant strengths**:
- State machine table (IDLE → RECORDING → RAW_INSERTING → RAW_INSERTED → REFINING → REPLACING → COMPLETED/ABORTED) is the clearest of the four documents
- IME composition detection is relevant — Babel's `promptInput.ts` handles IME, and voice input would need to coordinate
- Multi-cursor layout awareness is relevant for code editors
- `INativeInputBridge` interface is a good abstraction pattern (would simplify to just "insert into TUI prompt")

**Babel-irrelevant or misleading**:
- "Custom Dictionary Hierarchy" assumes external app context injection
- Platform feasibility matrix focuses on cross-app injection
- OS-level permission diagrams don't apply

**Verdict**: Best state machine specification. Best interface abstraction patterns. Ignore the OS permission architecture.

### 4.4 Doc #4: `Production-Grade Prompt_ Black-Box Architecture ....md`

**Quality**: Good on inference comparison and LLM tuning parameters. Strongest on the local vs. cloud trade-off analysis.

**Babel-relevant strengths**:
- LLM tuning parameters (temperature 0.0, inline prompts, 150+ tokens/sec target) are directly applicable
- Telemetry tracker pattern (`audio_ended`, `stt_first_token`, `llm_first_token`, `phase_2_complete`) fits Babel's existing observability
- "Levenshtein distance diff minimization" for minimal edits is an elegant approach for code-specific voice input
- Local-first hybrid setup section is directly relevant for privacy-conscious Babel users

**Babel-irrelevant or misleading**:
- `CrossPlatformAppDetector` with hardcoded mock returns is placeholder-quality
- Component topology diagram assumes external app injection
- Phase matrix overestimates complexity for TUI-only scope

**Verdict**: Best inference tuning reference. Best local/cloud trade-off analysis. The `DualPhaseTextInjector` class skeleton is the weakest of the four (stub methods, no safety checks).

---

## 5. If Babel Adds Voice: Recommended Architecture

### 5.1 Scope Decision: TUI-Only vs. System-Wide

| Approach | Scope | Complexity | Risk | Recommendation |
|----------|-------|-----------|------|----------------|
| **TUI-only voice input** | Voice → Babel prompt | Low-Medium | Low | **START HERE** |
| **System-wide dictation** | Voice → any app | High-Very High | High | Separate product |

**Rationale**: Babel is a coding agent TUI. Voice input into the chat prompt is the natural feature — dictate your question/instruction instead of typing it. System-wide dictation (voice into VS Code, Slack, etc.) is a different product that happens to share the STT+LLM pipeline.

### 5.2 TUI-Only Voice: What Changes from the Blueprints

What the blueprints describe → What Babel actually needs:

```
Blueprint: Mic → VAD → cloud STT → [Phase 1: inject raw into external app]
                                       → [Phase 2: replace with refined in external app]
                                           → caret tracking + clipboard swap + safety checks

Babel:     Mic → VAD → cloud STT → [Phase 1: stream raw into Babel's promptInput]
                                       → [Phase 2: replace with refined in promptInput]
                                           → simple string replace (no caret algebra needed!)
```

The dual-phase pattern still applies, but:
- No clipboard swap needed (write directly to React state)
- No caret algebra needed (track insertion offset in promptInput value)
- No OS permissions needed beyond microphone
- No foreground app detection needed
- Safety checks reduce to: "is the user currently typing in the prompt?" (trivial with React state)

### 5.3 What Babel Already Has That Helps

| Babel Component | How It Helps Voice |
|-----------------|-------------------|
| `ChatEngine` (`chatEngine.ts`) | Multi-turn agent loop already handles streaming text; could accept transcribed input |
| `PromptInput` (`promptInput.ts`) | React component with controlled value; insert transcribed text programmatically |
| `Daemon` (`daemon/main.ts`) | Could host voice pipeline as a background service, keeping TUI responsive |
| `TwoRegionStreaming` | Could render transcription in one region while showing chat in another |
| `ConversationalRenderer` | Already handles streaming tool output; transcription streaming fits this pattern |
| `InlineAutocomplete` (`inlineAutocomplete.ts`) | Could suggest voice commands while transcribing |
| OTLP/metrics (`evidence.ts`) | Voice pipeline observability slots in directly |
| Skill system (`02_Skills/`) | "Voice input" could be a skill; voice commands could route through existing skill dispatch |

### 5.4 Recommended Phase Matrix (TUI-Only Voice)

| Phase | What | Est. Days | Depends On |
|-------|------|-----------|------------|
| **0** | Mic capture + VAD in Node worker thread | 3-5 | `node-record-lpcm16`, Silero ONNX |
| **1** | Streaming STT client (WebSocket → Groq/Deepgram) | 2-3 | Phase 0 |
| **2** | Raw transcription → promptInput insertion | 1-2 | Phase 1, `promptInput.ts` |
| **3** | LLM refinement pass (cleanup + formatting) | 2-3 | Phase 2 |
| **4** | Dual-phase replace in promptInput | 1-2 | Phase 3 |
| **5** | Voice command routing (skill dispatch) | 3-5 | Phase 4, prompt catalog |
| **6** | Local fallback (whisper.cpp) | 3-5 | Phase 0 |
| **7** | Observability + error handling | 2-3 | All above |

**Total**: ~17-28 senior engineer days for production-grade TUI-only voice input.

### 5.5 Where the Blueprints' Code IS Usable

The following modules can be adapted with minimal changes:

1. **`DualPhaseTextInjector` state machine** (Doc #1, ~150 lines) — replace `doRawInsert`/`doPreciseReplace` with promptInput state setters instead of OS automation
2. **Error type hierarchy** (Doc #1, `errors.ts`) — drop `ActivityConflictError` (no external app to conflict with), keep `PermissionDeniedError` for mic access
3. **Personal vocabulary trie** (Doc #2, trie structure) — direct reuse
4. **Inference pipeline latency budget** (all docs) — drop injection overhead, keep STT+LLM budget
5. **Telemetry tracker** (Doc #4) — direct reuse with Babel's existing metrics

The following modules should NOT be used:

1. **All `ForegroundAppDetector` implementations** — irrelevant for TUI-only
2. **All OS hook code** (CGEventTap, SetWindowsHookEx, uiohook) — irrelevant for TUI-only
3. **All clipboard swap code** (backup/restore patterns) — irrelevant for TUI-only
4. **All caret algebra** (AppleScript key codes, PowerShell SendKeys) — irrelevant for TUI-only
5. **All accessibility API scraping** — irrelevant for TUI-only
6. **All Tauri/Electron packaging recommendations** — different product category

---

## 6. If Babel Adds System-Wide Voice: The Honest Assessment

If the goal is truly system-wide dictation (voice into ANY app, Wispr Flow-style):

1. **Do not build it inside the Babel TUI**. The blueprints are unanimous on this point: pure Node.js CLI/TUI cannot reliably do system-wide input hooks and cross-app injection. All four documents rate this YELLOW and recommend Tauri/Electron.

2. **Extract the STT+LLM pipeline as a shared library**. The inference pipeline (audio → STT → LLM → text) is the reusable core. Both a TUI voice input and a system-wide dictation tool would share it.

3. **Build the system-wide tool as a separate Tauri/Electron app**. It would use Babel's prompt catalog and skill system for voice command routing, but its OS integration surface is fundamentally different from the TUI.

4. **The daemon could bridge them**. Babel's existing daemon infrastructure could serve as the IPC layer between the TUI and the system-wide dictation tool, sharing the STT+LLM pipeline.

---

## 7. Key Risks the Blueprints Identify (That Apply Even to TUI-Only)

1. **Node.js event loop blocking** (all docs): Audio capture + VAD + WebSocket streaming in the main thread will cause UI stutter. Mitigation: Worker threads for audio/VAD, exactly as the blueprints recommend.

2. **IME composition conflicts** (Docs #2, #3): If the user has an IME active in the prompt, inserting transcribed text can corrupt the composition buffer. Mitigation: Detect IME active state and defer insertion (Babel's `promptInput.ts` likely already tracks this).

3. **Network latency spikes** (all docs): Cloud STT is fast but variable. Mitigation: Local whisper.cpp fallback for offline/privacy-sensitive users. The blueprints' local-first analysis is directly applicable.

4. **Cold-start for local models** (Docs #2, #3, #4): whisper.cpp model loading takes 1.2-3.5s. Mitigation: Persistent worker process with preloaded model, exactly as the blueprints recommend.

---

## 8. Recommendations

### 8.1 For the Planned Voice Feature

1. **Clarify scope first**: Is this "voice input into Babel's chat prompt" or "voice dictation into any app on the system"? The implementation path diverges radically.

2. **Start TUI-only**: Build voice input into Babel's own prompt first. This validates the STT+LLM pipeline, the dual-phase UX, and the voice command routing — all without the OS integration minefield.

3. **Reuse the inference pipeline design**: The STT → LLM architecture in these blueprints is sound. The streaming WebSocket client, latency budget, and error handling patterns are production-grade.

4. **Use Babel's existing patterns**: Register voice as a skill in `prompt_catalog.yaml`, add a "Voice Input" domain architect, use the daemon for the audio worker, and integrate with `promptInput.ts` for text insertion.

5. **Keep the blueprints as reference**: They're excellent for the inference pipeline, state machine, vocabulary trie, and observability design. Bookmark them for those sections.

### 8.2 What NOT to Do

1. **Do not implement the OS hook code** (CGEventTap, SetWindowsHookEx, accessibility scraping) — it doesn't apply to Babel's TUI.
2. **Do not use `execSync` for sustained operations** — the blueprints' AppleScript/PowerShell patterns would block Babel's event loop.
3. **Do not add Tauri/Electron as a Babel dependency** — if system-wide dictation is needed, build it as a separate tool that consumes Babel's shared pipeline library.
4. **Do not implement the clipboard swap pattern** — Babel controls its own prompt state; direct string insertion is simpler and faster.

### 8.3 Quick Wins (What Could Ship Fast)

1. **Hotkey-triggered voice input in the TUI prompt**: Hold a key → mic activates → transcribed text appears in prompt → release key → LLM refines. No OS hooks needed (keybinding within Babel's existing `keybindings` system). No cross-app injection. Just audio → STT → promptInput value.

2. **Voice command routing**: "babel fix the bug on line 42" spoken → STT → routed through existing ChatEngine. This is essentially the existing chat mode with audio input instead of keyboard input.

---

## 9. Document Quality Assessment

| Document | Technical Accuracy | Source Rigor | Code Quality | Babel Relevance |
|----------|-------------------|--------------|--------------|-----------------|
| Doc #1 (Analysis Methodology) | High | **Excellent** (labeled claims) | Good (abstract class, error types) | Medium (inference pipeline + state machine) |
| Doc #2 (Wispr Flow Teardown) | High | Excellent (51 citations) | Mixed (execSync-heavy, desktop-only) | Low-Medium (caret algebra, trie, ASR biasing) |
| Doc #3 (Voice Dictation Blueprint) | High | Good (51 citations) | Good (interface abstractions) | Medium (state machine, INativeInputBridge) |
| Doc #4 (Production Prompt) | Medium-High | Adequate (fewer citations) | Weak (stub methods, hardcoded mocks) | Low-Medium (inference tuning, telemetry) |

**Overall**: These are well-researched, production-grade blueprints for building a Wispr Flow competitor. They accurately identify that pure Node.js CLI/TUI is the wrong substrate for system-wide dictation. For Babel's purposes, the inference pipeline design, state machine, and vocabulary trie are the reusable core. The OS integration surface should be treated as reference material for a future separate product, not as implementation guidance for Babel itself.

---

*Audit complete. Cross-reference: Babel's CLAUDE.md invariants, `babel-cli/CLAUDE.md` coding standards, `prompt_catalog.yaml` skill registration patterns, `TUI_COMPETITIVE_REFERENCE.md` roadmap.*
