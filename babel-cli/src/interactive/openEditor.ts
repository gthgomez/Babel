/**
 * TTY-safe external editor launcher for long prompts and plan edits.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Interface } from 'node:readline';
import { BABEL_RUNS_DIR } from '../cli/constants.js';
import {
  stdinCoordinatorPauseForRun,
  stdinCoordinatorResumeAfterRun,
} from '../ui/inputCoordinator.js';
import { TerminalRestoreGuard } from '../ui/terminalRestoreGuard.js';

export interface OpenEditorOptions {
  /** Initial buffer content (without comment stripping). */
  seed?: string;
  /** Readline interface to pause while editor runs. */
  rl?: Interface;
}

/**
 * Open the user's editor and return submitted text (comment lines stripped).
 */
export async function openEditor(opts: OpenEditorOptions = {}): Promise<string | null> {
  if (opts.rl) {
    stdinCoordinatorPauseForRun(opts.rl);
  }

  const editor =
    process.env['EDITOR'] ||
    process.env['VISUAL'] ||
    (process.platform === 'win32' ? 'notepad' : 'vi');

  const tmpDir = path.join(BABEL_RUNS_DIR, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, `babel-editor-${Date.now()}.txt`);

  const seed =
    opts.seed ??
    '// Enter your Babel task or prompt below.\n' +
      '// Lines starting with // are ignored.\n' +
      '// Save and close the editor to submit.\n\n';
  fs.writeFileSync(tmpFile, seed, 'utf-8');

  const guard = new TerminalRestoreGuard();
  try {
    const result = spawnSync(editor, [tmpFile], {
      stdio: 'inherit',
      timeout: 300_000,
      shell: process.platform === 'win32',
    });

    if (result.error) {
      console.error(`Editor failed: ${result.error.message}`);
      return null;
    }

    const content = fs.readFileSync(tmpFile, 'utf-8');
    const lines = content
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//'))
      .join('\n')
      .trim();
    return lines || null;
  } finally {
    guard.restore();
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* best effort */
    }
    if (opts.rl) {
      stdinCoordinatorResumeAfterRun(opts.rl);
    }
  }
}