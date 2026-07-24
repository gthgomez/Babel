---
name: playwright-e2e
description: Create, modify, or review Playwright end-to-end tests, Playwright configuration, auth helpers, browser assertions, resilient selectors, screenshot and trace evidence, test reports, and CI E2E workflows.
---

## Prompt bridge

- **Babel catalog id:** `skill_playwright_e2e`
- **Prompt-layer owner:** `02_Skills/Framework/Playwright-E2E-v1.md`
- Use the prompt skill for Babel stack assembly; use this package for structured contracts, examples, and validation fixtures.

# Playwright E2E

Use this skill when creating, modifying, or reviewing Playwright end-to-end tests,
Playwright config, auth helpers, browser assertions, screenshot evidence, or CI E2E
workflows.

## Workflow

1. Inspect the existing Playwright config and test directory before adding tests.
2. Let Playwright manage the dev server with `webServer` when the repo supports it.
3. Prefer resilient user-facing locators: role, label, text, then test id.
4. Use Playwright's auto-retrying assertions instead of fixed sleeps.
5. Keep credentials in environment variables or test fixtures, never in source.
6. Save debug screenshots/reports to gitignored test output directories.
7. Run the narrowest test file first, then broader suites when risk requires it.

## Selector Priority

- `getByRole` with accessible name.
- `getByLabel` for fields.
- `getByText` for visible copy when role is unavailable.
- `getByTestId` for stable app-specific anchors.
- CSS selectors only when no semantic selector exists.

## Auth-Gated Tests

- Use `test.skip` when required credentials are unavailable.
- Share login helpers under the E2E test tree.
- Never hardcode credentials in tests or CI config.

## Verification

- Run `npx playwright test <file>` for changed tests.
- Check traces, screenshots, and `playwright-report/` on failure.
- In CI, upload the Playwright report artifact when available.
