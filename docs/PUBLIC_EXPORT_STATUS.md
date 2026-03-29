# Public Export Status

Generated from Babel-private at $generatedAt.

This tree was created by `tools/export-babel-public.ps1`.

Next steps:

1. Review public-facing docs, examples, and golden manifest previews
2. Run `pwsh -File tools\validate-public-release.ps1`
3. Run `pwsh -File tools\resolve-local-stack.ps1 -TaskCategory backend -Project example_saas_backend -Model codex -PipelineMode verified -Format json`
4. Compare the output to `examples/manifest-previews/backend-verified.json`
5. Keep final public-only hardening edits in `Babel-public`, not `Babel-private`
