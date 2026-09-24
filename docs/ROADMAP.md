# Public roadmap

**Audience:** developers evaluating Babel and contributors scanning priorities.  
**Updated:** 2026-09-19 (derived from the public tree, open engineering work, and maintainer decisions still pending — **not** a shipped-promise list).

Babel is **pre-1.0**. This page states **product priorities** for the public project. Use the same honesty buckets as [STATUS.md](./STATUS.md) when that page is available on the revision you are reading:

- **Available** — present in the tree / documented as an entrypoint.
- **Narrowly verified** — scoped CI, contracts, or validation evidence.
- **Active qualification** — engineering in progress; **not** a user promise.

**Ordinary coding-loop reliability remains under active qualification.** A mode, route, or CLI command existing is not evidence that everyday repository work is already reliable.

---

## NOW (product focus)

| Priority | Intent | Evidence posture today |
|---|---|---|
| **Reliable ordinary coding loop** | Make chat-mode day-to-day repository work trustworthy and terminal-truthful | **Active qualification** (engineering track) |
| **Honest first-success path** | Clone + build + doctor remains the documented trial path; keep install friction and maturity obvious on the front door | **Available** as clone/build; **no** published npm/npx package yet |
| **Clear maturity language** | Separate what exists in the tree from what is narrowly verified and what is still being qualified | STATUS / README honesty pass on the public docs track |
| **Readable public docs** | Product path first; architecture and Prompt OS behind progressive disclosure | Docs index + onboarding pointers |

Maintainer choices that unblock product clarity but are not automatic doc edits: a real TUI capture for the landing page, Discussions enablement, About blurb wording, Wiki keep/disable, and timing of any registry publish.

---

## NEXT (product follow-through)

1. **Better intake for real failures** — issue forms and contributor guidance that make it easy to report bugs, harness/agent failures, and docs gaps without dumping internal process on newcomers.
2. **Release notes people can use** — Unreleased / release narrative in user outcomes first; keep internal IDs as footnotes.
3. **Public evidence you can inspect** — index **existing** eval, failure, and demo artifacts; link only when the evidence is real and current (never fabricate results).
4. **Install path productization** — a published npm/npx (or equivalent) trial path remains an **implementation** decision. **No commit date** is stated here.

---

## LATER (after evidence and maintainer choices)

- Softened repository About / Discussions / Wiki disposition (maintainer settings).
- First **real** TUI screenshot or recording on the product front door (capture when ready; do not fabricate).
- Broader packaging once an implementation track lands and docs can truthfully describe it.
- Any move or rewrite of runtime-sensitive roots (`00_`–`07_`, catalogs, agent instruction files, `babel-cli` runtime) without reference proof — see [ROOT_SAFETY_INVENTORY.md](./ROOT_SAFETY_INVENTORY.md).

Internal harness sequencing and architecture roadmaps live under [architecture/](./architecture/). They are progressive disclosure for contributors who need depth — not the public product promise list.

---

## How to read this page

- **Try Babel:** [START_HERE.md](../START_HERE.md), then [CLI_QUICKSTART.md](./CLI_QUICKSTART.md).
- **Maturity / claims:** [STATUS.md](./STATUS.md) when present on your revision.
- **Docs map:** [docs index](./README.md).
- **Campaign provenance** (stewardship checklist, PR sequencing): issue [#231](https://github.com/gthgomez/Babel/issues/231) — that tracker is operational detail; this page stays product-facing.

## Related

- [VISION.md](./VISION.md) — product principles
- [ROOT_SAFETY_INVENTORY.md](./ROOT_SAFETY_INVENTORY.md) — read-only root classification
- [CHANGELOG.md](../CHANGELOG.md) — release history
