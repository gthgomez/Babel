import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { CLAUDE_HARNESS_MANIFEST_FILENAME } from './claudeCodeHarnessManifest.js';

const POLICY_FILENAME_RE = /(^|\/)settings\.json$/i;

function walkConfigHome(configHome: string, onFile: (rel: string, abs: string) => void): void {
  const stack = [''];
  while (stack.length > 0) {
    const rel = stack.pop() ?? '';
    const abs = rel ? join(configHome, rel) : configHome;
    for (const ent of readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      const childAbs = join(abs, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === '.claude') stack.push(childRel);
        continue;
      }
      if (ent.isFile()) onFile(childRel, childAbs);
    }
  }
}

function parseSettingsEscalation(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const perms = parsed.permissions as { defaultMode?: string } | undefined;
    const mode = perms?.defaultMode;
    if (mode && mode !== 'default' && mode !== 'plan') {
      return `permissions.defaultMode=${mode}`;
    }
    const sandbox = parsed.sandbox as { enabled?: boolean } | undefined;
    if (sandbox?.enabled === false) return 'sandbox.disabled';
    if (parsed.disableClaudeAiConnectors === false) return 'connectors.enabled';
    if (parsed.strictMcpConfig === false) return 'strictMcpConfig.disabled';
  } catch {
    return 'invalid_json';
  }
  return null;
}

/**
 * Fail closed when config HOME contains Claude settings the SDK would load via
 * CLAUDE_CONFIG_DIR at query() time but resolveSettings() does not model via env.
 */
export function auditClaudeConfigHomePolicyNeutral(configHome: string): { ok: true } | { ok: false; detail: string } {
  if (!existsSync(configHome) || !statSync(configHome).isDirectory()) {
    return { ok: false, detail: 'config home is not a directory' };
  }
  let sawManifest = false;
  let violation: string | null = null;
  walkConfigHome(configHome, (rel, abs) => {
    if (violation) return;
    if (rel === CLAUDE_HARNESS_MANIFEST_FILENAME) {
      sawManifest = true;
      return;
    }
    if (!POLICY_FILENAME_RE.test(rel)) return;
    const escalation = parseSettingsEscalation(readFileSync(abs, 'utf8'));
    if (escalation) violation = `${rel}: ${escalation}`;
  });
  if (violation) {
    return { ok: false, detail: `Escalating Claude settings in config HOME: ${violation}` };
  }
  if (!sawManifest) {
    return { ok: false, detail: `Missing ${CLAUDE_HARNESS_MANIFEST_FILENAME} in config HOME` };
  }
  return { ok: true };
}
