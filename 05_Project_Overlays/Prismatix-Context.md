# Project Overlay — Example: Multi-Provider LLM Router
**Status:** EXAMPLE | **Layer:** 05_Project_Overlays

> **Note:** This is an illustrative example of a Project Overlay for an LLM routing platform.
> Replace the content below with your own project's purpose, stack, invariants, and primary objects.
> See `06_Task_Overlays/README.md` for loading instructions.

---

## Purpose
Multi-provider LLM routing platform. Authenticated frontend requests route through a serverless
function that selects a provider, normalizes the response into a provider-agnostic SSE stream,
and persists cost and token metadata.

## Tech Stack
- **Backend:** Serverless edge functions (router, video-intake), TypeScript, PostgreSQL
- **Frontend:** React, Vite, TypeScript
- **Providers:** Multiple LLM providers — normalized via SSE
- **Video:** Dedicated video intake pipeline

## Hard Invariants
- Frontend parses **only the normalized SSE contract** — never provider-native stream shapes.
- Router response headers are a **stable API contract** — update in lockstep with frontend.
- Conversation ownership must always be verified **server-side** before read/write.
- Client-side token refresh must use a single-retry path with controlled sign-out on failure.
- Timeout errors must map to a defined HTTP error code at the router boundary.

## Primary Objects
Router manifests, SSE event contracts, conversation/cost records, provider availability state.
