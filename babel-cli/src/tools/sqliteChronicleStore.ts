import { DatabaseSync } from 'node:sqlite';

import {
  BABEL_FACTS_SCHEMA_SQL,
  type ChronicleFactRow,
  type ChronicleStore,
} from './chronicleStore.js';

export class SqliteChronicleStore implements ChronicleStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(BABEL_FACTS_SCHEMA_SQL);
  }

  storeFact(projectRoot: string, key: string, value: string): void {
    this.db
      .prepare(
        `
        INSERT OR REPLACE INTO babel_facts (project_root, fact_key, fact_value, last_verified)
        VALUES (?, ?, ?, datetime('now'))
      `,
      )
      .run(projectRoot, key, value);
  }

  getFact(projectRoot: string, key: string): string | null {
    const row = this.db
      .prepare(
        `
        SELECT fact_value
          FROM babel_facts
         WHERE fact_key = ? AND project_root = ?
      `,
      )
      .get(key, projectRoot) as { fact_value: string | null } | undefined;

    return row?.fact_value ?? null;
  }

  listFacts(projectRoot: string): ChronicleFactRow[] {
    const rows = this.db
      .prepare(
        `
        SELECT fact_key, fact_value, last_verified
          FROM babel_facts
         WHERE project_root = ?
      `,
      )
      .all(projectRoot) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      fact_key: String(row['fact_key'] ?? ''),
      fact_value: row['fact_value'] === null ? null : String(row['fact_value'] ?? ''),
      last_verified: row['last_verified'] === null ? null : String(row['last_verified'] ?? ''),
    }));
  }

  close(): void {
    this.db.close();
  }
}
