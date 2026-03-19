# Frontend Professionalism Overlay v1.0

## Purpose

Reusable guidance for making product UIs feel professional, calm, and reliable without rewriting working architecture.

## Use This Overlay When

- polishing an existing frontend
- refactoring page composition
- tightening a design system
- reducing prototype-like visual noise
- improving responsive quality and operational clarity

## Do Not Use This Overlay For

- backend contract changes
- infra work
- legal interpretation
- greenfield brand exploration where constraints should be looser

## Visual Direction

Professional product UIs should feel:
- calm
- intentional
- operational
- trustworthy
- visually consistent

They should not feel:
- crowded
- over-accented
- visually indecisive
- gamified
- like a generic template with many competing surfaces

## Core Rules

1. Prefer hierarchy over decoration.
2. Prefer spacing and typography over extra color.
3. Prefer one primary action per surface.
4. Use semantic status colors only when status meaning is real.
5. Minimize mixed card treatments, badge noise, and unnecessary motion.
6. Keep navigation quiet and predictable.

## Design-System Rules

1. Use tokens first.
2. Do not hardcode visual values without justification.
3. Standardize reusable primitives before expanding page-specific markup.
4. Keep empty, loading, error, and partial states consistent across the product.

## Refactor Bias

1. Preserve working auth and data boundaries.
2. Extract oversized pages into section components.
3. Move one-off page presentation into reusable UI primitives where appropriate.
4. Avoid rewrite-from-scratch unless the architecture is proven unsalvageable.

## Copy Rules

In-product copy should:
- describe current status
- clarify next action
- explain consequence when useful

Avoid:
- vague marketing language
- inflated product claims
- long explanatory blocks in operational screens

## Verification

Before completion, verify:
- accessibility remains intact
- responsive layout remains intact
- primary flows remain understandable
- visual hierarchy is clearer than before
