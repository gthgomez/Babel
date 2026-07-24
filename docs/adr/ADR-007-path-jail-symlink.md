# ADR-007: Path Jail with Symlink Resolution

<!--
status: ACTIVE
last_verified: 2026-07-03
-->
**Status:** Accepted  
**Date:** 2026-06-19  
**Deciders:** Babel team  

## Context

The CLI Executor performs file operations (read, write, list) within the user's project. Without path validation, a compromised or errant LLM could read sensitive files outside the project root (e.g., `~/.ssh/id_rsa`, `/etc/passwd`) or write to system directories.

Simple prefix checking (`path.startsWith(projectRoot)`) is insufficient: symlinks, `..` traversal, and NTFS junction points can escape the project root while appearing to stay within it.

## Decision

We use **segment-by-segment symlink resolution** via `resolveSafe()` and `resolveSafeRead()` in `babel-cli/src/sandbox.ts`.

**Algorithm:**
1. Resolve the target path relative to the project root
2. Walk each path segment from the root, calling `fs.realpathSync()` at each step
3. After each segment resolution, verify the resolved path still starts with the project root
4. If any segment resolves outside the root, reject the path

**Additional layers:**
- **Approved read roots (VCS):** Paths within `.git/`, `.svn/`, etc. are allowed for read-only access even if outside the strict project root
- **Write isolation:** File writes are restricted to the project root only (no VCS exception)
- **NTFS junction handling:** On Windows, `fs.realpathSync()` resolves NTFS junctions; the segment walk catches junction escapes

## Alternatives Considered

**Prefix-only checking:** Fast but trivially bypassed by symlinks and `..` traversal.

**Chroot/container isolation:** Strongest, but heavyweight. Used for benchmark execution (Docker); not suitable for every `file_read` call in local development.

**`fs.realpathSync()` once:** Resolves the final path but misses intermediate symlink escapes (a symlink at depth 3 could point outside, and a later `..` could traverse back in, making the final path appear safe).

## Consequences

**Benefits:**
- Catches symlink escapes at any depth in the path
- Works cross-platform (POSIX symlinks, Windows junctions)
- Read/write separation (VCS exception for reads)
- Segment-by-segment resolution is the same approach used by other security-conscious tools

**Trade-offs:**
- `realpathSync` per segment adds filesystem I/O overhead (mitigated by caching)
- NTFS junction resolution behavior differs between Windows versions
- Must handle edge cases: deleted files, mount points, network paths
- Added complexity in `sandbox.ts` (~200 lines for path validation)

## Compliance

All file operations must go through `resolveSafe()` (writes) or `resolveSafeRead()` (reads). Direct `fs.readFileSync`/`fs.writeFileSync` with unvalidated paths is prohibited. New path operations must use the existing safe resolution functions.
