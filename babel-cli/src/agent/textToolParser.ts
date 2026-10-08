/**
 * textToolParser.ts — Simplified text-based tool format for small local models.
 *
 * Small models (3-4B params) running locally via Ollama cannot produce the
 * complex JSON ChatTurnSchema required by the legacy path, and do not support
 * OpenAI native function calling. This module provides a third tool-call path
 * using a simple line-based format.
 *
 * Format:
 *   [TOOL:tool_name]
 *   key1: value1
 *   key2: value2
 *
 * Rules:
 * - [TOOL:name] starts a tool block, followed by key: value pairs
 * - Multi-line values are indented with 2+ spaces
 * - Plain text without [TOOL:] markers is treated as completion
 * - Parser never throws — always degrades to completion on failure
 */

import type { ChatToolAction, ChatTurn } from './chatToolDefinitions.js';
import { RecoveryPlanProposalSchema } from './codingLoop/recoveryPlan.js';

/** The 13 tools exposed to text-tool models. */
export const TEXT_TOOL_NAMES = new Set([
  'read_file', 'write_file', 'str_replace', 'grep', 'glob', 'run_command', 'finish',
  'think', 'ask', 'remember', 'recall', 'check', 'plan',
]);

/** Canonical fields accepted by the text parser's action builders. */
export const TEXT_TOOL_ARGUMENT_SHAPES: Readonly<Record<string, string>> = {
  read_file: 'path',
  write_file: 'path, content (multiline), repair_plan (optional single-line JSON)',
  str_replace: 'file_path, old_str (multiline), new_str (multiline), repair_plan (optional single-line JSON)',
  grep: 'pattern, path (optional)',
  glob: 'pattern',
  run_command: 'command',
  finish: '(no fields; compatibility only)',
  think: 'thought',
  ask: 'question',
  remember: 'key, value (multiline)',
  recall: 'key',
  check: 'file_path',
  plan: 'steps (multiline)',
};

/** Behavioral guidance shared by native, legacy JSON, and text-tool turns. */
export const CHAT_BEHAVIORAL_CONTRACT = [
  '## How Babel works',
  '- Inspect the request and relevant context before acting.',
  '- Answer directly when the available evidence is enough; make edits only when the request needs a change.',
  '- For changes, make focused edits, verify with relevant evidence when available, and report results honestly.',
  '- Only fresh, executed passing verifier evidence for the current revision counts as verification; simulated, stale, failed, or missing results do not.',
  '- Follow repository instructions and granted scope; tool availability does not grant authorization.',
].join('\n');

export function buildTextToolProtocolSection(availableToolNames?: readonly string[]): string {
  const available = availableToolNames === undefined
    ? [...TEXT_TOOL_NAMES]
    : [...TEXT_TOOL_NAMES].filter((name) => availableToolNames.includes(name));
  const sections = [
    '## How to use tools',
    '',
    'Use a tool when investigation or a requested change needs it. Only use listed text tools. Write one tool call as:',
    '',
    '[TOOL:tool_name]',
    'param1: value1',
    'param2: value2',
    '',
    'Fields accepted by each available text tool:',
    ...available.map((name) => `- ${name}: ${TEXT_TOOL_ARGUMENT_SHAPES[name]}`),
  ];
  const multiLineNames = ['write_file', 'str_replace', 'remember', 'plan', 'think'];
  if (available.some((name) => multiLineNames.includes(name))) {
    sections.push(
      '',
      'For a multi-line field, put its value on the next line and indent every value line by two spaces; keep additional indentation after those two spaces. Indent an empty line with two spaces to preserve a blank line. Other fields use `name: value` on one line.',
      'Values are literal text; do not JSON-escape them.',
    );
  } else {
    sections.push('', 'Values are literal text; do not JSON-escape them.');
  }
  if (available.includes('run_command')) {
    sections.push(
      'For `run_command`, quote arguments containing spaces (for example `command: node "scripts/test runner.mjs" --name "happy path"`); quotes group arguments and are removed by the parser. Arguments are parsed without a shell, so shell operators are not supported.',
    );
  }

  const exampleTool = available.includes('write_file')
    ? ['[TOOL:write_file]', 'path: src/message.txt', 'content:', '  Hello,', '  Babel!']
    : available.includes('read_file')
      ? ['[TOOL:read_file]', 'path: src/message.txt']
      : available.includes('grep')
        ? ['[TOOL:grep]', 'pattern: TODO', 'path: src/']
        : available.includes('glob')
          ? ['[TOOL:glob]', 'pattern: **/*.ts']
          : available.includes('run_command')
            ? ['[TOOL:run_command]', 'command: node "scripts/test runner.mjs"']
            : null;
  if (exampleTool) sections.push('', 'Example:', ...exampleTool);

  sections.push('', 'Plain text is a valid final answer.');
  if (available.includes('finish')) {
    sections.push('`finish` remains accepted after tool use for compatibility.');
  }
  return sections.join('\n');
}

/** Compatibility export: complete manual for callers that do not scope tools. */
export const TEXT_TOOL_PROTOCOL_SECTION = buildTextToolProtocolSection();

/** Compatibility export for callers that need the complete text-mode prompt section. */
export const TEXT_TOOL_PROMPT_SECTION = [
  CHAT_BEHAVIORAL_CONTRACT,
  TEXT_TOOL_PROTOCOL_SECTION,
].join('\n\n');

// ─── Parser ────────────────────────────────────────────────────────────────────

export function parseTextToolTurn(rawText: string): ChatTurn {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return {
      type: 'completion',
      answer: 'I could not produce a valid response. Please try rephrasing your request.',
    } as ChatTurn;
  }

  const actions = extractToolActions(trimmed);
  if (actions.length > 0) {
    return { type: 'tool_calls', actions } as ChatTurn;
  }

  const answerMatch = trimmed.match(/\[ANSWER\]\s*\n?([\s\S]*)$/i);
  const answer = answerMatch ? answerMatch[1]!.trim() : trimmed;
  return {
    type: 'completion',
    answer: answer || 'I could not produce a valid response.',
  } as ChatTurn;
}

// ─── Tool extraction ──────────────────────────────────────────────────────────

function extractToolActions(text: string): ChatToolAction[] {
  const actions: ChatToolAction[] = [];
  const blocks = text.split(/\[TOOL:([a-z_]+)\]/i);

  for (let i = 1; i < blocks.length; i += 2) {
    const toolName = blocks[i]?.toLowerCase().trim();
    const body = blocks[i + 1] ?? '';
    if (!toolName || !TEXT_TOOL_NAMES.has(toolName)) continue;

    const params = parseKeyValuePairs(body);
    try {
      const action = buildAction(toolName, params);
      if (action) actions.push(action);
    } catch {
      // Skip malformed actions
    }
  }
  return actions;
}

// ─── Key-value parsing ────────────────────────────────────────────────────────

function parseKeyValuePairs(body: string): Record<string, string> {
  const params: Record<string, string> = {};
  const lines = body.split('\n');
  let currentKey: string | null = null;
  let currentValue: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (currentKey && (rawLine.startsWith('  ') || rawLine.startsWith('\t'))) {
      currentValue.push(rawLine.startsWith('\t') ? line.slice(1) : line.slice(2));
      continue;
    }
    if (currentKey) {
      params[currentKey] = currentValue.join('\n').trim();
      currentKey = null;
      currentValue = [];
    }
    const match = line.match(/^([a-z_]+):\s*(.*)$/i);
    if (match) {
      currentKey = match[1]!.toLowerCase().trim();
      const inlineValue = match[2]!.trim();
      if (inlineValue) currentValue.push(inlineValue);
    }
  }
  if (currentKey) {
    params[currentKey] = currentValue.join('\n').trim();
  }
  return params;
}

// ─── Action builders ──────────────────────────────────────────────────────────

function buildAction(toolName: string, params: Record<string, string>): ChatToolAction | null {
  const repairPlan = (() => {
    if (!params['repair_plan']) return undefined;
    try {
      const parsed = RecoveryPlanProposalSchema.safeParse(JSON.parse(params['repair_plan']));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  })();
  switch (toolName) {
    case 'read_file': {
      const path = params['path'];
      if (!path) return null;
      return { type: 'read_file', path } as ChatToolAction;
    }
    case 'write_file': {
      const path = params['path'];
      const content = params['content'];
      if (!path || content === undefined) return null;
      return { type: 'write_file', path, content, ...(repairPlan ? { repair_plan: repairPlan } : {}) } as ChatToolAction;
    }
    case 'str_replace': {
      const fp = params['file_path'];
      const old = params['old_str'];
      const nw = params['new_str'] ?? '';
      if (!fp || !old) return null;
      return { type: 'str_replace', file_path: fp, old_str: old, new_str: nw, ...(repairPlan ? { repair_plan: repairPlan } : {}) } as ChatToolAction;
    }
    case 'grep': {
      const pattern = params['pattern'];
      if (!pattern) return null;
      const path = params['path'];
      return (path ? { type: 'grep', pattern, path } : { type: 'grep', pattern }) as ChatToolAction;
    }
    case 'glob': {
      const pattern = params['pattern'];
      if (!pattern) return null;
      return { type: 'glob', pattern } as ChatToolAction;
    }
    case 'run_command': {
      const command = params['command'];
      if (!command) return null;
      return { type: 'run_command', command } as ChatToolAction;
    }
    case 'finish':
      return { type: 'finish' } as ChatToolAction;
    case 'think': {
      // Lenient: bare [TOOL:think] without params is valid for small models
      return { type: 'think', thought: params['thought'] || '(thinking)' } as any;
    }
    case 'ask': {
      return { type: 'ask', question: params['question'] || 'What should I do next?' } as any;
    }
    case 'remember': {
      const key = params['key'];
      const value = params['value'];
      if (!key || value === undefined) return null;
      return { type: 'remember', key, value } as any;
    }
    case 'recall': {
      const key = params['key'];
      if (!key) return null;
      return { type: 'recall', key } as any;
    }
    case 'check': {
      const fp = params['file_path'];
      if (!fp) return null;
      return { type: 'check', file_path: fp } as any;
    }
    case 'plan': {
      const steps = params['steps'];
      if (!steps) return null;
      return { type: 'plan', steps } as any;
    }
    default:
      return null;
  }
}
