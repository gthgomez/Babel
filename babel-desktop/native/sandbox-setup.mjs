// License: Apache-2.0
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';

// Docker Official Node image, linux/amd64 manifest observed 2026-10-14.
// Pin content rather than silently following a mutable tag at preparation time.
export const RECOMMENDED_IMAGE='docker.io/library/node:24-bookworm@sha256:9af606de2e947cfb3f276633b7c5130c4cd22365aa10f5a647b7675d5cfce0c0';
const executeFile=promisify(execFile);
export const isPinnedImage=value=>typeof value==='string'&&/^sha256:[a-f0-9]{64}$/.test(value);

export function validateSandboxImageReference(value){
  if(typeof value!=='string'||value.length>512||!value.length||value.includes('://')||! /^[a-z0-9][a-z0-9._/:@-]*$/i.test(value)){
    throw new Error('Enter a Docker image reference without spaces, options or shell syntax.');
  }
  return value;
}

/** Non-secret profile settings only; the exact inspected local image wins. */
export function applySandboxEnvironment(env,preferences={}){
  if(isPinnedImage(preferences.sandboxImage))env.BABEL_BENCHMARK_DOCKER_IMAGE=preferences.sandboxImage;
  return env;
}

function dockerEnvironment(){
  const env={};
  for(const name of ['PATH','SystemRoot','WINDIR','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','XDG_RUNTIME_DIR','DOCKER_HOST','DOCKER_CONTEXT','DOCKER_CONFIG','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH']){
    if(process.env[name]!==undefined)env[name]=process.env[name];
  }
  return env;
}

/** Windows wording stays fixed. Other platforms name the Docker engine. */
export function sandboxHostFailureMessage(kind, error, platform = process.platform) {
  if (platform === 'win32') {
    return kind === 'pull'
      ? 'Sandbox download failed or timed out. Start Docker Desktop with Linux containers, then retry preparation.'
      : 'Sandbox image is not available locally. Start Docker Desktop, then prepare the recommended image or select an existing image.';
  }
  if (error?.code === 'ENOENT') return 'Docker is not installed. Install Docker Engine, start it, and choose Prepare recommended image again.';
  return kind === 'pull'
    ? 'Sandbox download failed or timed out. Start the Docker engine and retry preparation.'
    : 'Sandbox image is not available locally. Start the Docker engine, then prepare the recommended image or select an existing image.';
}

/** @param {string} [platform] */
export function sandboxArchitectureMessage(platform = process.platform) {
  return platform === 'win32'
    ? 'Choose a Linux amd64 Docker image for this Windows x64 application.'
    : 'Choose a Linux amd64 Docker image. This Desktop build runs project tools in a linux/amd64 container.';
}

/** Shown when a packaged project run is blocked on Docker or the sandbox image. */
export function packagedSandboxPrerequisiteMessage(platform = process.platform) {
  return platform === 'win32'
    ? 'Execution prerequisites are missing or unverified. Open Setup, start Docker Desktop and prepare or validate a sandbox image, then recheck setup.'
    : 'Execution prerequisites are missing or unverified. Open Setup, start the Docker engine and prepare or validate a sandbox image, then recheck setup.';
}

/** Dialog text for a failed setup. Uses the thrown message when it is already user-facing. */
export function sandboxIpcFailureMessage(error, platform = process.platform) {
  const message = typeof error?.message === 'string' ? error.message.split('\n')[0].trim() : '';
  if (/^(?:Docker |Sandbox |Choose a Linux )/.test(message)) return message;
  return platform === 'win32'
    ? 'Sandbox setup failed. Start Docker Desktop and try again.'
    : 'Sandbox setup failed. Install Docker Engine, start it, and try again.';
}

/**
 * Linux setup asks whether the docker binary and daemon are present.
 * `missing` means the command is not on PATH. `stopped` means the command
 * exists but the daemon did not answer. `running` means the daemon answered.
 * @param {Function} [execute]
 * @returns {Promise<'missing'|'stopped'|'running'>}
 */
export async function probeDockerInstallation(execute = executeFile) {
  try {
    await execute('docker', ['version', '--format', '{{.Server.Version}}'], {shell:false, windowsHide:true, timeout:4000, maxBuffer:64 * 1024});
    return 'running';
  } catch (error) {
    return error?.code === 'ENOENT' ? 'missing' : 'stopped';
  }
}

/** Explicit preparation never runs project code, mounts files, or enables host fallback. */
export async function configureSandboxImage({reference,prepareRecommended=false,execute=executeFile,platform=process.platform}={}){
  if(typeof prepareRecommended!=='boolean')throw new Error('Invalid sandbox preparation request.');
  const image=validateSandboxImageReference(prepareRecommended?RECOMMENDED_IMAGE:reference);
  const run=(args,timeout)=>execute('docker',args,{shell:false,windowsHide:true,timeout,maxBuffer:256*1024,env:dockerEnvironment()});
  if(prepareRecommended){
    try{await run(['pull','--platform=linux/amd64',RECOMMENDED_IMAGE],300000);}
    catch(error){throw new Error(sandboxHostFailureMessage('pull', error, platform));}
  }
  let record;
  try{
    const result=await run(['image','inspect','--format','{{json .}}','--',image],5000);
    record=JSON.parse(result.stdout);
  }catch(error){throw new Error(sandboxHostFailureMessage('inspect', error, platform));}
  if(record?.Os!=='linux'||record?.Architecture!=='amd64'||!isPinnedImage(record?.Id)){
    throw new Error(sandboxArchitectureMessage(platform));
  }
  const probe=prepareRecommended
    ? 'git --version >/dev/null && node --version >/dev/null && npm --version >/dev/null'
    : 'git --version >/dev/null';
  const marker=`babel-sandbox-${randomUUID()}`;
  try{
    // Preserve ENTRYPOINT just like project execution. Check direct Git as well
    // as shell dispatch; overriding it could certify an unusable custom image.
    for(const command of [['git','--version'],['/bin/sh','-lc',`${probe} && printf '%s\\n' '${marker}'`]]){
      const containerName=`babel-setup-${randomUUID()}`;
      try{
        const result=await run(['run','--rm',`--name=${containerName}`,'--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges',
          '--pids-limit=64','--memory=256m','--cpus=1','--user=65534:65534','--tmpfs=/tmp:rw,nosuid,size=32m',
          '--env=HOME=/tmp','--env=NPM_CONFIG_UPDATE_NOTIFIER=false',record.Id,...command],10000);
        const lines=String(result.stdout??'').split(/\r?\n/);
        if(command[0]==='git'?!lines.some(line=>/^git version \d+\.\d+(?:\.[0-9A-Za-z]+)*$/.test(line)):!lines.includes(marker)){
          throw new Error('Sandbox command output did not confirm execution.');
        }
      }finally{
        // Client timeout does not stop its daemon-owned container.
        try{await run(['rm','--force',containerName],5000);}catch{}
      }
    }
  }catch{throw new Error(prepareRecommended?'Sandbox tool verification failed. The recommended image must run shell, Git, Node and npm.':'Sandbox tool verification failed. The image must run /bin/sh and Git; include the tools your project tests require.');}
  return {sandboxImage:record.Id,sandboxImageReference:image};
}
