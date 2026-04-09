<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Node.js CLI Tools (v1.0)
**Category:** Framework / Runtime
**Status:** Active
**Pairs with:** `domain_swe_backend`, `domain_python_backend`

---

## Purpose

Node.js CLI tools have a distinct set of correctness patterns that differ from server-side application code. The most common failure modes are: wrong exit codes, broken ESM path resolution, missing `#!/usr/bin/env node`, and argument parsers that silently eat errors. This skill encodes the rules learned from building real CLI tools in this repo.

---

## 1. Package Setup

```json
// package.json — minimum correct structure for a Node.js CLI
{
  "name": "my-cli",
  "version": "1.0.0",
  "type": "module",
  "bin": {
    "my-cli": "./run.js"
  },
  "engines": {
    "node": ">=18"
  }
}
```

**Rules:**
- `"type": "module"` enables ES module syntax (`import`/`export`) throughout. Do NOT mix `require()` in an ESM package — it will throw at runtime.
- `"bin"` is required if the tool should be runnable as `npx my-cli` or installed globally.
- `"engines"` prevents silent failures on old Node versions. Node 18+ is safe for `crypto.randomBytes`, `URL`, `fs/promises`, and `node:util` `parseArgs`.
- Do NOT add `"main"` unless this is also a library. CLI-only packages have a `bin` entry, not a `main`.

---

## 2. Entrypoint Shebang

```javascript
#!/usr/bin/env node
/**
 * run.js — entrypoint
 */
import { doWork } from './lib.js'
// ...
```

**Rules:**
- The shebang line (`#!/usr/bin/env node`) must be the **first line** — no blank lines, no comments above it.
- Required for `npx` execution and for global installs (`npm install -g`). Without it, the shell tries to execute the file as a shell script and fails.
- In ESM packages, all local imports must include the `.js` extension even when the source is `.js` — Node's ESM resolver does not apply automatic extension resolution.

---

## 3. Path Resolution in ES Modules

`__dirname` and `__filename` do not exist in ES modules. Reconstruct them:

```javascript
import { fileURLToPath } from 'url'
import { dirname, join, resolve } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)

// Paths relative to the script file (for bundled assets like data/)
const dataPath = join(__dirname, 'data', 'tracker_domains.json')

// Paths relative to where the user ran the command (for output files)
const outputPath = resolve(process.cwd(), 'reports', 'scan.json')
```

**Rules:**
- Use `__dirname`-equivalent for paths to files **bundled with the tool** (config, data, templates).
- Use `process.cwd()` for paths to files the **user produces or provides** (output dirs, input files passed as args).
- Never hardcode absolute paths. Never assume `process.cwd()` equals `__dirname`.

---

## 4. Argument Parsing

### Option A — Manual parsing (simple tools, zero deps)

```javascript
function parseArgs(argv) {
  const args = argv.slice(2) // strip 'node' and script path
  if (args.length === 0) usage('No arguments provided.')

  let url = null
  let timeout = 30_000
  let outputDir = 'reports'

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === '--timeout') {
      const val = parseInt(args[++i], 10)
      if (isNaN(val) || val < 1_000) usage('--timeout must be a number ≥ 1000.')
      timeout = val
    } else if (arg === '--output') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) usage('--output requires a path.')
      outputDir = args[++i]
    } else if (arg === '--help' || arg === '-h') {
      usage()
    } else if (!arg.startsWith('--')) {
      if (url) usage('Multiple positional arguments provided.')
      url = arg
    } else {
      usage(`Unknown flag: ${arg}`)
    }
  }

  if (!url) usage('No URL provided.')
  return { url, timeout, outputDir }
}
```

### Option B — `node:util` parseArgs (Node 18+, more features)

```javascript
import { parseArgs } from 'node:util'

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    timeout:  { type: 'string',  short: 't' },
    output:   { type: 'string',  short: 'o' },
    verbose:  { type: 'boolean', short: 'v', default: false },
  },
  allowPositionals: true,
})

const url     = positionals[0]
const timeout = parseInt(values.timeout ?? '30000', 10)
const output  = values.output ?? 'reports'
```

**Rules:**
- Always call `argv.slice(2)`. `argv[0]` is the Node binary, `argv[1]` is the script path — both are irrelevant to the user's intent.
- Validate all parsed values before use. `parseInt` returns `NaN` on invalid input — always check `isNaN()`.
- Unknown flags should exit with code 1 and print usage. Never silently ignore unrecognized input.
- Use manual parsing for simple tools (≤5 flags, no subcommands). Use `node:util parseArgs` for tools with boolean flags, aliases, or defaults. Avoid external arg parsing libraries for v1 CLI tools.

---

## 5. Exit Codes

```javascript
// Standard exit code contract
// 0  — success (even if the result is "nothing found" — that is a valid outcome)
// 1  — bad arguments or invalid input (user error)
// 2  — unrecoverable runtime error (tool failure, not user fault)

function usage(message) {
  if (message) console.error(`Error: ${message}\n`)
  console.error('Usage: my-cli <url> [--timeout <ms>] [--output <dir>]')
  process.exit(1) // user error — exit 1
}

async function main() {
  // ...
  try {
    result = await doWork()
  } catch (err) {
    console.error(`Fatal: ${err.message}`)
    if (process.env.DEBUG) console.error(err.stack)
    process.exit(2) // tool failure — exit 2
  }

  // "no results found" is a valid outcome, not an error
  process.exit(0)
}
```

**Rules:**
- Exit 0 for all successful completions, including "nothing found" results. Scripts and CI pipelines treat non-zero as failure.
- Exit 1 for argument/input errors (wrong URL, unknown flag, missing required arg). The user needs to fix their invocation.
- Exit 2 for runtime failures (browser crashed, file system error, network failure). The tool failed, not the user.
- Never call `process.exit()` inside a library module. Only call it in the entrypoint (`run.js`). Libraries should `throw`.
- Always `await` the main async function — unhandled promise rejections are not caught by `try/catch` unless the rejection happens in an awaited call.

```javascript
// Correct top-level pattern
async function main() { /* ... */ }
main() // don't await at top level in ESM — async rejection surfaces differently
       // but DO handle the error:
main().catch((err) => {
  console.error(`Unexpected error: ${err.message}`)
  process.exit(2)
})
```

---

## 6. stdout vs stderr

```javascript
// stdout — the tool's output (piped by scripts, captured by CI)
console.log('{"scan_id": "scan_abc123", ...}')  // machine-readable output
process.stdout.write(data)                        // raw write, no newline

// stderr — diagnostic messages (not captured by pipes; always visible to the user)
console.error('Error: invalid URL')              // user-visible errors
console.error('Warning: idle timeout exceeded')  // warnings
console.error('Scanning https://example.com...') // progress (doesn't pollute pipe)
```

**Rules:**
- If your tool produces machine-readable output (JSON, CSV), write it to stdout only. All human-readable messages (progress, warnings, errors) go to stderr.
- If your tool produces a human-readable summary for a terminal user (not piped), `console.log` is fine for the summary. Add a `--json` flag if you need both modes.
- Never write progress messages to stdout in a tool that emits JSON to stdout — they will corrupt the output for any caller that pipes it.

---

## 7. File System Output

```javascript
import { writeFileSync, mkdirSync } from 'fs'
import { resolve, join } from 'path'

function writeOutput(data, outputDir) {
  const absDir = resolve(outputDir)       // resolve relative to cwd
  mkdirSync(absDir, { recursive: true })  // create dir if missing — idempotent
  const filePath = join(absDir, 'result.json')
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8')
  return filePath
}
```

**Rules:**
- Always `resolve()` user-provided output paths before use. `join()` alone does not handle relative paths correctly when the cwd changes.
- `mkdirSync({ recursive: true })` is safe to call even if the directory exists — it does not throw.
- Prefer `writeFileSync` over async file writes in CLI tools unless the file is very large. Async file writes that are not awaited will silently drop data on process exit.
- Return the absolute path from the write function so the entrypoint can print it to the user.

---

## 8. Graceful Error Handling

```javascript
// Wrap the entire main body — catch both sync throws and async rejections
async function main() {
  let result
  try {
    result = await expensiveOperation()
  } catch (err) {
    console.error(`\nOperation failed: ${err.message}`)
    // DEBUG mode shows the full stack — off by default to keep terminal clean
    if (process.env.DEBUG) console.error(err.stack)
    else console.error('Run with DEBUG=1 for a full stack trace.')
    process.exit(2)
  }

  // Non-fatal: best-effort output write
  try {
    const path = writeOutput(result, outputDir)
    console.log(`Report written: ${path}`)
  } catch (writeErr) {
    console.error(`Warning: could not write output file: ${writeErr.message}`)
    // Don't exit 2 here — the work succeeded; only the write failed
  }

  process.exit(0)
}
```

**Rules:**
- Separate fatal errors (operation failed → exit 2) from non-fatal errors (write failed → warn and continue).
- Gate full stack traces behind `process.env.DEBUG`. Stacktraces in normal output are noise for end users; they are essential for debugging.
- Wrap `browser.close()`, file writes, and other cleanup in try/catch inside `finally`. A cleanup failure must not mask the original error.

---

## 9. High-Risk Zones

| Zone | Risk |
|------|------|
| Missing `.js` extension in ESM imports | `ERR_MODULE_NOT_FOUND` at runtime — not caught at write time |
| `__dirname` used without reconstruction | `ReferenceError: __dirname is not defined` |
| `process.exit(0)` on error | Scripts think the tool succeeded; silent CI failures |
| `process.exit()` in library code | Kills the whole process from a non-entrypoint — caller has no chance to handle |
| `parseInt()` without `isNaN()` check | Silent `NaN` propagated into numeric comparisons |
| Relative `outputDir` passed to `join()` without `resolve()` | Files written to wrong location when cwd differs from expected |
| Unhandled promise rejection in `main()` | Process exits with code 1 and a deprecation warning in Node 18+, code 0 in older versions — unpredictable |
| stdout contaminated with progress messages | JSON output piped to another tool is broken without warning |
