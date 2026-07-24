---
name: react-nextjs
description: Implement or review React and Next.js application code including components, pages, server/client boundaries, data loading, actions, loading/error/empty states, accessibility, and performance-sensitive UI.
---

## Prompt bridge

- **Babel catalog id:** `skill_react_nextjs`
- **Prompt-layer owner:** `02_Skills/Framework/React-NextJS-v1.md`
- Use the prompt skill for Babel stack assembly; use this package for structured contracts, examples, and validation fixtures.

# React And Next.js

Use this skill when implementing or reviewing React or Next.js application code:
components, pages, server components, client boundaries, data fetching, actions,
loading/error/empty states, accessibility, and performance-sensitive UI.

## Workflow

1. Identify the framework version and routing model before editing.
2. Read the component, hooks, API helpers, and types it depends on.
3. Keep server-first code server-side; add `"use client"` only where interactivity requires it.
4. Avoid `useEffect` data fetching when the framework has a server/data-loading pattern.
5. Preserve loading, error, and empty states for user-facing data.
6. Use semantic HTML and accessible names for interactive controls.
7. Run typecheck, lint, and targeted tests/build as available.

## State And Data

- Keep local state local and small.
- Use URL/search params for shareable view state.
- Use server actions or established mutation helpers for writes.
- Do not invent API shapes; read the source contract first.

## Performance

- Avoid unnecessary client bundles.
- Use explicit image dimensions/aspect ratios.
- Avoid layout shift from dynamic content.
- Memoize only for measured expensive work or stable props across memoized children.

## Verification

- Run the repo's typecheck/build.
- Run component or E2E tests when behavior changes.
- Inspect UI screenshots for layout or text-fit changes when visual work is involved.
