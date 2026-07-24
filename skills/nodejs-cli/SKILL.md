---
name: nodejs-cli
description: Build, modify, or review Node.js command-line tools, especially ESM CLIs, package bin entries, Commander or node:util argument parsing, stdout/stderr contracts, exit codes, cross-platform path handling, generated reports, and real built-command smoke tests.
---

## Prompt bridge

- **Babel catalog id:** `skill_nodejs_cli`
- **Prompt-layer owner:** `02_Skills/Framework/NodeJS-CLI-v1.md`
- Use the prompt skill for Babel stack assembly; use this package for structured contracts, examples, and validation fixtures.

# Node.js CLI

Use this skill when creating, modifying, or reviewing a Node.js command-line tool.
It is especially relevant for ESM CLIs, Commander or `node:util` argument parsing,
package `bin` entries, stdout/stderr contracts, exit codes, generated reports, and
cross-platform path handling.

Do not use this skill for server-only Node.js applications unless the task also
touches a runnable CLI surface.

## Workflow

1. Identify the CLI entrypoint, package metadata, and command registration path before editing.
2. Preserve the existing parser style unless it is the source of the bug.
3. Keep library modules free of `process.exit()`; only the entrypoint should terminate the process.
4. Validate all user-provided arguments before file or network operations.
5. Keep machine-readable output on stdout and diagnostics on stderr.
6. Resolve bundled files relative to the module file, and user inputs relative to `process.cwd()`.
7. Verify through the built or installed command, not only by importing helper functions.

## Package Rules

- New ESM CLI packages should use `"type": "module"` and include a `bin` entry.
- The executable entrypoint must start with `#!/usr/bin/env node` as the first line.
- ESM local imports need explicit `.js` extensions in emitted JavaScript paths.
- Avoid a `"main"` field for CLI-only packages unless the package is also a library.
- State the minimum supported Node version in `engines`.

## Argument Parsing

- Always parse `process.argv.slice(2)`, never the full `process.argv`.
- Unknown flags should be rejected with exit code `1`.
- Missing required values should be rejected with exit code `1`.
- Numeric flags must be parsed and checked for `NaN`, bounds, and units.
- Use manual parsing for tiny CLIs; use `node:util parseArgs` or the repo's existing parser for larger command surfaces.

## Exit Codes

- `0`: command completed successfully, including valid "no results" outcomes.
- `1`: user/input error such as invalid args, missing path, or unknown flag.
- `2`: tool/runtime failure such as an unexpected exception or failed external dependency.

## Output Contract

- JSON, CSV, and other machine-readable command results go to stdout.
- Progress, warnings, usage errors, and debug hints go to stderr.
- Never mix progress logs into stdout for a JSON-emitting command.
- Gate stack traces behind an explicit debug flag or environment variable.

## File System Rules

- Use `process.cwd()` for user-provided input and output paths.
- Reconstruct `__dirname` in ESM with `fileURLToPath(import.meta.url)` when reading bundled assets.
- Create output directories with recursive mkdir where appropriate.
- Return or print absolute report paths when writing artifacts.

## Verification

Prefer this order:

1. Targeted unit tests for parsing and validation.
2. Typecheck or build.
3. Built CLI smoke test through the actual command.
4. JSON parse check for `--json` commands.
5. Human-output inspection for non-JSON commands.

Do not claim a CLI command works unless it was executed through its real entrypoint.
