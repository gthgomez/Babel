import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { ToolResult } from '../sandbox.js';
import type { ToolCallRequest } from '../localTools.js';
import { isDryRunEnabled } from '../config/dryRun.js';

/** example_web_audit project root - configure via EXAMPLE_WEB_AUDIT_ROOT env var. */
const EXAMPLE_WEB_AUDIT_ROOT = process.env['EXAMPLE_WEB_AUDIT_ROOT'] ?? process.cwd();

function buildSpawnInvocation(
  command: string,
  args: string[],
): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    return {
      command: 'cmd.exe',
      args: ['/c', command, ...args],
    };
  }

  return { command, args };
}

function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
  const resolvedCandidate = path.resolve(candidatePath);
  const resolvedRoot = path.resolve(rootPath);

  if (process.platform === 'win32') {
    const candidateNorm = resolvedCandidate.toLowerCase();
    const rootNorm = resolvedRoot.toLowerCase();
    return candidateNorm === rootNorm || candidateNorm.startsWith(`${rootNorm}\\`);
  }

  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}/`);
}

const AUDIT_UI_RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function validateAuditUiRequest(
  req: Extract<ToolCallRequest, { tool: 'audit_ui' }>,
): string | null {
  if (/[\r\n]/.test(req.url) || /[\r\n]/.test(req.run_id)) {
    return 'url and run_id must not contain newlines';
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(req.url);
  } catch {
    return 'url must be a valid absolute URL';
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return 'url must use http or https';
  }

  if (parsedUrl.username || parsedUrl.password) {
    return 'url must not embed credentials';
  }

  if (!AUDIT_UI_RUN_ID_RE.test(req.run_id)) {
    return 'run_id must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/';
  }

  return null;
}

/**
 * Spawns the example_web_audit orchestrator as a child process, waits for it to
 * complete, then reads and returns the generated refactor handoff report.
 */
export async function handleAuditUi(
  req: Extract<ToolCallRequest, { tool: 'audit_ui' }>,
): Promise<ToolResult> {
  if (isDryRunEnabled()) {
    console.log(`  [DRY RUN] audit_ui -> url=${req.url} run_id=${req.run_id}` + ` (not executed)`);
    return {
      exit_code: 0,
      stdout: `[DRY RUN] Would run example_web_audit orchestrator: url=${req.url} run_id=${req.run_id}`,
      stderr: '',
    };
  }

  console.log(`  [AUDIT_UI] audit_ui -> url="${req.url}" run_id="${req.run_id}"`);

  const validationError = validateAuditUiRequest(req);
  if (validationError) {
    return {
      exit_code: 1,
      stdout: '',
      stderr: `[AUDIT_UI_INVALID_ARGS] ${validationError}`,
    };
  }

  const artifactRoot = path.resolve(EXAMPLE_WEB_AUDIT_ROOT, 'artifacts');
  const reportPath = path.resolve(
    artifactRoot,
    req.run_id,
    'pass-b',
    'final-review.pass-b.v1.0.2.json',
  );

  if (!isPathWithinRoot(reportPath, artifactRoot)) {
    return {
      exit_code: 1,
      stdout: '',
      stderr: `[AUDIT_UI_INVALID_ARGS] run_id resolves outside artifact root: ${req.run_id}`,
    };
  }

  return new Promise<ToolResult>((resolve) => {
    let stdoutBuf = '';
    let stderrBuf = '';
    const invocation = buildSpawnInvocation('npx', [
      'tsx',
      'audit-frontend/tooling/orchestrator.ts',
      req.url,
      req.run_id,
    ]);

    const child = spawn(invocation.command, invocation.args, {
      cwd: EXAMPLE_WEB_AUDIT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
    });

    child.on('error', (err: Error) => {
      resolve({
        exit_code: 1,
        stdout: '',
        stderr: `[AUDIT_UI_SPAWN_ERROR] Failed to start orchestrator: ${err.message}`,
      });
    });

    child.on('close', (code: number | null) => {
      if (code !== 0) {
        resolve({
          exit_code: code ?? 1,
          stdout: stdoutBuf,
          stderr:
            `[AUDIT_UI_NONZERO] Orchestrator exited with code ${code ?? 'null'}. ` +
            `stderr: ${stderrBuf}`,
        });
        return;
      }

      let reportContent: string;
      try {
        reportContent = readFileSync(reportPath, 'utf8');
      } catch (err: unknown) {
        resolve({
          exit_code: 1,
          stdout: '',
          stderr:
            `[AUDIT_UI_MISSING_REPORT] Orchestrator completed (exit 0) but ` +
            `report not found at: ${reportPath}. ` +
            `Error: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }

      resolve({
        exit_code: 0,
        stdout: reportContent,
        stderr: '',
      });
    });
  });
}
