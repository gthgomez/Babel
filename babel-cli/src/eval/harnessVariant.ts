/**
 * Isolated harness identity for same-model A/B experiments.
 * Never share BABEL_ROOT, dist, or a mutable task directory across arms.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface HarnessVariant {
  id: string
  git_sha: string
  repo_root: string
  package_root: string
  cli_entry: string
  build_identity: {
    dist_hash: string
    source_tree_hash: string
  }
  environment: {
    BABEL_ROOT: string
  }
}

export interface HarnessVariantInput {
  id: string
  git_sha: string
  repo_root: string
  cli_entry?: string
}

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function hashTree(root: string, rel = ''): string {
  const dir = rel ? join(root, rel) : root
  if (!existsSync(dir)) {
    return createHash('sha256').update(`missing:${rel}`).digest('hex')
  }
  const names = readdirSync(dir).sort()
  const h = createHash('sha256')
  for (const name of names) {
    if (name === 'node_modules' || name === '.git' || name === 'dist') continue
    const full = join(dir, name)
    const st = statSync(full)
    const childRel = rel ? `${rel}/${name}` : name
    if (st.isDirectory()) {
      h.update(name)
      h.update(hashTree(root, childRel))
    } else if (st.isFile()) {
      h.update(name)
      h.update(hashFile(full))
    }
  }
  return h.digest('hex')
}

/**
 * Resolve a variant from an already-built worktree. Does not mutate the task workspace.
 */
export function resolveHarnessVariant(input: HarnessVariantInput): HarnessVariant {
  const repoRoot = resolve(input.repo_root)
  const packageRoot = join(repoRoot, 'babel-cli')
  const cliEntry = input.cli_entry
    ? resolve(input.cli_entry)
    : join(packageRoot, 'dist', 'index.js')
  const distHash = existsSync(cliEntry)
    ? hashFile(cliEntry)
    : createHash('sha256').update('missing-cli-entry').digest('hex')
  const sourceTreeHash = hashTree(packageRoot, 'src')
  return {
    id: input.id,
    git_sha: input.git_sha,
    repo_root: repoRoot,
    package_root: packageRoot,
    cli_entry: cliEntry,
    build_identity: {
      dist_hash: distHash,
      source_tree_hash: sourceTreeHash,
    },
    environment: {
      BABEL_ROOT: repoRoot,
    },
  }
}

/**
 * Child env for a variant. Parent BABEL_ROOT must not win.
 */
export function harnessVariantChildEnv(
  variant: HarnessVariant,
  extra?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    ...extra,
    BABEL_ROOT: variant.environment.BABEL_ROOT,
  }
}
