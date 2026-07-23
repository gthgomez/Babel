import { randomUUID } from 'node:crypto';

import { renderMarkdown } from '../highlight.js';
import {
  accentBright,
  dim,
  error,
  muted,
  padRight,
  primary,
  success,
  wrapText,
} from '../theme.js';
import type { HistoryCell } from './historyCell.js';
import { conversationalToolLabel } from '../toolDisplay.js';
import { renderUnseenDividerPill } from '../unseenDivider.js';
import type { HistoryRenderMode } from './layout.js';
import { BaseHistoryCell } from './historyCell.js';
import {
  HISTORY_CELL_SCHEMA_VERSION,
  type AssistantMessagePayload,
  type CompositePayload,
  type HistoryCellKind,
  type HistoryCellLifecycle,
  type HistoryCellPayload,
  type HistoryCellRecord,
  type PlainPayload,
  type SeparatorPayload,
  type SessionHeaderPayload,
  type ThinkingPayload,
  type ToolCallPayload,
  type UserMessagePayload,
} from './types.js';

const USER_PREFIX_COLS = 7;
const BODY_INDENT = '         ';

export interface CreateHistoryCellOptions {
  cell_id?: string;
  thread_id?: string;
  turn_id?: number;
  ts?: string;
  lifecycle?: HistoryCellLifecycle;
  revision?: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function createRecord(
  kind: HistoryCellKind,
  payload: HistoryCellPayload,
  options: CreateHistoryCellOptions = {},
): HistoryCellRecord {
  const record: HistoryCellRecord = {
    schema_version: HISTORY_CELL_SCHEMA_VERSION,
    cell_id: options.cell_id ?? randomUUID(),
    ts: options.ts ?? nowIso(),
    kind,
    lifecycle: options.lifecycle ?? 'committed',
    revision: options.revision ?? 0,
    payload,
  };
  if (options.thread_id !== undefined) record.thread_id = options.thread_id;
  if (options.turn_id !== undefined) record.turn_id = options.turn_id;
  return record;
}

function wrapPrefixedBody(
  body: string,
  label: string,
  width: number,
  mode: HistoryRenderMode,
): string[] {
  if (width <= 0) return [];
  const contentWidth = Math.max(1, width - USER_PREFIX_COLS);
  const header = `  ${accentBright(padRight(label, USER_PREFIX_COLS))}`;
  const renderedBody = mode === 'rich' ? renderMarkdown(body) : body;
  const paragraphs = renderedBody.split('\n');
  const lines: string[] = [];

  for (let p = 0; p < paragraphs.length; p++) {
    const paragraph = paragraphs[p] ?? '';
    const wrapped = wrapText(paragraph, contentWidth);
    for (let i = 0; i < wrapped.length; i++) {
      if (p === 0 && i === 0) {
        const first = wrapped[0] ?? '';
        lines.push(header + first);
      } else {
        lines.push(BODY_INDENT + (wrapped[i] ?? ''));
      }
    }
    if (wrapped.length === 0 && p === 0) {
      lines.push(`${header}${muted('(empty)')}`);
    }
  }

  if (lines.length === 0) {
    lines.push(`${header}${muted('(empty)')}`);
  }
  return lines;
}

export class UserMessageCell extends BaseHistoryCell {
  readonly kind = 'user_message' as const;
  readonly record: HistoryCellRecord;

  constructor(record: HistoryCellRecord) {
    super();
    if (record.kind !== 'user_message') {
      throw new Error(`UserMessageCell requires user_message kind, got ${record.kind}`);
    }
    this.record = record;
  }

  protected displayLinesForMode(width: number, mode: HistoryRenderMode): string[] {
    const payload = this.record.payload as UserMessagePayload;
    return wrapPrefixedBody(payload.message, 'You', width, mode);
  }
}

export class AssistantMessageCell extends BaseHistoryCell {
  readonly kind = 'assistant_message' as const;
  readonly record: HistoryCellRecord;

  constructor(record: HistoryCellRecord) {
    super();
    if (record.kind !== 'assistant_message') {
      throw new Error(`AssistantMessageCell requires assistant_message kind, got ${record.kind}`);
    }
    this.record = record;
  }

  protected displayLinesForMode(width: number, mode: HistoryRenderMode): string[] {
    const payload = this.record.payload as AssistantMessagePayload;
    return wrapPrefixedBody(payload.message, 'Babel', width, mode);
  }
}

export class ToolCallCell extends BaseHistoryCell {
  readonly kind = 'tool_call' as const;
  readonly record: HistoryCellRecord;

  constructor(record: HistoryCellRecord) {
    super();
    if (record.kind !== 'tool_call') {
      throw new Error(`ToolCallCell requires tool_call kind, got ${record.kind}`);
    }
    this.record = record;
  }

  protected displayLinesForMode(width: number, mode: HistoryRenderMode): string[] {
    if (width <= 0) return [];
    const payload = this.record.payload as ToolCallPayload;
    const label =
      mode === 'raw'
        ? `${payload.tool} ${payload.target}`
        : conversationalToolLabel(payload.tool, payload.target);

    if (payload.status === 'running') {
      return [`  ${dim('…')} ${label}`];
    }

    const detailStr = payload.detail ? ` ${dim(`(${payload.detail})`)}` : '';
    if (payload.status === 'failed' || payload.status === 'cancelled') {
      return [`  ${error('✗')} ${label}${detailStr}`];
    }
    return [`  ${success('✓')} ${label}${detailStr}`];
  }

  override transcriptLines(width: number): string[] {
    const payload = this.record.payload as ToolCallPayload;
    const command = `${payload.tool} ${payload.target}`.trim();
    const status =
      payload.status === 'completed'
        ? 'ok'
        : payload.status === 'failed'
          ? 'failed'
          : payload.status;
    const detail = payload.detail ? ` (${payload.detail})` : '';
    return wrapText(`$ ${command} → ${status}${detail}`, Math.max(1, width));
  }
}

export class ThinkingCell extends BaseHistoryCell {
  readonly kind = 'thinking' as const;
  readonly record: HistoryCellRecord;

  constructor(record: HistoryCellRecord) {
    super();
    if (record.kind !== 'thinking') {
      throw new Error(`ThinkingCell requires thinking kind, got ${record.kind}`);
    }
    this.record = record;
  }

  protected displayLinesForMode(width: number, mode: HistoryRenderMode): string[] {
    if (width <= 0) return [];
    const payload = this.record.payload as ThinkingPayload;
    const text = payload.text?.trim() || 'Thinking…';
    if (mode === 'raw') {
      return wrapText(text, width);
    }
    return [`  ${dim(text)}`];
  }

  override cacheKey(): string {
    return `${super.cacheKey()}:${(this.record.payload as ThinkingPayload).text ?? ''}`;
  }
}

export class SeparatorCell extends BaseHistoryCell {
  readonly kind = 'separator' as const;
  readonly record: HistoryCellRecord;

  constructor(record: HistoryCellRecord) {
    super();
    if (record.kind !== 'separator') {
      throw new Error(`SeparatorCell requires separator kind, got ${record.kind}`);
    }
    this.record = record;
  }

  protected displayLinesForMode(width: number, mode: HistoryRenderMode): string[] {
    if (width <= 0) return [];
    const payload = this.record.payload as SeparatorPayload;
    if (payload.style === 'unseen') {
      const count = Number.parseInt(payload.label ?? '0', 10) || 0;
      const pill = renderUnseenDividerPill(count);
      return pill ? [pill] : [];
    }
    const label = payload.label ?? '';
    const ruleWidth = Math.max(8, Math.min(width - 4, 40));
    const rule = '─'.repeat(ruleWidth);
    if (mode === 'raw') {
      return label ? [label, rule] : [rule];
    }
    return label
      ? [muted(`  ${label}`), muted(`  ${rule}`)]
      : [muted(`  ${rule}`)];
  }
}

export class SessionHeaderCell extends BaseHistoryCell {
  readonly kind = 'session_header' as const;
  readonly record: HistoryCellRecord;

  constructor(record: HistoryCellRecord) {
    super();
    if (record.kind !== 'session_header') {
      throw new Error(`SessionHeaderCell requires session_header kind, got ${record.kind}`);
    }
    this.record = record;
  }

  protected displayLinesForMode(width: number, mode: HistoryRenderMode): string[] {
    if (width <= 0) return [];
    const payload = this.record.payload as SessionHeaderPayload;
    const lines: string[] = [];
    const title = mode === 'raw' ? payload.title : primary(payload.title);
    lines.push(title);
    const meta: string[] = [];
    if (payload.mode) meta.push(`mode=${payload.mode}`);
    if (payload.model) meta.push(`model=${payload.model}`);
    if (payload.subtitle) meta.push(payload.subtitle);
    if (meta.length > 0) {
      lines.push(mode === 'raw' ? meta.join(' · ') : muted(`  ${meta.join(' · ')}`));
    }
    return lines;
  }
}

export class PlainHistoryCell extends BaseHistoryCell {
  readonly kind = 'plain' as const;
  readonly record: HistoryCellRecord;

  constructor(record: HistoryCellRecord) {
    super();
    if (record.kind !== 'plain') {
      throw new Error(`PlainHistoryCell requires plain kind, got ${record.kind}`);
    }
    this.record = record;
  }

  protected displayLinesForMode(width: number, mode: HistoryRenderMode): string[] {
    const payload = this.record.payload as PlainPayload;
    if (width <= 0) return [];
    const out: string[] = [];
    for (const line of payload.lines) {
      out.push(...wrapText(line, width));
    }
    return out;
  }
}

export class CompositeHistoryCell extends BaseHistoryCell {
  readonly kind = 'composite' as const;
  readonly record: HistoryCellRecord;
  readonly parts: BaseHistoryCell[];

  constructor(record: HistoryCellRecord, parts: BaseHistoryCell[]) {
    super();
    if (record.kind !== 'composite') {
      throw new Error(`CompositeHistoryCell requires composite kind, got ${record.kind}`);
    }
    this.record = record;
    this.parts = parts;
  }

  protected displayLinesForMode(width: number, mode: HistoryRenderMode): string[] {
    const out: string[] = [];
    let first = true;
    for (const part of this.parts) {
      const lines = mode === 'raw' ? part.rawLines() : part.displayLines(width);
      if (lines.length === 0) continue;
      if (!first) out.push('');
      out.push(...lines);
      first = false;
    }
    return out;
  }

  override rawLines(): string[] {
    const out: string[] = [];
    let first = true;
    for (const part of this.parts) {
      const lines = part.rawLines();
      if (lines.length === 0) continue;
      if (!first) out.push('');
      out.push(...lines);
      first = false;
    }
    return out;
  }

  override transcriptLines(width: number): string[] {
    const out: string[] = [];
    let first = true;
    for (const part of this.parts) {
      const lines = part.transcriptLines(width);
      if (lines.length === 0) continue;
      if (!first) out.push('');
      out.push(...lines);
      first = false;
    }
    return out;
  }
}

export function createUserMessageCell(
  message: string,
  options: CreateHistoryCellOptions = {},
): UserMessageCell {
  return new UserMessageCell(
    createRecord('user_message', { message }, options),
  );
}

export function createAssistantMessageCell(
  message: string,
  options: CreateHistoryCellOptions = {},
): AssistantMessageCell {
  return new AssistantMessageCell(
    createRecord('assistant_message', { message }, options),
  );
}

export function createToolCallCell(
  tool: string,
  target: string,
  status: ToolCallPayload['status'],
  options: CreateHistoryCellOptions & { detail?: string } = {},
): ToolCallCell {
  const { detail, ...recordOptions } = options;
  const payload: ToolCallPayload = { tool, target, status };
  if (detail !== undefined) payload.detail = detail;
  return new ToolCallCell(createRecord('tool_call', payload, recordOptions));
}

export function createThinkingCell(
  text?: string,
  options: CreateHistoryCellOptions = {},
): ThinkingCell {
  const payload: ThinkingPayload = {};
  if (text !== undefined) payload.text = text;
  return new ThinkingCell(createRecord('thinking', payload, options));
}

export function createSeparatorCell(
  style: SeparatorPayload['style'],
  options: CreateHistoryCellOptions & { label?: string } = {},
): SeparatorCell {
  const { label, ...recordOptions } = options;
  const payload: SeparatorPayload = { style };
  if (label !== undefined) payload.label = label;
  return new SeparatorCell(createRecord('separator', payload, recordOptions));
}

export function createSessionHeaderCell(
  title: string,
  options: CreateHistoryCellOptions & {
    subtitle?: string;
    mode?: string;
    model?: string;
  } = {},
): SessionHeaderCell {
  const { subtitle, mode, model, ...recordOptions } = options;
  const payload: SessionHeaderPayload = { title };
  if (subtitle !== undefined) payload.subtitle = subtitle;
  if (mode !== undefined) payload.mode = mode;
  if (model !== undefined) payload.model = model;
  return new SessionHeaderCell(createRecord('session_header', payload, recordOptions));
}

export function createPlainCell(
  lines: string[],
  options: CreateHistoryCellOptions = {},
): PlainHistoryCell {
  return new PlainHistoryCell(createRecord('plain', { lines }, options));
}

export function createCompositeCell(
  parts: BaseHistoryCell[],
  options: CreateHistoryCellOptions = {},
): CompositeHistoryCell {
  const payload: CompositePayload = {
    child_ids: parts.map((part) => part.record.cell_id),
  };
  return new CompositeHistoryCell(createRecord('composite', payload, options), parts);
}

export function historyCellFromRecord(
  record: HistoryCellRecord,
  childCells: HistoryCellRecord[] = [],
): BaseHistoryCell {
  switch (record.kind) {
    case 'user_message':
      return new UserMessageCell(record);
    case 'assistant_message':
      return new AssistantMessageCell(record);
    case 'tool_call':
      return new ToolCallCell(record);
    case 'thinking':
      return new ThinkingCell(record);
    case 'separator':
      return new SeparatorCell(record);
    case 'session_header':
      return new SessionHeaderCell(record);
    case 'plain':
      return new PlainHistoryCell(record);
    case 'composite': {
      const byId = new Map(childCells.map((child) => [child.cell_id, child]));
      const payload = record.payload as CompositePayload;
      const parts = payload.child_ids.map((id) => {
        const child = byId.get(id);
        if (!child) {
          throw new Error(`Composite cell ${record.cell_id} missing child ${id}`);
        }
        return historyCellFromRecord(child);
      });
      return new CompositeHistoryCell(record, parts);
    }
    default: {
      const unknown = (record as HistoryCellRecord).kind;
      throw new Error(`Unknown history cell kind: ${unknown}`);
    }
  }
}

/** Round-trip check used by thread-store writers (D3). */
export function serializeHistoryCell(cell: BaseHistoryCell): HistoryCellRecord {
  return structuredClone(cell.toRecord());
}

export function renderHistoryCell(cell: HistoryCell, width: number): string {
  return cell.displayLines(width).join('\n');
}