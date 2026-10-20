import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CLAUDE_HARNESS_MANIFEST_FILENAME = 'babel-claude-harness.json';

export interface ClaudeHarnessCredentialRefSpec {
  /** Host environment variable that must already be configured. */
  host_env: string;
  /** Child subprocess variable name (defaults to host_env). */
  child_env?: string;
}

export interface ClaudeHarnessManifest {
  version: 1;
  credential_refs: Record<string, ClaudeHarnessCredentialRefSpec>;
}

export function loadClaudeHarnessManifest(configRoot: string): ClaudeHarnessManifest | null {
  const path = join(configRoot, CLAUDE_HARNESS_MANIFEST_FILENAME);
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as ClaudeHarnessManifest;
    if (parsed.version !== 1 || typeof parsed.credential_refs !== 'object') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
