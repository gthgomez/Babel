# Project Overlay — Example: Compliance Signal Enforcement
**Status:** EXAMPLE | **Layer:** 05_Project_Overlays

> **Note:** This is an illustrative example of a Project Overlay for a compliance-focused SaaS product.
> Replace the content below with your own project's purpose, stack, constraints, and primary objects.
> See `06_Task_Overlays/README.md` for loading instructions.

---

## Purpose
Deterministic signal enforcement infrastructure. This project sits **in the runtime data path** to
intercept, validate, enforce, and record compliance signals. It is NOT a UI overlay or consent manager.

## Tech Stack
- **Backend:** Serverless edge functions, PostgreSQL
- **Frontend:** Next.js, TypeScript, SSR auth, data-fetching library
- **Infra:** Cloud-hosted, multi-tenant

## Hard Constraints
- Fail-closed by default — ambiguity triggers deny, never allow.
- Every claim must have a traceable decision record (input → guard → outcome).
- Multi-tenant isolation is structural — cross-tenant data access must be architecturally impossible.
- No "AI-driven" framing anywhere in copy or UI.

## Primary Objects
Decision records, audit trails, guard-chain traces, exportable evidence packets.
