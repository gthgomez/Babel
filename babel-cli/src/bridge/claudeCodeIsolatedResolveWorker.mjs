#!/usr/bin/env node
/**
 * Isolated resolveSettings with query()-style full env replace (no parent env).
 * Invoked only from claudeCodeIsolatedPolicyResolve.ts via fixed argv.
 */
import { readFileSync } from 'node:fs';
import { resolveSettings, filterEscalatingDefaultMode } from '@anthropic-ai/claude-agent-sdk';

const raw = readFileSync(0, 'utf8');
const input = JSON.parse(raw);

for (const key of Object.keys(process.env)) {
  delete process.env[key];
}
for (const [key, value] of Object.entries(input.childEnv ?? {})) {
  if (typeof value === 'string') process.env[key] = value;
}

const resolved = await resolveSettings({
  cwd: input.cwd,
  settingSources: input.settingSources ?? [],
  managedSettings: input.managedSettings,
  serverManagedSettings: input.serverManagedSettings,
});

const filtered = filterEscalatingDefaultMode(resolved);
process.stdout.write(
  JSON.stringify({
    ok: true,
    filtered,
    sources: resolved.sources.map((s) => ({
      source: String(s.source),
      settings: s.settings,
      ...(s.path ? { path: s.path } : {}),
    })),
  }),
);
