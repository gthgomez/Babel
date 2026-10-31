/** Inspect resolved runtime defaults without starting inference or indexing. */
import { resolveEffectiveSettings } from '../config/userSettings.js'
import { resolveChatEngineLimits } from '../config/chatEngineLimits.js'
import { DEFAULT_EXECUTION_PROFILE } from '../config/executionProfiles.js'
import { readApprovalProfileStatus } from '../config/approvalProfiles.js'
import { resolveRuntimePaths } from '../config/runtimePaths.js'
import { getRequestTimeoutMs, getRequestMaxRetries } from '../runners/providerResponsePolicy.js'
import { getStreamIdleTimeoutMs, getStreamMaxRetries } from '../runners/providerResponseStream.js'
import { DEFAULT_COMPACTION_CONFIG } from '../agent/chatCompaction.js'
import { resolveChatTaskClass, getChatTaskTune } from '../config/chatTaskClass.js'
import type { SelectionSession } from './connectionSettings.js'

export function inspectDefaults(session: SelectionSession = {}, projectRoot = process.cwd()) {
  const effective = resolveEffectiveSettings({ session, projectRoot })
  const limits = resolveChatEngineLimits({}, effective.model.value ?? undefined, { projectRoot })
  const finite = (value: number) => Number.isFinite(value) ? value : 'unlimited'
  const paths = resolveRuntimePaths()
  const taskClass = resolveChatTaskClass({ autoClassify: false })
  const { compactionModel: _legacyModel, ...compactionDefaults } = DEFAULT_COMPACTION_CONFIG
  const source = (neutral: string, legacy: string) => process.env[neutral] !== undefined ? neutral : process.env[legacy] !== undefined ? legacy : 'built-in'
  return { effective,
    execution: { defaultProfile: DEFAULT_EXECUTION_PROFILE, permissions: readApprovalProfileStatus(),
      note: 'Workflow, review depth, display and permissions are independent. Tool execution still requires current authority and isolation.' },
    limits: { maxTurns: finite(limits.maxTurns), maxConversationMessages: limits.maxConversationMessages,
      monetaryCapSupport: 'Standard Work uses its admitted task allowance. Plan, thorough Work, Apply and legacy unmetered lanes reject finite saved caps before inference; they require an explicit unlimited preference until qualified.',
      maxEstimatedTokens: limits.maxEstimatedTokens, maxCostUsd: finite(limits.maxCostUsd), maxWallMs: finite(limits.maxWallMs),
      stallTurns: limits.stallTurns, maxTokensPerRound: limits.maxTokensPerRound },
    taskClass: { value: taskClass, source: process.env['BABEL_CHAT_TASK_CLASS'] ? 'environment' : 'built-in', tune: getChatTaskTune(taskClass).limits },
    transport: { scope: 'Shared compatible/native transport defaults; Go owns a separate bounded allowance and Ollama owns its local request policy.',
      requestTimeoutMs: { value: getRequestTimeoutMs(), source: source('BABEL_PROVIDER_REQUEST_TIMEOUT_MS', 'BABEL_DEEPINFRA_REQUEST_TIMEOUT_MS') },
      requestMaxAttempts: { value: Math.max(1, getRequestMaxRetries()), source: source('BABEL_PROVIDER_REQUEST_MAX_RETRIES', 'BABEL_DEEPINFRA_REQUEST_MAX_RETRIES'), zeroMeans: 'initial attempt only' },
      streamIdleTimeoutMs: { value: getStreamIdleTimeoutMs(), source: source('BABEL_PROVIDER_STREAM_IDLE_TIMEOUT_MS', 'BABEL_DEEPINFRA_STREAM_IDLE_TIMEOUT_MS') },
      streamRetries: { value: getStreamMaxRetries(), source: source('BABEL_PROVIDER_STREAM_MAX_RETRIES', 'BABEL_DEEPINFRA_STREAM_MAX_RETRIES') },
      localPolicy: effective.connection.value?.provider === 'ollama' ? { requestTimeoutMs: Number(process.env['BABEL_OLLAMA_REQUEST_TIMEOUT_MS'] ?? process.env['BABEL_PROVIDER_REQUEST_TIMEOUT_MS'] ?? 300000), maxAttempts: Math.max(1, Number(process.env['BABEL_OLLAMA_REQUEST_MAX_RETRIES'] ?? process.env['BABEL_PROVIDER_REQUEST_MAX_RETRIES'] ?? 1)) } : null,
    },
    compaction: { ...compactionDefaults, selectedModel: effective.model.value, llmRequested: process.env['BABEL_COMPACTION'] !== 'off',
      modelPolicy: effective.connection.value ? 'Selected connection/model; same account and canonical runner. No ambient auxiliary account.' : 'No selected connection; no cloud compaction route.',
      note: 'These are strategy defaults. Current serialized request admission and task limits determine effective headroom.' },
    roles: effective.connection.value ? { policy: 'Selected connection pins inference roles; no automatic provider fallback.', provider: effective.connection.value.provider, model: effective.model.value } : null,
    indexing: { startupEligible: !paths.isInstalled && Boolean(effective.connection.value && effective.model.value) && process.env['BABEL_SKIP_KG_INDEX'] !== '1', requires: 'Local provider prerequisites before indexing; installed startup does not index automatically.' },
    memory: { writebackRequested: !['0', 'false'].includes(process.env['BABEL_MEMORY_WRITEBACK'] ?? ''), policy: 'Current read-only and project-memory rules still govern writes.' },
    identity: { requestedModel: effective.model.value, sentModel: null, observedModel: null,
      explanation: 'Sent and observed identity come from actual invocation receipts; configuration does not prove either.' },
    instructions: { work: 'Built-in Chat behavioral contract plus the canonical project instruction compiler (AGENTS.md and ENGINEERING.md within resolved scope).',
      thorough: 'Existing governed Deep stack assembly; not every prompt-library layer is active in ordinary Work.',
      includedAndOmitted: 'Inspect the current run instruction manifest using context/inspection views; no run has been compiled by this command.' },
    persistence: { preferences: 'Private user profile; project overrides are stored there by resolved project root.',
      localState: paths.userStateRoot, remoteTracingOptIn: true, remoteTracingRequested: /^(?:1|true|yes)$/i.test(process.env['BABEL_OTEL_ENABLED'] ?? '') },
    prices: 'Unknown until matching provider/model pricing evidence is available; unknown is never zero.',
  }
}
