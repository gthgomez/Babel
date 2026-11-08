# Hidden-test scope regression rows

Added three explicit negative rows to `babel-cli/src/agent/chatEngineTaskIntent.test.ts` on branch `fix/c12-hidden-test-scope`:

- Read-only explanation plus “Do not create hidden tests” stays READ_ONLY.
- An implementation request with “Do not create hidden tests or edit files” stays READ_ONLY.
- An implementation request followed by separate hidden-test and global no-file-edit prohibitions stays READ_ONLY.

Focused test command: `node --import tsx --test src/config/chatTaskClass.test.ts src/config/chatTaskClassAdversarial.test.ts src/agent/chatEngineTaskIntent.test.ts src/agent/chatOperationPolicy.test.ts`

Result: 129 passed, 0 failed, 4 suites. `git diff --check` passed. Committed and pushed normally as `fb65297a` (`test: preserve hidden-test edit denial scope`), following the classifier implementation commit `da22d7283c1a20b80e106c82a36f5ec7e1ca47f8`. No inference calls were made for this test addition.
