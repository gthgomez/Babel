import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { resolveRuntimePaths } from './config/runtimePaths.js'
import { readUserSettings, resolveEffectiveSettings, type UserSettings } from './config/userSettings.js'
import { getProviderSpec, listProviderSpecs } from './runners/providerRegistry.js'
import {probeInstalledSandboxImage} from './config/installedSandbox.js'
import { CLI_COMMAND } from './cli/commandName.js'
import { dockerCheckMessage, formatManualProviderEnvExample, sandboxImageCheckMessage } from './cli/firstRunText.js'
import { inspectRunningProduct, runningProduct, type RunningProduct } from './services/runningProduct.js'
import { resolveExecutionProfile, type ExecutionProfileName } from './config/executionProfiles.js'

type Check = { id: string; status: 'ok' | 'warn' | 'fail' | 'not_required'; message: string }

/** Fixed-argument Docker calls for installed diagnostics. The host-process manifest owns this file. */
export function runInstalledDockerCommand(args: readonly string[], timeout: number, env: NodeJS.ProcessEnv): { status: number | null; stdout: string } {
  const result: SpawnSyncReturns<string> = spawnSync('docker', args, {
    timeout, encoding: 'utf8', shell: false, windowsHide: true, maxBuffer: 256 * 1024, env,
  })
  return { status: result.status, stdout: typeof result.stdout === 'string' ? result.stdout : '' }
}

export function supportsInstalledNode(version: string): boolean {
  const [major = 0, minor = 0, patch = 0] = version.replace(/^v/, '').split('.').map(Number)
  return (major === 22 && minor >= 19) || (major === 24 && (minor > 13 || (minor === 13 && patch >= 1)))
}

/** Read-only installed diagnostics; presence checks never expose credential values. */
export function runInstalledDoctor(options: {
  paths?: ReturnType<typeof resolveRuntimePaths>
  env?: NodeJS.ProcessEnv
  strict?: boolean
  settings?: UserSettings
  dockerProbe?: () => boolean
  imageProbe?: (image:string) => boolean
  platform?: NodeJS.Platform
  running?: RunningProduct
  /** Explicit opt-in; omission keeps the original diagnostic protocol for old clients. */
  executionProfile?: string
} = {}): { status: 'ok' | 'warn' | 'fail'; kind: string; paths: ReturnType<typeof resolveRuntimePaths>; checks: Check[]; profileDiagnosticsVersion?: 1; executionProfile?: ExecutionProfileName } {
  const env = options.env ?? process.env
  const profile = options.executionProfile === undefined ? undefined : resolveExecutionProfile(options.executionProfile)
  const requiresDocker = profile?.dockerSandbox !== false
  const paths = options.paths ?? resolveRuntimePaths(env)
  const nodeReady = supportsInstalledNode(process.versions.node)
  const effective = resolveEffectiveSettings({ settings: options.settings ?? readUserSettings({ env }), env, projectRoot: paths.targetProjectRoot })
  const connection = effective.connection.value
  const spec = connection ? getProviderSpec(connection.provider) : null
  const keyName = connection?.apiKeyEnvVar ?? spec?.credentialEnvVar
  const configured = Boolean(connection && effective.model.value && (connection.authentication === 'none' || !spec?.requiresCredential || (keyName && env[keyName]?.trim())))
  const dockerReady = requiresDocker && (options.dockerProbe ? options.dockerProbe() :
    spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 3000, stdio: 'ignore', env }).status === 0)
  const image=env['BABEL_BENCHMARK_DOCKER_IMAGE']?.trim()
  const imageReady=Boolean(dockerReady&&image&&(options.imageProbe?options.imageProbe(image):probeInstalledSandboxImage(image,{
    env,execute:(_binary,args,settings)=>spawnSync('docker',args,settings),
  })))
  const product = inspectRunningProduct(options.running ?? runningProduct)
  const platform = options.platform ?? process.platform
  const envFile = join(paths.userConfigRoot, '.env')
  const checks: Check[] = [
    { id: 'node', status: nodeReady ? 'ok' : 'fail', message: nodeReady
      ? `Node.js ${process.versions.node} meets ^22.19.0 or ^24.13.1.`
      : `Node.js ${process.versions.node} is too old. ${CLI_COMMAND} needs Node.js ^22.19.0 or ^24.13.1. Install one of those, then check it with: node --version` },
    { id: 'resources', status: existsSync(join(paths.resourceRoot, 'prompt_catalog.yaml')) ? 'ok' : 'fail', message: paths.resourceRoot },
    { id: 'provider', status: configured ? 'ok' : 'warn', message: configured ?
      `Selected ${connection!.id}: ${connection!.provider}/${effective.model.value}; source ${effective.connection.source}. Credential presence checked; connectivity and observed model unverified.` :
      `No provider is selected yet. Run ${CLI_COMMAND} setup in a terminal, or save one key in ${envFile}. Read-only commands work; nothing was contacted.` },
    { id: 'executable', status: product.restartNeeded ? 'warn' : 'ok', message: `Running Babel ${product.runningVersion ?? 'unknown'}; revision ${product.revision ?? 'unknown'}; command ${CLI_COMMAND} (alias babel-agent); CLI entry ${product.entrypoint ?? 'unknown'}; Node executable ${product.executable}; package ${product.packageRoot}; ${product.restartNeeded === true ? 'package files changed; restart to use the current installation' : product.restartNeeded === null ? 'installation change detection unknown' : 'no change detected in package manifest or entrypoint'}` },
    { id: 'docker', status: !requiresDocker ? 'not_required' : dockerReady ? 'ok' : 'fail', message: !requiresDocker ? 'Docker is not required for the selected execution profile; it was not checked.' : dockerCheckMessage(dockerReady, platform) },
    { id:'sandbox_image',status:!requiresDocker?'not_required':imageReady?'ok':'fail',message:!requiresDocker?'A Docker sandbox image is not required for the selected execution profile; it was not checked.':sandboxImageCheckMessage(imageReady, dockerReady, platform) },
  ]
  return { status: checks.some(c => c.status === 'fail' || (options.strict && c.status === 'warn')) ? 'fail' :
    checks.some(c => c.status === 'warn') ? 'warn' : 'ok', kind: 'installed_user', paths, checks,
    ...(profile ? {profileDiagnosticsVersion:1 as const,executionProfile:profile.name} : {}) }
}

/** Read-only first steps for the installed executable. */
export function installedSetupChecklist(options: { paths?: ReturnType<typeof resolveRuntimePaths> } = {}): { status: string; kind: string; provider_configuration: { env_file: string; credential_env_vars: string[]; local_provider: string; manual_env_example: string }; first_five_minutes: { step: string; command: string; note?: string }[]; next_command: string; mutates_workspace: boolean; remote_side_effects: boolean } {
  const envFile = join((options.paths ?? resolveRuntimePaths()).userConfigRoot, '.env')
  const credentialEnvVars = listProviderSpecs().filter(p => p.authorityConformance === 'certified' && p.credentialEnvVar).map(p => p.credentialEnvVar!)
  return { status: 'ok', kind: 'installed_user', provider_configuration: {
    env_file: envFile, credential_env_vars: credentialEnvVars,
    local_provider: 'Ollama does not require a cloud credential; configure a local model separately.',
    manual_env_example: formatManualProviderEnvExample(envFile),
  }, first_five_minutes: [
    { step: 'diagnose_installation', command: `${CLI_COMMAND} doctor --json` },
    { step: 'preview_project_context', command: `${CLI_COMMAND} context preview @file README.md --json`, note: 'Run inside your target project, with an existing file.' },
    { step: 'configure_provider', command: `${CLI_COMMAND} setup`, note: 'Choose a provider connection, exact model and budget. Guided credentials are masked; diagnostics never send provider requests.' },
    { step: 'start_safe_execution', command: `${CLI_COMMAND} interactive`, note: `The default safe_repo profile runs project commands in Docker. On Windows, Babel Desktop Setup can prepare the image. On macOS and Linux, run ${CLI_COMMAND} sandbox prepare after Docker is installed.` },
  ], next_command: `${CLI_COMMAND} doctor --json`, mutates_workspace: false, remote_side_effects: false }
}
