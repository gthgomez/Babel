import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { ChronicleFactRow, ChronicleStore } from './chronicleStore.js';

interface ChronicleJsonFact {
  project_root: string;
  fact_key: string;
  fact_value: string;
  last_verified: string;
}

interface ChronicleJsonFile {
  schemaVersion: 1;
  facts: ChronicleJsonFact[];
}

export class JsonChronicleStore implements ChronicleStore {
  constructor(private readonly jsonPath: string) {}

  storeFact(projectRoot: string, key: string, value: string): void {
    const file = this.readFile();
    const existing = file.facts.find(
      (fact) => fact.project_root === projectRoot && fact.fact_key === key,
    );
    const lastVerified = new Date().toISOString();

    if (existing) {
      existing.fact_value = value;
      existing.last_verified = lastVerified;
    } else {
      file.facts.push({
        project_root: projectRoot,
        fact_key: key,
        fact_value: value,
        last_verified: lastVerified,
      });
    }

    this.writeFile(file);
  }

  getFact(projectRoot: string, key: string): string | null {
    return this.readFile().facts.find(
      (fact) => fact.project_root === projectRoot && fact.fact_key === key,
    )?.fact_value ?? null;
  }

  listFacts(projectRoot: string): ChronicleFactRow[] {
    return this.readFile().facts
      .filter((fact) => fact.project_root === projectRoot)
      .map((fact) => ({
        fact_key: fact.fact_key,
        fact_value: fact.fact_value,
        last_verified: fact.last_verified,
      }));
  }

  close(): void {
    // File-backed store opens files per operation.
  }

  private readFile(): ChronicleJsonFile {
    if (!existsSync(this.jsonPath)) {
      return { schemaVersion: 1, facts: [] };
    }

    const parsed = JSON.parse(readFileSync(this.jsonPath, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Invalid Chronicle JSON file at ${this.jsonPath}`);
    }

    const candidate = parsed as Partial<ChronicleJsonFile>;
    if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.facts)) {
      throw new Error(`Unsupported Chronicle JSON file at ${this.jsonPath}`);
    }

    return {
      schemaVersion: 1,
      facts: candidate.facts.map((fact) => ({
        project_root: String((fact as Partial<ChronicleJsonFact>).project_root ?? ''),
        fact_key: String((fact as Partial<ChronicleJsonFact>).fact_key ?? ''),
        fact_value: String((fact as Partial<ChronicleJsonFact>).fact_value ?? ''),
        last_verified: String((fact as Partial<ChronicleJsonFact>).last_verified ?? ''),
      })).filter((fact) => fact.project_root.length > 0 && fact.fact_key.length > 0),
    };
  }

  private writeFile(file: ChronicleJsonFile): void {
    mkdirSync(path.dirname(this.jsonPath), { recursive: true });
    writeFileSync(this.jsonPath, `${JSON.stringify(file, null, 2)}\n`, 'utf-8');
  }
}
