// ─── Session Persistence ──────────────────────────────────────────────────────
// Extracted from interactive.ts — session state save/load, model resolution,
// and cost total tracking. All functions take ReplContext as first param.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { globalCostTracker } from '../services/costTracker.js';
import { MODE_ALIAS_TO_RUNTIME } from './types.js';
import { VALID_MODES } from '../cli/constants.js';
import { resolveModelByKey } from '../modelPolicy.js';
import { accentBright } from '../ui/theme.js';
import { saveTokenHistory, loadTokenHistory } from '../ui/tokenHistory.js';
import type { ReplContext } from './context.js';
import type { SessionState } from './types.js';

export function updateCostTotals(ctx: ReplContext): void {
  const summary = globalCostTracker.getSessionSummary();
  ctx.state.costTotals = {
    totalCostUSD: summary.totalCostUSD,
    totalInputTokens: summary.totalInputTokens,
    totalOutputTokens: summary.totalOutputTokens,
    totalTokens: summary.totalTokens,
  };
}

export function saveSessionState(ctx: ReplContext): void {
  updateCostTotals(ctx);
  const sessionDir = path.join(os.homedir(), '.babel');
  const sessionFile = path.join(sessionDir, 'session.json');
  try {
    fs.mkdirSync(sessionDir, { recursive: true });
    const state = {
      ...ctx.state,
      lastTask: ctx.lastResolvedTask ?? undefined,
      lastAnswer: ctx.lastAssistantAnswer,
      lastRunDir: ctx.lastRunDir,
      turnCount: ctx.turnCounter,
      timestamp: new Date().toISOString(),
    };
    const tmpFile = sessionFile + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tmpFile, sessionFile);
    saveTokenHistory(path.join(os.homedir(), '.babel', 'token-history.json'));
  } catch {
    // Best-effort — silent if home dir is unwritable
  }
}

export function loadSessionState(): SessionState | null {
  const sessionFile = path.join(os.homedir(), '.babel', 'session.json');
  try {
    if (!fs.existsSync(sessionFile)) return null;
    const raw = fs.readFileSync(sessionFile, 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (typeof parsed.mode !== 'string') return null;
    const normalized = MODE_ALIAS_TO_RUNTIME[parsed.mode];
    if (normalized && VALID_MODES.includes(normalized)) {
      parsed.mode = normalized;
    } else if (!VALID_MODES.includes(parsed.mode)) {
      parsed.mode = 'chat';
    }
    loadTokenHistory(path.join(os.homedir(), '.babel', 'token-history.json'));
    return parsed as SessionState;
  } catch {
    return null;
  }
}

export function restoreSessionState(ctx: ReplContext, saved: SessionState): void {
  ctx.state = {
    ...saved,
    lastRunUserStatus: 'ready',
  };
  ctx.lastAssistantAnswer = saved.lastAnswer ?? null;
  ctx.lastResolvedTask = saved.lastTask ?? null;
  ctx.lastRunDir = saved.lastRunDir ?? null;
  ctx.turnCounter = saved.turnCount ?? 0;
  if (saved.costTotals) {
    globalCostTracker.restoreSessionCost(saved.costTotals);
  }
  console.log(
    `\n  Session restored — ${saved.turnCount ?? 0} turns, $${(saved.costTotals?.totalCostUSD ?? 0).toFixed(4)} cumulative cost.\n`,
  );
}

export function resolveSessionModel(ctx: ReplContext): void {
  if (!ctx.state.model) return;
  try {
    const resolved = resolveModelByKey({ key: ctx.state.model });
    ctx.state.resolvedModelId = resolved.providerModelId;
    ctx.state = {
      ...ctx.state,
      ...(resolved.approximateCostPerRunUsd !== undefined
        ? { approximateCostPerRunUsd: resolved.approximateCostPerRunUsd }
        : {}),
    };
  } catch (error: any) {
    console.log(`${accentBright('\n  Policy Error:')} ${error.message}`);
    delete (ctx.state as any).model;
    delete (ctx.state as any).resolvedModelId;
    delete (ctx.state as any).approximateCostPerRunUsd;
  }
}
