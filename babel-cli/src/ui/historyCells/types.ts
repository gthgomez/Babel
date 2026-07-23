/**
 * HistoryCell persistence schema — co-designed with Phase D3 thread-store.
 *
 * Records are JSON-serializable rows suitable for JSONL append + SQLite index.
 * The cell schema is the persistence schema; no adapter layer between display
 * and storage.
 */

export const HISTORY_CELL_SCHEMA_VERSION = 1 as const;

export type HistoryCellKind =
  | 'user_message'
  | 'assistant_message'
  | 'tool_call'
  | 'thinking'
  | 'separator'
  | 'session_header'
  | 'plain'
  | 'composite';

/** Active cells mutate in place while streaming; committed cells are immutable. */
export type HistoryCellLifecycle = 'active' | 'committed';

export interface UserMessagePayload {
  message: string;
}

export interface AssistantMessagePayload {
  message: string;
}

export type ToolCallStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface ToolCallPayload {
  tool: string;
  target: string;
  status: ToolCallStatus;
  detail?: string;
}

export interface ThinkingPayload {
  text?: string;
}

export type SeparatorStyle = 'turn' | 'unseen' | 'section';

export interface SeparatorPayload {
  style: SeparatorStyle;
  label?: string;
}

export interface SessionHeaderPayload {
  title: string;
  subtitle?: string;
  mode?: string;
  model?: string;
}

export interface PlainPayload {
  lines: string[];
}

export interface CompositePayload {
  child_ids: string[];
}

export type HistoryCellPayload =
  | UserMessagePayload
  | AssistantMessagePayload
  | ToolCallPayload
  | ThinkingPayload
  | SeparatorPayload
  | SessionHeaderPayload
  | PlainPayload
  | CompositePayload;

export interface HistoryCellRecord {
  schema_version: typeof HISTORY_CELL_SCHEMA_VERSION;
  cell_id: string;
  thread_id?: string;
  turn_id?: number;
  ts: string;
  kind: HistoryCellKind;
  lifecycle: HistoryCellLifecycle;
  revision: number;
  payload: HistoryCellPayload;
}

export interface HistoryCellRecordEnvelope {
  type: 'history_cell';
  record: HistoryCellRecord;
}