# Example: Android AAB + Multi-Store Release

This is a lightweight example of what Babel changes.

## Without Babel

User request:

```text
Help me prepare my Android app for release as an AAB and ship it to Google Play, Amazon, and Samsung.
```

Typical result:
- The model gives generic Android advice.
- Store policy, packaging, and signing concerns get mixed together.
- Google Play details may dominate while Amazon or Samsung steps get skipped.
- The response depends heavily on which model answered.

## With Babel

Same request, but the model is told:

```text
Read BABEL_BIBLE.md and use Babel before planning or completing this task.
```

Babel routes the task into a structured stack:

- Behavioral OS: enforce plan-first execution and evidence discipline
- Domain Architect: `domain_android_kotlin`
- Skills: `skill_android_app_bundle`, `skill_google_play_store`, `skill_amazon_appstore`, `skill_samsung_galaxy_store`
- Project Overlay: `overlay_example_mobile_suite` when the task belongs to the Android monorepo
- Model Adapter: selected for the active model surface

Why that matters:
- AAB packaging is handled as a packaging/distribution concern, not buried inside general Android advice.
- Google Play, Amazon, and Samsung requirements stay distinct.
- The same task stays consistent across different LLMs because the stack is explicit.

In the public repo, a mobile manifest preview is now a real first-class helper path. For example:

```powershell
pwsh -File .\tools\resolve-local-stack.ps1 `
  -TaskCategory mobile `
  -Project example_mobile_suite `
  -Model codex `
  -Format json
```

Reference output:

- `examples/manifest-previews/mobile-direct.json`

## Takeaway

Babel does not make the model smarter by magic. It makes the task boundaries, constraints, and reusable protocols explicit so the model is far more likely to behave correctly on the first pass.
