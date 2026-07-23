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

/** The 13 tools exposed to text-tool models. */
export const TEXT_TOOL_NAMES = new Set([
  'read_file', 'write_file', 'str_replace', 'grep', 'glob', 'run_command', 'finish',
  'think', 'ask', 'remember', 'recall', 'check', 'plan',
]);

export const TEXT_TOOL_PROMPT_SECTION = [
  '',
  '## How to use tools',
  '',
  'You have access to tools for reading and modifying the codebase.',
  'To use a tool, write EXACTLY:',
  '',
  '[TOOL:tool_name]',
  'param1: value1',
  'param2: value2',
  '',
  'For multi-line values, indent continuation lines with 2 spaces.',
  '',
  'Available tools:',
  '- read_file: path (required) — read a file',
  '- write_file: path (required), content (required) — create/overwrite file',
  '- str_replace: file_path (required), old_str (required), new_str (required)',
  '- grep: pattern (required), path (optional)',
  '- glob: pattern (required) — find files',
  '- run_command: command (required)',
  '- finish: no parameters — done',
  '- think: thought (optional) — reason internally',
  '- ask: question (optional) — ask user for clarification',
  '- remember: key (required), value (required) — store a fact',
  '- recall: key (required) — retrieve a stored fact',
  '- check: file_path (required) — quick syntax check',
  '- plan: steps (required) — outline task steps',
  '',
  'Always use tools to investigate before answering.',
].join('\n');

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
    if (currentKey && (line.startsWith('  ') || line.startsWith('\t'))) {
      currentValue.push(line.startsWith('\t') ? line.slice(1) : line.slice(2));
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
      return { type: 'write_file', path, content } as ChatToolAction;
    }
    case 'str_replace': {
      const fp = params['file_path'];
      const old = params['old_str'];
      const nw = params['new_str'] ?? '';
      if (!fp || !old) return null;
      return { type: 'str_replace', file_path: fp, old_str: old, new_str: nw } as ChatToolAction;
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
