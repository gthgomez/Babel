#!/usr/bin/env node
if (process.argv.includes('--version') || process.argv.includes('-V') || process.argv.includes('version')) {
  process.stdout.write('opencode fixture 1.0.0\n');
  process.exit(0);
}
process.stdout.write('opencode fixture 1.0.0\n');
