import { normalizeDocumentUrl } from './missionDocumentAcquisitionPolicy.js'

/** Strip fragment for HTTP resource identity/dedup (#section anchors share one resource). */
export function httpResourceUrlWithoutFragment(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    return parsed.href
  } catch {
    const hashIdx = url.indexOf('#')
    return hashIdx >= 0 ? url.slice(0, hashIdx) : url
  }
}

/** Normalized dedup/fetch target key for web resources (fragment-insensitive). */
export function httpResourceDedupKey(url: string): string {
  return normalizeDocumentUrl(httpResourceUrlWithoutFragment(url))
}
