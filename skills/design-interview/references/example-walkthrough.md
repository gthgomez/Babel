# Example Walkthrough — CLI Authentication

User: `/design-interview I need to add authentication to the CLI`

```
Phase 0 — CLASSIFY
  → Domain: CODE (source changes) + ARCHITECTURE (auth model decision)
  → "This is CODE + ARCHITECTURE composite. The auth model choice ripples into config, session management, and the CLI's HTTP layer."

Phase 1 — SURVEY
  → Read: babel-cli/src/auth/ (if it exists), config schema, existing HTTP client
  → Find: No existing auth module. HTTP client uses fetch with a Bearer token pattern already. Config file supports a `token` field but it's undocumented.
  → Implication: Token-based auth is pre-wired. OAuth would require refactoring the HTTP layer.

Phase 2 — MAP
  → Share Mermaid diagram:

  ```mermaid
  graph TD
      S["🎯 CLI Authentication"] --> A
      A["❓ Auth method"] --> B1["✅ Token-based (pre-wired)"]
      A --> B2["❓ OAuth2 device flow"]
      S --> C
      C["❓ Token storage"] --> D1["❓ OS keychain"]
      C --> D2["❓ Config file (existing token field)"]
      S --> E
      E["✅ Session refresh — HTTP layer already handles 401 retry"]
  ```

Phase 3 — GRILL (round 1)
  → Ask: "Auth method — token-based or OAuth2?"
  → Recommended: Token-based (already wired, less friction)
  → User picks: Token-based ✅

  → Update diagram. Next: "Token storage — OS keychain or config file?"
  → Recommended: OS keychain (secure by default, worth the platform-specific code)
  → User picks: OS keychain ✅

  → All branches resolved. Exit to Phase 4.

Phase 4 — PLAN
  → Decisions Made:
    1. Auth method: Token-based (pre-wired in HTTP layer)
    2. Token storage: OS keychain (keytar or similar)
  → Assumptions: None — all branches resolved
  → Implementation steps:
    1. Add `keytar` dependency (cross-platform keychain)
    2. Create `src/auth/tokenStore.ts` — read/write/delete token via keychain, fallback to config file
    3. Create `src/auth/login.ts` — prompt for token, validate against API, store
    4. Update `src/cli/args.ts` — add `--login` and `--logout` commands
    5. Update HTTP client to read token from store (replace hardcoded config read)
  → Verification: `cd babel-cli && npm test`, manual `babel --login` smoke test
```
