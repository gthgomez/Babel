// License: Apache-2.0
// One-time settings move from the old Electron userData name to babel-desktop.
// The old directory is never deleted. Existing files in the new directory are
// never replaced. A success marker is written only after every copied file
// matches its source size and SHA256.
import {createHash} from 'node:crypto';
import {chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync} from 'node:fs';
import {dirname, isAbsolute, join, relative} from 'node:path';

export const DESKTOP_PROFILE_DIRECTORY = 'babel-desktop';
export const LEGACY_DESKTOP_PROFILE_DIRECTORY = 'babel-north-star-desktop';
export const PROFILE_MIGRATION_MARKER = 'profile-migration.json';

function sha256(path, readFile) {
  return createHash('sha256').update(readFile(path)).digest('hex');
}

function isDirectory(path) {
  try { return lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(); }
  catch { return false; }
}

function listFiles(root) {
  const files = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(relative(root, path));
    }
  };
  walk(root);
  return files;
}

function inside(root, path) {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Copy a legacy Desktop profile into the new directory.
 * @param {string} parent Directory that contains both profile folders.
 * @param {{copyFile?: Function}} [hooks]
 * @returns {{profile: string, action: string, filesCopied?: number, filesKept?: number}}
 */
export function migrateDesktopProfile(parent, hooks = {}) {
  if (typeof parent !== 'string' || !parent) throw new TypeError('Profile parent directory is required');
  const copyFile = hooks.copyFile ?? copyFileSync;
  const source = join(parent, LEGACY_DESKTOP_PROFILE_DIRECTORY);
  const target = join(parent, DESKTOP_PROFILE_DIRECTORY);
  if (!isDirectory(source)) return {profile: target, action: 'fresh', filesCopied: 0, filesKept: 0};
  const markerPath = join(target, PROFILE_MIGRATION_MARKER);
  if (isDirectory(target) && existsSync(markerPath)) {
    try {
      const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
      if (marker?.status === 'copied' && marker.verified === true) return {profile: target, action: 'already-migrated', filesCopied: 0, filesKept: 0};
    } catch { /* An unreadable marker is retried below and is not a success. */ }
  }
  mkdirSync(target, {recursive: true, mode: 0o700});
  const files = listFiles(source).filter(rel => rel !== PROFILE_MIGRATION_MARKER);
  let filesCopied = 0;
  let filesKept = 0;
  for (const rel of files) {
    const from = join(source, rel);
    const to = join(target, rel);
    if (!inside(source, from) || !inside(target, to)) throw new Error('Profile path escaped the settings directory');
    const sourceStat = lstatSync(from);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) continue;
    if (existsSync(to)) {
      const destStat = lstatSync(to);
      if (destStat.isSymbolicLink() || !destStat.isFile()) throw new Error(`Refusing to replace ${rel} because the new profile entry is not a regular file`);
      filesKept += 1;
      continue;
    }
    mkdirSync(dirname(to), {recursive: true, mode: 0o700});
    copyFile(from, to);
    chmodSync(to, sourceStat.mode & 0o777);
    utimesSync(to, sourceStat.atime, sourceStat.mtime);
    const copied = statSync(to);
    if (copied.size !== sourceStat.size || sha256(from, readFileSync) !== sha256(to, readFileSync)) {
      rmSync(to, {force: true});
      throw new Error(`Profile copy verification failed for ${rel}`);
    }
    filesCopied += 1;
  }
  const marker = {
    status: 'copied',
    verified: true,
    from: LEGACY_DESKTOP_PROFILE_DIRECTORY,
    to: DESKTOP_PROFILE_DIRECTORY,
    filesCopied,
    filesKept,
  };
  writeFileSync(markerPath, JSON.stringify(marker, null, 2) + '\n', {mode: 0o600});
  return {profile: target, action: 'copied', filesCopied, filesKept};
}
