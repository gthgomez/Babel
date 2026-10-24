/**
 * Resolve the ten requested two-provider model routes against the live public
 * catalogs and emit a frozen manifest. Emits evidence references only — no
 * inference, no credentials. Usage:
 *
 *   node --import tsx scripts/resolve_provider_test_models.ts --out <private-manifest-path>
 */
import { parseArgs } from 'node:util'
import { writeFileSync } from 'node:fs'
import {
  refreshProviderCatalogs,
  resolveRequestedRoutes,
  REQUESTED_SELECTOR_KEYS,
} from '../src/intelligence/providerCatalog.js'

const { values } = parseArgs({
  options: { out: { type: 'string' } },
  strict: true,
})
if (!values.out || values.out.length === 0) {
  console.error('Usage: node --import tsx scripts/resolve_provider_test_models.ts --out <manifest-path>')
  process.exit(2)
}

const now = new Date()
const resolvedAt = now.toISOString()
const catalogs = await refreshProviderCatalogs({
  providers: ['openrouter', 'commandcode'],
  now: () => now,
})
const routes = resolveRequestedRoutes(catalogs, resolvedAt)

const manifest = {
  schemaVersion: 1,
  purpose: 'Frozen campaign route manifest; catalog evidence only, no credentials.',
  resolvedAt,
  selectors: [...REQUESTED_SELECTOR_KEYS],
  routes: routes.map((route) => ({
    selectorKey: route.selectorKey,
    provider: route.provider,
    modelId: route.modelId,
    protocol: route.protocol,
    apiBase: route.apiBase,
    canonicalRevision: route.canonicalRevision,
    revisionKind: route.revisionKind,
    credentialEnvVar: route.credentialEnvVar,
    catalog: route.catalog,
    capabilities: route.capabilities,
    routeHash: route.routeHash,
  })),
  catalogs: {
    openrouter: catalogs.openrouter && {
      url: catalogs.openrouter.url,
      fetchedAt: catalogs.openrouter.fetchedAt,
      sha256: catalogs.openrouter.sha256,
      entryCount: catalogs.openrouter.entries.length,
    },
    commandcode: catalogs.commandcode && {
      url: catalogs.commandcode.url,
      fetchedAt: catalogs.commandcode.fetchedAt,
      sha256: catalogs.commandcode.sha256,
      entryCount: catalogs.commandcode.entries.length,
    },
  },
}

writeFileSync(values.out, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
console.log(`Resolved ${routes.length} routes -> ${values.out}`)
for (const route of routes) {
  console.log(`  ${route.selectorKey} => ${route.provider}:${route.modelId} (${route.protocol})`)
}
