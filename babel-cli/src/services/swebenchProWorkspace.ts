/**
 * SWE-Bench Pro (Scale AI) campaign runner — standalone path for shadow scoreboard data.
 *
 * - Does not reuse Verified docker eval (`swebench.harness`)
 * - V1 verifier: semantic gold_diff when gold patch present
 * - Early-stop: abort after N consecutive identical failure signatures
 * - Harvests policy_events for offline shadow precision/recall
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseSweStringList } from './agentBenchmarkHarness.js';
import { type SwebenchProInstanceRow } from './swebenchProCampaign.js';

const CLONE_TIMEOUT_MS = 10 * 60 * 1000;

const CHECKOUT_TIMEOUT_MS = 5 * 60 * 1000;


export function checkoutProRepo(instance: SwebenchProInstanceRow, repoRoot: string): void {
  if (existsSync(repoRoot)) {
    rmSync(repoRoot, { recursive: true, force: true });
  }
  mkdirSync(dirname(repoRoot), { recursive: true });
  const url = `https://github.com/${instance.repo}.git`;
  let result = spawnSync('git', ['clone', '--filter=blob:none', url, repoRoot], {
    encoding: 'utf8',
    timeout: CLONE_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`git clone failed for ${instance.repo}: ${result.stderr || result.stdout}`);
  }
  result = spawnSync('git', ['checkout', instance.base_commit], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: CHECKOUT_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(
      `git checkout ${instance.base_commit} failed: ${result.stderr || result.stdout}`,
    );
  }
}

export interface TestPatchApplyResult {
  /** True when a non-empty test_patch was present. */
  attempted: boolean;
  /** True when git apply (or 3-way) succeeded. */
  applied: boolean;
  method: 'git_apply' | 'git_apply_3way' | 'none' | 'skip_empty';
  error?: string;
}

/**
 * W1.2 / H3: Apply instance `test_patch` into a checked-out workspace so
 * fail_to_pass tests exist on disk before the agent (and dep preflight collect).
 *
 * Does not hard-fail the campaign when apply fails — caller records notes.
 */
export function applyInstanceTestPatch(
  workspaceRoot: string,
  testPatch: string | undefined | null,
): TestPatchApplyResult {
  if (typeof testPatch !== 'string' || !testPatch.trim()) {
    return { attempted: false, applied: false, method: 'skip_empty' };
  }
  const markerPath = join(workspaceRoot, '.babel-swe-pro-test-patch.ok');
  // Reused campaign workspaces: skip re-apply when prior cell already applied.
  if (existsSync(markerPath)) {
    return { attempted: true, applied: true, method: 'git_apply' };
  }
  const patchPath = join(workspaceRoot, '.babel-swe-pro-test.patch');
  try {
    writeFileSync(patchPath, testPatch, 'utf8');
    const tryApply = (args: string[]): { ok: boolean; err: string } => {
      const result = spawnSync('git', args, {
        cwd: workspaceRoot,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 60_000,
      });
      if (result.status === 0) return { ok: true, err: '' };
      const err = `${result.stderr || ''}${result.stdout || ''}`.trim();
      return { ok: false, err: err.slice(0, 500) || `git apply exit ${result.status}` };
    };

    const first = tryApply(['apply', '--whitespace=nowarn', patchPath]);
    if (first.ok) {
      try {
        rmSync(patchPath, { force: true });
      } catch {
        /* ignore */
      }
      // Marker + commit so later captureGitPatch is agent-only (not gold pollution).
      writeFileSync(markerPath, 'ok\n', 'utf8');
      commitTestPatchBaseline(workspaceRoot);
      return { attempted: true, applied: true, method: 'git_apply' };
    }

    const second = tryApply(['apply', '--3way', '--whitespace=nowarn', patchPath]);
    try {
      rmSync(patchPath, { force: true });
    } catch {
      /* ignore */
    }
    if (second.ok) {
      writeFileSync(markerPath, 'ok\n', 'utf8');
      commitTestPatchBaseline(workspaceRoot);
      return { attempted: true, applied: true, method: 'git_apply_3way' };
    }
    return {
      attempted: true,
      applied: false,
      method: 'git_apply',
      error: second.err || first.err,
    };
  } catch (err) {
    return {
      attempted: true,
      applied: false,
      method: 'none',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Stage + commit applied test_patch so agent git-diff is production-only. */
function commitTestPatchBaseline(workspaceRoot: string): void {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Babel SWE-Pro',
    GIT_AUTHOR_EMAIL: 'babel-swe-pro@local',
    GIT_COMMITTER_NAME: 'Babel SWE-Pro',
    GIT_COMMITTER_EMAIL: 'babel-swe-pro@local',
  };
  spawnSync('git', ['add', '-A'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    windowsHide: true,
    env,
  });
  spawnSync(
    'git',
    ['commit', '--allow-empty', '-m', 'babel: apply instance test_patch (baseline)'],
    {
      cwd: workspaceRoot,
      encoding: 'utf8',
      windowsHide: true,
      env,
    },
  );
}

/** Prefer selected_test_files, else fail_to_pass file path (node id stripped). */
export function resolveProTestPathHint(instance: SwebenchProInstanceRow): string | null {
  const selected = parseSweStringList(instance.selected_test_files_to_run);
  if (selected[0]) return selected[0]!;
  const ftp = parseSweStringList(instance.fail_to_pass);
  if (!ftp[0]) return null;
  const node = ftp[0]!;
  const idx = node.indexOf('::');
  return idx >= 0 ? node.slice(0, idx) : node;
}


export function testPatchNotes(result: TestPatchApplyResult): string[] {
  if (!result.attempted) {
    return ['test_patch_applied=false', 'test_patch_reason=absent_or_empty'];
  }
  if (result.applied) {
    return [`test_patch_applied=true`, `test_patch_method=${result.method}`];
  }
  return [
    'test_patch_applied=false',
    `test_patch_method=${result.method}`,
    `test_patch_error=${(result.error ?? 'unknown').replace(/\s+/g, ' ').slice(0, 200)}`,
  ];
}
