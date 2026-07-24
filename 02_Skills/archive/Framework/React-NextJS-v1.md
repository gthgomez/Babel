<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: React & Next.js (v1.0)
**Category:** Framework
**Status:** Active
**Last Verified:** 2026-04-25

## Package bridge

- **Canonical package:** `skills/react-nextjs/` (`SKILL.md`, `skill.yaml`, `contracts/`, `examples/`, `tests/`)
- **Catalog id:** `skill_react_nextjs`
- **This file:** Babel prompt routing and layer behavior only
- Do not duplicate schemas or examples here; use the package skill for I/O contracts and fixtures

## Server-First Architecture (Next.js 16)
- **RSC by Default**: All components are React Server Components unless interactivity is required. Use `"use client"` sparingly and at the leaf nodes.
- **Data Fetching**: Fetch data directly in Server Components using `await`. Avoid `useEffect` for data fetching.
- **React 19 Actions**: Use Actions for form submissions and mutations. Leverage `useActionState` and `useFormStatus` for pending and error handling.
- **PPR (Partial Pre-Rendering)**: Wrap dynamic components in `Suspense` with high-fidelity skeletons to enable instant initial loads while dynamic content streams in.

## UI Engineering & The React Compiler
- **Implicit Memoization**: Use the **React Compiler** where the project enables it. React Compiler reduces the need for manual component memoization, but `useMemo`, `useCallback`, and `memo` remain valid escape hatches for measured expensive calculations, stable props to memoized children, and external dependency boundaries.
- **State Mastery**: Use `useState` only for truly local ephemeral state. Lift state to the URL (search params) or use Server Actions for shared state.
- **Component States**: Every component must define **Loading (Skeleton)**, **Error**, and **Empty** states using `Suspense` and `ErrorBoundary`.

## Performance as a Constraint (2026)
- **Core Web Vitals**: Target LCP < 1.5s, CLS < 0.1, INP < 150ms.
- **Zero-Layout-Shift**: Use explicit aspect ratios and `next/image` with placeholder blur.
- **Bundle Efficiency**: Eliminate unused client-side libraries. Total client bundle size budget ≤ 100KB (gzip) for the main path.
- **Font Strategy**: Use variable fonts and `next/font` for zero-layout-shift and optimal performance.

## Design Invariants
- **Design Tokens**: Reference tokens via CSS Variables or `@theme`. No hardcoded magic numbers.
- **Accessibility**: Enforce semantic HTML and ARIA attributes. Test with screen-reader focus flows.
