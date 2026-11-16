# First-run acceptance

This checklist separates source-build evidence from an installed release and a
real provider. Never place keys, raw provider responses, project contents, or
credential-store contents in test output or evidence. Use an isolated profile,
a disposable project, and synthetic credentials for automated tests.

## Offline and synthetic checks

Build the CLI and renderer from the candidate, then run the focused tests in
an isolated profile with provider networking denied. Some tests construct their
own synthetic fixture; do not assume every test sanitizes its parent environment:

```powershell
npm --prefix babel-cli run build
node babel-desktop/scripts/build.mjs
node babel-cli/scripts/stage_runtime_assets.mjs
Push-Location babel-cli
node --import tsx --test --test-concurrency=1 src/cli/productPolicy.entry.test.ts src/agent/chatEngine.connectionSwitch.test.ts src/agent/offlineAuxiliary.test.ts src/runners/offlineBoundary.test.ts src/runners/productDispatchPolicy.test.ts src/services/productConnectionPolicy.test.ts src/services/providerSetup.test.ts src/config/interactiveCredential.test.ts src/interactive/repl/replLifecycle.test.ts
node --test src/cli/builtEntry.acceptance.test.mjs
node --test src/cli/packageLayout.acceptance.test.mjs
node --import tsx --test --test-concurrency=1 src/config/sharedCredentialStore.test.ts src/config/sharedCredentialIntegration.test.ts src/config/sharedConnectionService.test.ts src/config/sharedDesktopIntegration.test.ts src/services/providerModelCatalog.test.ts src/config/userSettings.test.ts
node --import tsx --test --test-name-pattern=hostProcessSurface src/authority/commandSpec.test.ts
node --test src/cli/lazyStartup.acceptance.test.mjs
node --import tsx --test --test-concurrency=1 src/cli/plainInteractiveEntry.test.ts src/interactive/repl/replLoop.admission.test.ts src/ui/shell/shellOperations.test.ts src/services/chatSessionIndex.test.ts src/runners/providerRouteSafety.test.ts
node --import tsx --test --test-concurrency=1 src/agent/campaignCommandCode.chatEngine.test.ts src/agent/chat-general-purpose-artifact-journey.test.ts
Pop-Location
Push-Location babel-desktop
node --test --test-concurrency=1 test/credential-first-run.test.mjs test/connection-readiness-renderer.test.mjs test/product-provider-policy.test.mjs test/provider-save-boundary.test.mjs test/provider-auth.test.mjs test/model-catalog.test.mjs
node --test --test-concurrency=1 test/shared-credentials.test.mjs test/worker-credential-identity.test.mjs test/linux-keyring-binding.test.mjs test/cli-launch-selection.test.mjs
Pop-Location
```

The built-entry and terminal acceptance tests create owned synthetic profiles
and deny provider network dispatch. The built-entry test checks persistence across processes and offline
status; it needs `dist` and skips if the CLI has not been built. The renderer
tests use a native bridge double. The local tarball test also requires staged
resources and reuses the checkout's dependencies; it is not a clean npm install.
These checks do not establish provider authentication,
model availability, a real inference response, or installed-app behavior.
The dispatch-policy fixture also verifies that cached and direct transports
cannot bypass the approved-provider policy, approved product transports reject
redirects, and offline pipeline fixtures cannot fall through to inference.
The mocked task journeys do exercise a real engine read in a disposable Git
repository and a separate repository edit whose result is checked by an
independent Node test. Their scripted provider responses do not qualify a live
model, and the edit fixture uses benchmark-only admission settings.

Run `babel-desktop/test/empty-state-electron.test.mjs` for the actual Electron
main/preload/renderer path with an isolated profile, and set
`BABEL_TEST_ELECTRON_EXECUTABLE` to a trusted local Electron binary when running
`babel-desktop/test/credential-electron.test.mjs`. These source-build fixtures
use synthetic credentials and do not prove a packaged installer works.

For a clean local npm installation, set `BABEL_TEST_INSTALLED_CLI` to that
installation's absolute `node_modules/babel-harness/bin/babel.js` path and run
`node --test src/cli/cleanInstall.acceptance.test.mjs` from `babel-cli`. On
Windows the test also starts all three installed `.cmd` shims. On Linux,
`node --test src/cli/linuxTerminal.acceptance.test.mjs` runs a real
pseudo-terminal against the built CLI with a synthetic profile and denied
network access. These tests do not require or access a real provider account.

One source-build diagnostic on 2026-11-15 used Node 22.22.1 in WSL Ubuntu 22,
with the checkout and isolated fixture on a Windows-mounted drive. A single
launch reached the composer in 72.5 seconds before the startup import changes;
two later runs reached it in 35.3 and 34.9 seconds. In the last run `/exit`
finished approximately 0.35 seconds after the composer appeared. These are not
a release benchmark or a platform-independent target. Measure multiple cold and
warm runs on the installed candidates, including a native Linux filesystem,
before setting a performance threshold.

## Installed-product matrix

For each candidate, record the exact source commit, package version, platform,
runtime version, artifact identity, selected provider, and whether each result
uses a mock or a real provider. Exercise Windows Desktop, Linux terminal/TUI,
and WSL separately; run the actual npm-installed binaries as well as source
builds. Do not substitute a source Electron launch for an installed Windows app.

| Scenario | Evidence required |
| --- | --- |
| Fresh profile, each approved gateway | Composer appears; choosing a provider and model requires no inference; saved credentials are reported as unverified. |
| Returning profile | Connection and project restore without repeated setup; the effective project, environment and session precedence is visible. |
| Existing and legacy credentials | Explicit sharing and plaintext-to-Desktop migration retain their recovery copies; sharing never auto-imports plaintext. Missing and removed credentials or unavailable OS protection block Send. Verify schema-2 rejection for each supported prior build and prohibit unqualified downgrades. An unreadable saved key fails before provider dispatch and retains the draft; secrets do not appear in output. |
| Offline and headless | No prompts or unexpected remote provider/catalog/voice requests; protected accounts fail clearly rather than prompting for an OS unlock in headless mode. Explicit environment-backed headless connections still work. |
| 401, 403, 404, 429 and network failure | Synthetic transport tests distinguish the failures, retain the conversation and draft, and never silently switch provider or replay a task. |
| Provider/model switch | The next request uses the chosen account and exact model; conversation and execution authority remain intact. |
| Large repository | Measure composer availability and first task separately; verify background tree/session results cannot overwrite a later project. |
| Read-only coding task | With an expressly authorized real provider, inspect a disposable repository and independently compare the answer to the source and unchanged worktree. |
| Disposable edit | With an expressly authorized real provider, request a small change in a disposable repository, independently run the relevant test and inspect the diff and execution evidence. |

The last two rows require separate authorization for any provider charges.
Never infer their result from a mock. Record failures and skips, not only passing
runs. Measure launch-to-composer, install-to-first-successful-task, required
interactions, returning-user success, recovery success, false-ready cases and
provider request counts. Collect distributions and hardware/environment details
before proposing latency targets; do not treat a single source-build run as a
release benchmark.
