# Project Overlay — Example: Compliance Audit Platform
**Status:** EXAMPLE | **Layer:** 05_Project_Overlays

> **Note:** This is an illustrative example of a Project Overlay for an audit and compliance tool.
> Replace the content below with your own project's purpose, stack, constraints, and primary objects.
> See `06_Task_Overlays/README.md` for loading instructions.

---

## Purpose
Compliance audit frontend with artifact management and CI validation. Provides structured audit
trails, evidence artifact storage, and automated compliance checks across a SaaS workspace.

## Tech Stack
- **Frontend:** Next.js, TypeScript, cloud auth and storage, data-fetching library
- **Backend:** Cloud database (PostgreSQL, auth), database ORM for schema management
- **Tooling:** Pre-deployment validator, dev orchestration scripts
- **Build:** Monorepo root — frontend and CI tools are separate packages

## Hard Constraints
- Audit records must be **append-only** — no silent mutation of existing entries.
- Pre-deployment validator must run before any schema migration is applied.
- All artifact exports must include timestamp, actor identity, and outcome — no anonymous records.

## Primary Objects
Audit entries, evidence artifacts, compliance reports, CI validation results.
