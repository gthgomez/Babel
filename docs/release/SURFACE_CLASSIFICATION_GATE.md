# Surface Classification Gate

<!--
status: ACTIVE
last_verified: 2026-07-24
-->
Before major editing or reorganization work, classify the target surface.

Use one of these values:

- `development`
- `internal_shared`
- `public_release`
- `release_artifact`

## Surface Rules

### `development`

Use for sandbox or local experimentation.

- Optimize for correctness and usefulness
- Content is expected to be rough or incomplete
- Do not promote to `public_release` without review

### `internal_shared`

Use for trusted internal sharing that is not fully public.

- Reduce obvious secrets if needed
- Keep operational value higher than presentational polish

### `public_release`

Use for content intended for the public canonical repo.

- Verify no environment-specific identifiers, local paths, or credentials remain
- Replace specific identifiers with examples or placeholders
- Review for clarity and safety before submitting

### `release_artifact`

Use for release notes, README, `START_HERE.md`, examples, and other public-facing assets.

- Optimize for clarity, first success, and safety
- Teach the current CLI surfaces (`babel "<task>"`, `babel plan`, `babel deep`,
  `babel chat-headless`) and the current runtime architecture; never teach removed
  surfaces (Lite/Full/`bl`/Lite-era verbs) as active
- Do not describe retired orchestrator versions (`v8`) as an active compatibility fallback
- Do not add operator context or system-specific details

## Default Rule

When in doubt, default to `development` classification. Promote content to `public_release` only after review against the content guidelines in this directory.
