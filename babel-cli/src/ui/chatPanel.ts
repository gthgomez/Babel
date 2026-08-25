import {
  accentBright,
  getTerminalWidth,
  muted,
  padRight,
  primary,
  visibleLength,
} from './theme.js';
import { renderMarkdown } from './highlight.js';
import { wrapPrefixedBlock } from './textLayout.js';

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
  const firstPrefix = `  ${accentBright(padRight(label, 7))}`;
  const continuationPrefix = '         ';

  const lines = wrapPrefixedBlock(body, {
    firstPrefix,
    continuationPrefix,
    width,
    longTokenPolicy: 'hard-wrap',
  });

  if (lines.length === 0 || (lines.length === 1 && lines[0] === firstPrefix)) {
    return `${firstPrefix}${muted('(empty turn)')}`;
  }
  return lines.join('\n');
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
