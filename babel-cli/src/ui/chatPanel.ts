import {
  accentBright,
  getTerminalWidth,
  muted,
  padRight,
  primary,
  visibleLength,
} from './theme.js';
import { renderMarkdown } from './highlight.js';

export interface ChatTurnRecord {
  role: 'user' | 'assistant';
  input?: string;
  answer?: string;
  summary?: string;
  turn_id?: number;
  ts?: string;
}

const DEFAULT_MAX_TURNS = 24;
const DEFAULT_WRAP_WIDTH = 96;

function wrapChatLine(text: string, indent: string, width: number): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return [];
  }
  const lines: string[] = [];
  let current = '';
  for (const word of normalized.split(' ')) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (visibleLength(candidate) > width) {
      if (current.length > 0) {
        lines.push(`${indent}${current}`);
      }
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) {
    lines.push(`${indent}${current}`);
  }
  return lines;
}

function formatTurnBody(turn: ChatTurnRecord): string {
  if (turn.role === 'user') {
    return turn.input ?? turn.summary ?? '';
  }
  return turn.answer ?? turn.summary ?? '';
}

export function renderChatTurn(turn: ChatTurnRecord, options: { wrapWidth?: number } = {}): string {
  const label = turn.role === 'user' ? 'You' : 'Babel';
  const rawBody = formatTurnBody(turn);
  const body = renderMarkdown(rawBody);
  const width = Math.max(
    40,
    Math.min(options.wrapWidth ?? DEFAULT_WRAP_WIDTH, getTerminalWidth() - 8),
  );
  const header = `  ${accentBright(padRight(label, 7))}`;
  const lines = wrapChatLine(body, '         ', width);
  if (lines.length === 0) {
    return `${header}${muted('(empty turn)')}`;
  }
  return [header + lines[0]!.slice(7), ...lines.slice(1)].join('\n');
}

export function renderChatTranscript(
  turns: ChatTurnRecord[],
  options: {
    title?: string;
    maxTurns?: number;
    transcriptPath?: string;
    wrapWidth?: number;
  } = {},
): string {
  if (turns.length === 0) {
    return muted('\n  No chat turns recorded yet.\n');
  }
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const visible = turns.slice(-maxTurns);
  const blocks = [
    primary(`\n  ${options.title ?? 'Chat Transcript'}:`),
    ...visible.map((turn) =>
      renderChatTurn(turn, options.wrapWidth !== undefined ? { wrapWidth: options.wrapWidth } : {}),
    ),
  ];
  if (options.transcriptPath) {
    blocks.push(muted(`\n  Transcript: ${options.transcriptPath}`));
  }
  blocks.push('');
  return blocks.join('\n');
}
