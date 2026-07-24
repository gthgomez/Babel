# Skill System Bridge

<!--
status: ACTIVE
last_verified: 2026-07-03
-->
Babel has two skill surfaces by design. They serve different parts of the system and should stay separate unless a skill has an explicit bridge contract.

## Surfaces

`02_Skills/` is the prompt-layer skill catalog. Use it for routable Babel prompt assets that participate in layer ordering, stack assembly, and catalog validation.

Ownership:

- Registered in `prompt_catalog.yaml` (the sole catalog — a former secondary mirror was eliminated 2026-06-29).
- Organized by Babel task domain, such as `Governance`, `Mobile`, `UI`, or `Lang`.
- Written as prompt guidance for Babel's control plane.

`skills/` is the package-style reusable skill library. Use it for portable, tool-like workflows that can carry a `SKILL.md`, metadata, schemas, examples, and validation fixtures.

Ownership:

- One directory per package skill.
- Each package skill must include `SKILL.md` and `skill.yaml`.
- Contracts live in `contracts/`.
- Examples live in `examples/`.
- Validation notes or fixtures live in `tests/`.

## Add Decision

Add to `02_Skills/` when the asset needs catalog routing, prompt-stack selection, or Babel layer semantics.

Add to `skills/` when the asset needs reusable packaging, structured input/output contracts, or examples that can travel outside a single Babel prompt layer.

Use both only when the skill needs both a prompt-routing surface and a reusable package surface. In that case, pick one canonical owner and add a bridge note in both assets.

## Bridge Rules

When bridging from `skills/` to `02_Skills/`:

- Keep `skills/<name>/` as the reusable package owner.
- Add a thin prompt-layer skill in `02_Skills/<Domain>/`.
- Register the prompt-layer skill in `prompt_catalog.yaml`.
- Include a short "Package bridge" note that points to `skills/<name>/`.
- Do not copy schemas or examples into `02_Skills/`; link to the package skill instead.

When bridging from `02_Skills/` to `skills/`:

- Keep the prompt-layer skill as the routing owner.
- Add a package skill only for reusable contracts, tests, or examples.
- Name the package skill with a stable kebab-case directory.
- Include a short "Prompt bridge" note that points to the prompt-layer skill and catalog id.

When a skill appears in both systems:

- The prompt-layer asset owns routing and layer behavior.
- The package asset owns reusable workflow packaging and contracts.
- Metadata must name the bridge target explicitly.
- Validation must include catalog validation plus package boundary checks.

## Naming

Prompt-layer files use Babel's existing title-case domain organization and version suffixes where needed, for example `02_Skills/Mobile/Android-UI-Audit-Review-v2.md`.

Package skills use lowercase kebab-case directories, for example `skills/react-nextjs/`.

Do not create package-skill directories under `02_Skills/`. Do not create prompt catalog files under `skills/`.

## Validation

Run these checks after changing either surface:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\validate-catalog.ps1
powershell -ExecutionPolicy Bypass -File .\tools\audit-skill-disk-drift.ps1
powershell -ExecutionPolicy Bypass -File .\tools\test-skill-surface-boundaries.ps1
```

The first check protects Babel prompt routing. The second catches unregistered `02_Skills/**/*.md` files (active tree only; `archive/02_Skills/` is excluded from the scan). The third check protects the package/prompt boundary.
