# Product visuals (screenshots & recordings)

**Maintainer runbook.** The README “See Babel in action” section now shows a real offline CLI inspection capture, with stdout, source metadata, and reproduction scripts under `docs/assets/showcase/`. It is paced transcript playback, not an interactive TUI session or completed coding task. A real model-backed TUI capture remains future work.

This file is for maintainers producing assets. Do not link it from the product front door as a user-facing invite.

## Target assets

| File | Purpose |
|------|---------|
| `docs/assets/tui-chat.png` | Primary README screenshot (chat session) |
| `docs/assets/tui-chat.webm` (optional) | Short 10–30s terminal recording |

Suggested image width: ~1200–1600px. Prefer a readable font and cropped terminal chrome.

## Capture procedure (maintainer)

1. Build Babel from a clean clone (`START_HERE.md`).
2. Use a throwaway or public demo repo (no secrets, no private paths).
3. Set `BABEL_EXECUTION_PROFILE=dev_local` only if appropriate for that repo.
4. Start: `node ./babel-cli/dist/index.js interactive`
5. Run a short, legible task (for example: explain repo layout, or fix a tiny failing test).
6. Capture:
   - **Screenshot:** native OS tool or `screencapture` / Win+Shift+S; save as `docs/assets/tui-chat.png`
   - **Recording (optional):** asciinema, VHS, or OS screen recorder → `docs/assets/tui-chat.webm`
7. Open a docs PR that:
   - adds the asset file(s);
   - updates the README media with an image/video embed from the repo root;
   - states the captured revision, runtime, provider/fixture scope, and limitations;
   - preserves the offline inspection capture's provenance when replacing its front-door preview.

## README embed (after capture)

From the repository root `README.md`, embed the screenshot with a normal Markdown image whose target is the path `docs/assets/tui-chat.png` (relative to repo root).

For a short recording, link or embed `docs/assets/tui-chat.webm` the same way, using the GitHub raw URL for this repository if needed.

Do not commit placeholder image binaries.

## Rules

- Never fabricate a screenshot, recording, benchmark, or “sample output” presented as live.
- Redact API keys, tokens, machine paths, and private project names before committing.
- Prefer boring, real sessions over theatrical demos.
