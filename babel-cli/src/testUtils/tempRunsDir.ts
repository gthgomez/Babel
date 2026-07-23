/**
 * Shared test helper: override BABEL_RUNS_DIR with a temp directory and
 * restore after the test.  Accepts optional extra env-var overrides for
 * protocol / in-process mode tests (chatTransport.test.ts).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ExtraEnv {
  [key: string]: string | undefined;
}

export interface TempRunsDir {
  root: string;
  cleanup(): void;
}

export function withTempRunsDir(
  prefix: string = 'babel-test',
  extraEnv?: ExtraEnv,
): TempRunsDir {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const prevRuns = process.env['BABEL_RUNS_DIR'];

  // Save extra env vars before overriding.
  const prevExtra: Record<string, string | undefined> = {};
  if (extraEnv) {
    for (const key of Object.keys(extraEnv)) {
      prevExtra[key] = process.env[key];
      if (extraEnv[key] !== undefined) {
        process.env[key] = extraEnv[key];
      } else {
        delete process.env[key];
      }
    }
  }

  process.env['BABEL_RUNS_DIR'] = root;

  return {
    root,
    cleanup() {
      if (prevRuns === undefined) delete process.env['BABEL_RUNS_DIR'];
      else process.env['BABEL_RUNS_DIR'] = prevRuns;

      if (extraEnv) {
        for (const key of Object.keys(extraEnv)) {
          if (prevExtra[key] === undefined) delete process.env[key];
          else process.env[key] = prevExtra[key]!;
        }
      }

      rmSync(root, { recursive: true, force: true });
    },
  };
}
