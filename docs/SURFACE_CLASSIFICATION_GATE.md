# Surface Classification Gate

Before major edit, release, anonymization, or hardening work, classify the target surface.

Use one of these values:

- `private_source`
- `internal_shared`
- `public_export`
- `release_artifact`

## Surface Rules

### `private_source`

Use for the real working Babel repo.

- Preserve real overlays, personal context, and private operating knowledge
- Do not anonymize by default
- Optimize for correctness, leverage, and owner usefulness

### `internal_shared`

Use for trusted internal sharing that is not fully public.

- Reduce obvious secrets if needed
- Do not flatten private context just for presentational polish
- Keep operational value higher than publishability

### `public_export`

Use for the sanitized public repo.

- Sanitize aggressively
- Replace private identifiers with examples or placeholders
- Keep only public-safe overlays, examples, docs, and runtime surfaces
- Run the public export checklist before release

### `release_artifact`

Use for release notes, README, `START_HERE.md`, examples, and other public-facing assets.

- Optimize for clarity, first success, and safety
- Keep `v9` as the visible default story
- Keep `v8` in the background
- Do not add operator context or private system details

## Default Rule

When operating in this repo root, default to `private_source` unless the user explicitly says you are working on `Babel-public` or a public export lane.

If the surface is unclear, stop and ask, or recommend the private-to-public export workflow instead of making destructive changes.
