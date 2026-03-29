<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE
-->

# Babel OSS Readiness Checklist

Use this checklist before public release.

## Product

- [ ] The repo explains Babel in under 2 minutes
- [ ] `README.md` and `START_HERE.md` stay benefit-first
- [ ] `v9` is the visible default story
- [ ] `v8` stays in the background as compatibility-only

## Safety

- [ ] `pwsh -File tools\validate-public-release.ps1` passes
- [ ] No private repo names, app names, local paths, package IDs, SKUs, or deployment URLs remain
- [ ] Example overlays remain example overlays

## Integrity

- [ ] `pwsh -File tools\validate-catalog.ps1` passes
- [ ] Public docs do not point to missing local files
- [ ] README examples and architecture docs match the exported repo

## Runtime

- [ ] Backend preview matches `examples/manifest-previews/backend-verified.json`
- [ ] Android/mobile preview matches `examples/manifest-previews/mobile-pdf-direct.json`
- [ ] `npm run test:orchestrator-routing` passes in `babel-cli`
- [ ] `npm run test:resolver` passes in `babel-cli`
- [ ] `npm run test:manifest-preview` passes in `babel-cli`
- [ ] `npm run test:mcp-adapter` passes in `babel-cli`

## Release

- [ ] release notes are ready in `docs/releases/`
- [ ] `REPO_ROLE.md` reflects the public-export role
- [ ] the repo is ready for git init / remote attach / commit / tag
