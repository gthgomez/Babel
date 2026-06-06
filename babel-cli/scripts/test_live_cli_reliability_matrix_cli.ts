import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(scriptDir, '..');

/** Mirrors operator path: npm run reliability:matrix -- --help */
function runMatrixViaNpm(extraArgs: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'npm',
      ['run', 'reliability:matrix', '--', ...extraArgs],
      {
        cwd: packageRoot,
        env: process.env,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stderr = '';
    child.stderr.on('data', chunk => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`reliability matrix exited ${code ?? 'null'}: ${stderr.trim()}`));
        return;
      }
      resolve(code ?? 0);
    });
  });
}

async function main(): Promise<void> {
  await runMatrixViaNpm(['--help']);
  await runMatrixViaNpm(['--list']);
  console.log('[test] npm run reliability:matrix -- --help and --list exited 0');
}

main().catch(error => {
  console.error(`[test] reliability matrix CLI spawn failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
