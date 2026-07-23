/**
 * ChatToolDefinitions — Zod schemas, prompt builders, and formatters for the
 * unified ChatEngine. Defines the two-phase per-turn contract between the
 * model and the engine:
 *
 *   Phase 1 (tool_calls)  — structured JSON, non-streamed, actions execute
 *   Phase 2 (completion)  — raw text, streamed via executeRaw
 *
 * This file reuses AgentAction shapes from actions.ts for tool definitions
 * and adds the `sub_agent` action for parallel investigation.
 */

import { z } from 'zod';
import { extractJson } from '../utils/extractJson.js';
import type { AgentAction } from './actions.js';
import type { ProviderMessage, ProviderToolCall, ToolDefinition } from '../runners/base.js';
import {
  BaseReadFileSchema,
  BaseListDirSchema,
  BaseGrepSchema,
  BaseGlobSchema,
  BaseWriteFileSchema,
  BaseApplyPatchSchema,
  BaseRunCommandSchema,
  BaseSemanticSearchSchema,
  BaseGitContextSchema,
  BaseTestRunSchema,
} from './actions.js';
import { readMcpServers } from '../config/mcpServers.js';
import type { ToolCallRequest } from '../localTools.js';
import { targetBasename } from '../services/targetResolver.js';
import { trimForPrompt } from '../services/liteProjectContext.js';

// ─── Chat Tool Action Schema ──────────────────────────────────────────────

/**
 * Extended action schema for chat mode. Reuses the existing AgentAction shapes
 * from actions.ts and adds `sub_agent` for parallel read-only investigation.
 */
export const ChatToolActionSchema = z.discriminatedUnion('type', [
  BaseReadFileSchema,
  BaseListDirSchema,
  BaseGrepSchema,
  BaseGlobSchema,
  BaseWriteFileSchema,
  BaseApplyPatchSchema,
  // T2.2: optional background flag on run_command (chat path only).
  BaseRunCommandSchema.extend({
    background: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('await_command'),
    task_id: z.string().min(1),
    timeout_seconds: z.number().int().positive().optional(),
  }),
  BaseSemanticSearchSchema,
  BaseGitContextSchema,
  BaseTestRunSchema,
  z.object({ type: z.literal('mcp_tool_search'), server: z.string().min(1), query: z.string().optional() }),
  z.object({
    type: z.literal('mcp_request'),
    server: z.string().min(1),
    query: z.string().min(1),
  }),
  z.object({
    type: z.literal('str_replace'),
    file_path: z.string().min(1),
    old_str: z.string().min(1),
    new_str: z.string(),
  }),
  z.object({
    type: z.literal('read_range'),
    file_path: z.string().min(1),
    start_line: z.number().int().positive(),
    end_line: z.number().int().positive(),
  }),
  z.object({
    type: z.literal('todo_write'),
    todos: z
      .array(
        z.object({
          id: z.string().min(1),
          content: z.string(),
          status: z.enum(['pending', 'in_progress', 'completed']),
        }),
      )
      .min(1),
  }),
  z.object({ type: z.literal('web_search'), query: z.string().min(1) }),
  z.object({ type: z.literal('web_fetch'), url: z.string().min(1) }),
  z.object({ type: z.literal('finish') }),
  z.object({
    type: z.literal('lsp'),
    operation: z.enum([
      'goToDefinition',
      'findReferences',
      'hover',
      'documentSymbol',
      'workspaceSymbol',
      'goToImplementation',
      'prepareCallHierarchy',
      'incomingCalls',
      'outgoingCalls',
    ]),
    filePath: z.string().min(1),
    line: z.number().int().positive().optional(),
    character: z.number().int().positive().optional(),
    query: z.string().optional(),
  }),
  z.object({
    type: z.literal('sub_agent'),
    task: z.string().min(1),
    instructions: z.string().optional(),
    write_scope: z.array(z.string()).optional(),
    mutation: z.boolean().optional().default(false),
    /** Model backend key override (e.g. "deepseek-v4-pro", "scout").
     *  When omitted, the sub-agent uses the cheapest enabled model. */
    model: z.string().optional(),
    /** Maximum conversation turns for this sub-agent (overrides default).
     *  Read-only agents default to 4; mutation agents default to 8. */
    max_rounds: z.number().int().positive().optional(),
  }),
]);

export type ChatToolAction = z.infer<typeof ChatToolActionSchema>;

/**
 * Discriminated union for the model's per-turn response:
 * - tool_calls: model wants to execute tools before synthesizing an answer
 * - completion: model is ready to produce the final answer
 */
export const ChatTurnSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('tool_calls'),
    thinking: z.string().optional(),
    actions: z.array(ChatToolActionSchema).min(1).max(6),
  }),
  z.object({
    type: z.literal('completion'),
    answer: z.string().min(1),
    summary: z.string().optional(),
    status: z.enum(['completed', 'blocked']).optional(),
  }),
]);

export type ChatTurn = z.infer<typeof ChatTurnSchema>;

// ─── Conversation Types ───────────────────────────────────────────────────

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCallId?: string;
  toolName?: string;
  name?: string;
}

// ─── Action Helpers ───────────────────────────────────────────────────────

export function chatActionToolName(action: ChatToolAction): string {
  return action.type;
}

export function chatActionTarget(action: ChatToolAction): string {
  switch (action.type) {
    case 'read_file':
    case 'write_file':
    case 'list_dir':
      return action.path;
    case 'grep':
      return action.path ? `${action.pattern} @ ${action.path}` : action.pattern;
    case 'glob':
      return action.pattern;
    case 'web_search':
      return action.query;
    case 'web_fetch':
      return action.url;
    case 'run_command':
    case 'test_run':
      return action.command;
    case 'await_command':
      return action.task_id;
    case 'semantic_search':
      return action.query;
    case 'git_context':
      return action.path ?? action.format ?? 'summary';
    case 'mcp_tool_search':
      return action.query ? `${action.server}: ${action.query}` : action.server;
    case 'mcp_request':
      return `${action.server} → ${action.query.slice(0, 80)}`;
    case 'apply_patch':
      return action.patch.slice(0, 120);
    case 'lsp':
      return `${action.operation} @ ${action.filePath}`;
    case 'sub_agent':
      return action.task;
    case 'str_replace':
    case 'read_range':
      return action.file_path;
    case 'todo_write':
      return 'todos';
    case 'finish':
      return '';
    default: {
      const _exhaustive: never = action;
      return String((_exhaustive as ChatToolAction).type);
    }
  }
}

export function mapChatActionToAgentAction(action: ChatToolAction): AgentAction {
  // Shared base-schema actions: structural compatibility guaranteed by
  // construction (both ChatToolActionSchema and AgentActionSchema compose
  // from the same Base*Schema exports in actions.ts).
  switch (action.type) {
    case 'read_file':
    case 'list_dir':
    case 'grep':
    case 'glob':
    case 'write_file':
    case 'apply_patch':
      return action as unknown as AgentAction;
    case 'run_command':
      // Strip chat-only background flag before mapping to AgentAction.
      return {
        type: 'run_command',
        command: action.command,
        ...(action.cwd !== undefined ? { cwd: action.cwd } : {}),
      };
    case 'semantic_search':
      return { type: 'search', query: action.query };
    case 'git_context':
    case 'test_run':
      return action as unknown as AgentAction;
    case 'str_replace':
    case 'read_range':
    case 'todo_write':
    case 'await_command':
    case 'mcp_tool_search':
    case 'mcp_request':
    case 'web_search':
    case 'web_fetch':
    case 'sub_agent':
    case 'lsp':
      // These action types must be handled by the caller before calling
      // mapChatActionToAgentAction — AgentAction has no equivalent variant.
      // The chat engine's executeOneAction catches them first (sub_agent,
      // MCP, web_search/web_fetch, and lsp via executeTool). Throwing here
      // catches programming errors if a new code path reaches this function.
      throw new Error(
        `Unreachable: '${action.type}' must be handled by caller before mapChatActionToAgentAction`,
      );
    case 'finish':
      return { type: 'finish', summary: '', verification: [] };
  }
}

// ─── Prompt Builders ──────────────────────────────────────────────────────

export interface ChatSystemPromptOptions {
  projectRoot: string;
  systemContext?: string;
  /** When true, instruct the model to use native function calling (no JSON envelope). */
  nativeTools?: boolean;
  /** When true, use the simplified text-tool format for small local models. */
  textTools?: boolean;
  /** When true, include execution-first directives in the system prompt. */
  executionFirst?: boolean;
}

export function buildChatSystemPrompt(options: ChatSystemPromptOptions): string {
  const sections: string[] = [];

  // Text-tools mode: use a MINIMAL prompt. Small models (3-4B) cannot
  // reliably attend to the full Babel system prompt. Give them just the
  // tool format and essential instructions.
  if (options.textTools) {
    sections.push(
      'You are a coding agent with file tools. Always use tools before answering.',
      'DO NOT copy example values — use REAL file paths and values for YOUR task.',
      'Results arrive as [RESULT]... or [OK]. Chain tools or answer in plain text.',
      '',
      '[TOOL:read_file]',
      'path: src/auth.ts',
      '[TOOL:grep]',
      'pattern: isAuthenticated',
      'path: src/',
      '[TOOL:glob]',
      'pattern: **/*.test.ts',
      '[TOOL:write_file]',
      'path: src/fix.ts',
      'content:',
      '  export function hello() {',
      '    return "world";',
      '  }',
      '[TOOL:str_replace]',
      'file_path: src/auth.ts',
      'old_str: if (token = null)',
      'new_str: if (token === null)',
      '[TOOL:run_command]',
      'command: npm test',
      '[TOOL:think]',
      'thought: The bug is on line 42 — null assignment instead of comparison.',
      '[TOOL:ask]',
      'question: Should I fix this for Node 18 or Node 20?',
      '[TOOL:remember]',
      'key: auth_bug',
      'value:',
      '  Line 42: token = null should be token === null',
      '  File: src/auth.ts',
      '[TOOL:recall]',
      'key: auth_bug',
      '[TOOL:check]',
      'file_path: src/auth.ts',
      '[TOOL:plan]',
      'steps:',
      '  1. Read src/auth.ts to find the bug',
      '  2. Apply str_replace to fix the comparison',
      '  3. Run npm test to verify',
      '  4. Report the fix',
    );
    return sections.join('\n');
  }

  sections.push(
    '# Babel Chat',
    '',
    'You are a conversational coding agent — an interactive software engineer who investigates, ' +
      'diagnoses, AND applies fixes. You are not an advisor who only gives suggestions. ' +
      'When a task asks you to fix, implement, repair, or create something, you must use your tools ' +
      'to make actual file changes and verify them.',
    '',
    '## Core Principles',
    '- Prefer the file/search tools (read_file, grep, glob) over shell commands for code exploration.',
    '- When fixing: read → diagnose → apply changes → verify. Do not stop at diagnosis.',
    '- Write code that matches the surrounding style, conventions, and patterns.',
    '- Be thorough — read the relevant files, understand the problem, then act.',
    '- Small, focused edits are better than large rewrites.',
    '- Prefer `str_replace` over `write_file` for targeted edits under ~50 lines — it is faster, cheaper, and less error-prone.',
    '- Use `read_range` when you know the approximate line numbers instead of reading entire files.',
    '- Use `todo_write` at the start of complex multi-step tasks to track progress on sub-goals.',
    '- If tests fail after your change, read the error output and fix the issue — do not give up.',
  );

  if (options.executionFirst) {
    sections.push(
      '',
      '## How You Work',
      '',
      'You are a conversational coding agent — you investigate AND apply changes. ' +
        'You are not an advisor who only gives suggestions. When a task requires code changes, ' +
        'you must use the tools to make those changes happen.',
      '',
      '### For fix, implement, repair, or create requests:',
      '- Read the relevant files first to understand the problem.',
      '- Apply the fix using str_replace (preferred for targeted edits) or write_file for larger changes — the filesystem must change.',
      '- Run the project verifier (npm test, pytest, etc.) via test_run or run_command after making changes.',
      '- Code in markdown fences does not count as done. Only actual file writes count.',
      '- If tests fail, read the output, fix the issue, and rerun. Iterate until they pass.',
      '',
      '### For explanation or review requests:',
      '- Read relevant files, then explain clearly.',
      '- You may complete without writes.',
      '',
      '### Important',
      '- You are operating in automated/headless mode — make changes directly, do not wait for approval.',
      '- Prefer small, focused edits over large rewrites.',
      '- If you do not know the answer, investigate with tools before giving up.',
    );
  }

  if (options.textTools) {
    sections.push(
      '',
      '## CRITICAL: How to use tools',
      '',
      'You MUST use tools to read files and make changes. Do NOT guess or hallucinate.',
      'To invoke a tool, write EXACTLY this format on its own line:',
      '',
      '[TOOL:tool_name]',
      'param1: value1',
      'param2: value2',
      '',
      'Multi-line values: indent continuation lines with 2 spaces.',
      '',
      '[TOOL:write_file]',
      'path: src/hello.ts',
      'content:',
      '  export function hello() {',
      '    return "world";',
      '  }',
      '',
      'Available tools:',
      '- [TOOL:read_file] path: "file/path"',
      '- [TOOL:write_file] path: "file/path" content: (next lines indented)',
      '- [TOOL:str_replace] file_path: "f" old_str: (next lines) new_str: (next lines)',
      '- [TOOL:grep] pattern: "regex" path: "dir/" (path optional)',
      '- [TOOL:glob] pattern: "**/*.ts"',
      '- [TOOL:run_command] command: "npm test"',
      '- [TOOL:finish] (no params — signals completion)',
      '',
      'IMPORTANT: Every time you need to read a file, run a command, or make an edit,',
      'you MUST start your response with the [TOOL:...] block. Do not write explanations',
      'before using a tool. Tools go FIRST, then your analysis.',
    );
  } else if (options.nativeTools) {
    sections.push(
      '',
      '## How to respond',
      '',
      'Use the provided function tools when you need to investigate or modify the codebase.',
      'When you have enough context, reply in clear natural language with markdown.',
      'Read before you write. Prefer small, focused edits.',
    );
  } else {
    sections.push(
      '',
      '## How to respond',
      '',
      'Each turn you MUST output a single JSON object matching one of these two shapes:',
      '',
      '**To use tools (investigate or modify):**',
      '```json',
      '{',
      '  "type": "tool_calls",',
      '  "thinking": "brief reasoning about what you need to do",',
      '  "actions": [',
      '    { "type": "read_file", "path": "src/file.ts" },',
      '    { "type": "grep", "pattern": "function name", "path": "src/" },',
      '    { "type": "sub_agent", "task": "investigate the auth module" }',
      '  ]',
      '}',
      '```',
      '',
      '**To answer (when you have enough context):**',
      '```json',
      '{',
      '  "type": "completion",',
      '  "answer": "Your full answer here in natural language. Use markdown."',
      '}',
      '```',
      'Provide the complete answer in the JSON. It will be displayed to the user directly.',
      'You do NOT need to make a separate call — the answer goes right here.',
    );
  }

  sections.push(
    '',
    '## Available Tools',
    '',
    '| Tool | Description |',
    '|------|-------------|',
    '| `read_file` | Read a file. `path`: absolute or project-relative path |',
    '| `list_dir` | List directory contents. `path`: directory path |',
    '| `grep` | Search file contents with regex. `pattern`: regex, `path` (optional): scope directory |',
    '| `glob` | Find files by glob pattern. `pattern`: eg `"src/**/*.ts"` |',
    '| `semantic_search` | Semantic repo search. `query`: natural language query |',
    '| `git_context` | Git status/diff context. `format`: summary/files/diff, optional `path` |',
    '| `test_run` | Run tests with extended timeout. `command`: test command |',
    '| `web_search` | Search the web. `query`: search string |',
    '| `web_fetch` | Fetch and read a URL. `url`: full URL |',
    '| `str_replace` | Perform exact string replacement in a file. `file_path`: target file, `old_str`: text to replace, `new_str`: replacement text. PREFERRED over write_file for targeted edits under ~50 lines. |',
    '| `read_range` | Read a specific line range from a file. `file_path`: target file, `start_line`/`end_line`: 1-indexed inclusive range. Use instead of read_file when you only need a portion of a large file. |',
    '| `todo_write` | Create/manage a structured task list for complex multi-step tasks. `todos`: array of `{id, content, status}` with merge-patch semantics. |',
    '| `run_command` | Run a shell command. `command`: shell command. Optional `background: true` starts the command without blocking; use `await_command` to collect output. |',
    '| `await_command` | Wait for a background shell job. `task_id`: id from background `run_command`, optional `timeout_seconds`. |',
    '| `write_file` | Write or overwrite a file. `path`: absolute or project-relative path, `content`: complete file contents. This is the primary tool for making code changes — use it to apply fixes, create new files, or update existing ones. |',
    '| `apply_patch` | Apply a unified diff patch to modify files. `patch`: unified diff content. Use this when you have a specific diff to apply. |',
    '| `sub_agent` | Spawn a sub-agent for parallel investigation or mutation. `task`: what to do, `mutation` (optional): set to true for write access, `write_scope` (optional): paths the sub-agent can modify, `model` (optional): backend key override (e.g. "deepseek-v4-pro", "scout"), `max_rounds` (optional): turn limit. Use for complex multi-step tasks. |',
    '| `finish` | Signal completion (no more actions needed) |',
    '',
    '## Recommended Workflow',
    '',
    'For complex multi-step tasks, follow this cycle:',
    '',
    '1. **Investigate** — Use `read_file`, `read_range`, `grep`, `glob`, or `sub_agent` to understand the codebase.',
    '2. **Plan** — Use `todo_write` to break the task into tracked sub-goals with clear completion criteria.',
    '3. **Mutate** — Apply changes using `str_replace` (preferred for edits under ~50 lines) or `write_file` for larger changes. Use `apply_patch` when you have a specific diff.',
    '4. **Verify** — Run tests or build commands via `test_run` or `run_command`. Check that your changes compile and pass existing tests.',
    '5. **Complete** — Update `todo_write` with completed statuses. Signal done with `finish` when all todos are done and the verifier passes.',
    '',
    'This cycle keeps your work focused, verifiable, and efficient. Update `todo_write` after each step to maintain visibility into your progress.',
    '',
    '## Safety Rules',
    '',
    '- Always read before you write — understand the code before changing it.',
    '- Use `sub_agent` for parallel investigation of multiple files/modules.',
    '- Be thorough: when investigating, read the relevant files, not just file names.',
    '- When modifying code, show the user what changed and why.',
    '- Never run destructive commands (rm -rf, force push, etc.).',
    ...(options.executionFirst
      ? [
          '- When working on a fix or implementation task, apply the changes directly — the user expects you to execute, not just advise.',
        ]
      : ['- Ask the user before making significant architectural changes.']),
  );

  const mcpServers = readMcpServers();
  const mcpNames = Object.keys(mcpServers);
  if (mcpNames.length > 0) {
    sections.push(
      '',
      '## MCP Servers',
      ...mcpNames.map((name) => `- ${name}`),
      '',
      '| `mcp_tool_search` | Search tools on MCP server. `server`, optional `query` |',
      '| `mcp_request` | Call MCP tool. `server`, `query` (tool name + JSON args) |',
    );
  }

  if (options.systemContext) {
    sections.push('', '## Project Context', options.systemContext);
  }

  sections.push(
    '',
    `Current working directory: ${options.projectRoot}`,
    `Project: ${targetBasename(options.projectRoot)}`,
  );

  return sections.join('\n');
}

export interface ChatTurnPromptOptions {
  conversation: ChatMessage[];
  toolObservations?: string;
  task: string;
  /** When true, omit JSON response instructions (native function calling). */
  nativeTools?: boolean;
  /** When true, use simplified text-tool format for small local models. */
  textTools?: boolean;
}

export function buildChatTurnPrompt(options: ChatTurnPromptOptions): string {
  const sections: string[] = [];

  // Conversation history
  if (options.conversation.length > 1) {
    sections.push('## Conversation History');
    for (const msg of options.conversation) {
      const label = msg.name ? `${msg.role} (${msg.name})` : msg.role;
      sections.push(`### ${label}`);
      sections.push(msg.content);
      sections.push('');
    }
  }

  // Tool observations from prior turns
  if (options.toolObservations) {
    sections.push('## Tool Results');
    sections.push(options.toolObservations);
  }

  // Current task
  sections.push('## Current Request');
  sections.push(options.task);

  if (options.textTools) {
    sections.push(
      '',
      'Respond with [TOOL:name] to use a tool, or answer in plain text.',
    );
  } else if (!options.nativeTools) {
    sections.push('', 'Respond with the JSON for your next action.');
  } else {
    sections.push('', 'Use tools as needed, then answer the user.');
  }

  return sections.join('\n');
}

// ─── Provider-Native Structured Messages (P0-B) ────────────────────────────
// buildProviderMessages replaces buildChatTurnPrompt for native-tool-capable
// providers. Instead of flattening the entire conversation into Markdown prose
// inside a single user message, it produces a protocol-faithful ProviderMessage[]
// array: native system / user / assistant (with tool_calls) / tool (with
// tool_call_id) roles. The provider receives the conversation it was trained to
// consume, with correct role semantics and tool-call/result pairing.

export interface ProviderMessagesOptions {
  /** Provider-native conversation history (P0-B structured messages). */
  conversation: ProviderMessage[];
  /** The current task / user request. */
  task: string;
  /** When true, omit the user turn (caller will add it separately). */
  omitUserTurn?: boolean;
}

let _providerToolCallSeq = 0;

/** Build a protocol-faithful ProviderMessage[] for native-tool-capable runners. */
export function buildProviderMessages(options: ProviderMessagesOptions): ProviderMessage[] {
  const messages: ProviderMessage[] = [];

  // Conversation history — structured native messages (system, assistant+tool_calls,
  // tool+tool_call_id). The system prompt is the first message; assistant tool calls
  // carry their tool_calls array; tool results carry tool_call_id.
  for (const msg of options.conversation) {
    messages.push(msg);
  }

  // Current user request — sent once, never duplicated across turns
  if (!options.omitUserTurn && options.task) {
    messages.push({ role: 'user', content: options.task });
  }

  return messages;
}

/** Generate a stable, unique tool call ID scoped to a turn and index. */
export function generateToolCallId(turnIndex: number, callIndex: number): string {
  return `call_${turnIndex}_${callIndex}_${++_providerToolCallSeq}`;
}

/**
 * Build a ProviderMessage representing an assistant turn with native tool calls.
 * Each tool call gets a stable ID that tool results will reference.
 */
export function buildAssistantToolCallMessage(
  thinking: string,
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>,
  turnIndex: number,
): ProviderMessage {
  const calls: ProviderToolCall[] = toolCalls.map((tc, i) => ({
    id: generateToolCallId(turnIndex, i),
    type: 'function' as const,
    function: {
      name: tc.name,
      arguments: JSON.stringify(tc.arguments),
    },
  }));

  const msg: ProviderMessage = {
    role: 'assistant',
    content: thinking || 'Using tools…',
    name: 'tool_calls',
  };
  if (calls.length > 0) {
    msg.tool_calls = calls;
  }
  return msg;
}

/**
 * Build a ProviderMessage representing a single tool result.
 * The tool_call_id MUST match the ID from the corresponding assistant tool call.
 */
export function buildToolResultMessage(
  toolCallId: string,
  toolName: string,
  target: string,
  result: { stdout?: string; stderr?: string; exitCode?: number },
): ProviderMessage {
  const body =
    (result.stdout?.trim().length ?? 0) > 0
      ? result.stdout!
      : (result.stderr?.trim().length ?? 0) > 0
        ? result.stderr!
        : '(no output)';
  const exitCode = result.exitCode ?? -1;

  const content = [
    `### ${toolName} ${target}`,
    `exit_code: ${exitCode}`,
    '```',
    trimForPrompt(body, 2000),
    '```',
  ].join('\n');

  return {
    role: 'tool',
    content,
    tool_call_id: toolCallId,
  };
}

export function buildAnswerSynthesisPrompt(options: {
  conversation: ChatMessage[];
  task: string;
  toolObservations: string;
}): string {
  const sections: string[] = [];

  sections.push(
    '# Synthesize Answer',
    '',
    'You are an expert senior software engineer. The user asked:',
    '',
    `> ${options.task}`,
    '',
    'Below are the results of your investigation. Synthesize a clear, ' +
      'concise answer in natural language. Use markdown for formatting. ' +
      'Be specific — reference file paths, code snippets, and evidence.',
    '',
    '## Investigation Results',
    options.toolObservations,
    '',
    '## Answer Formatting Guidance',
    '',
    '### File Paths',
    'When referencing file paths, wrap them in backticks: `src/services/indexer.ts`. ' +
      'Use project-relative paths when possible (e.g., `babel-cli/src/agent/actions.ts`) rather than ' +
      'absolute paths to keep the answer readable.',
    '',
    '### Citing Evidence',
    'Always cite the source of your findings. When referencing content from a tool observation, ' +
      'name the tool call that produced it (e.g., `read_file` on `src/auth.ts`) and quote or paraphrase ' +
      'the relevant evidence. Include specific line numbers if the observation provided them. ' +
      'For `grep` results, mention the search pattern and the files where matches were found.',
    '',
    '### Contradictory or Uncertain Findings',
    'If you encounter conflicting evidence, acknowledge the contradiction explicitly rather than ' +
      'picking one side. Explain what each source says and, if possible, suggest how to resolve ' +
      'the discrepancy (e.g., "the type signature says X but the runtime check at line 42 says Y — ' +
      'this may be a bug or dead code"). When you are uncertain, state your confidence level and ' +
      'what additional information would help.',
    '',
    '### Length',
    'Aim for 3–8 paragraphs. Be thorough but concise — favor specific evidence over general ' +
      'statements. If the topic is simple, a single paragraph is fine; if complex, use the full range. ' +
      'Avoid filler phrases like "based on the provided information" or "as we can see."',
    '',
    '### Code Snippets vs. Descriptions',
    'Include a code snippet when the exact code matters (e.g., a bug, a function signature, ' +
      'a configuration value). Use a description when the concept is more important than the ' +
      'exact characters (e.g., "the module exports three helper functions"). For multi-line snippets, ' +
      'use fenced code blocks with the language specified. Keep snippets focused — extract only the ' +
      'relevant lines rather than dumping entire files.',
    '',
    '### Answer Structure',
    'Structure your answer as follows:',
    "1. **Summary** (1–2 sentences) — Directly answer the user's question.",
    '2. **Details** (2–5 paragraphs) — Explain your findings, reference evidence, ' +
      'discuss trade-offs or alternatives.',
    '3. **Recommendations** (1 paragraph) — Suggest next steps, workarounds, or actions ' +
      'the user should take.',
    '',
    '## Answer',
    'Write your answer below. Follow the formatting guidance above.',
  );

  return sections.join('\n');
}

// ─── Tool Observation Formatters ──────────────────────────────────────────

export function formatChatToolObservation(
  action: ChatToolAction,
  result: { stdout?: string; stderr?: string; exitCode?: number },
): string {
  const tool = chatActionToolName(action);
  const target = chatActionTarget(action);
  const body =
    (result.stdout?.trim().length ?? 0) > 0
      ? result.stdout!
      : (result.stderr?.trim().length ?? 0) > 0
        ? result.stderr!
        : '(no output)';
  const exitCode = result.exitCode ?? -1;

  return [
    `### ${tool} ${target}`,
    `exit_code: ${exitCode}`,
    '```',
    trimForPrompt(body, 2000),
    '```',
  ].join('\n');
}

export function formatSubAgentFindings(
  agentId: string,
  task: string,
  result: {
    observations: string;
    stepsExecuted: number;
    degraded: boolean;
  },
): string {
  const sections: string[] = [
    `### sub_agent ${agentId}: ${task}`,
    `steps: ${result.stepsExecuted}${result.degraded ? ' (degraded)' : ''}`,
  ];
  if (result.observations) {
    sections.push(result.observations);
  } else {
    sections.push('(no findings)');
  }
  return sections.join('\n');
}

// ─── Response Parsing ─────────────────────────────────────────────────────

export class ChatTurnParseError extends Error {
  constructor(
    message: string,
    readonly rawOutput?: string,
    readonly zodIssues?: z.ZodError,
  ) {
    super(message);
    this.name = 'ChatTurnParseError';
  }
}

export function parseChatTurn(rawText: string): ChatTurn {
  let parsed: unknown;
  try {
    parsed = extractJson(rawText);
  } catch (err) {
    throw new ChatTurnParseError(
      `Failed to extract JSON from model response: ${err instanceof Error ? err.message : String(err)}`,
      rawText,
    );
  }

  const result = ChatTurnSchema.safeParse(parsed);
  if (!result.success) {
    throw new ChatTurnParseError(
      `Chat turn validation failed: ${result.error.message}`,
      rawText,
      result.error,
    );
  }

  return result.data;
}

// ─── Native Tool Definitions ───────────────────────────────────────────────

/**
 * Build the OpenAI-compatible tool definitions for all available chat actions.
 * Each tool definition is a JSON Schema describing the function's parameters.
 * These are passed to the runner's `executeWithToolsStream()` method for native
 * function calling.
 */
export function buildChatToolDefinitions(): ToolDefinition[] {
  return [
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read the contents of a file at the given path.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute or project-relative path to the file' },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_dir',
        description: 'List the contents of a directory.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path to the directory' },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'grep',
        description: 'Search file contents using a regular expression pattern, optionally scoped to a directory.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Regular expression pattern to search for' },
            path: { type: 'string', description: 'Optional directory path to scope the search' },
          },
          required: ['pattern'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'semantic_search',
        description: 'Semantic search across the repository index.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Natural language search query' },
            limit: { type: 'number', description: 'Max results' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'git_context',
        description: 'Get git repository context (status, changed files, or diff).',
        parameters: {
          type: 'object',
          properties: {
            format: { type: 'string', enum: ['summary', 'files', 'diff'] },
            path: { type: 'string', description: 'Optional path scope' },
            max_lines: { type: 'number', description: 'Max diff lines' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'glob',
        description: 'Find files matching a glob pattern.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Glob pattern, e.g. "src/**/*.ts"' },
          },
          required: ['pattern'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Write content to a file, creating or overwriting it.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Target file path' },
            content: { type: 'string', description: 'Full file contents to write' },
          },
          required: ['path', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'str_replace',
        description:
          'Perform exact string replacement in a file. Use this instead of write_file for targeted edits under ~50 lines — it is faster, cheaper, and less error-prone than rewriting entire files.',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Absolute or project-relative path to the target file' },
            old_str: { type: 'string', description: 'The exact text to replace (must match including whitespace and indentation)' },
            new_str: { type: 'string', description: 'The new text to substitute in place of old_str' },
          },
          required: ['file_path', 'old_str', 'new_str'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_range',
        description:
          'Read a specific line range from a file. Use this instead of read_file when you only need a portion of a large file. Lines are 1-indexed and inclusive.',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Absolute or project-relative path to the file' },
            start_line: { type: 'number', description: 'Starting line number (1-indexed, inclusive)' },
            end_line: { type: 'number', description: 'Ending line number (1-indexed, inclusive)' },
          },
          required: ['file_path', 'start_line', 'end_line'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'todo_write',
        description:
          'Create and manage a structured task list for your current coding session. Use this to track progress on complex multi-step tasks. Merge-patch semantics: todos with new IDs are added, existing IDs are updated, omit to remove.',
        parameters: {
          type: 'object',
          properties: {
            todos: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'Unique identifier for this todo item' },
                  content: { type: 'string', description: 'Description of the task to complete' },
                  status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'Current status of the todo item' },
                },
                required: ['id', 'content', 'status'],
              },
              description: 'List of todo items (merge-patch: new IDs added, existing IDs updated, omitted IDs removed)',
            },
          },
          required: ['todos'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'apply_patch',
        description: 'Apply a unified diff patch to a file.',
        parameters: {
          type: 'object',
          properties: {
            patch: { type: 'string', description: 'Unified diff content to apply' },
          },
          required: ['patch'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'run_command',
        description:
          'Execute a shell command and return its output. Set background=true for long-running jobs (builds, full test suites) so the agent loop is not blocked; then call await_command with the returned task_id. Background uses the same whitelist/cwd sandbox as foreground shell; argv is whitespace-split only (no quoted multi-arg syntax). Not available under Docker sandbox profiles or plan mode.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command to run' },
            cwd: {
              type: 'string',
              description: 'Working directory (must resolve within project root)',
            },
            background: {
              type: 'boolean',
              description:
                'When true, start the command in the background and return a task_id immediately. Jobs have a hard kill timeout (default 10 minutes). Use await_command to collect exit code and output.',
            },
          },
          required: ['command'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'await_command',
        description:
          'Wait for a background shell job started via run_command(background=true). Returns exit code, stdout, and stderr when complete, or timed_out=true if still running (await timeout does not kill the job; the job still has its own hard timeout).',
        parameters: {
          type: 'object',
          properties: {
            task_id: {
              type: 'string',
              description: 'Background task id returned by run_command when background=true',
            },
            timeout_seconds: {
              type: 'number',
              description: 'Max seconds to wait (default 120). Does not kill the job on timeout.',
            },
          },
          required: ['task_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'test_run',
        description: 'Run a test command with extended timeout (preferred for test suites).',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Test command to run' },
            cwd: { type: 'string', description: 'Working directory' },
            timeout_seconds: { type: 'number', description: 'Timeout in seconds' },
          },
          required: ['command'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'mcp_tool_search',
        description: 'Search available tools on a configured MCP server.',
        parameters: {
          type: 'object',
          properties: {
            server: { type: 'string', description: 'MCP server name' },
            query: { type: 'string', description: 'Optional search query' },
          },
          required: ['server'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'mcp_request',
        description: 'Call a tool on an MCP server. Query is tool name plus JSON arguments.',
        parameters: {
          type: 'object',
          properties: {
            server: { type: 'string', description: 'MCP server name' },
            query: { type: 'string', description: 'Tool invocation (name + args)' },
          },
          required: ['server', 'query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Search the web for information.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query string' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'web_fetch',
        description: 'Fetch and read the contents of a URL.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Full URL to fetch' },
          },
          required: ['url'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'sub_agent',
        description: 'Spawn a sub-agent for parallel investigation or mutation. Set mutation to true for write access. Optional model override for per-agent model selection.',
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'What the sub-agent should do' },
            instructions: { type: 'string', description: 'Optional additional instructions' },
            write_scope: {
              type: 'array',
              items: { type: 'string' },
              description: 'Paths the mutation sub-agent can write to',
            },
            mutation: {
              type: 'boolean',
              description: 'Set to true to give the sub-agent write access',
            },
            model: {
              type: 'string',
              description: 'Model backend key override (e.g. "deepseek-v4-pro", "scout", "deepseek-v4-flash"). When omitted, uses the cheapest enabled model.',
            },
            max_rounds: {
              type: 'number',
              description: 'Maximum conversation turns for this sub-agent. Read-only defaults to 4, mutation defaults to 8.',
            },
          },
          required: ['task'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'lsp',
        description:
          'Query a Language Server Protocol (LSP) server for code intelligence. Supports go-to-definition, find references, hover info, document/workspace symbols, go-to-implementation, and call hierarchy. Spawns LSP servers lazily per file type. Read-only — prefer this over grep/ast for symbol navigation when available.',
        parameters: {
          type: 'object',
          properties: {
            operation: {
              type: 'string',
              enum: [
                'goToDefinition',
                'findReferences',
                'hover',
                'documentSymbol',
                'workspaceSymbol',
                'goToImplementation',
                'prepareCallHierarchy',
                'incomingCalls',
                'outgoingCalls',
              ],
              description: 'The LSP operation to perform',
            },
            filePath: {
              type: 'string',
              description: 'Absolute or project-relative path to the file',
            },
            line: {
              type: 'number',
              description: 'Line number (1-based, required for position-based operations)',
            },
            character: {
              type: 'number',
              description: 'Character offset (1-based, required for position-based operations)',
            },
            query: {
              type: 'string',
              description: 'Search query (used by workspaceSymbol)',
            },
          },
          required: ['operation', 'filePath'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'finish',
        description: 'Signal that no more tools are needed and the model is ready to synthesize the answer.',
        parameters: {
          type: 'object',
          properties: {},
        },
      },
    },
  ];
}

/**
 * T2.3: Build a restricted tool set for stall / force-mutate interventions.
 *
 * When the agent is stuck in a read/shell loop, the harness removes
 * exploration tools from the schema for one turn. This makes "restrict_tools"
 * real enforcement, not just an advisory message.
 *
 * Modes:
 * - mutate_only (default): force a real patch — no shell thrash path.
 *   write_file, str_replace, apply_patch, todo_write, finish.
 * - act_or_verify: after a patch exists, also allow shell/test verification.
 *   + run_command, await_command, test_run.
 *
 * Disallowed in both: read_file, read_range, list_dir, grep, glob,
 * semantic_search, git_context, web_search, web_fetch, mcp_*, sub_agent.
 */
export type RestrictedToolMode = 'mutate_only' | 'act_or_verify';

export function buildRestrictedChatToolDefinitions(
  mode: RestrictedToolMode = 'mutate_only',
): ToolDefinition[] {
  const mutateOnly = [
    'write_file',
    'str_replace',
    'apply_patch',
    'todo_write',
    'finish',
  ] as const;
  const actOrVerify = [
    ...mutateOnly,
    'run_command',
    'await_command',
    'test_run',
  ] as const;
  const names = new Set<string>(mode === 'act_or_verify' ? actOrVerify : mutateOnly);
  return buildChatToolDefinitions().filter((def) => names.has(def.function.name));
}

// ─── MCP Helpers ─────────────────────────────────────────────────────────

export function isMcpChatAction(
  action: ChatToolAction,
): action is Extract<ChatToolAction, { type: 'mcp_request' } | { type: 'mcp_tool_search' }> {
  return action.type === 'mcp_request' || action.type === 'mcp_tool_search';
}

export function mapChatMcpActionToToolRequest(action: ChatToolAction): ToolCallRequest {
  if (action.type === 'mcp_tool_search') {
    return {
      tool: 'mcp_tool_search',
      server: action.server,
      ...(action.query !== undefined ? { query: action.query } : {}),
    };
  }
  if (action.type === 'mcp_request') {
    return { tool: 'mcp_request', server: action.server, query: action.query };
  }
  throw new Error(`Not an MCP action: ${(action as ChatToolAction).type}`);
}

/** Map chat-mode web actions to localTools `ToolCallRequest` shapes. */
export function mapChatWebActionToToolRequest(action: ChatToolAction): ToolCallRequest {
  if (action.type === 'web_search') {
    return { tool: 'web_search', query: action.query };
  }
  if (action.type === 'web_fetch') {
    return { tool: 'web_fetch', url: action.url };
  }
  throw new Error(`Not a web action: ${(action as ChatToolAction).type}`);
}

/** Map chat-mode LSP actions to localTools `ToolCallRequest` shapes. */
export function mapChatLspActionToToolRequest(
  action: Extract<ChatToolAction, { type: 'lsp' }>,
): ToolCallRequest {
  return {
    tool: 'lsp',
    operation: action.operation,
    filePath: action.filePath,
    ...(action.line !== undefined ? { line: action.line } : {}),
    ...(action.character !== undefined ? { character: action.character } : {}),
    ...(action.query !== undefined ? { query: action.query } : {}),
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────
// trimForPrompt is imported from services/liteProjectContext.js
