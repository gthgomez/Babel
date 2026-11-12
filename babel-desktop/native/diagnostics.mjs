import {execFile} from 'node:child_process';

/** Project only the installed CLI's prerequisite statuses across the renderer boundary. */
export function prerequisiteStatus(report,{executionProfile}={}) {
  const checks = report?.kind === 'installed_user' && Array.isArray(report.checks) ? report.checks : [];
  const has = (id,status) => checks.filter(check => check?.id === id).length === 1 && checks.find(check => check?.id === id)?.status === status;
  const good = id => has(id,'ok');
  const negotiated = executionProfile === undefined ||
    (['host_native','safe_repo'].includes(executionProfile) && report?.profileDiagnosticsVersion === 1 && report?.executionProfile === executionProfile);
  const host = negotiated && executionProfile === 'host_native';
  const dockerStatus=host&&has('docker','not_required')?'not_required':good('docker')?'available':'unavailable';
  const imageStatus=host&&has('sandbox_image','not_required')?'not_required':good('sandbox_image')?'available':'unavailable';
  // Provider presence is advisory: credential-free local routes are owned by the CLI.
  return {ready:negotiated&&good('node')&&good('resources')&&(host?dockerStatus==='not_required'&&imageStatus==='not_required':good('docker')&&good('sandbox_image')),
    node:good('node') ? 'ready' : 'unavailable', resources:good('resources') ? 'ready' : 'unavailable',
    provider:good('provider') ? 'configured' : 'missing', docker:dockerStatus,
    sandboxImage:imageStatus};
}

/** Failure text for the doctor child. Windows keeps the Babel Harness.cmd name. */
export function runtimeDiagnosticsFailureMessage({killed = false, platform = process.platform} = {}) {
  if (killed) return 'Runtime diagnostics timed out. Retry after checking the installation and Docker.';
  const launcher = platform === 'win32' ? 'Babel Harness.cmd' : 'babel-harness';
  return `Runtime diagnostics failed. Run ${launcher} doctor --json for local details.`;
}

/** Read-only doctor: bounded execution, no inference, no raw stdout/stderr in the UI. */
export async function diagnoseRuntime(runtime, {env, cwd, executionProfile}) {
  if(executionProfile!==undefined&&!['host_native','safe_repo'].includes(executionProfile))throw new Error('Invalid execution profile for diagnostics.');
  const selection={executionProfile};
  if (!runtime.ready) return {...prerequisiteStatus(null,selection), error:process.platform==='win32'?'Bundled runtime files are missing. Extract the complete ZIP again.':'Bundled runtime files are missing. Download the complete AppImage again.'};
  return new Promise(resolve => {
    execFile(runtime.executable, [runtime.path, 'doctor', '--json',...(executionProfile?['--execution-profile',executionProfile]:[])], {
      cwd, env, windowsHide:true, timeout:30000, maxBuffer:256 * 1024,
    }, (error, stdout) => {
      try {
        const report = JSON.parse(stdout);
        if (report.kind !== 'installed_user') throw new Error('Unexpected doctor');
        resolve(prerequisiteStatus(report,selection));
      } catch {
        resolve({...prerequisiteStatus(null,selection), error:runtimeDiagnosticsFailureMessage({killed:Boolean(error?.killed)})});
      }
    });
  });
}
