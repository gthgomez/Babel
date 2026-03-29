#!/usr/bin/env tsx
/**
 * init_chronicle.ts — Babel Chronicle Schema Initializer
 *
 * Creates (or verifies) the `babel_facts` table in the Chronicle SQLite
 * database used by the Babel Multi-Agent OS persistent memory layer.
 *
 * Uses the Node.js built-in `node:sqlite` module (available since Node 22.5,
 * stable in Node 23+, fully supported in Node 24).  No native addon required.
 *
 * Run once per environment:
 *   npx tsx scripts/init_chronicle.ts
 *
 * Database file:  <babel-cli root>/chronicle.sqlite
 *
 * Table: babel_facts
 *   id            INTEGER PRIMARY KEY
 *   project_root  TEXT NOT NULL          — Absolute path to the target project
 *   fact_key      TEXT NOT NULL          — Stable kebab-case identifier
 *   fact_value    TEXT                   — Stored value (string or JSON string)
 *   last_verified DATETIME               — Auto-set on each INSERT OR REPLACE
 *   UNIQUE(project_root, fact_key)       — Prevents duplicate keys per project
 */

import { DatabaseSync } from 'node:sqlite';
import path              from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the Chronicle SQLite database file. */
export const CHRONICLE_DB_PATH = path.join(__dirname, '..', 'chronicle.sqlite');

// ─── Open database (creates file if absent) ───────────────────────────────────

const db = new DatabaseSync(CHRONICLE_DB_PATH);

// ─── Create table ─────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS babel_facts (
    id            INTEGER  PRIMARY KEY,
    project_root  TEXT     NOT NULL,
    fact_key      TEXT     NOT NULL,
    fact_value    TEXT,
    last_verified DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(project_root, fact_key)
  )
`);

db.close();

// ─── Confirmation ─────────────────────────────────────────────────────────────

console.log('[Chronicle] babel_facts table initialized.');
console.log('[Chronicle] Database path:', CHRONICLE_DB_PATH);
