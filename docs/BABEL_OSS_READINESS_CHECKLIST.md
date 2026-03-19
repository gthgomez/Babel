# Babel OSS Readiness Checklist

## Goal

Before open-sourcing, Babel should present as a portable, testable, model-agnostic instruction control plane for coding and research agents.

Babel should not look like:
- a folder of private prompt notes
- a workstation-bound personal setup
- a project-specific prompt dump
- an untested routing concept

## Target Open-Source Shape

Babel should be understandable as:
- a layered prompt operating system
- a routing and instruction-assembly framework
- a reusable control plane for multi-model agent workflows

## Release Gate

Do not publicly release Babel until all critical items below are complete.

## 1. Product Definition

### Required

- [ ] One-sentence positioning exists and is stable.
- [ ] README explains what Babel is not.
- [ ] Public terminology is consistent:
  - router
  - behavioral OS
  - domain architect
  - model adapter
  - project overlay
  - task overlay
- [ ] Public examples match the actual architecture.

### Target Outcome

Anyone landing on the repo should understand Babel in under 2 minutes.

## 2. Portability

### Required

- [ ] Core usage does not require hardcoded local machine paths.
- [ ] Absolute path assumptions are either removed from the public core or clearly isolated as local-runtime contracts.
- [ ] Root-relative path resolution strategy is documented.
- [ ] Windows-first assumptions are documented where they still exist.
- [ ] Public docs use relative links only.

### Target Outcome

An external user can understand and adopt Babel without sharing your workstation layout.

## 3. Repo Hygiene

### Required

- [ ] `README.md`
- [ ] `LICENSE`
- [ ] `CONTRIBUTING.md`
- [ ] `GOVERNANCE.md`
- [ ] `PROJECT_CONTEXT.md`
- [ ] `BABEL_BIBLE.md`
- [ ] `.gitignore`
- [ ] `.gitattributes`
- [ ] CI validation workflow

### Target Outcome

The repo looks like maintained software, not an internal scratchpad.

## 4. Catalog Integrity

### Required

- [ ] Every `path:` entry in `prompt_catalog.yaml` resolves.
- [ ] Every catalog ID is unique.
- [ ] Deprecated entries are labeled clearly.
- [ ] New routable assets are registered.
- [ ] Catalog schema expectations are documented.

### Target Outcome

The catalog is trustworthy as the source of truth for the stack.

## 5. Routing Reliability

### Required

- [ ] The orchestrator supports optional task overlays intentionally.
- [ ] The router has test fixtures for representative tasks.
- [ ] Model-selection heuristics are documented and stable.
- [ ] Layer precedence rules are explicit.
- [ ] Failure behavior for missing files or invalid catalog entries is defined.

### Suggested Fixture Set

- [ ] frontend refactor task
- [ ] backend auth task
- [ ] compliance question
- [ ] research synthesis task
- [ ] project-specific frontend polish task

### Target Outcome

Router behavior is predictable enough to trust under change.

## 6. Testing

### Required

- [ ] Catalog validator exists and runs in CI.
- [ ] Router regression tests exist.
- [ ] Manifest assembly tests exist.
- [ ] At least one golden-output fixture per major task category exists.

### Target Outcome

Prompt-system changes become observable and reviewable.

## 7. Layer Discipline

### Required

- [ ] Behavioral OS contains only behavioral rules.
- [ ] Domain architects contain only broad primary expertise.
- [ ] Model adapters contain style and execution-shape guidance only.
- [ ] Project overlays remain thin and repo-specific.
- [ ] Task overlays remain optional and bounded.
- [ ] Weaker layers do not override stronger layers.

### Target Outcome

Babel stays composable instead of collapsing into prompt sprawl.

## 8. Public Core vs Private Content

### Required

- [ ] Decide what belongs in the public core.
- [ ] Decide what remains private or moves to examples.
- [ ] Project-specific overlays are reviewed for sensitive internal assumptions.
- [ ] Generated manifests are either excluded or clearly marked as generated.

### Recommended Public-Core Contents

- router
- behavioral OS
- domain architects
- model adapters
- generic task overlays
- validator
- examples

### Recommended Private/Example Contents

- private project overlays
- internal naming conventions
- workstation-specific assumptions
- generated manifests if they are not meant to be edited

### Target Outcome

The public repo exposes the framework, not your entire private operating environment.

## 9. Documentation Quality

### Required

- [ ] Architecture document exists.
- [ ] Layering document exists.
- [ ] Usage examples exist for Codex, GPT, Claude, and Gemini.
- [ ] Bible doc is short enough to be practical.
- [ ] Public docs explain how to extend Babel safely.

### Target Outcome

A new user can invoke Babel without needing your personal explanations.

## 10. Positioning Against Adjacent Tools

### Required

- [ ] README clarifies how Babel differs from prompt storage tools.
- [ ] README clarifies how Babel differs from eval tools.
- [ ] README clarifies how Babel differs from prompt programming frameworks.

### Nearby Categories To Position Against

- prompt evaluation and regression tools
- prompt management and observability platforms
- prompt-as-code / typed prompt frameworks
- agent orchestration frameworks

### Target Outcome

Babel has a distinct identity instead of sounding like a vague prompt toolkit.

## 11. Security and Privacy Posture

### Required

- [ ] Public docs describe what Babel does and does not do with data.
- [ ] Repo avoids encouraging unsafe data-sharing patterns.
- [ ] Examples avoid embedding secrets or private environment details.
- [ ] Capability-aware evidence rules are documented.

### Target Outcome

Open-source users can adopt Babel without inheriting bad operational habits.

## 12. Versioning and Release Discipline

### Required

- [ ] Versioning policy exists.
- [ ] Changelog exists before first public release.
- [ ] Breaking changes to router/catalog/layer contracts are documented.
- [ ] Release tags are planned.

### Target Outcome

External users can depend on Babel without guessing what changed.

## 13. Minimum Open-Source Release Recommendation

Release only when these are true:

- [ ] catalog validation is automated
- [ ] router behavior has regression fixtures
- [ ] docs are GitHub-safe
- [ ] public/private split is intentional
- [ ] positioning is clear
- [ ] layer precedence is explicit
- [ ] portability story is acceptable

## Current Recommendation

Short term:
- use Babel internally and on personal projects immediately

Before public release:
- harden routing tests
- improve portability
- separate public core from private overlays
- add architecture docs and examples

## Suggested Public Positioning

Preferred positioning:

`Babel is a layered instruction control plane for multi-model coding and research agents.`

Avoid weaker positioning like:
- prompt library
- prompt notes
- prompt manager
- personal AI workflow folder
