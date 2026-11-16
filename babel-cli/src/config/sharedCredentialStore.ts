/** OS-protected credentials shared by explicitly selected Babel connections. */
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const prefix = 'babel-os-v1:'
export interface CredentialBackend {
  get(id: string): string | null
  set(id: string, value: string): void
  remove(id: string): boolean
}

/** Never include backend error text: some native APIs include their input. */
export class SharedCredentialError extends Error {
  constructor(readonly code: 'INVALID' | 'MISSING' | 'UNAVAILABLE' | 'COLLISION' | 'UNCONFIRMED', message: string, readonly reference?: string) {
    super(message); this.name = 'SharedCredentialError'
  }
}
function idFromReference(reference: string): string {
  const id = typeof reference === 'string' && reference.startsWith(prefix) ? reference.slice(prefix.length) : ''
  if (!idPattern.test(id)) throw new SharedCredentialError('INVALID', 'Invalid protected credential reference.')
  return id
}
export function isSharedCredentialReference(reference: unknown): reference is string {
  try { idFromReference(reference as string); return true } catch { return false }
}
function unavailable(): SharedCredentialError {
  return new SharedCredentialError('UNAVAILABLE', 'OS-protected credential storage is unavailable or locked. Unlock it or choose another credential source.')
}

/** Fresh references avoid overwriting an existing connection during replacement. */
export function createSharedCredentialStore(backend: CredentialBackend, makeId: () => string = randomUUID) {
  return {
    save(value: string): string {
      if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > 4096) throw new SharedCredentialError('INVALID', 'A nonempty credential of at most 4096 bytes is required.')
      const reference = prefix + makeId(), id = idFromReference(reference)
      let existing: string | null
      try { existing = backend.get(id) } catch { throw unavailable() }
      if (existing !== null) throw new SharedCredentialError('COLLISION', 'The new protected credential reference already exists.')
      // A timeout or failed read-back has unknown outcome. Do not retry or
      // delete: doing either could destroy an existing credential or evidence.
      try { backend.set(id, value); if (backend.get(id) === value) return reference } catch { /* unknown outcome */ }
      throw new SharedCredentialError('UNCONFIRMED', 'The protected credential write could not be confirmed; existing settings were preserved.', reference)
    },
    read(reference: string): string {
      const id = idFromReference(reference)
      let value: string | null
      try { value = backend.get(id) } catch { throw unavailable() }
      if (value === null || !value.trim()) throw new SharedCredentialError('MISSING', 'The selected protected credential is missing. Repair this connection before retrying.')
      return value
    },
    remove(reference: string): boolean {
      const id = idFromReference(reference)
      try { return backend.remove(id) } catch { throw unavailable() }
    },
  }
}

interface KeyringEntry { getPassword(): string | null; setPassword(value: string): void; deletePassword(): boolean }
type KeyringEntryConstructor = new (service: string, account: string, options?: { linux: { store: 'secret-service' } }) => KeyringEntry
/** Linux must never silently fall back to its nonpersistent kernel keyring. */
export function createKeyringBackend(Entry: KeyringEntryConstructor, platform: NodeJS.Platform): CredentialBackend {
  if (platform !== 'linux' && platform !== 'darwin') throw unavailable()
  const entry = (id: string) => new Entry('Babel', id, ...(platform === 'linux' ? [{ linux: { store: 'secret-service' as const } }] as const : []))
  return { get: id => entry(id).getPassword(), set: (id, value) => entry(id).setPassword(value), remove: id => entry(id).deletePassword() }
}

type WindowsResult = { status: number | null; stdout: string; stderr?: string; error?: Error }
type WindowsRunner = (input: string) => WindowsResult
type HelperOptions = { input: string; encoding: 'utf8'; windowsHide: true; shell: false; timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv }
type PosixHelperOptions = HelperOptions & { killSignal: 'SIGKILL' }
/** Secrets cross the child boundary only over private pipes, never argv or env. */
export function createWindowsCredentialBackend(run: WindowsRunner = runWindowsHelper): CredentialBackend {
  function call(operation: 'get' | 'set' | 'remove', id: string, value?: string): unknown {
    if (!idPattern.test(id)) throw new Error('Invalid reference')
    const result = run(JSON.stringify({ operation, id, ...(value === undefined ? {} : { value }) }))
    if (result.error || result.status !== 0) throw new Error('Credential helper unavailable')
    const response: unknown = JSON.parse(result.stdout)
    if (!response || typeof response !== 'object' || !('ok' in response) || response.ok !== true || !('result' in response)) throw new Error('Credential helper failed')
    return response.result
  }
  return {
    get: id => { const value = call('get', id); if (value !== null && typeof value !== 'string') throw new Error('Invalid response'); return value },
    set: (id, value) => { if (call('set', id, value) !== true) throw new Error('Invalid response') },
    remove: id => { const value = call('remove', id); if (typeof value !== 'boolean') throw new Error('Invalid response'); return value },
  }
}
/** Kept injectable so tests can inspect the boundary without opening a keychain. */
export function createWindowsHelperRunner(options: { systemRoot: string; helper: string; temp?: string; tmp?: string;
  invoke?: (executable: string, args: string[], options: HelperOptions) => WindowsResult }): WindowsRunner {
  const executable = join(options.systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const env: NodeJS.ProcessEnv = { SystemRoot: options.systemRoot, WINDIR: options.systemRoot,
    PSModulePath: join(options.systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
    ...(options.temp ? { TEMP: options.temp } : {}), ...(options.tmp ? { TMP: options.tmp } : {}) }
  const invoke = options.invoke ?? ((file, args, childOptions) => spawnSync(file, args, childOptions))
  // PowerShell compiles the Windows interop on startup; a hosted Windows
  // runner took 28 seconds. Keep a finite bound without aborting that case.
  return input => invoke(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', options.helper], {
    input, encoding: 'utf8', windowsHide: true, shell: false, timeout: 45000, maxBuffer: 32768, env,
  })
}
/** A blocked Secret Service request cannot hang the owning process indefinitely. */
export function createPosixHelperRunner(options: { executable: string; worker: string; env: NodeJS.ProcessEnv;
  invoke?: (executable: string, args: string[], options: PosixHelperOptions) => WindowsResult }): WindowsRunner {
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' }
  for (const name of ['HOME', 'USER', 'LOGNAME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_CURRENT_DESKTOP', 'XDG_SESSION_TYPE', 'LANG', 'LC_ALL']) {
    if (options.env[name] !== undefined) env[name] = options.env[name]
  }
  const invoke = options.invoke ?? ((file, args, childOptions) => spawnSync(file, args, childOptions))
  return input => invoke(options.executable, [options.worker], { input, encoding: 'utf8', windowsHide: true,
    shell: false, timeout: 15000, maxBuffer: 32768, killSignal: 'SIGKILL', env })
}
function runWindowsHelper(input: string): WindowsResult {
  const systemRoot = process.env['SystemRoot'] ?? process.env['WINDIR']
  const profile = process.env['USERPROFILE'], localData = process.env['LOCALAPPDATA']
  if (!systemRoot || !profile || !localData || !isAbsolute(systemRoot) || !isAbsolute(profile) || !isAbsolute(localData)) throw unavailable()
  // Windows PowerShell's C# compiler creates temporary source files. Compile
  // only inside the current user's real profile, never a shared temp directory.
  const temp = resolve(localData, 'Temp'), profileRoot = resolve(profile)
  try {
    const root = resolve(systemRoot), executable = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const executableInfo = lstatSync(executable)
    if (realpathSync(root).toLowerCase() !== root.toLowerCase() || !executableInfo.isFile() || executableInfo.isSymbolicLink() || realpathSync(executable).toLowerCase() !== executable.toLowerCase() ||
      !temp.toLowerCase().startsWith(profileRoot.toLowerCase() + sep.toLowerCase()) ||
      !lstatSync(temp).isDirectory() || lstatSync(temp).isSymbolicLink() || realpathSync(temp).toLowerCase() !== temp.toLowerCase()) throw unavailable()
  } catch { throw unavailable() }
  const helper = fileURLToPath(new URL('./sharedCredential.windows.ps1', import.meta.url))
  // Do not bypass an administrator's PowerShell execution policy.
  return createWindowsHelperRunner({systemRoot, helper, temp, tmp: temp})(input)
}

/** Backend creation does not access the credential store or prompt the user. */
export function platformSharedCredentialStore(platform: NodeJS.Platform = process.platform) {
  if (platform === 'win32') return createSharedCredentialStore(createWindowsCredentialBackend())
  if (platform !== 'linux' && platform !== 'darwin') throw unavailable()
  const worker = fileURLToPath(new URL('./sharedCredential.worker.js', import.meta.url))
  const run = createPosixHelperRunner({ executable: process.execPath, worker, env: process.env })
  return createSharedCredentialStore(createWindowsCredentialBackend(run))
}
