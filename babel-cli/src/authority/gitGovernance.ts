/** Resolve linked-worktree governance without executing Git or following symlinks. */
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, win32, posix } from 'node:path';

/** Reject traversed symlinks; missing descendants remain valid snapshot targets. */
export function assertGovernanceAncestors(path: string): void {
  const parents: string[] = [];
  for (let p = dirname(resolve(path)); dirname(p) !== p; p = dirname(p)) parents.push(p);
  for (const p of parents.reverse()) {
    try {
      if (!lstatSync(p).isDirectory()) throw new Error('Invalid governance ancestor');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

function regularText(path: string): string {
  assertGovernanceAncestors(path);
  if (!lstatSync(path).isFile()) throw new Error('Invalid Git governance pointer');
  return readFileSync(path, 'utf8').trim();
}

type IdentityFs = { lstatSync(path: string): Pick<import('node:fs').Stats, 'isDirectory' | 'isSymbolicLink'>; realpathSync(path: string): string };

/** Canonicalize validated existing ancestors; retain only missing ordinary suffixes. */
export function canonicalGovernanceTarget(path: string, fs: IdentityFs = { lstatSync, realpathSync: realpathSync.native }, platform = process.platform, allowMissing = true): string {
  const paths = platform === 'win32' ? win32 : posix;
  let existing = paths.resolve(path);
  const suffix: string[] = [];
  while (allowMissing) {
    try { fs.lstatSync(existing); break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || paths.dirname(existing) === existing) throw error;
      suffix.unshift(paths.basename(existing));
      existing = paths.dirname(existing);
    }
  }
  const chain = [existing];
  for (let p = paths.dirname(existing); paths.dirname(p) !== p; p = paths.dirname(p)) chain.unshift(p);
  for (const item of chain) {
    const stat = fs.lstatSync(item);
    if (stat.isSymbolicLink() || ((item !== existing || suffix.length > 0) && !stat.isDirectory())) throw new Error('Invalid governance ancestor');
  }
  const canonical = paths.join(fs.realpathSync(existing), ...suffix);
  return platform === 'win32' ? canonical.toLowerCase() : canonical;
}

/** Compare existing objects after rejecting links, including every ancestor and leaf. */
export function sameGovernancePath(left: string, right: string, fs: IdentityFs = { lstatSync, realpathSync: realpathSync.native }, platform = process.platform): boolean {
  return canonicalGovernanceTarget(left, fs, platform, false) === canonicalGovernanceTarget(right, fs, platform, false);
}

/** Physical aliases cannot evade direct-write or patch governance admission. */
export function isProtectedGovernanceAlias(root: string, cwd: string, target: string, entries: readonly { path: string }[], fs: IdentityFs = { lstatSync, realpathSync: realpathSync.native }, platform = process.platform): boolean {
  const paths = platform === 'win32' ? win32 : posix;
  const actual = canonicalGovernanceTarget(paths.resolve(cwd, target), fs, platform);
  return entries.some(entry => {
    const protectedPath = canonicalGovernanceTarget(paths.resolve(root, entry.path), fs, platform);
    const rel = paths.relative(protectedPath, actual);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${paths.sep}`) && !paths.isAbsolute(rel));
  });
}

/** null denotes a normal repository (or no Git metadata). */
export function linkedGitGovernancePaths(repoRoot: string, trustedGitCommonDir?: string): string[] | null {
  const pointer = resolve(repoRoot, '.git');
  let st;
  try { st = lstatSync(pointer); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (st.isDirectory()) return null;
  const match = /^gitdir: ([^\r\n]+)$/.exec(regularText(pointer));
  if (!match) throw new Error('Invalid Git worktree pointer');
  const admin = resolve(repoRoot, match[1]!);
  // Authorization precedes every read outside the selected project.
  if (!trustedGitCommonDir || !isAbsolute(trustedGitCommonDir)) throw new Error('Missing absolute trusted Git common directory');
  const trusted = resolve(trustedGitCommonDir);
  if (!sameGovernancePath(dirname(admin), join(trusted, 'worktrees'))) throw new Error('Git admin path is outside trusted Git common directory');
  assertGovernanceAncestors(join(trusted, 'config'));
  const commonText = regularText(join(admin, 'commondir'));
  if (!commonText || /[\r\n]/.test(commonText)) throw new Error('Invalid Git common directory');
  const common = resolve(admin, commonText);
  if (!sameGovernancePath(common, trusted) || !sameGovernancePath(dirname(dirname(admin)), common) || !sameGovernancePath(dirname(admin), join(common, 'worktrees'))) {
    throw new Error('Git worktree admin directory is outside common worktrees');
  }
  const backlink = regularText(join(admin, 'gitdir'));
  if (!backlink || /[\r\n]/.test(backlink) || !sameGovernancePath(resolve(admin, backlink), pointer)) {
    throw new Error('Git worktree backlink mismatch');
  }
  const paths = [pointer, join(admin, 'commondir'), join(admin, 'gitdir')];
  for (const base of [common, admin]) {
    for (const suffix of ['config', 'config.worktree', 'hooks', 'info/attributes']) paths.push(join(base, suffix));
  }
  for (const path of paths) assertGovernanceAncestors(path);
  return paths.map((path) => relative(repoRoot, path).replace(/\\/g, '/'));
}

/** Resolve manifest entries without rebasing absolute cross-drive Windows paths. */
export function resolveGovernancePath(root: string, entry: string, platform = process.platform): string {
  return (platform === 'win32' ? win32 : posix).resolve(root, entry);
}
