// ─── Config / Display Command Handlers ───────────────────────────────────────
// Extracted from interactive.ts handleCommand switch.
// Each function receives ctx: ReplContext as first parameter.

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ReplContext } from '../context.js';
import {
  resolveModelAlias,
  describeVisibleMode,
  MODE_DESCRIPTIONS,
  MODE_ALIAS_TO_RUNTIME,
  MODEL_ALIASES,
} from '../types.js';
import { resolveModelByKey, getAvailableModels } from '../../modelPolicy.js';
import { globalCostTracker } from '../../services/costTracker.js';
import { VALID_MODES } from '../../cli/constants.js';
import { getRecentRuns } from '../utils.js';
import { loadInspectBundle, buildInspectRunView } from '../../inspect/loaders.js';
import { renderInspectRun } from '../../ui/inspection.js';
import {
  accentBright,
  muted,
  primary,
  warning,
  padRight,
  truncate,
  hyperlinkFile,
  getTerminalWidth,
} from '../../ui/theme.js';
import { enableNotifications, disableNotifications } from '../../ui/notifications.js';
import {
  normalizeChatOperatorMode,
  OPERATOR_MODE_HELP,
  operatorModeImpliesDryRun,
} from '../../agent/planExecuteMode.js';

// ── Session control ──────────────────────────────────────────────────────────

export function handleClear(ctx: ReplContext, _args: string[]): void {
  ctx.chatEngine = undefined;
  ctx.lastRoutingLabel = null;
  process.stdout.write('\x1bc');
}

export function handleHeader(ctx: ReplContext, _args: string[]): void {
  ctx.printIdleHeader();
}

export function handleVerbose(ctx: ReplContext, _args: string[]): void {
  ctx.verboseMode = !ctx.verboseMode;
  ctx.saveSessionState();
  console.log(
    primary(`\n  Verbose log mode: ${ctx.verboseMode ? accentBright('ON') : muted('off')}`),
  );
}

export function handleCompact(ctx: ReplContext, args: string[]): void {
  if (args[0] === 'on') {
    ctx.state.compactMode = 'on';
    console.log(primary('\n  Compact mode: ON — conversational renderer for all modes'));
  } else if (args[0] === 'off') {
    ctx.state.compactMode = 'off';
    console.log(primary('\n  Compact mode: OFF — waterfall HUD for all modes'));
  } else {
    // Toggle: unset -> on, on -> off, off -> unset (auto)
    if (ctx.state.compactMode === 'on') {
      ctx.state.compactMode = 'off';
      console.log(
        primary(`\n  Compact mode: ${accentBright('OFF')}  ${muted('waterfall for all modes')}`),
      );
    } else if (ctx.state.compactMode === 'off') {
      delete ctx.state.compactMode;
      console.log(
        primary(
          `\n  Compact mode: ${accentBright('auto')}  ${muted('chat=conversational, plan/deep=waterfall')}`,
        ),
      );
    } else {
      ctx.state.compactMode = 'on';
      console.log(
        primary(
          `\n  Compact mode: ${accentBright('ON')}  ${muted('conversational for all modes')}`,
        ),
      );
    }
  }
  ctx.saveSessionState();
}

export function handleNotifications(_ctx: ReplContext, args: string[]): void {
  if (args[0] === 'off') {
    disableNotifications();
    console.log(primary('\n  Desktop notifications: OFF'));
  } else if (args[0] === 'on') {
    enableNotifications();
    console.log(primary('\n  Desktop notifications: ON'));
  } else {
    // Toggle default behavior: currently enabled, toggle off
    disableNotifications();
    console.log(primary('\n  Desktop notifications: OFF  Use /notifications on to enable'));
  }
}

// ── Mode ─────────────────────────────────────────────────────────────────────

export function handleMode(ctx: ReplContext, args: string[]): void {
  if (args[0]) {
    const requested = args[0].toLowerCase();
    // Implementor operator modes (orthogonal to chat/plan/deep).
    const op = normalizeChatOperatorMode(requested);
    if (op) {
      ctx.state.operatorMode = op;
      if (operatorModeImpliesDryRun(op)) {
        process.env['BABEL_DRY_RUN'] = '1';
      } else if (process.env['BABEL_DRY_RUN'] === '1' && op !== 'dry_run') {
        // Leaving dry-run: clear only if we own it via operator mode switch.
        delete process.env['BABEL_DRY_RUN'];
      }
      // Force new engine so hard_plan / handoff options take effect.
      ctx.chatEngine = undefined;
      ctx.saveSessionState();
      console.log(
        primary(
          `\n  Operator mode set to ${accentBright(op)} — ${muted(OPERATOR_MODE_HELP[op])}`,
        ),
      );
      console.log(
        muted(
          '  (Runtime surface remains chat unless you also /mode plan|deep. hard_plan blocks mutations until /execute-plan.)',
        ),
      );
      return;
    }
    const mode = MODE_ALIAS_TO_RUNTIME[requested];
    if (mode && VALID_MODES.includes(mode)) {
      ctx.state.mode = mode;
      ctx.saveSessionState();
      console.log(primary(`\n  Mode set to ${accentBright(describeVisibleMode(mode))}`));
    } else {
      console.log(accentBright(`\n  Invalid mode: "${args[0]}". Available options:`));
      Object.entries(MODE_DESCRIPTIONS).forEach(([k, v]) =>
        console.log(`    - ${accentBright(padRight(k, 12))} ${muted(v)}`),
      );
      console.log(muted('\n  Operator modes (implementor):'));
      for (const [k, v] of Object.entries(OPERATOR_MODE_HELP)) {
        console.log(`    - ${accentBright(padRight(k, 14))} ${muted(v)}`);
      }
    }
  } else {
    console.log(primary('\n  Available Modes:'));
    Object.entries(MODE_DESCRIPTIONS).forEach(([k, v]) =>
      console.log(`    - ${accentBright(padRight(k, 12))} ${muted(v)}`),
    );
    console.log(muted(`\n  Current: ${accentBright(describeVisibleMode(ctx.state.mode))}`));
    if (ctx.state.operatorMode) {
      console.log(muted(`  Operator: ${accentBright(ctx.state.operatorMode)}`));
    }
    console.log(muted(`  Use '/mode <name>' to switch.`));
  }
}

// ── Execute plan (implementor W1.3) ──────────────────────────────────────────

/**
 * Stage a plan body and switch operator mode to implement (default) so the
 * next chat turn injects a plan→execute handoff with elevated mutate.
 *
 * Usage:
 *   /execute-plan                     — use last assistant answer as plan body
 *   /execute-plan path/to/plan.md     — read plan from file
 */
export function handleExecutePlan(ctx: ReplContext, args: string[]): void {
  let body = '';
  const arg = args.join(' ').trim();
  if (arg && fs.existsSync(path.resolve(arg))) {
    body = fs.readFileSync(path.resolve(arg), 'utf8');
  } else if (arg) {
    body = arg;
  } else if (ctx.lastAssistantAnswer?.trim()) {
    body = ctx.lastAssistantAnswer.trim();
  }
  if (!body) {
    console.log(
      accentBright(
        '\n  No plan body. Provide a file path, paste after the command, or run hard-plan first so the last answer is a plan.\n',
      ),
    );
    return;
  }
  ctx.state.pendingPlanBody = body;
  ctx.state.operatorMode = 'default';
  ctx.chatEngine = undefined;
  if (process.env['BABEL_DRY_RUN'] === '1') {
    delete process.env['BABEL_DRY_RUN'];
  }
  ctx.saveSessionState();
  console.log(
    primary(
      `\n  Plan staged (${body.length} chars). Next chat message starts implement with plan→execute handoff.`,
    ),
  );
  console.log(muted('  Mutations allowed; force-mutate threshold elevated. Use /mode hard-plan to plan again.\n'));
}

// ── Project ──────────────────────────────────────────────────────────────────

export function handleProject(ctx: ReplContext, args: string[]): void {
  if (args[0]) {
    ctx.state.project = args[0];
    ctx.saveSessionState();
    // Invalidate stale engine so the next turn picks up the new root
    ctx.chatEngine = undefined;
    console.log(primary(`\n  Project set to ${accentBright(args[0])}`));
  } else {
    delete (ctx.state as any).project;
    ctx.saveSessionState();
    // Invalidate stale engine so the next turn picks up the new root
    ctx.chatEngine = undefined;
    console.log(primary('\n  Project cleared — auto-detect enabled'));
  }
}

export function handleRetarget(ctx: ReplContext, args: string[]): void {
  const requested = args.join(' ').trim();
  ctx.targetOverrideRoot = requested ? path.resolve(requested) : null;
  const target = ctx.resolveCurrentTarget();
  ctx.saveSessionState();
  // Invalidate stale engine so the next turn uses the new target root
  ctx.chatEngine = undefined;
  console.log(primary(`\n  Target set to ${accentBright(target.targetRoot)}`));
  if (!requested) {
    console.log(muted('  Override cleared; using automatic cwd/project target resolution.'));
  }
}

// ── Model ────────────────────────────────────────────────────────────────────

export function handleModel(ctx: ReplContext, args: string[]): void {
  if (args[0] && args[0].toLowerCase() !== 'clear') {
    const requested = args[0].toLowerCase();
    try {
      // Check alias shorthand before resolving by key
      const aliasResolution = resolveModelAlias(requested);
      const targetKey = aliasResolution?.resolvedKey ?? requested;

      const resolved = resolveModelByKey({ key: targetKey });
      ctx.state.model = resolved.resolvedBackendKey;
      ctx.state.resolvedModelId = resolved.providerModelId;
      ctx.state = {
        ...ctx.state,
        ...(resolved.approximateCostPerRunUsd !== undefined
          ? { approximateCostPerRunUsd: resolved.approximateCostPerRunUsd }
          : {}),
      };
      ctx.saveSessionState();

      // Invalidate stale engine so the next turn uses the new model/provider
      ctx.chatEngine = undefined;

      // Warn if the required API key is missing
      const keyWarnings: string[] = [];
      if (resolved.provider === 'deepseek' && !process.env['DEEPSEEK_API_KEY']) {
        keyWarnings.push('DEEPSEEK_API_KEY is not set — add it to babel-cli/.env');
      }
      if (
        resolved.provider === 'deepinfra' &&
        !process.env['DEEPINFRA_API_KEY'] &&
        !process.env['DEEPINFRA_TOKEN']
      ) {
        keyWarnings.push('DEEPINFRA_API_KEY is not set — add it to babel-cli/.env');
      }

      const aliasSuffix = aliasResolution
        ? ` ${muted(`(alias: ${aliasResolution.aliasName})`)}`
        : '';
      console.log(
        primary(
          `\n  Model set to ${accentBright(resolved.resolvedBackendKey)}${aliasSuffix} ${muted(`(approx. $${resolved.approximateCostPerRunUsd?.toFixed(4)}/run)`)}`,
        ),
      );
      if (keyWarnings.length > 0) {
        console.log(warning(`  ⚠ ${keyWarnings.join('. ')}.`));
      }
    } catch {
      const available = getAvailableModels()
        .map(
          (m) =>
            `    - ${accentBright(m.key)}: ${muted(`$${m.entry.estimated_cost_per_1m_output}/M`)}`,
        )
        .join('\n');
      console.log(accentBright(`\n  Invalid model: "${requested}". Available backends:`));
      console.log(available);
    }
  } else if (args[0]?.toLowerCase() === 'clear') {
    delete (ctx.state as any).model;
    delete (ctx.state as any).resolvedModelId;
    delete (ctx.state as any).approximateCostPerRunUsd;
    ctx.saveSessionState();
    // Invalidate stale engine so the next turn uses route-selected model
    ctx.chatEngine = undefined;
    console.log(primary('\n  Model cleared — route-selected enabled'));
  } else {
    // Show current model first, then available backends
    if (ctx.state.model) {
      const detail = ctx.state.resolvedModelId ? ` (${ctx.state.resolvedModelId})` : '';
      const cost = ctx.state.approximateCostPerRunUsd
        ? ` · ~$${ctx.state.approximateCostPerRunUsd.toFixed(4)}/run`
        : '';
      console.log(
        primary(
          `\n  Current model: ${accentBright(ctx.state.model)}${muted(detail)}${muted(cost)}`,
        ),
      );
    } else {
      console.log(muted('\n  No model set — using auto (policy default tier)'));
    }
    console.log(primary('\n  Available Models:'));
    const available = getAvailableModels()
      .map(
        (m) =>
          `    - ${accentBright(padRight(m.key, 12))} ${muted(`$${padRight((m.entry.estimated_cost_per_1m_output ?? 0).toString(), 6)}/M`)}${m.entry.selection_reason ? `  ${muted(m.entry.selection_reason)}` : ''}`,
      )
      .join('\n');
    const aliases = Object.keys(MODEL_ALIASES)
      .sort()
      .map((a) => `    - ${accentBright(padRight(a, 12))} ${muted(`alias`)}`)
      .join('\n');
    console.log(available);
    console.log(primary('\n  Model Aliases:'));
    console.log(aliases);
    console.log(
      muted(`\n  Use '/model <key>' or '<alias>' to select, or '/model clear' to reset.`),
    );
  }
}

// ── Thinking ─────────────────────────────────────────────────────────────────

export function handleThinking(ctx: ReplContext, args: string[]): void {
  const sub = args[0]?.toLowerCase();
  if (sub === 'on') {
    ctx.state.thinkingCollapsed = false;
    ctx.saveSessionState();
    console.log(primary('\n  Thinking display: expanded'));
  } else if (sub === 'off') {
    ctx.state.thinkingCollapsed = true;
    ctx.saveSessionState();
    console.log(primary('\n  Thinking display: collapsed (press [T] to expand during a run)'));
  } else if (sub === 'toggle') {
    ctx.state.thinkingCollapsed = !ctx.state.thinkingCollapsed;
    ctx.saveSessionState();
    const state = ctx.state.thinkingCollapsed ? 'collapsed' : 'expanded';
    console.log(primary(`\n  Thinking display: ${state}`));
  } else {
    const state = ctx.state.thinkingCollapsed ? 'collapsed' : 'expanded';
    console.log(primary(`\n  Thinking display: ${state}`));
    console.log(muted(`  Use '/thinking on', '/thinking off', or '/thinking toggle' to change.`));
    console.log(muted(`  Press [T] during a run to toggle thinking visibility inline.`));
  }
}

// ── Runs / Inspect ───────────────────────────────────────────────────────────

export function handleRuns(_ctx: ReplContext, _args: string[]): void {
  const recent = getRecentRuns(5);
  if (recent.length === 0) {
    console.log(muted('\n  No runs found.'));
  } else {
    console.log(primary('\n  Recent Runs:'));
    recent.forEach((r, i) =>
      console.log(
        `    ${muted(String(i + 1) + '.')} ${hyperlinkFile(r, truncate(r, getTerminalWidth() - 8))}`,
      ),
    );
    console.log(muted('\n  Use /inspect to open the latest run.'));
  }
}

export function handleInspect(ctx: ReplContext, _args: string[]): void {
  const target = ctx.lastRunDir ?? getRecentRuns(1)[0];
  if (!target) {
    console.log(muted('\n  No runs to inspect.'));
  } else if (!fs.existsSync(target)) {
    console.log(muted(`\n  Run bundle not found: ${target}`));
  } else {
    const bundle = loadInspectBundle(target);
    console.log(`\n${renderInspectRun(buildInspectRunView(bundle))}\n`);
  }
}

// ── Policy / Financials ──────────────────────────────────────────────────────

export function handlePolicy(_ctx: ReplContext, _args: string[]): void {
  const models = getAvailableModels();
  console.log(primary('\n  Active Model Policy:'));
  models.forEach((m) => {
    console.log(
      `    ${accentBright(padRight(m.key, 12))} ${muted(`$${padRight((m.entry.estimated_cost_per_1m_output ?? 0).toString(), 6)}/M`)}  ${m.entry.selection_reason ? muted(m.entry.selection_reason) : ''}`,
    );
  });
}

export function handleCost(_ctx: ReplContext, _args: string[]): void {
  const summary = globalCostTracker.getSessionSummary();
  console.log(primary('\n  Session Cost Summary:'));
  console.log(
    `    ${muted(padRight('Total USD', 14))} ${accentBright('$' + summary.totalCostUSD.toFixed(6))}`,
  );
  console.log(primary('\n  Breakdown by Model:'));
  Object.entries(summary.modelBreakdown).forEach(([model, usage]) => {
    const shortName = model.split('/').pop() ?? model;
    console.log(
      `    ${accentBright(padRight(shortName, 24))} ${muted(`In: ${usage.inputTokens.toString().padStart(8)}`)} ${muted(`Out: ${usage.outputTokens.toString().padStart(8)}`)} ${accentBright(`$${usage.costUSD.toFixed(6)}`)}`,
    );
  });
  console.log(muted('\n  Use /stats for lifetime project totals.'));
}
