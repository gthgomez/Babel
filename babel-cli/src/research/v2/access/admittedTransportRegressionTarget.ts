/**
 * Resolve Agent A shared gzip admission API for B regressions only.
 * Do not import B reconciliation proposal modules here.
 */
import type { ExpandGzipWireAdmission } from './admittedTransportContract.js'

const AGENT_A_GZIP_DECODER_MODULE_CANDIDATES = [
  './admittedHttpGzipAdmission.js',
  './admittedCompressedHttpBody.js',
  './admittedTransportDecode.js',
] as const

const EXPORT_NAMES = ['expandGzipWireAdmission', 'expandAdmittedTransportBody'] as const

export async function loadAgentAGzipWireAdmission(): Promise<ExpandGzipWireAdmission | null> {
  for (const modulePath of AGENT_A_GZIP_DECODER_MODULE_CANDIDATES) {
    try {
      const mod = (await import(modulePath)) as Record<string, unknown>
      for (const name of EXPORT_NAMES) {
        const fn = mod[name]
        if (typeof fn === 'function') {
          return fn as ExpandGzipWireAdmission
        }
      }
    } catch {
      // try next candidate
    }
  }
  return null
}
