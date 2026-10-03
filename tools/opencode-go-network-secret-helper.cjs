// License: Apache-2.0 — see LICENSE
// Captured-output adapter for a Codex Cloud Network secret. The host must supply
// a placeholder; this script cannot distinguish it from a misconfigured raw key.
// Never invoke this helper interactively with a real configured environment.
'use strict'

const placeholder = process.env.BABEL_OPENCODE_GO_API_KEY
if (typeof placeholder !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(placeholder)) {
  process.stderr.write('OpenCode Go network-secret placeholder unavailable or invalid.\n')
  process.exitCode = 1
} else {
  process.stdout.write(placeholder)
}
