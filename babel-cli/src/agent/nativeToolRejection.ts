import { createHash } from 'node:crypto'

const FIELDS = new Set(['path', 'file_path', 'command', 'cwd', 'content', 'old_str', 'new_str',
  'query', 'pattern', 'start_line', 'end_line', 'max_rounds', 'model', 'task', 'mutation',
  'write_scope', 'instructions', 'type', 'actions', 'url', 'limit', 'server', 'name', 'arguments'])
const TOOLS = new Set('read_file read_range list_dir glob grep write_file str_replace apply_patch run_command test_run sub_agent finish semantic_search git_context todo_write lsp mcp_request mcp_tool_search web_search web_fetch await_command'.split(' '))
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const field = (value: string): string => FIELDS.has(value) ? value : `field-sha256:${hash(value)}`

/** Diagnostics expose schema shapes and hashes, never rejected source/command values. */
export function describeNativeToolRejection(input: {
  turn: number; id: string; name: string; input: Record<string, unknown>;
  reason: string; issues: Array<{ code: string; path: string[] }>;
}): Record<string, unknown> {
  return {
    schema_version: 1, turn: input.turn, call_id_sha256: hash(String(input.id)),
    tool: TOOLS.has(input.name) ? input.name : 'unrecognized_tool', tool_sha256: hash(String(input.name)),
    input_sha256: hash(JSON.stringify(input.input) ?? 'undefined'), reason: input.reason, dispatched: false,
    input_shape: Object.entries(input.input ?? {}).slice(0, 64).map(([key, value]) => ({
      field: field(key), type: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
      ...(typeof value === 'string' || Array.isArray(value) ? { length: value.length } : {}),
    })),
    issues: input.issues.slice(0, 32).map(issue => ({
      code: /^[a-z_]{1,40}$/.test(issue.code) ? issue.code : 'schema_invalid',
      path: issue.path.slice(0, 8).map(field),
    })),
    replay: 'Use synthetic values of the recorded types; original argument values are intentionally not retained.',
  }
}
