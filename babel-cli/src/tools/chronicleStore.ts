export const BABEL_FACTS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS babel_facts (
    id            INTEGER  PRIMARY KEY,
    project_root  TEXT     NOT NULL,
    fact_key      TEXT     NOT NULL,
    fact_value    TEXT,
    last_verified DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(project_root, fact_key)
  )
`;

export const CHRONICLE_BACKENDS = ['auto', 'sqlite', 'json'] as const;
export type ChronicleBackend = (typeof CHRONICLE_BACKENDS)[number];

export interface ChronicleFactRow {
  fact_key: string;
  fact_value: string | null;
  last_verified: string | null;
}

export interface ChronicleStore {
  storeFact(projectRoot: string, key: string, value: string): void;
  getFact(projectRoot: string, key: string): string | null;
  listFacts(projectRoot: string): ChronicleFactRow[];
  close(): void;
}

export function parseChronicleBackend(raw: string | undefined): ChronicleBackend {
  const normalized = (raw ?? 'auto').trim().toLowerCase();
  if (CHRONICLE_BACKENDS.includes(normalized as ChronicleBackend)) {
    return normalized as ChronicleBackend;
  }

  throw new Error(
    `Invalid BABEL_CHRONICLE_BACKEND "${raw}". Valid values: ${CHRONICLE_BACKENDS.join(', ')}`,
  );
}
