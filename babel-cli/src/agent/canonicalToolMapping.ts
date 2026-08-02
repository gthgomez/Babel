/**
 * Canonical model↔executor tool vocabulary.
 *
 * ChatEngine exposes model-facing names because those names are part of the
 * provider prompt and native function-call contract. The governed executor
 * exposes the lower-level names used by `localTools.ts`. Keeping the relation
 * here prevents each runtime surface from growing its own alias table.
 */

export const MODEL_TOOL_NAMES = [
  'read_file',
  'list_dir',
  'semantic_search',
  'grep',
  'glob',
  'write_file',
  'str_replace',
  'read_range',
  'apply_patch',
  'run_command',
  'await_command',
  'test_run',
  'git_context',
  'todo_write',
  'workspace_map',
  'mcp_tool_search',
  'mcp_request',
  'web_search',
  'web_fetch',
  'lsp',
  'sub_agent',
  'finish',
] as const

export type ModelToolName = (typeof MODEL_TOOL_NAMES)[number]

export const EXECUTOR_TOOL_NAMES = [
  'file_read',
  'directory_list',
  'semantic_search',
  'grep',
  'glob',
  'file_write',
  'shell_exec',
  'test_run',
  'git_context',
  'workspace_map',
  'mcp_tool_search',
  'mcp_request',
  'web_search',
  'web_fetch',
  'lsp',
] as const

export type ExecutorToolName = (typeof EXECUTOR_TOOL_NAMES)[number]

export interface CanonicalToolMapping {
  /** Stable name used in model prompts and ChatToolAction values. */
  model: ModelToolName
  /** Stable name understood by the lower-level executor. */
  /** Null when the model action is handled by the ChatEngine kernel itself. */
  executor: ExecutorToolName | null
  /** Provider/executor spellings accepted at the boundary. */
  aliases: readonly string[]
}

const MAPPINGS: readonly CanonicalToolMapping[] = [
  { model: 'read_file', executor: 'file_read', aliases: ['read', 'file_read'] },
  { model: 'list_dir', executor: 'directory_list', aliases: ['list_directory', 'directory_list'] },
  { model: 'semantic_search', executor: 'semantic_search', aliases: ['search'] },
  { model: 'grep', executor: 'grep', aliases: ['ripgrep', 'file_grep'] },
  { model: 'glob', executor: 'glob', aliases: ['glob_file', 'glob_paths'] },
  { model: 'write_file', executor: 'file_write', aliases: ['write', 'file_write'] },
  { model: 'str_replace', executor: null, aliases: ['replace', 'string_replace'] },
  { model: 'read_range', executor: null, aliases: ['range_read'] },
  { model: 'apply_patch', executor: null, aliases: ['patch'] },
  { model: 'run_command', executor: 'shell_exec', aliases: ['shell', 'shell_exec', 'exec'] },
  { model: 'await_command', executor: 'shell_exec', aliases: ['wait_for_command'] },
  { model: 'test_run', executor: 'test_run', aliases: ['test', 'run_tests'] },
  { model: 'git_context', executor: 'git_context', aliases: ['git_status', 'git_diff'] },
  { model: 'todo_write', executor: null, aliases: ['todo', 'todos'] },
  { model: 'workspace_map', executor: 'workspace_map', aliases: ['map_workspace'] },
  { model: 'mcp_tool_search', executor: 'mcp_tool_search', aliases: [] },
  { model: 'mcp_request', executor: 'mcp_request', aliases: [] },
  { model: 'web_search', executor: 'web_search', aliases: ['search_web'] },
  { model: 'web_fetch', executor: 'web_fetch', aliases: ['fetch_url'] },
  { model: 'lsp', executor: 'lsp', aliases: ['language_server'] },
  { model: 'sub_agent', executor: null, aliases: ['subagent'] },
  { model: 'finish', executor: null, aliases: ['done', 'complete'] },
]

const modelByName = new Map<string, CanonicalToolMapping>()
const executorByName = new Map<string, CanonicalToolMapping>()
for (const mapping of MAPPINGS) {
  modelByName.set(mapping.model, mapping)
  if (mapping.executor) executorByName.set(mapping.executor, mapping)
  for (const alias of mapping.aliases) {
    modelByName.set(alias, mapping)
  }
}

function normalizeKey(name: string): string {
  return name.trim().toLowerCase().replace(/[\s-]+/g, '_')
}

/** Return the canonical model-facing tool name for a provider spelling. */
export function normalizeModelToolName(name: string): string {
  return modelByName.get(normalizeKey(name))?.model ?? normalizeKey(name)
}

/** Return the canonical executor tool name for an executor/provider spelling. */
export function normalizeExecutorToolName(name: string): string {
  const key = normalizeKey(name)
  return executorByName.get(key)?.executor ?? modelByName.get(key)?.executor ?? key
}

/** Map a model-facing tool name to its lower-level executor name. */
export function modelToolNameToExecutor(name: string): ExecutorToolName | undefined {
  const mapping = modelByName.get(normalizeKey(name))
  return mapping?.executor ?? undefined
}

/** Map an executor tool name to the canonical model-facing name. */
export function executorToolNameToModel(name: string): ModelToolName | undefined {
  return executorByName.get(normalizeKey(name))?.model
}

/** Return an immutable snapshot for diagnostics and structural tests. */
export function getCanonicalToolMappings(): readonly CanonicalToolMapping[] {
  return MAPPINGS
}
