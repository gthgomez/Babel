# Skill: React & Next.js (v1.0)
**Category:** Framework
**Status:** Active

## High-Fidelity UI Engineering
- **Component States:** Every component must define **Loading**, **Error**, **Empty**, and **Partial** states.
- **Design Tokens:** Reference tokens for all values (color, spacing, typography). No hardcoded values.
- **Composition:** Scalable and accessible components following a design system.

## Performance as a Constraint
- **Core Web Vitals:** Target LCP < 2.5s, CLS < 0.1, INP < 200ms.
- **Above-the-Fold:** Design for fast initial render. Avoid blocking resources.
- **Image Optimization:** Use next-gen formats (WebP, AVIF) and responsive `srcset`.
- **Payload Budget:** Above-the-fold combined (Fonts+Images+CSS) ≤ 500KB.
- **Animations:** Keep micro-interactions ≤ 300ms. Use GPU-composited properties (`transform`, `opacity`).
