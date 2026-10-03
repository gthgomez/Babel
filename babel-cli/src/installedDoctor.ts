import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { resolveRuntimePaths } from './config/runtimePaths.js'
import { listProviderSpecs } from './runners/providerRegistry.js'

type Check = { id: string; status: 'ok' | 'warn' | 'fail'; message: string }

/** Read-only installed diagnostics; presence checks never expose credential values. */
export function runInstalledDoctor(options: {
  paths?: ReturnType<typeof resolveRuntimePaths>
  env?: NodeJS.ProcessEnv
  strict?: boolean
  dockerProbe?: () => boolean
} = {}): { status: 'ok' | 'warn' | 'fail'; kind: string; paths: ReturnType<typeof resolveRuntimePaths>; checks: Check[] } {
  const env = options.env ?? process.env
  const paths = options.paths ?? resolveRuntimePaths(env)
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
  const nodeReady = major > 22 || (major === 22 && minor >= 19)
  const configured = listProviderSpecs().filter(p => p.authorityConformance === 'certified' && p.credentialEnvVar && env[p.credentialEnvVar]?.trim()).map(p => p.id)
  const dockerReady = options.dockerProbe ? options.dockerProbe() :
    spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 3000, stdio: 'ignore', env }).status === 0
  const checks: Check[] = [
    { id: 'node', status: nodeReady ? 'ok' : 'fail', message: `Node ${process.versions.node}; requires >=22.19.0` },
    { id: 'resources', status: existsSync(join(paths.resourceRoot, 'prompt_catalog.yaml')) ? 'ok' : 'fail', message: paths.resourceRoot },
    { id: 'provider', status: configured.length ? 'ok' : 'warn', message: configured.length ?
      `Credential environment configured for: ${configured.join(', ')} (not authenticated)` :
      'No provider credentials configured. Read-only commands work; configure one supported provider or a local Ollama model for model-backed tasks. No connection was attempted.' },
    { id: 'docker', status: dockerReady ? 'ok' : 'fail', message: dockerReady ?
      'Docker server available; required by the default safe_repo execution profile.' :
      'Docker server unavailable; safe_repo requires Docker. Start Docker before executing tasks; no fallback is enabled.' },
  ]
  return { status: checks.some(c => c.status === 'fail' || (options.strict && c.status === 'warn')) ? 'fail' :
    checks.some(c => c.status === 'warn') ? 'warn' : 'ok', kind: 'installed_user', paths, checks }
}

/** Read-only first steps for the installed executable. */
export function installedSetupChecklist(): { status: string; kind: string; first_five_minutes: { step: string; command: string; note?: string }[]; next_command: string; mutates_workspace: boolean; remote_side_effects: boolean } {
  return { status: 'ok', kind: 'installed_user', first_five_minutes: [
    { step: 'diagnose_installation', command: 'babel-agent doctor --json' },
    { step: 'preview_project_context', command: 'babel-agent context preview @file README.md --json', note: 'Run inside your target project, with an existing file.' },
    { step: 'configure_provider', command: 'babel-agent doctor', note: 'Configure one supported provider credential or a local Ollama model. Diagnostics never send provider requests.' },
    { step: 'start_safe_execution', command: 'babel-agent interactive', note: 'The default safe_repo profile requires a running Docker server.' },
  ], next_command: 'babel-agent doctor --json', mutates_workspace: false, remote_side_effects: false }
}
