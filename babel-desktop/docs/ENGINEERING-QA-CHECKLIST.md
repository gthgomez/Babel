# Repeatable engineering QA checklist

Use this checklist for a particular change and artifact. Keep it in Babel until
another repository has adapted it to its own runner and acceptance criteria.

- [ ] **Identify the candidate and runner.** Record `git remote get-url origin`,
  `git rev-parse HEAD`, branch, and `git status --short`. Use a clean, isolated,
  writable checkout; record the exact runner OS, Node, Git and PowerShell
  versions, and the CI run/job URL when applicable. Check that the runner can
  return logs and artifacts. Use native Windows for Windows acceptance; run Linux
  work in cloud or via remote Cursor Composer in non-Fast mode, never local WSL.
- [ ] **Bind the artifact to the checkout.** Record the build source SHA, build
  inputs and artifact checksum. Verify the payload against `SHA256SUMS`, and
  compare the installed `BUILD.json` source SHA with the checkout that built it.
  For a synthetic PR merge build, retain its head/base binding. A package build
  or successful install alone does not prove the application can perform a task.
- [ ] **Use one repeatable Windows entry point.** On a clean Windows user and a
  disposable checkout, use the existing `installer-lifecycle` CI job or run:

  ```powershell
  pwsh -NoProfile -File babel-desktop/test/installer-lifecycle/run-lifecycle.ps1 `
    -PayloadZip <qualified-payload.zip> -Sha256Sums <SHA256SUMS> -MakensisPath <makensis.exe>
  ```

  Supply the pinned Node and Electron archives in `LIFECYCLE_NODE_ARCHIVE` and
  `LIFECYCLE_ELECTRON_ARCHIVE`, as the workflow does. The lifecycle creates an
  upgrade-fixture commit in its checkout; do not run it in a working checkout.
  Step 3b invokes the installed Electron acceptance. Its scripted provider must
  exclusively bind `127.0.0.1:11434`; an occupied port is a preflight failure.
  `run-packaged-gui.ps1` fails closed unless `packaged-electron-acceptance.json`
  records this checkout's source SHA, engine readiness, an unchanged read-only
  task, and the one-line `parser.mjs` repair diff. A process exit alone is not
  that evidence.
  Keep its JSON, actual fixture diff and screenshots with the run URL and
  artifact identity. The lifecycle retains `installer-build.json`,
  `installer.sha256` and `payload-SHA256SUMS` in the same artifact directory.
- [ ] **Use clean state and a real oracle.** Use disposable profiles and synthetic
  projects, with no inherited credentials or external provider calls. Establish
  the fixture's failing behavior first. For a repair, submit through the actual
  user-facing path, observe a terminal result, independently rerun the behavior
  check, and inspect the actual scoped diff. Include a submitted read-only task
  that leaves the project unchanged; keep the normal project-trust and
  operation-bound approval checks. The lane preauthorizes its disposable
  project; it does not test the project-trust dialog. A new or changed lane is
  unqualified until it passes against the exact installed Windows artifact.
  The host-native source probe allowed this fixture verifier without a prompt;
  if the installed run requests approval, the harness only allows `npm test`
  in the fixture project through the displayed, operation-bound control. The
  harness stops an active task and then terminates its owned test process tree;
  this is not a graceful-close test. If the GUI cleanup receipt is unresolved
  or unavailable, the lifecycle retains the install and reports cleanup blocked.
- [ ] **Classify the evidence.** Report build/install, render or fixture tests,
  installed end-to-end behavior, and live-provider results separately. A source
  test or mocked IPC is not installed proof; a scripted local provider is not a
  live model. For the fixture/oracle alone, run
  `node --test babel-desktop/test/packaged-repair-fixture.test.mjs babel-desktop/test/packaged-fixture-lane.test.mjs`.
- [ ] **Keep a failure receipt.** Record candidate SHA, artifact checksum,
  runner, entry point, stage, exit/result, relevant run and artifact links, and
  whether failure was setup/preflight, build/install, render/transport,
  admission/approval, provider dispatch, task execution, independent oracle,
  or cleanup. Record unavailable evidence and skipped checks explicitly; do not
  present a prior or different-artifact result as a pass.
- [ ] **Keep live smoke separate.** Only when explicitly requested, follow normal
  product policy and use an approved credential store and a synthetic project.
  Report pre-dispatch blocks, provider rejection, response, usage and cost when
  available. Do not use live credentials or calls for the deterministic lane.
