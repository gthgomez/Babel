/** Resolve linked-worktree governance without executing Git or following symlinks. */
import { lstatSync, readFileSync } from 'node:fs';
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

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
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
  if (!samePath(dirname(admin), join(trusted, 'worktrees'))) throw new Error('Git admin path is outside trusted Git common directory');
  assertGovernanceAncestors(join(trusted, 'config'));
  const commonText = regularText(join(admin, 'commondir'));
  if (!commonText || /[\r\n]/.test(commonText)) throw new Error('Invalid Git common directory');
  const common = resolve(admin, commonText);
  if (!samePath(common, trusted) || !samePath(dirname(dirname(admin)), common) || !samePath(dirname(admin), join(common, 'worktrees'))) {
    throw new Error('Git worktree admin directory is outside common worktrees');
  }
  const backlink = regularText(join(admin, 'gitdir'));
  if (!backlink || /[\r\n]/.test(backlink) || !samePath(resolve(admin, backlink), pointer)) {
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
