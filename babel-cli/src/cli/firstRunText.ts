// License: Apache-2.0
import { CLI_COMMAND } from './commandName.js';
import { listProviderSpecs } from '../runners/providerRegistry.js';

/** What to install so the default safe_repo profile can run project commands. */
export function dockerFailureGuidance(platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return 'Install Docker Desktop for Windows, start it, and leave it running. Then run `' + CLI_COMMAND + ' doctor` again.';
  }
  if (platform === 'darwin') {
    return 'Install Docker Desktop for Mac, start it, and leave it running. Then run `' + CLI_COMMAND + ' doctor` again. Babel Desktop is a Windows app, so it does not prepare Docker on macOS.';
  }
  return 'Install Docker Engine, start it, and allow this user to run `docker info` (on systemd: `sudo systemctl enable --now docker`). Then run `' + CLI_COMMAND + ' doctor` again. Babel Desktop is a Windows app, so it does not prepare Docker on Linux.';
}

export function dockerCheckMessage(ready: boolean, platform: NodeJS.Platform): string {
  if (ready) return 'Docker is running. The default safe_repo profile uses it so project commands stay off this machine.';
  return `Docker is not available, so project commands cannot run. The default safe_repo profile requires Docker and does not fall back to this machine. ${dockerFailureGuidance(platform)}`;
}

/** Next step for the Linux amd64 image used to run project commands. */
export function sandboxImageGuidance(platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return 'On Windows, open Babel Desktop, choose Setup, and use Prepare recommended image. That saves the image for this CLI. `' + CLI_COMMAND + ' sandbox prepare` does the same check from the command line.';
  }
  const system = platform === 'darwin' ? 'macOS' : 'Linux';
  return `Babel Desktop Setup is only available on Windows, so there is no desktop step on ${system}. Run \`${CLI_COMMAND} sandbox prepare\` after Docker is running. It downloads the pinned Linux amd64 image, checks that a shell and Git run, and saves the image id for this user.`;
}

export function sandboxImageCheckMessage(ready: boolean, dockerReady: boolean, platform: NodeJS.Platform): string {
  if (ready) return 'The sandbox image is a Linux amd64 image that can run a shell and Git. Include your project test tools in that image too.';
  const waiting = dockerReady ? '' : 'Docker has to be running before an image can be checked. ';
  return `${waiting}No usable sandbox image is configured. Babel runs project commands inside a Linux amd64 container. ${sandboxImageGuidance(platform)} The image id is stored as BABEL_BENCHMARK_DOCKER_IMAGE in the environment or the private config file. Commands are not run on this machine instead.`;
}

/** Placeholder-only copy for a manual provider file. Never include a real key. */
export function formatManualProviderEnvExample(envFile: string): string {
  const coding = listProviderSpecs().filter((spec) => spec.authorityConformance === 'certified' && spec.operations.includes('native_tool_stream'));
  const keyed = coding.filter((spec) => spec.credentialEnvVar);
  const lines = keyed.map((spec, index) => `${index === 0 ? '' : '# '}${spec.credentialEnvVar}=your-key-here`);
  return [
    'Save one provider key in this file (keep it out of the project and out of chat):',
    `  ${envFile}`,
    'On macOS and Linux the file is created with permissions 0600. Replace your-key-here, keep a single provider, and do not commit the file.',
    '',
    '# example',
    ...lines,
    '# Ollama on this machine does not use an API key.',
    `# Choose it with: ${CLI_COMMAND} provider connect ollama --model <exact-model>`,
    '',
    `Or run ${CLI_COMMAND} setup in a terminal. It stores the key without printing it.`,
  ].join('\n');
}
