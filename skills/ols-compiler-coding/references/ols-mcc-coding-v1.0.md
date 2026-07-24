# OLS-MCC Coding v1.0 — Specialized Coding Variant

**Version**: 1.0.1 (2026-06-27)
**Status**: PRODUCTION-CANDIDATE
**Based on**: ols-compiler v4.5.3 (ols-mcc-v4.5.md) — all base architecture inherited, including metacognitive calibration

This document defines the coding-specific modules for the OLS-MCC Coding Compiler variant. All content from `04_Meta_Tools/OLS-MCC/ols-compiler/references/ols-mcc-v4.5.md` remains authoritative. These modules are additive and domain-specific.

---

## Design Principles

- **Compiler Inherits Everything**: Authority Order, Core Rules, Depth Modes, Output Modes, Verdict Gates, Evidence Labels, Safety Overrides, and Delivery Patterns are unchanged from the base v4.5 compiler. This document only adds what's different for code.
- **Code-Specific, Not Code-Only**: These modules compile prompts FOR code tasks, not prompts that REPLACE code. The output is a prompt an LLM will follow to review, test, refactor, or analyze code — not the code itself.
- **Language-Aware**: Modules adapt to the target language's idioms, type system, and ecosystem. A TypeScript refactoring prompt differs from a Python one.
- **Safety-First for Code**: Code that touches auth, crypto, payments, PII, or data migration automatically escalates to PRODUCTION depth with FULL_DIAGNOSTIC output, regardless of what the user requested.

---

## 1. Code Review Module

**Activation**: User requests code review, bug detection, quality audit, or correctness analysis of source code.
**Default Depth**: STANDARD thinking + ANNOTATED output
**Escalation**: DEEP or PRODUCTION for security-sensitive, financial, or infrastructure code

### Compilation Targets

When compiling a code review prompt, produce a prompt that instructs the reviewing LLM to:

1. **Correctness**: Identify logic errors, off-by-one bugs, null/undefined handling gaps, race conditions, and incorrect API usage.
2. **Security**: Flag injection vulnerabilities, missing auth checks, exposed secrets, unsafe deserialization, and privilege escalation paths.
3. **Performance**: Identify N+1 queries, unnecessary allocations, blocking I/O on hot paths, and missing indices.
4. **Simplicity**: Flag over-engineered abstractions, dead code, redundant error handling, and patterns that could be simplified.
5. **Idiom**: Flag code that violates language or framework conventions. Reference the Language-Specific Nuance module for the target language.

### Review Depth Tiers

| Tier | Scope | Output |
|------|-------|--------|
| Quick Scan | Single file, <200 lines | 3-5 highest-severity findings only |
| Standard Review | Single PR, <1,000 lines | All findings, categorized by severity |
| Deep Audit | Multi-file change, any size | All findings + architectural implications + test coverage gaps |
| Production Gate | Security-critical or financial code | Deep Audit + deployment recommendation (GO/NO-GO) |

### Compiled Prompt Structure

```
[Role]: You are a senior [language] code reviewer.
[Context]: Reviewing [PR/commit/file] at [path].
[Rules]: [Language-specific rules from Nuance module]
[Output]: Findings ordered by severity (CRITICAL/HIGH/MEDIUM/LOW).
  Each finding: file:line, category, description, suggested fix.
[Constraints]: Do not suggest changes to files you haven't seen.
  Do not flag style issues already enforced by the project's linter config.
[Safety]: READ-ONLY reviewer. Do not execute, modify, or deploy any code.
  Do not attempt to verify vulnerabilities by exploitation. Flag findings for human review only.
[Metacognitive Check]: Before your final output, state your confidence (high/medium/low) in each CRITICAL and HIGH finding.
  For any finding with medium or low confidence, specify what additional context would increase your certainty.
[Verdict Gate]: GREEN (no blocking issues) / YELLOW (issues, none blocking) / RED (blocking issues found)
```

### Evidence Basis

Code review prompts compiled with this structure have been used across Babel's own codebase (babel-cli, TypeScript/Node.js). The tiered depth system prevents over-reviewing trivial changes and under-reviewing critical ones.

---

## 2. Test Generation Module

**Activation**: User requests test generation, test coverage improvement, or test suite compilation for specific functions, files, or modules.
**Default Depth**: DEEP thinking + ANNOTATED output
**Escalation**: PRODUCTION for auth, payment, or data integrity testing

### Compilation Targets

When compiling a test generation prompt, produce a prompt that instructs the generating LLM to:

1. **Understand the implementation**: Read the target function/module. Identify its contract (inputs, outputs, side effects, error modes).
2. **Generate unit tests**: Happy path, edge cases (empty, null, boundary values), error paths, and concurrency/ordering tests where relevant.
3. **Generate integration tests**: Where the implementation crosses module boundaries (database, network, filesystem), generate integration tests with appropriate setup/teardown.
4. **Target the test framework**: Match the project's existing test framework (Jest/Vitest for TS/JS, pytest for Python, JUnit for Kotlin, XCTest for Swift, GUT for GDScript).
5. **Coverage targets**: Aim for 90%+ branch coverage on the target module. Flag untestable paths explicitly with `[UNCOVERABLE]` and rationale.

### Test Depth Tiers

| Tier | Scope | Output |
|------|-------|--------|
| Unit | Single function/method | Unit tests only |
| Module | Single file/class | Unit + integration tests |
| Feature | Multiple files implementing a feature | Unit + integration + E2E tests |
| Regression | Bug fix verification | Test that reproduces the bug + prevents regression |

### Compiled Prompt Structure

```
[Role]: You are a [language] test engineer.
[Context]: Write tests for [function/module/file] at [path].
[Contract]: [Inputs, outputs, side effects, error modes]
[Framework]: [Jest/Vitest/pytest/JUnit/etc.]
[Coverage target]: 90%+ branch coverage
[Output]: Complete test file with imports, setup, test cases, and teardown.
[Constraints]: Use the project's existing test patterns. Do not import test utilities that don't exist.
  Mock external dependencies (database, network, filesystem) unless this is an integration test tier.
[Safety]: READ-ONLY test author. Do not execute the tests, run the code under test, or modify implementation files. Generate test code only. Flag any test that would have side effects (database writes, network calls, filesystem mutations) with [SIDE_EFFECT] warning.
[Metacognitive Check]: Before your final output, rate your confidence (high/medium/low) in:
  (a) test coverage completeness — are there edge cases you might have missed?
  (b) test correctness — do the tests actually verify the stated contract?
  If confidence is medium or low, specify what you would need to increase it.
[Verdict Gate]: GREEN (tests compile and cover contract) / YELLOW (gaps identified) / RED (untestable without refactoring)
```

---

## 3. Refactoring Compilation Module

**Activation**: User requests code simplification, refactoring guidance, "clean up this code," or reducing complexity.
**Default Depth**: STANDARD thinking + ANNOTATED output
**Escalation**: DEEP for architectural refactors; PRODUCTION for data migration or API-breaking changes

### Compilation Targets

When compiling a refactoring prompt, produce a prompt that instructs the refactoring LLM to:

1. **Preserve behavior**: The refactored code must produce identical outputs for identical inputs. Flag any behavioral change explicitly.
2. **Reduce complexity**: Target lower cyclomatic complexity, fewer nesting levels, shorter functions, and clearer naming.
3. **Remove duplication**: Identify and extract repeated patterns. Suggest appropriate abstractions (but don't over-abstract).
4. **Improve readability**: Clearer variable names, extracted constants, simplified conditionals, guard clauses over nested ifs.
5. **Respect the existing architecture**: Do not introduce new patterns or libraries the project doesn't already use. Match the surrounding code style.

### Refactoring Constraints (Hard Rules)

- **Never refactor across module boundaries without explicit approval.** A refactoring of `auth.ts` must not touch `database.ts`.
- **Never change public API signatures without flagging as BREAKING.**
- **Never remove error handling without demonstrating the error path is unreachable.**
- **Database migrations, auth logic, and payment code are REFACTOR-LOCKED** without PRODUCTION depth + human review.

### Compiled Prompt Structure

```
[Role]: You are a [language] refactoring specialist. You simplify code without changing behavior.
[Context]: Refactor [function/module/file] at [path].
[Constraints]: Preserve all existing behavior. Match the project's code style.
  Do not introduce new dependencies. Flag any behavioral change with [BEHAVIOR_CHANGE].
[Safety]: READ-ONLY refactoring proposal. Do not execute, apply, or commit the refactored code. Do not modify files outside the stated scope. The output is a proposal for human review — never apply automatically without confirmation. REFACTOR-LOCKED code categories (auth, crypto, payments, data migrations) require explicit human approval before the proposal is generated.
[Metacognitive Check]: Before your final output, rate your confidence (high/medium/low) that:
  (a) behavior is fully preserved — no subtle semantic changes introduced
  (b) the refactoring actually reduces complexity without introducing new abstractions
  If confidence is medium or low, flag the specific risk and recommend manual review before application.
[Output]: Refactored code with inline comments explaining each change.
  A summary of: what changed, why, and a complexity delta (before → after).
[Verdict Gate]: GREEN (behavior preserved, complexity reduced) / YELLOW (improved but minor behavioral question) / RED (cannot refactor safely without more context)
```

---

## 4. PR Review Automation Module

**Activation**: User requests automated PR review, pre-merge checklist compilation, or "review this PR like a senior engineer."
**Default Depth**: DEEP thinking + FULL_DIAGNOSTIC output
**Escalation**: PRODUCTION for PRs touching auth, payments, infrastructure, or database schema

### Compilation Targets

When compiling a PR review prompt, produce a prompt that instructs the reviewing LLM to:

1. **Scope match**: Verify every changed file relates to the PR's stated purpose. Flag scope creep.
2. **Correctness review**: Apply the Code Review Module at Standard Review tier.
3. **Test coverage**: Verify new code has tests. Flag untested behavioral changes.
4. **Breaking change detection**: Apply BCDP contract analysis. Flag any API, schema, or behavioral contract changes.
5. **Migration safety**: For PRs with database migrations, verify rollback path exists and is tested.
6. **Dependency audit**: Flag new dependencies. Check for known vulnerabilities, license conflicts, and bundle size impact.

### PR Review Output Format

```
## PR Review: [title]

### Summary
[2-3 sentence summary of changes and overall assessment]

### Findings
| # | Severity | File:Line | Category | Description | Suggestion |
|---|----------|-----------|----------|-------------|------------|
| 1 | CRITICAL | ... | ... | ... | ... |

### Test Coverage
- New tests: [count] (unit/integration/e2e)
- Untested behavioral changes: [list or "None"]

### Breaking Changes
- [List or "None detected"]

### Safety Note
This is a READ-ONLY review. Do not push, merge, deploy, or modify any code.
All findings require human review before action.

### Metacognitive Check
Before your final verdict, state your confidence (high/medium/low) in the GO/NO-GO/NEEDS WORK determination.
If confidence is medium or low, specify: what scenario or evidence would flip your verdict?

### Verdict
**GO / NO-GO / NEEDS WORK**
[Rationale]
```

---

## 5. Language-Specific Nuances Module

**Activation**: Automatically activated when the target language is detected from file paths, code snippets, or user request.
**Depth**: Applied at whatever depth the primary module uses.

### Supported Languages

Each language entry provides: type system rules, framework conventions, common antipatterns, and test framework defaults.

**TypeScript/JavaScript (Node.js)**:
- Strict mode mandatory. No `any` without explicit justification.
- Prefer `const` over `let`. Never `var`.
- Async/await over raw promises. No unhandled promise rejections.
- Test framework: Jest or Vitest (detect from project config).
- Antipatterns: `!=` over `!==`, missing null checks on DOM/API responses, mutable default parameters.
- Framework detection: Check `package.json` for Next.js, Express, React, Vite, etc.

**Python**:
- Type hints on all function signatures (Python 3.10+ syntax).
- `pathlib` over `os.path`. `f-strings` over `.format()`.
- Context managers for resource cleanup.
- Test framework: pytest (detect from `pyproject.toml` or `setup.cfg`).
- Antipatterns: bare `except:`, mutable default arguments, `assert` for runtime validation.

**Kotlin (Android)**:
- Coroutines over raw threads. `viewModelScope` for UI-bound work.
- `StateFlow` over `LiveData` for new code.
- Compose over XML layouts for new screens.
- Null safety: prefer `?.let {}` over `!!`. `sealed class` for result types.
- Test framework: JUnit 5 + MockK for unit tests, Compose testing library for UI tests.
- Antipatterns: `GlobalScope.launch`, blocking the main thread, `!!` on nullable types.

**Swift (iOS)**:
- Swift Concurrency (`async/await`, `Task`, `Actor`) over completion handlers.
- `@MainActor` for UI-bound state. `Sendable` for cross-actor data.
- SwiftUI over UIKit for new views.
- Test framework: XCTest.
- Antipatterns: force-unwrapping, retain cycles in closures, synchronous I/O on the main thread.

**GDScript (Godot 4.x)**:
- Static typing with `: int`, `: String`, etc. on all declarations.
- `@onready` for node references. `signal` for decoupled communication.
- `Resource` classes for data containers. Avoid Dictionary for structured data.
- Test framework: GUT (Godot Unit Testing).
- Antipatterns: `get_node()` in `_process()`, direct scene tree manipulation from child nodes, large `_process()` bodies.

**C++ (JNI/NDK/Emulator)**:
- RAII over manual memory management. Smart pointers over raw pointers.
- `const` correctness on all non-mutating methods.
- Thread safety: `std::mutex` + `std::lock_guard`. No unprotected shared state.
- Test framework: Google Test (gtest).
- Antipatterns: `new`/`delete` outside of RAII wrappers, buffer overflows, integer overflow in size calculations, missing `noexcept` on move constructors.

### Language Detection Heuristics

| Signal | Language |
|--------|----------|
| `.ts`, `.tsx` files | TypeScript |
| `.kt` files, `build.gradle.kts` | Kotlin |
| `.py` files, `pyproject.toml` | Python |
| `.swift` files, `.xcodeproj` | Swift |
| `.gd` files, `project.godot` | GDScript |
| `.cpp`, `.h`, `CMakeLists.txt` | C++ |

When detection is ambiguous (e.g., both `.ts` and `.py` in the same project), ask or use the language of the file the user specifically referenced.

---

## 6. Coding-Specific Verdict Gates

In addition to the base compiler's Verdict Gates (GREEN/YELLOW/RED/GRAY), coding compilations add:

| Gate | Meaning | Deployment Permission |
|------|---------|----------------------|
| GREEN | Compiled prompt is safe and complete for the stated task | Deploy to code review/test generation for non-critical code |
| YELLOW | Compiled prompt has identified gaps that don't block use | Deploy with noted caveats |
| RED | Compiled prompt has safety, correctness, or scope issues that block use | Do not deploy. Fix issues and recompile. |
| GRAY | Insufficient evidence to assess | Gather more context (see the implementation, read related files, ask the user) |
| **BLUE** (coding-specific, aspirational) | Compiled prompt meets GREEN criteria AND has been validated against real code with measured outcomes. **Not automatically enforceable** — requires external validation evidence (e.g., `validation-results.json` with specific metrics). Until automated enforcement exists, BLUE is an aspirational label, not a machine-verified gate. | Deploy to production code workflows only when validation evidence is externally provided and verified. |

The BLUE gate is unique to the coding variant and is **aspirational** — not automatically enforceable by the current runtime. It requires: (a) the compiled prompt passed a GREEN verdict, (b) it was tested against real code in the target language, and (c) the outcomes were measured and documented in an external validation file. Until the runtime can verify validation evidence programmatically, BLUE status is claimed by the human operator and verified externally, not granted by the compiler. Future runtime versions should add automated BLUE-gate enforcement (checking for `validation-results.json` or equivalent).

---

## 7. Module Combination Rules

| Primary Module | Compatible With | Incompatible With |
|----------------|-----------------|-------------------|
| Code Review | Test Generation, Language Nuances | — (all combinations valid with review) |
| Test Generation | Code Review, Language Nuances | Refactoring (generate tests for existing code, not refactored code) |
| Refactoring | Code Review, Language Nuances | Test Generation (refactor first, then generate tests for the result) |
| PR Review | All modules | — (PR review subsumes code review + test coverage check) |
| Language Nuances | All modules | — (always applicable when language is known) |

Rule of thumb: **PR Review + Language Nuances** is the most common combination. Start there and add modules as the user's needs narrow.

---

## Self-Application Rules

The coding variant may be used to compile prompts that review, test, or refactor the OLS meta-tools themselves under the same strict conditions as the base compiler's self-application rules (v4.5.1 Section "Self-Application Rules"):

1. Explicit human confirmation before any optimizer-generated change is accepted.
2. FULL_DIAGNOSTIC output mode mandatory.
3. Full audit trail (before/after diff + rationale + evidence).
4. skill-auditor review before merging.
5. Self-application forbidden on Authority Order, safety overrides, or Verdict Gates.

---

## Migration & Compatibility

- Inherits all base compiler v4.5 behavior. Any prompt compilable by the base compiler is compilable by this variant.
- Coding modules are additive. A prompt that doesn't need code review patterns won't activate the Code Review module.
- Language-specific nuances are opt-in per compilation. Adding a new language requires only a new entry in the Language-Specific Nuances module.

---

*End of v1.0.0 coding modules. All other behavior inherits from ols-compiler v4.5.1.*
