# Product visuals (screenshots & recordings)

The README “See Babel in action” section should eventually show a **real** Babel TUI capture. Until one exists, the README keeps an **illustrative** transcript and must not embed fake imagery.

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
   - replaces the illustrative transcript in `README.md` with an image/video embed;
   - removes the “illustrative” wording once the asset is authentic.

## README embed (after capture)

```markdown
![Babel TUI chat session](./docs/assets/tui-chat.png)
```

or for video:

```markdown
https://github.com/gthgomez/Babel/raw/main/docs/assets/tui-chat.webm
```

## Rules

- Never fabricate a screenshot, recording, benchmark, or “sample output” presented as live.
- Redact API keys, tokens, machine paths, and private project names before committing.
- Prefer boring, real sessions over theatrical demos.
