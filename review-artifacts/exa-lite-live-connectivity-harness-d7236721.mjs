/**
 * Frozen single-request Exa Lite connectivity harness @ d7236721.
 * Requires: built babel-cli dist at BABEL_EXA_CONNECTIVITY_BABEL_CLI_ROOT,
 * EXA_API_KEY in environment (never logged), BABEL_WEB_SEARCH_PROVIDER=exa_lite, NODE_PATH unset.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const babelCliRoot =
  process.env.BABEL_EXA_CONNECTIVITY_BABEL_CLI_ROOT?.trim() ||
  '/tmp/babel-exa-preflight-d723672/babel-cli'

const distImport = (rel) => import(pathToFileURL(join(babelCliRoot, 'dist', rel)).href)

const { createAdmittedSourceSearchProvider } = await distImport(
  'research/v2/access/createAdmittedSourceSearchProvider.js',
)
const { ResearchMissionV2Schema } = await distImport('research/v2/contracts/mission.js')
const { RESEARCH_V2_CONTRACT_VERSION } = await distImport('research/v2/contracts/version.js')
const { resolveEffectiveResearchV2ModelRouteForCli } = await distImport(
  'research/v2/model/researchV2ModelRoute.js',
)

const harnessStartedAt = new Date().toISOString()
const QUERY = 'Python latest stable release official downloads'
const effectiveRoute = resolveEffectiveResearchV2ModelRouteForCli(process.env)

const mission = ResearchMissionV2Schema.parse({
  schema_version: 'research-mission-v2',
  contract_version: RESEARCH_V2_CONTRACT_VERSION,
  mission_id: 'mission-general-exa-lite-connectivity-20261021',
  profile_id: 'general',
  profile_version: '0.1.0-m0',
  created_at: harnessStartedAt,
  primary_question:
    'From official python.org sources only, what is the latest stable CPython release and where is it published for download?',
  intended_decision:
    'State the latest stable release identifier and official download location using admitted python.org evidence only.',
  constraints: ['public_official_python_org_sources_only', 'stable_release_not_prerelease'],
  exclusions: ['third_party_mirrors', 'unverified_aggregators'],
  as_of: harnessStartedAt.slice(0, 10),
  jurisdiction: 'unknown',
  source_policy: {
    allowed_source_classes: ['web'],
    allowed_web_domains: ['python.org', 'www.python.org', 'docs.python.org'],
    visibility_retention: {
      source_visibility: 'public',
      retention: 'excerpt_only',
      export_may_omit_bytes: true,
    },
  },
  effort_policy: {
    preset_name: 'normal',
    resolved_budget_label: 'host-resolved-normal-exa-connectivity',
  },
  model_route: {
    backend_key: effectiveRoute.backend_key,
    provider: effectiveRoute.provider,
    provider_model_id: effectiveRoute.model_id,
  },
})

const { provider, configuredProviderId, limitations } = createAdmittedSourceSearchProvider({
  mode: 'babel_configured_web',
  mission,
  env: { ...process.env, BABEL_WEB_SEARCH_PROVIDER: 'exa_lite' },
})

const searchStartedAt = new Date().toISOString()
const controller = new AbortController()
const result = await provider.search(
  {
    operationId: 'op-general-exa-lite-connectivity-20261021-001',
    query: QUERY,
    sourceClasses: ['web'],
    signal: controller.signal,
  },
  mission,
)
const searchEndedAt = new Date().toISOString()

const receipt = result.status === 'ok' ? result.receipt : result.receipt
const hitDomains =
  result.status === 'ok'
    ? [
        ...new Set(
          result.hits.map((h) => {
            try {
              return new URL(h.source.observed_urls[0] ?? h.source.canonical_key).hostname
            } catch {
              return 'invalid'
            }
          }),
        ),
      ]
    : []

const pass =
  result.status === 'ok' &&
  receipt?.effective_provider_id === 'exa_lite' &&
  !receipt?.degradation &&
  Boolean(receipt?.exa_lite?.request_id)

const report = {
  harness: {
    babel_cli_root: babelCliRoot,
    pinned_head: 'd723672192db54b0caf167088fb5cdc857464f18',
    pinned_tree: '2ed97921d2768626f780fe7bb53070fb0f767b0c',
    harness_script: 'review-artifacts/exa-lite-live-connectivity-harness-d7236721.mjs',
    started_at_utc: harnessStartedAt,
    search_started_at_utc: searchStartedAt,
    search_ended_at_utc: searchEndedAt,
  },
  model_route_resolution: {
    selection_basis: effectiveRoute.selection_basis,
    route_key: effectiveRoute.route_key ?? null,
    backend_key: effectiveRoute.backend_key,
    provider: effectiveRoute.provider,
    provider_model_id: effectiveRoute.model_id,
    policy_path: effectiveRoute.policy_path ?? 'config/model-policy.json',
  },
  mission: {
    mission_id: mission.mission_id,
    profile_id: mission.profile_id,
    allowed_web_domains: mission.source_policy.allowed_web_domains,
  },
  configured_provider_id: configuredProviderId,
  limitations,
  result_status: result.status,
  validated_hit_count: result.status === 'ok' ? result.hits.length : 0,
  hit_hostnames: hitDomains,
  effective_provider_id: receipt?.effective_provider_id ?? null,
  exa_participation: receipt?.exa_participation ?? null,
  degradation: receipt?.degradation ?? null,
  exa_lite_request_id: receipt?.exa_lite?.request_id ?? null,
  exa_lite_resolved_search_type: receipt?.exa_lite?.resolved_search_type ?? null,
  exa_lite_estimated_cost_dollars: receipt?.exa_lite?.estimated_cost_dollars ?? null,
  exa_lite_warnings: receipt?.exa_lite?.warnings ?? [],
  exa_lite_notices: receipt?.exa_lite?.notices ?? [],
  failure_category: result.status === 'failed' ? result.failureCategory : undefined,
  failure_message: result.status === 'failed' ? result.message : undefined,
  connectivity_acceptance: pass,
  exit_code: pass ? 0 : 1,
}

const outPath = process.env.BABEL_EXA_CONNECTIVITY_REPORT_PATH
if (outPath) {
  writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n')
}
console.log(JSON.stringify(report, null, 2))
process.exit(report.exit_code)
