import {execFile} from 'node:child_process';

/** Project only the installed CLI's prerequisite statuses across the renderer boundary. */
export function prerequisiteStatus(report) {
  const checks = report?.kind === 'installed_user' && Array.isArray(report.checks) ? report.checks : [];
  const good = id => checks.filter(check => check?.id === id).length === 1 && checks.find(check => check?.id === id)?.status === 'ok';
  // Provider presence is advisory: credential-free local routes are owned by the CLI.
  return {ready:['node','resources','docker','sandbox_image'].every(good),
    node:good('node') ? 'ready' : 'unavailable', resources:good('resources') ? 'ready' : 'unavailable',
    provider:good('provider') ? 'configured' : 'missing', docker:good('docker') ? 'available' : 'unavailable',
    sandboxImage:good('sandbox_image') ? 'available' : 'unavailable'};
}

/** Failure text for the doctor child. Windows keeps the Babel Harness.cmd name. */
export function runtimeDiagnosticsFailureMessage({killed = false, platform = process.platform} = {}) {
  if (killed) return 'Runtime diagnostics timed out. Retry after checking the installation and Docker.';
  const launcher = platform === 'win32' ? 'Babel Harness.cmd' : 'babel-harness';
  return `Runtime diagnostics failed. Run ${launcher} doctor --json for local details.`;
}

/** Read-only doctor: bounded execution, no inference, no raw stdout/stderr in the UI. */
export async function diagnoseRuntime(runtime, {env, cwd}) {
  if (!runtime.ready) return {...prerequisiteStatus(null), error:process.platform==='win32'?'Bundled runtime files are missing. Extract the complete ZIP again.':'Bundled runtime files are missing. Download the complete AppImage again.'};
  return new Promise(resolve => {
    execFile(runtime.executable, [runtime.path, 'doctor', '--json'], {
      cwd, env, windowsHide:true, timeout:30000, maxBuffer:256 * 1024,
    }, (error, stdout) => {
      try {
        const report = JSON.parse(stdout);
        if (report.kind !== 'installed_user') throw new Error('Unexpected doctor');
        resolve(prerequisiteStatus(report));
      } catch {
        resolve({...prerequisiteStatus(null), error:runtimeDiagnosticsFailureMessage({killed:Boolean(error?.killed)})});
      }
    });
  });
}
