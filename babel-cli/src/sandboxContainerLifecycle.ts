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

class ContainerAbsenceUncertainError extends Error {
  constructor() { super('Owned Docker container cleanup uncertain: interrupted launch was not acknowledged and no container was found'); }
}

function cleanupFailed(error: Error | null | undefined, status: number | null, stderr: string, requireRemoval = false): Error | null {
  if (!error && status === 0) return null;
  if (/no such container/i.test(stderr)) return requireRemoval ? new ContainerAbsenceUncertainError() : null;
  return new Error(`Owned Docker container cleanup failed: ${stderr.trim() || error?.message || `exit ${status}`}`);
}

export function removeOwnedContainerSync(name: string, env: NodeJS.ProcessEnv, requireRemoval = false): void {
  const result = spawnSync('docker', cleanupArgs(name), { env, encoding: 'utf8', windowsHide: true, timeout: 5_000 });
  const failure = cleanupFailed(result.error, result.status, result.stderr ?? '', requireRemoval);
  if (failure) throw failure;
}

export async function removeOwnedContainer(name: string, env: NodeJS.ProcessEnv, requireRemoval = false): Promise<void> {
  const args = cleanupArgs(name);
  for (let attempt = 0; ; attempt++) {
    const failure = await new Promise<Error | null>((resolve) => {
      execFile('docker', args, { env, encoding: 'utf8', windowsHide: true, timeout: 5_000 }, (error, _stdout, stderr) => {
        resolve(cleanupFailed(error, error ? 1 : 0, stderr, requireRemoval));
      });
    });
    if (!failure) return;
    if (!(failure instanceof ContainerAbsenceUncertainError) || attempt >= 2) throw failure;
    // A stopped client may have submitted a daemon request before closure.
    // Reconcile briefly, but never certify absence as an acknowledged removal.
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
