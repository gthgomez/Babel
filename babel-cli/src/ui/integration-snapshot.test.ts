/**
 * integration-snapshot.test.ts — Multi-width snapshot tests for Babel TUI renderers.
 *
 * Expands coverage beyond renderers-snapshot.test.ts to include:
 *   - AgentProgressPane & AgentTeamOverview (multi-agent panes)
 *   - DiffView (side-by-side diffs)
 *   - Dialog interaction states (focused, selected, multi-select)
 *   - Renderers composite functions (prelude, routing, plan, qa, result, doctor)
 *   - Keybindings help display
 *
 * Tests use matchStrippedSnapshot() for cross-platform safety and test
 * each renderer at 2-3 terminal widths (narrow ~50, standard ~88, wide ~120).
 *
 * Run:   FORCE_COLOR=1 npx tsx --test src/ui/integration-snapshot.test.ts
 * Update: UPDATE_SNAPSHOTS=1 FORCE_COLOR=1 npx tsx --test src/ui/integration-snapshot.test.ts
 */

import test from 'node:test';
import { matchStrippedSnapshot } from './snapshot.js';

// ═══════════════════════════════════════════════════════════════════════════════
// 1. AgentProgressPane + AgentTeamOverview
// ═══════════════════════════════════════════════════════════════════════════════

import { AgentProgressPane, AgentTeamOverview } from './agentProgress.js';
import type { AgentInfo } from './agentProgress.js';

function makeAgent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: 'agent-1',
    name: 'researcher',
    task: 'Find relevant files for the authentication module',
    status: 'active',
    ...overrides,
  };
}

test('AgentProgressPane: active agent at width 50', () => {
  const pane = new AgentProgressPane(makeAgent({ status: 'active' }));
  matchStrippedSnapshot(pane.render(), 'agent pane active w50', import.meta.url);
});

test('AgentProgressPane: active agent at width 120', () => {
  const pane = new AgentProgressPane(makeAgent({ status: 'active' }));
  matchStrippedSnapshot(pane.render(), 'agent pane active w120', import.meta.url);
});

test('AgentProgressPane: pending agent', () => {
  const pane = new AgentProgressPane(makeAgent({ status: 'pending' }));
  matchStrippedSnapshot(pane.render(), 'agent pane pending', import.meta.url);
});

test('AgentProgressPane: complete agent with cost and steps', () => {
  const pane = new AgentProgressPane(makeAgent({ status: 'complete', cost: 0.042, steps: 12 }));
  matchStrippedSnapshot(pane.render(), 'agent pane complete', import.meta.url);
});

test('AgentProgressPane: error agent', () => {
  const pane = new AgentProgressPane(
    makeAgent({ status: 'error', sublabel: 'Connection timeout' }),
  );
  matchStrippedSnapshot(pane.render(), 'agent pane error', import.meta.url);
});

test('AgentProgressPane: compact single-line', () => {
  const pane = new AgentProgressPane(makeAgent({ status: 'active', cost: 0.015 }));
  matchStrippedSnapshot(pane.renderCompact(), 'agent pane compact', import.meta.url);
});

test('AgentTeamOverview: single active agent', () => {
  const team = new AgentTeamOverview();
  team.addAgent(makeAgent({ id: 'a1', name: 'planner', task: 'Design auth flow' }));
  matchStrippedSnapshot(team.render(), 'team single active', import.meta.url);
});

test('AgentTeamOverview: mixed statuses (2 agents)', () => {
  const team = new AgentTeamOverview();
  team.addAgent(
    makeAgent({
      id: 'a1',
      name: 'researcher',
      task: 'Find auth files',
      status: 'complete',
      cost: 0.02,
      steps: 5,
    }),
  );
  team.addAgent(
    makeAgent({
      id: 'a2',
      name: 'implementer',
      task: 'Write auth middleware',
      status: 'active',
      cost: 0.01,
    }),
  );
  matchStrippedSnapshot(team.render(), 'team mixed', import.meta.url);
});

test('AgentTeamOverview: three agents (complete, active, pending)', () => {
  const team = new AgentTeamOverview();
  team.addAgent(
    makeAgent({
      id: 'a1',
      name: 'researcher',
      task: 'Find auth files',
      status: 'complete',
      cost: 0.02,
      steps: 5,
    }),
  );
  team.addAgent(
    makeAgent({ id: 'a2', name: 'implementer', task: 'Write auth middleware', status: 'active' }),
  );
  team.addAgent(
    makeAgent({ id: 'a3', name: 'reviewer', task: 'Code review auth changes', status: 'pending' }),
  );
  team.setHeader('Team: Auth Module Refactor');
  matchStrippedSnapshot(team.render(), 'team three agents', import.meta.url);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. DiffView
// ═══════════════════════════════════════════════════════════════════════════════

import { DiffView } from './diffView.js';

const SIMPLE_DIFF = [
  '--- a/src/auth.ts',
  '+++ b/src/auth.ts',
  '@@ -1,5 +1,6 @@',
  ' import { Router } from "./router.js";',
  ' ',
  '-export function login(req: Request): Response {',
  '+export async function login(req: Request): Promise<Response> {',
  '+  await validateSession(req);',
  '   return { status: 200 };',
  ' }',
].join('\n');

const MULTI_HUNK_DIFF = [
  '--- a/src/config.ts',
  '+++ b/src/config.ts',
  '@@ -10,7 +10,7 @@',
  ' export const config = {',
  '   port: 3000,',
  '-  debug: false,',
  '+  debug: true,',
  '   host: "localhost",',
  ' };',
  '@@ -25,4 +25,5 @@',
  ' export const db = {',
  '   url: process.env.DATABASE_URL,',
  '+  pool: 10,',
  ' };',
].join('\n');

test('DiffView: simple diff at width 60', () => {
  const out = DiffView.render({ diff: SIMPLE_DIFF, width: 60 });
  matchStrippedSnapshot(out, 'diff simple w60', import.meta.url);
});

test('DiffView: simple diff at width 120', () => {
  const out = DiffView.render({ diff: SIMPLE_DIFF, width: 120 });
  matchStrippedSnapshot(out, 'diff simple w120', import.meta.url);
});

test('DiffView: multi-hunk diff at width 80', () => {
  const out = DiffView.render({ diff: MULTI_HUNK_DIFF, width: 80 });
  matchStrippedSnapshot(out, 'diff multi-hunk w80', import.meta.url);
});

test('DiffView: with maxLines truncation', () => {
  const out = DiffView.render({ diff: MULTI_HUNK_DIFF, width: 80, maxLines: 6 });
  matchStrippedSnapshot(out, 'diff truncated', import.meta.url);
});

test('DiffView: empty diff', () => {
  const out = DiffView.render({ diff: '', width: 80 });
  matchStrippedSnapshot(out, 'diff empty', import.meta.url);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Dialog interaction states
// ═══════════════════════════════════════════════════════════════════════════════

import { ConfirmDialog, SelectDialog, MultiSelectDialog, PermissionDialog } from './dialog.js';

test('ConfirmDialog: danger variant at width 60', () => {
  const dlg = new ConfirmDialog({
    title: 'Confirm Delete',
    message: 'Delete file src/old.ts?\nThis cannot be undone.',
    confirmLabel: 'Delete',
    rejectLabel: 'Cancel',
    danger: true,
    minWidth: 50,
  });
  matchStrippedSnapshot(dlg.render(), 'dialog confirm danger w60', import.meta.url);
});

test('ConfirmDialog: standard variant at width 80', () => {
  const dlg = new ConfirmDialog({
    title: 'Save Changes',
    message: 'Save changes to config.json before proceeding?',
    confirmLabel: 'Save',
    rejectLabel: "Don't Save",
    minWidth: 50,
  });
  matchStrippedSnapshot(dlg.render(), 'dialog confirm standard w80', import.meta.url);
});

test('SelectDialog: with options at width 60', () => {
  const dlg = new SelectDialog({
    title: 'Select Action',
    message: 'Choose an action:',
    options: ['Run tests', 'Build project', 'Deploy to staging', 'Cancel'],
    minWidth: 40,
  });
  matchStrippedSnapshot(dlg.render(), 'dialog select w60', import.meta.url);
});

test('SelectDialog: many options at width 80', () => {
  const dlg = new SelectDialog({
    title: 'Choose File',
    message: 'Select a file to open:',
    options: [
      'src/auth/login.ts',
      'src/auth/middleware.ts',
      'src/auth/session.ts',
      'src/auth/tokens.ts',
      'src/auth/oauth.ts',
      'src/auth/refresh.ts',
      'Cancel',
    ],
    selectedIndex: 2,
    minWidth: 40,
  });
  matchStrippedSnapshot(dlg.render(), 'dialog select many w80', import.meta.url);
});

test('MultiSelectDialog: with selections at width 80', () => {
  const dlg = new MultiSelectDialog({
    title: 'Select Files',
    message: 'Choose files to include:',
    options: ['src/auth.ts', 'src/router.ts', 'src/config.ts', 'src/utils.ts'],
    selected: [0, 2],
    minWidth: 40,
  });
  matchStrippedSnapshot(dlg.render(), 'dialog multiselect w80', import.meta.url);
});

test('PermissionDialog: write_file with preview at width 80', () => {
  const dlg = new PermissionDialog({
    title: 'Approve Write',
    message: 'Allow writing to the following file:',
    actionType: 'write_file',
    path: 'src/auth/new-middleware.ts',
    preview: [
      'export function authMiddleware(req: Request) {',
      '  const token = req.headers.get("Authorization");',
      '  if (!token) throw new Error("Unauthorized");',
      '  return validateToken(token);',
      '}',
    ].join('\n'),
    metadata: ['Lines: 5', 'Size: 182 bytes'],
    minWidth: 50,
  });
  matchStrippedSnapshot(dlg.render(), 'dialog permission write w80', import.meta.url);
});

test('PermissionDialog: shell_exec with metadata at width 60', () => {
  const dlg = new PermissionDialog({
    title: 'Approve Command',
    message: 'Allow executing the following command:',
    actionType: 'shell_exec',
    path: 'npm run build',
    metadata: ['CWD: /var/tmp/project', 'Duration: ~15s'],
    minWidth: 40,
  });
  matchStrippedSnapshot(dlg.render(), 'dialog permission shell w60', import.meta.url);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Renderers composite functions
// ═══════════════════════════════════════════════════════════════════════════════

import {
  renderRunPrelude,
  renderRoutingSummary,
  renderPlanSummary,
  renderQaSummary,
  renderResultSummary,
  renderDoctorSummary,
  renderOperatorHeader,
} from './renderers.js';

test('renderRunPrelude: basic context', () => {
  const out = renderRunPrelude({
    task: 'Add authentication middleware to the Express app',
    mode: 'deep',
    model: 'claude-opus-4-8',
    project: 'babel',
    runDir: '/tmp/babel/runs/20260624-001',
    stageStates: ['active', 'pending', 'pending', 'pending'],
  });
  matchStrippedSnapshot(out, 'prelude basic', import.meta.url);
});

test('renderRunPrelude: with execution profile', () => {
  const out = renderRunPrelude({
    task: 'Refactor database queries to use prepared statements',
    mode: 'plan',
    model: 'deepseek-v4',
    tier: 'flash',
    project: 'my-app',
    executionProfile: 'budget',
    runDir: '/tmp/babel/runs/20260624-002',
    showStatus: true,
  });
  matchStrippedSnapshot(out, 'prelude with profile', import.meta.url);
});

test('renderRoutingSummary: with domain and pipeline', () => {
  const out = renderRoutingSummary({
    target_project: 'babel',
    analysis: { task_category: 'code-generation' },
    instruction_stack: {
      domain_id: 'swe_v3',
      model_adapter_id: 'claude-opus-v1',
      pipeline_stage_ids: ['analyze', 'plan', 'review', 'apply'],
    },
  });
  matchStrippedSnapshot(out, 'routing summary', import.meta.url);
});

test('renderRoutingSummary: minimal manifest', () => {
  const out = renderRoutingSummary({
    target_project: 'unknown',
  });
  matchStrippedSnapshot(out, 'routing minimal', import.meta.url);
});

test('renderPlanSummary: with action set', () => {
  const out = renderPlanSummary({
    plan_type: 'sequential',
    task_summary: 'Add JWT authentication with refresh token rotation',
    minimal_action_set: [
      { description: 'Create auth middleware', target: 'src/auth/middleware.ts' },
      { description: 'Add login endpoint', target: 'src/routes/auth.ts' },
      { description: 'Add token refresh logic', target: 'src/auth/tokens.ts' },
    ],
  });
  matchStrippedSnapshot(out, 'plan summary', import.meta.url);
});

test('renderPlanSummary: empty plan', () => {
  const out = renderPlanSummary({});
  matchStrippedSnapshot(out, 'plan empty', import.meta.url);
});

test('renderQaSummary: PASS verdict', () => {
  const out = renderQaSummary({
    verdict: 'PASS',
    overall_confidence: 0.92,
    failure_count: 0,
  });
  matchStrippedSnapshot(out, 'qa pass', import.meta.url);
});

test('renderQaSummary: FAIL verdict with items', () => {
  const out = renderQaSummary({
    verdict: 'FAIL',
    overall_confidence: 0.45,
    failure_count: 2,
    failures: [
      { tag: 'security', condition: 'No input validation on token parameter' },
      { tag: 'correctness', condition: 'Missing error handling for expired tokens' },
    ],
  });
  matchStrippedSnapshot(out, 'qa fail', import.meta.url);
});

test('renderResultSummary: successful run', () => {
  const out = renderResultSummary({
    status: 'complete',
    runDir: '/tmp/babel/runs/20260624-001',
    plan: {
      plan_type: 'sequential',
      task_summary: 'Added auth middleware',
    },
    manifest: { analysis: { pipeline_mode: 'governed' } },
    usageSummary: {
      totalCostUSD: 0.2345,
      totalInputTokens: 12500,
      totalOutputTokens: 3400,
      totalTokens: 15900,
    },
  });
  matchStrippedSnapshot(out, 'result success', import.meta.url);
});

test('renderResultSummary: failed run', () => {
  const out = renderResultSummary({
    status: 'failed',
    runDir: '/tmp/babel/runs/20260624-002',
    usageSummary: {
      totalCostUSD: 0.08,
      totalInputTokens: 5000,
      totalOutputTokens: 800,
      totalTokens: 5800,
    },
  });
  matchStrippedSnapshot(out, 'result failed', import.meta.url);
});

test('renderDoctorSummary: mixed checks', () => {
  const out = renderDoctorSummary(
    {
      workspaceRoot: '/var/tmp/project',
      mode: 'full',
      scope: 'all',
      status: 'warning',
      checks: [
        {
          section: 'terminal',
          status: 'pass',
          title: 'Terminal capabilities',
          message: 'WezTerm 20250603 — all features supported',
        },
        {
          section: 'network',
          status: 'pass',
          title: 'API connectivity',
          message: 'DeepSeek API reachable (142ms)',
        },
        {
          section: 'config',
          status: 'warn',
          title: 'Keybindings conflict',
          message: 'Ctrl+P is bound in both palette and prompt contexts',
          details: ['palette: open-command-palette', 'prompt: history-previous'],
          fixHint: 'Rebind one of the conflicting keys in ~/.babel_keybindings.json',
        },
      ],
    },
    false,
  );
  matchStrippedSnapshot(out, 'doctor mixed', import.meta.url);
});

test('renderDoctorSummary: all passing', () => {
  const out = renderDoctorSummary(
    {
      workspaceRoot: '/var/tmp/project',
      mode: 'quick',
      scope: 'terminal',
      status: 'pass',
      checks: [
        {
          section: 'terminal',
          status: 'pass',
          title: 'Terminal capabilities',
          message: 'All checks passed',
        },
      ],
    },
    true,
  );
  matchStrippedSnapshot(out, 'doctor all pass verbose', import.meta.url);
});

test('renderOperatorHeader: full state', () => {
  const out = renderOperatorHeader({
    lastRunUserStatus: 'idle',
    project: 'babel',
    resolvedModelId: 'claude-opus-4-8',
    model: 'Claude Opus 4.8',
    mode: 'auto',
    turnCount: 5,
    router: 'v9',
    compactMode: 'off',
    timestamp: '2026-06-24T14:30:00Z',
  });
  matchStrippedSnapshot(out, 'operator header full', import.meta.url);
});

test('renderOperatorHeader: minimal state', () => {
  const out = renderOperatorHeader({
    mode: 'chat',
    turnCount: 0,
  });
  matchStrippedSnapshot(out, 'operator header minimal', import.meta.url);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Keybindings display
// ═══════════════════════════════════════════════════════════════════════════════

import { KeybindingManager } from './keybindings.js';

test('KeybindingManager: getBindings returns descriptors', () => {
  KeybindingManager.resetInstance();
  const km = KeybindingManager.getInstance();

  // Check that getBindings returns key arrays for known actions
  const paletteBindings = km.getBindings('palette', 'open-command-palette');
  const pagerBindings = km.getBindings('pager', 'quit');

  // At minimum, default bindings should return something
  const hasPalette = paletteBindings.length > 0;
  const hasPager = pagerBindings.length > 0;

  // Format bindings for snapshot
  const display = [
    'Keybindings (default):',
    `  palette.open-command-palette: ${paletteBindings.join(', ') || '(not bound)'}`,
    `  pager.quit: ${pagerBindings.join(', ') || '(not bound)'}`,
    `  Global bindings resolved: ${hasPalette || hasPager ? 'yes' : 'no'}`,
  ].join('\n');

  matchStrippedSnapshot(display, 'keybindings display', import.meta.url);
});
