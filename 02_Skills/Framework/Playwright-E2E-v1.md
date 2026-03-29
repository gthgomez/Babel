<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Playwright E2E Testing (v1.0)
**Category:** Framework / Testing
**Status:** Active

---

## 1. Project Setup (example_web_audit pattern)

```typescript
// playwright.config.ts
import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3000';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,       // fails build if test.only is committed
  retries: process.env.CI ? 2 : 0,    // retries in CI only
  workers: process.env.CI ? 1 : undefined,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',       // debug artifacts saved automatically on failure
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --port 3000',
    url: 'http://127.0.0.1:3000',
    reuseExistingServer: !process.env.CI, // reuse in local dev, always fresh in CI
    timeout: 120000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
```

**Rules:**
- `webServer` block manages the dev server. Never start it manually before running tests — Playwright handles it.
- `reuseExistingServer: !process.env.CI` lets local dev reuse an already-running server for speed, while CI always gets a fresh one.
- `forbidOnly: !!process.env.CI` prevents accidentally merging `test.only` calls that would skip the full suite.
- `trace: 'retain-on-failure'` captures timeline, screenshots, and network calls on failure — check `playwright-report/` before debugging manually.

---

## 2. Selector Priority (ARIA-First)

Playwright's test philosophy is to query the DOM the same way a user or assistive technology would. Use selectors in this priority order:

```typescript
// 1. Role + accessible name (preferred — ARIA-first)
page.getByRole('button', { name: /sign in/i })
page.getByRole('navigation', { name: /global navigation/i })
page.getByRole('link', { name: 'Dashboard' })

// 2. Label (for form fields)
page.getByLabel('Email address')
page.getByLabel('Password')

// 3. Placeholder text
page.getByPlaceholder('Search...')

// 4. Text content (for non-interactive elements)
page.getByText('Welcome back')

// 5. Test ID (last resort — couples test to implementation)
page.getByTestId('submit-button')   // requires data-testid attribute

// ❌ Avoid CSS selectors and XPath — they break on refactors
page.locator('.btn-primary')        // fragile
page.locator('//button[1]')         // fragile
```

**Rule:** If the `getByRole` query fails, that is usually a signal that the component is missing proper ARIA attributes — fix the component, don't fall back to CSS.

---

## 3. Auth-Gated Tests

```typescript
// Never hardcode credentials. Always use environment variables.
const AUTH_EMAIL    = process.env.E2E_EMAIL;
const AUTH_PASSWORD = process.env.E2E_PASSWORD;

async function ensureDashboardSession(page: Page) {
  await page.goto('/dashboard');

  // If already authenticated (e.g. session cookie), skip login
  if (!page.url().includes('/auth/signin')) return;

  // Skip test entirely if credentials are not provided — don't fail
  test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'E2E_EMAIL and E2E_PASSWORD required.');

  await page.getByLabel('Email address').fill(AUTH_EMAIL ?? '');
  await page.getByLabel('Password').fill(AUTH_PASSWORD ?? '');
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await page.waitForURL(/\/dashboard(?:\?.*)?$/, { timeout: 20000 });
}

test('dashboard loads', async ({ page }) => {
  await ensureDashboardSession(page);
  await expect(page.getByRole('navigation', { name: /global navigation/i })).toBeVisible();
});
```

**Rules:**
- `test.skip(condition, reason)` is the right tool for env-gated tests. A skipped test is visible in the report; a commented-out test is invisible.
- Never `throw` from an auth helper — use `test.skip` so the skip reason appears in the report.
- Extract auth flows into shared helper functions in a `helpers/` file within `tests/e2e/`. Don't duplicate the login sequence across test files.

---

## 4. Assertions

```typescript
// Visibility
await expect(locator).toBeVisible();
await expect(locator).not.toBeVisible();
await expect(locator).toBeHidden();

// Text
await expect(locator).toHaveText('Exact text');
await expect(locator).toContainText(/partial/i);

// Attributes and ARIA state
await expect(locator).toHaveAttribute('aria-expanded', 'true');
await expect(locator).toHaveAttribute('aria-controls', 'menu-id');
await expect(locator).toHaveAttribute('href', '/dashboard');

// Focus (keyboard navigation tests)
await expect(locator).toBeFocused();

// URL
await expect(page).toHaveURL(/\/dashboard/);
await expect(page).toHaveURL('http://127.0.0.1:3000/dashboard');

// Count
await expect(page.getByRole('listitem')).toHaveCount(5);
```

**Rules:**
- All Playwright assertions are auto-retrying — they poll until the condition is met or timeout. Never add manual `page.waitForTimeout()` before an assertion.
- Use `toHaveAttribute('aria-expanded', 'true')` over checking `.classList` — this tests the actual accessibility state, not the visual implementation.

---

## 5. Interactions

```typescript
// Click
await locator.click();
await locator.click({ button: 'right' });

// Keyboard
await page.keyboard.press('Escape');
await page.keyboard.press('Tab');
await page.keyboard.press('Enter');

// Fill (clears existing value first)
await page.getByLabel('Email').fill('test@example.com');

// Type (appends — use for incremental input tests)
await page.getByLabel('Search').type('query');

// Navigation
await page.goto('/dashboard');
await page.waitForURL(/\/dashboard/, { timeout: 10000 });

// Wait for element (prefer assertions over explicit waits)
await page.waitForSelector('[data-testid="result"]');  // only if assertion is impractical
```

---

## 6. Visual Testing and Screenshots

```typescript
// Screenshot to test-results/ for visual evidence
await page.screenshot({
  path: `test-results/nav-audit-${colorScheme}-menu-open.png`,
  fullPage: true,
});

// Dark/light mode testing
for (const colorScheme of ['light', 'dark'] as const) {
  test(`nav audit (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    // ... test body
  });
}
```

**Rules:**
- Save screenshots to `test-results/` (gitignored), not `tests/` or repo root.
- Use `emulateMedia({ colorScheme })` to test both light and dark themes in the same test file.
- Visual snapshots (`toHaveScreenshot()`) require a baseline image. Only use for stable, deterministic UI — avoid for pages with dynamic content (timestamps, live data).

---

## 7. Running Tests

```bash
# Run all E2E tests
npx playwright test

# Run a specific file
npx playwright test tests/e2e/nav-button-audit.spec.ts

# Run in headed mode (shows browser — useful for debugging)
npx playwright test --headed

# Run with UI mode (interactive test runner)
npx playwright test --ui

# View HTML report after run
npx playwright show-report

# Install browsers (required on fresh machine)
npx playwright install chromium

# Set auth credentials for auth-gated tests
E2E_EMAIL=test@example.com E2E_PASSWORD=secret npx playwright test
```

---

## 8. CI Integration

```yaml
# GitHub Actions example
- name: Install Playwright browsers
  run: npx playwright install --with-deps chromium

- name: Run E2E tests
  run: npx playwright test
  env:
    CI: true
    E2E_EMAIL: ${{ secrets.E2E_EMAIL }}
    E2E_PASSWORD: ${{ secrets.E2E_PASSWORD }}

- name: Upload test report
  uses: actions/upload-artifact@v4
  if: always()
  with:
    name: playwright-report
    path: playwright-report/
```

**Rules:**
- `CI=true` enables `retries: 2` and `workers: 1`. Parallel workers in CI can cause flakiness from port conflicts or shared state.
- Always upload the HTML report as an artifact — it's the primary debugging tool for CI failures.
- Store auth credentials in CI secrets, never in workflow YAML.

---

## 9. High-Risk Zones

| Zone | Risk |
|------|------|
| Hardcoded credentials in test files | Secrets committed to git |
| `page.waitForTimeout(3000)` | Brittle timing — use assertions with retry instead |
| CSS selectors (`locator('.btn')`) | Break on component refactors without warning |
| `test.only` committed to main | Silently skips entire test suite in CI |
| Screenshots in `tests/` directory | Binary files accidentally committed |
| Missing `webServer` block | Tests run against stale or absent server |
| No `test.skip` for credential-gated tests | Hard failure instead of graceful skip in environments without secrets |

