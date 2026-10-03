# Visual acceptance and intentional deviations

## Preserved

The first-run screen retains the reference's three-column workspace, top Chat/Plan/Deep navigation, left sessions/project/quick actions, central message and inline tool feed, findings and solution cards, right Mode/Model/Tools/Context/Status hierarchy, composer, bottom bar, dark navy surfaces, thin blue borders, luminous selection states, and Babel branding.

At the 1536 × 1024 reference viewport the build uses a 72 px header, 268 px left column, flexible 912 px center, 332 px right column, and 42 px footer. The first result card starts at y=518 and the composer at y=909. Reference geometry was reconstructed from the image, not extracted from an original design file.

System typography follows Cascadia Code / Cascadia Mono / Consolas / Liberation Mono, then monospace. The exact source font was not supplied. No font files are bundled; metrics and rasterization can differ on Windows and Linux.

## Intentional corrections

1. **Truthfulness:** “Ready / All systems operational” becomes “Preview / Sample session · no engine connected.” A small REFERENCE PREVIEW badge is added in the footer. The preview does not imply successful agent execution.
2. **Version:** The image's v0.8.0-dev is not presented as this application's version. The delivered visual build identifies itself as v0.1.0-preview.
3. **Interaction states:** Focus outlines, hover states, tool-row expansion, dialogs, copy, reduced motion, and an error example are defined. The screenshot cannot specify these states.
4. **Responsive access:** Three columns remain at ordinary desktop/laptop widths. Below 1000 px the right sidebar becomes a drawer; below 740 px both sidebars are drawers. The composer remains visible and the conversation scrolls independently.
5. **Native honesty:** Live mode removes all screenshot sessions and model options. It defers model routing to Babel and marks unreported context/tool information as unknown. It does not turn sample tool switches into permissions.
6. **Reference-only text:** Newlines in the reference conversation are fixed to match the image at its target size. Real messages wrap naturally. Sample tool paths are preserved even though they are not evidence about current Babel code.
7. **Brand asset:** The mark is a crop of the supplied image, not a new logo or a claimed official vector asset. A production-quality original/vector can replace this single asset later without changing the layout.

## Validation discipline

The screenshots in `artifacts/` are actual Chromium renders of this implementation. The whole reference is never used as the application's background: text, controls, cards, rows, and panels are real DOM elements. Only the logo crop is a raster image.

Layout dimensions and the presence of both cards and all four tool rows are checked in the browser test. Exact pixel-diff thresholds are not claimed; different source-font rendering and the documented honesty corrections would need masking before a useful automated image comparison.

The reference screenshot is retained under `references/`. Compare it against `artifacts/Babel-Desktop-1536x1024.png` side by side. Large-monitor density and high-DPI Windows rasterization still need target-device acceptance.
