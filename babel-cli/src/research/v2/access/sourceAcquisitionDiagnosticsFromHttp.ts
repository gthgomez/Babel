import type { AdmittedHttpGetResult } from './admittedHttpGet.js'
import { parseAcquisitionDiagnosticsFromHttpGet } from './parseAcquisitionDiagnosticsFromHttpGet.js'
import type { SourceAcquisitionDiagnostics } from '../contracts/sourceAcquisitionDiagnostics.js'

export function acquisitionDiagnosticsFromHttpGet(
  response: AdmittedHttpGetResult,
  params: { attemptedUrl: string; sourceId?: string; truncationReason?: string },
): SourceAcquisitionDiagnostics {
  return parseAcquisitionDiagnosticsFromHttpGet(response, params)
}
