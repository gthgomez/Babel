#!/usr/bin/env node

const invoked = process.argv[1]?.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? 'bl';
const label = invoked === 'babel-lite.js' || invoked === 'babel-lite' ? 'babel-lite' : 'bl';

process.stderr.write(
  `[babel] ${label} was removed. Use:\n` +
  '  babel "<task>"\n' +
  '  babel plan "<task>"\n' +
  '  babel deep "<task>"\n',
);
process.exit(1);