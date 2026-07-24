# OLS Compiler & Meta-Layer Changelog

All notable changes to the ols-compiler skill, ols-mcc reference, and OLS Meta-Meta Standards are documented here.

## [v4.4.1] - 2026-06-26

### Added
- New authoritative reference: `ols-meta-meta-standards.md` (v1.0) — consolidates higher-order principles for skill architecture, progressive disclosure, robustness sections, create → test → audit loop, and production bias for meta work.
- **Migration Guide** section inside `ols-meta-meta-standards.md` with high-level summary of v4.3 → v4.4.1 changes and quick-start guidance.
- `CHANGELOG.md` for easier long-term tracking.
- Explicit references to `ols-meta-meta-standards.md` in:
  - `ols-compiler/SKILL.md` (meta-meta work section and “Do not duplicate” paragraph)
  - `ols-mcc-v4.4.md` (Audit Framework checklist)
  - `skill-auditor/SKILL.md` description and `audit-criteria.md`

### Changed
- ols-compiler skill officially marked **PRODUCTION-CANDIDATE**.
- Minor polish to MINIMAL safety override wording (“suppress or circumvent” for clarity).
- Self-Test Battery item #3 clarified with explicit sequencing for `ARCHITECTURE_GAP`.

### Fixed / Hardened (from v4.3 Architecture Critique)
- Nomenclature collision between Depth and Output modes → resolved with orthogonal axes (`THINKING_DEPTH` vs `OUTPUT_DETAIL`).
- DRY violation in SKILL.md → eliminated (pure lean activation layer).
- Overlap between Output Modes and Output Patterns sections → merged for single source of truth.
- Fallback behavior in SKILL.md → made more precise and non-silent.
- MINIMAL mode safety override → strengthened with concrete decision criteria examples and dangerous combination anti-pattern.

## [v4.4] - 2026-06 (Major Hardening Release)

### Highlights
- Introduced formal orthogonal Output Modes (MINIMAL, ANNOTATED, FULL_DIAGNOSTIC) with non-negotiable safety override.
- Renamed axes for clarity and eliminated user intent ambiguity.
- Merged output-related sections.
- Added Compiler Self-Test Battery.
- SKILL.md refactored to pure router/activation layer.
- Full prompt-tester + skill-auditor validation cycle completed.

---

**Notes**:
- This changelog focuses on meta-layer and compiler changes.
- For detailed technical changes inside `ols-mcc-v4.4.md`, see the Version Notes section at the end of that file.
- Future entries will follow the same minimal, high-signal format.

## [v4.5.3] - 2026-06-27

### Added
- **Metacognitive Verdict Calibration** (Section 11 in ols-mcc-v4.5.md): Four-step metacognitive reflection before every Verdict Gate at DEEP/PRODUCTION depth. Step 1: Initial assessment. Step 2: Counter-evidence reflection ("What could make this verdict wrong?"). Step 3: Knowledge gap inventory with Gap Codes. Step 4: Calibrated verdict with confidence interval. Evidence basis: MetaFaith (EMNLP 2025) — 61% faithfulness gain, 83% human preference.
- **Multi-Perspective Gating Protocol** (Section 11.2): Three independent verdicts from different evaluator framings (Builder, Auditor, Executor) with a gate determination matrix. Majority vote determines final gate; split votes default to YELLOW. Evidence basis: DiNCo (ICLR 2026) — 10x calibration efficiency over single-perspective self-consistency.
- **Cost-Aware Optimization** (Section 8.2): Optimizer objective changed from maximize(performance) to maximize(performance − λ × token_cost). Default λ values by depth: STANDARD=0.01, DEEP=0.005, PRODUCTION=0.001. λ>0.02 requires explicit confirmation. Evidence basis: Promptomatix (Salesforce AI Research, 2025) — λ=0.005 maintains 99.9% peak performance at ~43% length reduction.
- **Metacognitive Output Calibration** (Section 12): Compiler-level injection of a ~50-token metacognitive block into every compiled prompt's output format at STANDARD+ depth. Forces the executing LLM to surface confidence level, counter-evidence, and verification needs before final output.
- **SKILL.md updated**: Verdict Gates bullet now references metacognitive reflection and multi-perspective gating for DEEP/PRODUCTION work.

### Changed
- ols-compiler reference updated from v4.5.1 to v4.5.3.
- ols-compiler-coding variant updated to v1.0.1 — inherits metacognitive calibration from v4.5.3 base. All 4 compiled prompt structures (Code Review, Test Generation, Refactoring, PR Review) now include `[Metacognitive Check]` blocks.
- All changes are additive and backward-compatible. v4.5.1 behavior unchanged at LIGHT/STANDARD depth.

## [v4.5.2] - 2026-06-27

### Added
- **Security Threat Model** (`references/ols-security-model-v1.0.md`): Honest analysis of what Authority Order CAN and CANNOT defend against. Documents indirect prompt injection, multi-turn jailbreaks (Crescendo), token smuggling, steganographic payloads, and compromised tool outputs as attack classes that require Layer 2/3 defenses beyond prompt-level protection. Includes Dynamic Alignment Engine threat model and self-application security analysis.
- **Empirical Validation Register** (`references/ols-empirical-validation-v1.0.md`): Separates [VALIDATED] claims (SKILL.md router pattern, orthogonal axes functional verification, Verdict Gates, file-extension gating) from [INFERRED] design hypotheses (Authority Order prevents injection, Evidence Labels improve calibration, orthogonal axes improve cost/quality, OLS-compiled > hand-written). Includes validation methodology and prioritized experimental roadmap.
- **Meta-Meta Standards elevated**: Added version badge (v1.0.0 PRODUCTION-CANDIDATE), table of contents, and cross-references to new security and empirical documents.

### Changed
- **SKILL.md Boundaries**: Added explicit security claim limitations — "Do not claim OLS's prompt-level defenses provide complete protection against injection." Added empirical claim boundaries — "[INFERRED] design hypotheses unless validated."
- **v4.5 Optimizer Output Requirements**: Eval contracts and regression tests changed from "Suggested" to "Required (mandatory for PRODUCTION depth)." Added post-validation Evidence Label upgrade requirement to `[VALIDATED]`. Added variance acknowledgment and 3-run minimum requirement per GEPA instability findings.

### Fixed
- Addressed gaps identified by multi-agent adversarial review (Academic Researcher, OLS System Expert, Security Specialist) of Grok-4 literature comparison: honest acknowledgment of prompt-level defense limits, empirical grounding for claims, visibility for existing meta-meta infrastructure.

## [v4.5] - 2026-06-27

### Changed
- Wired `ols-compiler/SKILL.md` to default to `references/ols-mcc-v4.5.md` as the primary/ authoritative reference (v4.4 retained strictly for backward compatibility when v4.5 features are not requested).
- Updated all cross-references, depth/output mode selection guidance, "Do not duplicate" sections, Boundaries, Failure Behavior reload instructions, and Strategic Next Move enforcement to point to the v4.5 core.
- ols-compiler skill v4.5 is now fully wired as the production default while preserving opt-in v4.4 paths and full compatibility.