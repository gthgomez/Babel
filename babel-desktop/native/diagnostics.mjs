import {execFile} from 'node:child_process';

/** Project only the installed CLI's prerequisite statuses across the renderer boundary. */
export function prerequisiteStatus(report) {
  const checks = report?.kind === 'installed_user' && Array.isArray(report.checks) ? report.checks : [];
  const good = id => checks.filter(check => check?.id === id).length === 1 && checks.find(check => check?.id === id)?.status === 'ok';
  // Provider presence is advisory: credential-free local routes are owned by the CLI.
  return {ready:['node','resources','docker'].every(good),
    node:good('node') ? 'ready' : 'unavailable', resources:good('resources') ? 'ready' : 'unavailable',
    provider:good('provider') ? 'configured' : 'missing', docker:good('docker') ? 'available' : 'unavailable'};
}

/** Read-only doctor: bounded execution, no inference, no raw stdout/stderr in the UI. */
export async function diagnoseRuntime(runtime, {env, cwd}) {
  if (!runtime.ready) return {...prerequisiteStatus(null), error:'Bundled runtime files are missing. Extract the complete ZIP again.'};
  return new Promise(resolve => {
    execFile(runtime.executable, [runtime.path, 'doctor', '--json'], {
      cwd, env, windowsHide:true, timeout:8000, maxBuffer:256 * 1024,
    }, (error, stdout) => {
      try {
        const report = JSON.parse(stdout);
        if (report.kind !== 'installed_user') throw new Error('Unexpected doctor');
        resolve(prerequisiteStatus(report));
      } catch {
        resolve({...prerequisiteStatus(null), error:error?.killed ? 'Runtime diagnostics timed out. Retry after checking the installation and Docker.' : 'Runtime diagnostics failed. Run Babel CLI.cmd doctor --json for local details.'});
      }
    });
  });
}
