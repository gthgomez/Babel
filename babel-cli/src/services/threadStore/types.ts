export interface ThreadMeta {
  thread_id: string;
  created_at: number;
  updated_at: number;
  turn_count: number;
  cell_count: number;
  project_root: string | null;
  preview: string | null;
  resume_line_offset: number;
}

export interface TurnBounds {
  turn_id: number;
  first_cell_id: string;
  last_cell_id: string;
  first_line_offset: number;
  last_line_offset: number;
  cell_count: number;
}

export interface ListThreadsOptions {
  limit?: number;
}