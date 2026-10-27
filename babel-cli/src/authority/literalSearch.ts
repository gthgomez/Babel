import { parseCommandArgv } from '../utils/commandArgv.js'

/** Recognize only direct rg searches whose pattern operands cannot execute code. */
export function literalSearchFileOperands(command: string): string[] | null {
  // Keep shell syntax, wrappers, config-driven helpers and unknown options on
  // the existing conservative path. This projection grants no tool permission.
  if (process.env['RIPGREP_CONFIG_PATH'] || /[;&|><`$(){}!\\\r\n%^]/.test(command)) return null
  let argv: string[]
  try { argv = parseCommandArgv(command) } catch { return null }
  if (argv[0] !== 'rg' && argv[0] !== 'rg.exe') return null
  const files: string[] = []
  let hasPattern = false
  let options = true
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!
    if (options && arg === '--') { options = false; continue }
    if (options && (arg === '-e' || arg === '--regexp' || arg === '-f' || arg === '--file')) {
      const value = argv[++i]
      if (!value) return null
      if (arg === '-f' || arg === '--file') files.push(value)
      hasPattern = true
      continue
    }
    if (options && (arg.startsWith('--regexp=') || arg.startsWith('--file='))) {
      const value = arg.slice(arg.indexOf('=') + 1)
      if (!value) return null
      if (arg.startsWith('--file=')) files.push(value)
      hasPattern = true
      continue
    }
    if (options && /^-(?:[inFwxlqcSv]+)$/.test(arg)) continue
    if (options && ['--no-config', '--line-number', '--ignore-case', '--fixed-strings', '--count', '--files-with-matches', '--quiet'].includes(arg)) continue
    if (options && arg.startsWith('-')) return null
    if (!hasPattern) hasPattern = true
    else files.push(arg)
  }
  return hasPattern && files.length > 0 ? files : null
}

/** rg preprocessors and archive decompressors execute external programs. */
export function searchRequiresIsolation(command: string): boolean {
  let argv: string[]
  try { argv = parseCommandArgv(command) } catch { return false }
  if (!/^(?:.*[\\/])?rg(?:\.exe)?$/i.test(argv[0] ?? '')) return false
  if (process.env['RIPGREP_CONFIG_PATH']) return true
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--') break
    if (['-e', '--regexp', '-f', '--file'].includes(arg)) { i++; continue }
    if (arg === '--pre' || arg.startsWith('--pre=') || arg === '--search-zip' || /^-[A-Za-z]*z[A-Za-z]*$/.test(arg)) return true
  }
  return false
}
