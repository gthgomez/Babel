# Public roadmap

**Audience:** developers evaluating Babel and contributors scanning priorities.  
**Updated:** 2026-09-19 (stewardship PR2; evidence from live `main`, campaign tracker [#231](https://github.com/gthgomez/Babel/issues/231), and open engineering work — **not** a shipped-promise list).

Babel is **pre-1.0**. This page states **what the public tree and open work currently imply**, using the same honesty buckets as the stewardship STATUS pass:

- **Available** = present in the tree / documented as an entrypoint.
- **Narrowly verified** = scoped CI/contracts/validation evidence.
- **Active qualification** = engineering in progress; **not** a user promise.

**Ordinary coding-loop reliability remains under active qualification.** A mode, route, or CLI command existing is not evidence that everyday repository work is already reliable.

For maturity language and “what we are not claiming,” prefer [STATUS.md](./STATUS.md) when that page is on the branch you are reading (arrives via draft PR [#230](https://github.com/gthgomez/Babel/pull/230)). This roadmap does not invent STATUS content.

---

## NOW (public stewardship + qualification)

Work that is **already in flight or next-bounded** on the public repo, based on tracker [#231] and current open engineering focus:

| Track | What it is | Evidence posture |
|---|---|---|
| **Front-door clarity** | Product landing that leads with try-path, honest install (clone + build), and maturity buckets | Draft PR [#230](https://github.com/gthgomez/Babel/pull/230) (README / STATUS / assets runbook) |
| **Docs IA** | Public roadmap, docs index, root safety inventory (this PR) | Campaign [#231] PR2 scope |
| **Ordinary coding-loop qualification** | Terminal truthfulness, harness hardening, related draft/integration PRs on the engineering track | **Active qualification** — not a claim that the daily loop is settled |
| **Clone + build install path** | Documented, runnable local CLI build | **Available**; install is **not** a published npm/npx package today |

Maintainer-only decisions (not auto-shipped by docs PRs): real TUI capture, Discussions enablement, About blurb wording, Wiki keep/disable, timing of any published package path.

---

## NEXT (bounded stewardship follow-ups)

These are **planned campaign slices** from [#231], not delivery dates:

1. **Community / issue intake** — Issue Forms (Bug, Feature, Agent failure / harness report, Docs); CONTRIBUTING progressive disclosure; label taxonomy without mass-relabeling history.
2. **Releases presentation** — CHANGELOG Unreleased user-outcome bullets first; release-notes guidance; keep historical MIT tags accurately attributed.
3. **Public evidence index** — curate **existing** public eval/failure/demo artifacts into a docs index; link only where evidence is real and current (no fabricated results).

**Implementation track (separate from stewardship docs):** a published npm/npx install path remains an open product/engineering decision. **No committed publish timeline** is stated here.

---

## LATER (after evidence and maintainer choices)

Items that are **explicitly deferred** or depend on evidence/maintainer action:

- Softened repository About / Discussions / Wiki disposition (maintainer settings).
- First **real** TUI screenshot or recording on the product front door (capture when ready; do not fabricate).
- Broader product packaging (registry publish) once an implementation track lands and docs can truthfully describe it.
- Anything that would move or rewrite runtime-sensitive roots (`00_`–`07_`, catalogs, agent instruction files, `babel-cli` runtime) without reference proof — see [ROOT_SAFETY_INVENTORY.md](./ROOT_SAFETY_INVENTORY.md).

Internal harness sequencing (H0–H7 and related architecture roadmaps) lives under [architecture/](./architecture/) and is **not** restated here as a public product promise list.

---

## How to read this page

- Prefer **product path** docs for trying Babel: [START_HERE.md](../START_HERE.md), [CLI_QUICKSTART.md](./CLI_QUICKSTART.md).
- Prefer **STATUS** (when present) for available vs verified vs qualification language.
- Prefer **architecture** docs only when you need Prompt OS / harness depth — they are progressive disclosure, not the front door.
- Campaign tracker: [#231](https://github.com/gthgomez/Babel/issues/231).

## Related

- [docs index](./README.md) — canonical documentation map
- [VISION.md](./VISION.md) — product principles
- [ROOT_SAFETY_INVENTORY.md](./ROOT_SAFETY_INVENTORY.md) — read-only root classification (no moves in stewardship PRs)
- [CHANGELOG.md](../CHANGELOG.md) — release history
