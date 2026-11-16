# Shared credentials: implementation boundary

Status: **implemented in the source candidate; installed-product and real
credential-store acceptance remain outstanding**. Desktop's existing
Electron-protected store stays under its native owner until the user explicitly
shares a protected account. The standalone Desktop launcher still refuses any
profile containing unshared protected entries or removal markers.

## Decision

Allow a separately launched Babel CLI process to retrieve a provider key that
the user has explicitly placed in a shared OS credential service. Before the
user shares it, Desktop's existing entry can be unlocked only by its Electron
owner and passed to its owned child.
This changes who can retrieve a saved credential; it is not merely a change to
the route display. On Windows, OS protection does not isolate credentials from
all other programs running as the same user. See the [Electron safeStorage
security model](https://www.electronjs.org/docs/latest/api/safe-storage).

## Implementation and compatibility

1. Add a small CLI-owned credential adapter with `get`, `set`, and `remove`
   operations scoped by a non-secret profile ID and connection ID. Keep secret
   values out of preferences, logs, command-line arguments, diagnostics and
   temporary files. The Desktop main process and standalone CLI use the same
   adapter; the renderer never receives a key.
2. The pinned `@napi-rs/keyring` release provides the Linux and macOS adapter. On Windows its upstream default permits enterprise credential roaming, so Babel instead uses a fixed local Credential Manager bridge with `CRED_PERSIST_LOCAL_MACHINE`. The bridge respects PowerShell execution policy and fails closed when unavailable. Evaluate its
   license, binary provenance, Electron/Node compatibility and package size.
   Explicitly require its `secret-service` backend on Linux: the library's
   [documented default](https://github.com/Brooooooklyn/keyring-node#linux-backend-selection)
   can otherwise fall back to an in-memory kernel keyring that does not survive
   reboot. A missing, locked or unsupported store must be reported, not treated
   as an empty store or a reason to write plaintext.
3. A user may explicitly migrate one Desktop credential: Desktop unlocks its
   existing entry in the native process, writes the shared entry, verifies the
   new entry, and only then records a non-secret reference. Preserve the old
   encrypted entry and removal markers for rollback. A failed or indeterminate
   write must not delete or silently fall back to another credential. Never
   automatically migrate a plaintext legacy file.
4. Preserve explicit credential provenance. A session-only replacement stays
   in its process; an explicitly selected environment reference remains an
   option for headless use; a shared store entry is used only for the selected
   account. Desktop must not begin inheriting arbitrary provider environment
   variables. Report the source and unverified status without returning values.
5. A shared account has one credential reference in the CLI's private
   `preferences.json`; Desktop's versioned marker names that account and retains
   its separate provider/model route. Existing CLI defaults and project choices
   are preserved. Replacing the account changes the shared reference; removal
   leaves the CLI reference pointing to a missing key so it cannot fall back.
   Cross-file writes cannot be fully atomic: uncertain outcomes are reported and
   old encrypted data is retained until an explicit removal. Non-secret retired
   references are retained with the connection so removal can delete each saved
   key; a partial failure keeps the references for a safe retry. A route update does
   not alter execution permissions or replay a task.
6. Package the platform-specific adapter for both npm and Desktop; account for
   Desktop builds that omit optional dependencies. A standalone WSL process uses
   its Linux credential service rather than silently reading Windows credentials.
   When no approved persistent backend is available, offer a session-only key or
   an explicitly supplied environment variable. Headless jobs select an
   environment-backed account instead of attempting an OS unlock prompt.

Shared accounts upgrade CLI preferences and Desktop credential markers to schema
version 2. The previous source version rejects these files rather than ignoring
the shared reference; older releases that do not read these files have not been
qualified and may follow their own configuration. Do not use an older build
against a shared profile. There is no automatic downgrade:
back up the files, understand which keys were subsequently replaced or removed,
and use a compatible build. Never restore an old encrypted copy blindly after a
removal. Session files, unrelated accounts and project overrides are preserved.

## Required verification

Use synthetic credentials and mocked adapters for failure, cancellation,
concurrent update, tombstone, legacy migration and no-leak cases. Verify the
actual selected backend and cross-process persistence on Windows and Linux in
isolated profiles, including missing/locked Secret Service and a restart. Test
installed Desktop and npm artifacts, not just source imports. Require the
repository's independent security review before delivery. No provider inference
or paid request is required for these checks.
