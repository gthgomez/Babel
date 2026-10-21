import { randomUUID } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { buildBenchmarkContainerCommand, type BenchmarkContainerCommandOptions } from './config/benchmarkContainer.js';

export interface PreparedShellInvocation {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  ownedContainerName?: string;
}

/** Docker daemon jobs are not descendants of the client PID that runs them. */
export function buildOwnedContainerCommand(options: BenchmarkContainerCommandOptions) {
  const command = buildBenchmarkContainerCommand(options);
  const ownedContainerName = `babel-run-${randomUUID()}`;
  command.args.splice(1, 0, '--name', ownedContainerName);
  return { ...command, ownedContainerName };
}

export function prepareOwnedContainerInvocation(options: BenchmarkContainerCommandOptions, env: NodeJS.ProcessEnv): PreparedShellInvocation {
  return { ...buildOwnedContainerCommand(options), cwd: options.projectRoot, env };
}

function cleanupArgs(name: string): string[] {
  if (!/^babel-run-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(name)) {
    throw new Error('Container cleanup requires a Babel-owned identity');
  }
  return ['rm', '--force', name];
}

function cleanupFailed(error: Error | null | undefined, status: number | null, stderr: string): Error | null {
  if (!error && status === 0) return null;
  if (/no such container/i.test(stderr)) return null;
  return new Error(`Owned Docker container cleanup failed: ${stderr.trim() || error?.message || `exit ${status}`}`);
}

export function removeOwnedContainerSync(name: string, env: NodeJS.ProcessEnv): void {
  const result = spawnSync('docker', cleanupArgs(name), { env, encoding: 'utf8', windowsHide: true, timeout: 5_000 });
  const failure = cleanupFailed(result.error, result.status, result.stderr ?? '');
  if (failure) throw failure;
}

export async function removeOwnedContainer(name: string, env: NodeJS.ProcessEnv): Promise<void> {
  const args = cleanupArgs(name);
  await new Promise<void>((resolve, reject) => {
    execFile('docker', args, { env, encoding: 'utf8', windowsHide: true, timeout: 5_000 }, (error, _stdout, stderr) => {
      const failure = cleanupFailed(error, error ? 1 : 0, stderr);
      if (failure) reject(failure); else resolve();
    });
  });
}
