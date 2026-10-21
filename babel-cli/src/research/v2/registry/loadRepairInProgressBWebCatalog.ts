import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { SourceAdapter } from '../ports/sourceAdapter.js'

const v2Root = join(dirname(fileURLToPath(import.meta.url)), '..')

function modulePathExists(relativeJs: string): boolean {
  const base = join(v2Root, relativeJs.replace(/\.js$/, ''))
  return existsSync(`${base}.ts`) || existsSync(`${base}.js`)
}

export interface RepairInProgressBWebCatalogLoad {
  adapters: SourceAdapter[]
  /** Present when B's catalog module exists locally; not an acceptance label. */
  catalogModuleLoaded: boolean
  /** Adapter ids registered from the in-repair HTML/PDF slice only. */
  adapterIds: string[]
}

/**
 * B-owned HTML/PDF slice (`generalWebAdapter`, `generalAdapterCatalog`) is under repair.
 * Loads only when those files exist on disk; never treated as independently reviewed.
 */
export async function loadRepairInProgressBWebCatalog(): Promise<RepairInProgressBWebCatalogLoad> {
  const catalogRel = 'profiles/general/generalAdapterCatalog.js'
  if (!modulePathExists(catalogRel)) {
    return { adapters: [], catalogModuleLoaded: false, adapterIds: [] }
  }

  const catalogUrl = pathToFileURL(join(v2Root, catalogRel)).href
  const catalog = (await import(catalogUrl)) as {
    generalAdapterCatalog?: { adapters?: readonly SourceAdapter[] }
    createGeneralSourceAdapters?: () => readonly SourceAdapter[]
    GeneralWebAdapter?: new () => SourceAdapter
  }

  const fromCatalog =
    catalog.generalAdapterCatalog?.adapters ??
    (typeof catalog.createGeneralSourceAdapters === 'function'
      ? catalog.createGeneralSourceAdapters()
      : undefined)

  if (fromCatalog?.length) {
    const adapters = [...fromCatalog]
    return {
      adapters,
      catalogModuleLoaded: true,
      adapterIds: adapters.map((a) => a.adapterId),
    }
  }

  const webRel = 'adapters/web/generalWebAdapter.js'
  if (modulePathExists(webRel) && catalog.GeneralWebAdapter) {
    const adapter = new catalog.GeneralWebAdapter()
    return {
      adapters: [adapter],
      catalogModuleLoaded: true,
      adapterIds: [adapter.adapterId],
    }
  }

  if (modulePathExists(webRel)) {
    const web = (await import(pathToFileURL(join(v2Root, webRel)).href)) as {
      GeneralWebAdapter?: new () => SourceAdapter
    }
    if (web.GeneralWebAdapter) {
      const adapter = new web.GeneralWebAdapter()
      return {
        adapters: [adapter],
        catalogModuleLoaded: true,
        adapterIds: [adapter.adapterId],
      }
    }
  }

  return { adapters: [], catalogModuleLoaded: true, adapterIds: [] }
}
