#!/usr/bin/env node

const invoked = process.argv[1]?.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? 'bl';
const label = invoked === 'babel-lite.js' || invoked === 'babel-lite' ? 'babel-lite' : 'bl';

process.stderr.write(
  `[babel] ${label} was removed. Use:\n` +
  '  babel-harness "<task>"\n' +
  '  babel-harness plan "<task>"\n' +
  '  babel-harness deep "<task>"\n',
);
process.exit(1);