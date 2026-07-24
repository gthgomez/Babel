# Example

User task:

```text
Add an E2E test for the dashboard login flow.
```

Expected behavior:

- Read `playwright.config.*` and existing E2E helpers.
- Use env-gated credentials and `test.skip` if missing.
- Use role/label selectors.
- Run the changed test file through Playwright.
- Report trace or screenshot artifacts if it fails.
