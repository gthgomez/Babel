import { createHash } from 'node:crypto'

/** Tools whose successful observations can provide new localization evidence. */
export function isDiscoveryTool(name: string): boolean {
  return ['read_file', 'file_read', 'read_range', 'read_artifact', 'grep',
    'glob', 'list_dir', 'semantic_search', 'lsp'].includes(name)
}

/** Fingerprint the actual model-visible observation, not its UI summary. */
export function hashDiscoveryContent(tool: string, content: string): string | undefined {
  return isDiscoveryTool(tool) && content.trim().length > 0
    ? createHash('sha256').update(content).digest('hex')
    : undefined
}

/** Keep queries/ranges separate so alternating already-seen windows is not progress. */
export function discoveryObservationKey(tool: string, target: string, argumentsJson?: string): string {
  let selectors: Record<string, unknown> = {}
  try {
    const args: unknown = JSON.parse(argumentsJson ?? '{}')
    if (args && typeof args === 'object' && !Array.isArray(args)) {
      selectors = Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'type').sort(([a], [b]) => a.localeCompare(b)))
    }
  } catch { /* Legacy results without structured arguments retain target identity. */ }
  return `${tool}:${target}:${JSON.stringify(selectors)}`
}
