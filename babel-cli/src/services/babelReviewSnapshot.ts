import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, lstatSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, parse } from 'node:path';

export function assertReviewStateOutsideGit(directory: string): string {
  const full = resolve(directory);
  for (let p = full; ; p = dirname(p)) {
    if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new Error('STATE_SYMLINK_DENIED');
    if (existsSync(join(p, '.git'))) throw new Error('STATE_INSIDE_CANDIDATE_WORKTREE');
    if (p === parse(p).root) break;
  }
  mkdirSync(full, { recursive: true, mode: 0o700 });
  return full;
}

export function secretRiskReviewPath(path: string): boolean {
  if (/(^|\/)\.env\.example$/i.test(path)) return false;
  return /(^|\/)(\.env([.]|$)|auth\.json$|credentials([.]|$)|\.credentials|id_rsa$|id_ed25519$|\.npmrc$|local\.properties$|gradle\.properties$)|\.(pem|p12|pfx|key)$/i.test(path);
}

export function safeReviewPath(path: string): boolean {
  return !!path && !path.includes('\\') && !path.startsWith('/') && !path.includes(':') && !path.split('/').some(p => ['', '.', '..'].includes(p));
}

/** Materialize Git blobs as inert data, never checkout hooks, links, or installs. */
export function collectBabelReviewSnapshot(input: { repoRoot: string; base: string; head: string; state: string; task: string }) {
  if (![input.base, input.head].every(v => /^[0-9a-f]{40}$/.test(v))) throw new Error('INVALID_REVIEW_SHA');
  const git = (args: string[]) => execFileSync('git', ['-C', input.repoRoot, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 100 * 1024 * 1024 });
  const range = `${input.base}...${input.head}`;
  const scope = git(['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', range]).split('\0').filter(Boolean).sort();
  if (!scope.length || scope.some(p => !safeReviewPath(p) || secretRiskReviewPath(p))) throw new Error('UNSAFE_REVIEW_SCOPE');
  const numstat = git(['diff', '--no-ext-diff', '--no-textconv', '--numstat', range]).trimEnd().split(/\r?\n/);
  const diff = git(['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', range]);
  const records = git(['ls-tree', '-r', '-z', '--long', input.head]).split('\0').filter(Boolean).map(line => {
    const tab = line.indexOf('\t'); const [mode, type, oid, size] = line.slice(0, tab).trim().split(/\s+/);
    return { mode, type, oid: oid!, size: Number(size), path: line.slice(tab + 1) };
  });
  const files = records.filter(r => safeReviewPath(r.path) && !secretRiskReviewPath(r.path) && r.type === 'blob' && /^100(644|755)$/.test(r.mode!) && r.size <= 2 * 1024 * 1024);
  const excluded = records.filter(r => !files.includes(r)).map(r => r.path);
  if (scope.some(p => excluded.includes(p))) throw new Error('CHANGED_UNSUPPORTED_BLOB');
  if (files.reduce((n, r) => n + r.size, 0) > 80 * 1024 * 1024) throw new Error('SNAPSHOT_SIZE_LIMIT');
  const id = randomUUID(); const root = join(assertReviewStateOutsideGit(input.state), 'snapshots', id);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const batch = execFileSync('git', ['-C', input.repoRoot, 'cat-file', '--batch'], { input: files.map(r => r.oid).join('\n') + '\n', maxBuffer: 100 * 1024 * 1024, windowsHide: true });
  let offset = 0;
  for (const file of files) {
    const end = batch.indexOf(10, offset); const header = batch.subarray(offset, end).toString('utf8').split(' ');
    if (header[0] !== file.oid || header[1] !== 'blob' || Number(header[2]) !== file.size) throw new Error('SNAPSHOT_OBJECT_MISMATCH');
    offset = end + 1;
    const target = join(root, 'source', file.path); mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, batch.subarray(offset, offset + file.size), { flag: 'wx', mode: 0o400 }); offset += file.size + 1;
  }
  writeFileSync(join(root, 'changes.diff'), diff, { flag: 'wx', mode: 0o400 });
  writeFileSync(join(root, 'review-task.txt'), input.task, { flag: 'wx', mode: 0o400 });
  writeFileSync(join(root, 'review-manifest.json'), JSON.stringify({ scope, base: input.base, head: input.head, excluded, execution_id: id }), { flag: 'wx', mode: 0o400 });
  execFileSync('gitleaks', ['dir', root, '--redact', '--no-banner'], { stdio: 'pipe', windowsHide: true, maxBuffer: 1024 * 1024 });
  return { id, root, scope, numstatDigest: createHash('sha256').update([...numstat].sort().join('\n')).digest('hex'), taskHash: createHash('sha256').update(input.task).digest('hex') };
}
