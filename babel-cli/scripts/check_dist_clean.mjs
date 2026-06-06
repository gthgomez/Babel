import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = resolve(__dirname, '..');

function readDistStatus() {
  return execFileSync(
    'git',
    ['status', '--porcelain', '--', 'dist'],
    { cwd: packageRoot, encoding: 'utf8' },
  ).trim();
}

const before = readDistStatus();
if (process.platform === 'win32') {
  execFileSync(
    process.env['ComSpec'] ?? 'cmd.exe',
    ['/d', '/s', '/c', 'npm run build'],
    { cwd: packageRoot, stdio: 'inherit' },
  );
} else {
  execFileSync(
    'npm',
    ['run', 'build'],
    { cwd: packageRoot, stdio: 'inherit' },
  );
}

const after = readDistStatus();

if (after !== before) {
  console.error('[babel] Rebuilding changed dist/. Generated output is drifting from src/.');
  console.error('[babel] Dist status before rebuild:');
  console.error(before || '(clean)');
  console.error('[babel] Dist status after rebuild:');
  console.error(after || '(clean)');
  process.exit(1);
}
