#!/usr/bin/env node
// Deterministic Command Code CLI stand-in for discovery tests (no network).
const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-V') || args[0] === 'version') {
  process.stdout.write('command-code fixture 0.4.2-beta.1\n');
  process.exit(0);
}
process.stderr.write('unknown invocation\n');
process.exit(2);
