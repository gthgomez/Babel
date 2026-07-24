# Modern Typography & Fluid Layout (v1.0)

## Purpose
Guidelines for premium typography and grid layouts that feel stable and responsive by default.

## Rules
1. **Fluid Sizing (clamp)**: Use the `clamp()` function for all core typography to enable smooth viewport-aware scaling without excessive media queries.
   - Example: `font-size: clamp(2rem, 1.5rem + 2.5vw, 4rem);`
2. **Variable Font Mastery**: Leverage variable font axes (`wght`, `wdth`, `ital`, `slnt`) instead of loading multiple static weights.
3. **Subgrid Consistency**: Use `display: subgrid` for nested layouts to maintain alignment with the global layout grid.
4. **Leading & Line Height**: Enforce strict vertical rhythm. Base line height should be ~1.5 for body text and ~1.1-1.2 for headings.
5. **Legibility Guards**: Maximize readability by capping body text width to ~65-75 characters (approx. `60ch` or `70ch`).
6. **Neo-Brutalist Spacing**: Use bold, deliberate white space (margins/padding) to create a premium, high-end "magazine" feel.
7. **System Font Fallbacks**: Always provide a high-quality system fallback stack to prevent FOIT (Flash of Invisible Text).

## Design Philosophy (2026)
- **Hierarchy through Contrast**: Combine a bold, variable sans-serif for headings (e.g., Inter, Outfit) with a highly legible, optimized serif or mono for secondary details.
- **Micro-Typography**: Use `font-variant-numeric: tabular-nums` for data tables and `text-underline-offset` for refined link styling.
- **Optical Sizing**: Enable `font-optical-sizing: auto` for fonts that support it, ensuring clarity at small sizes and elegance at large sizes.

## Verification
- Resize viewport to confirm `clamp()` scaling is smooth and doesn't break layout.
- Verify subgrid alignment in browser dev tools (Grid overlay).
- Check contrast ratios for all typographic elements (WCAG 2.2 AA minimum).
