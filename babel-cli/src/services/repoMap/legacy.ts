import { opendir, open } from 'node:fs/promises';
import { join } from 'node:path';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'runs', 'artifacts', 'runtime', '.claude', '.cursor',
  'coverage', '.nyc_output', 'tmp',
]);
const MAX_ENTRIES = 2_000;
const MAX_DISPLAYED_PER_CATEGORY = 100;
const MAX_CONFIG_BYTES = 128 * 1024;

function isKeyConfigFile(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'package.json' || lower === 'tsconfig.json' || lower === 'claude.md'
    || lower.endsWith('.yaml') || lower.endsWith('.yml') || lower === '.gitignore'
    || lower === 'dockerfile' || lower === 'makefile' || lower.endsWith('.toml')
    || lower.endsWith('.cfg');
}

async function readSmallJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const handle = await open(path, 'r');
    try {
      if ((await handle.stat()).size > MAX_CONFIG_BYTES) return null;
      const buffer = Buffer.allocUnsafe(MAX_CONFIG_BYTES + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const result = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (!result.bytesRead) break;
        offset += result.bytesRead;
      }
      if (offset > MAX_CONFIG_BYTES) return null;
      return JSON.parse(buffer.subarray(0, offset).toString('utf8')) as Record<string, unknown>;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/** Legacy directory summary. The worker bounds its execution and lifetime. */
export async function buildLegacyRepoMapPreamble(projectRoot: string): Promise<string> {
  const topDirs: string[] = [];
  const keyFiles: string[] = [];
  let truncated = false;
  try {
    const entries = await opendir(projectRoot);
    let count = 0;
    for await (const entry of entries) {
      if (++count > MAX_ENTRIES) {
        truncated = true;
        break;
      }
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        if (topDirs.length < MAX_DISPLAYED_PER_CATEGORY) topDirs.push(`${entry.name}/`);
        else truncated = true;
      } else if (entry.isFile() && !SKIP_DIRS.has(entry.name) && isKeyConfigFile(entry.name)) {
        if (keyFiles.length < MAX_DISPLAYED_PER_CATEGORY) keyFiles.push(entry.name);
        else truncated = true;
      }
    }
  } catch {
    // Missing or unreadable directory: retain the header as a safe fallback.
  }
  topDirs.sort();
  keyFiles.sort();
  const lines = ['## Repository Map'];
  if (topDirs.length) lines.push(`- Top-level: ${topDirs.join(' ')}`);
  if (keyFiles.length) lines.push(`- Key files: ${keyFiles.join(', ')}`);
  if (truncated) lines.push('- Directory listing truncated.');
  const testDirs = topDirs.filter((dir) => /test/i.test(dir));
  if (testDirs.length) lines.push(`- Tests: ${testDirs.join(' ')}`);

  const pkg = await readSmallJson(join(projectRoot, 'package.json'));
  const scripts = pkg?.['scripts'] as Record<string, unknown> | undefined;
  if (scripts?.['build']) lines.push('- Build: npm run build');
  if (scripts?.['test']) lines.push('- Test: npm test');
  if (scripts?.['typecheck']) lines.push('- TypeCheck: npm run typecheck');
  const tsconfig = await readSmallJson(join(projectRoot, 'tsconfig.json'));
  const compilerOptions = tsconfig?.['compilerOptions'] as Record<string, unknown> | undefined;
  if (compilerOptions?.['strict'] === true) lines.push('- TypeScript strict mode: true');
  return lines.join('\n');
}
