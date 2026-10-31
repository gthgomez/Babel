// ─── Command Router ───────────────────────────────────────────────────────────
// Centralized command dispatch: routes slash commands to extracted handler
// modules. Replaces the ~315-line switch statement that was in BabelRepl.

import { getSetupStatus } from '../services/providerSetup.js';
import { accentBright, muted } from '../ui/theme.js';
import { findClosestCommands } from './utils.js';
import type { ReplContext } from './context.js';

// Config commands
import {
  handleClear,
  handleHeader,
  handleVerbose,
  handleCompact,
  handleNotifications,
  handleMode,
  handleExecutePlan,
  handleProject,
  handleRetarget,
  handleModel,
  handleThinking,
  handleRuns,
  handleInspect,
  handlePolicy,
  handleCost,
} from './commands/config.js';

// Info commands
import {
  handleStatus,
  handleDoctor,
  handleTools,
  handleMemory,
  handleChat,
  handleLast,
  handleCopy,
  handleTarget,
  handleStats,
  handleHistory,
  handleDashboard,
  handleWhyStopped,
} from './commands/info.js';

// MCP commands
import { handleMcpServers } from './commands/mcp.js';

// Service commands
import {
  handlePlugins,
  handlePluginCommand,
  handleCheckpoint,
  handleRestore,
  handleSession,
  handleContinue,
  handleChain,
  handleAgents,
  handleGit,
  handleShip,
  handleEvidence,
  handleScrollback,
  handleReverseSearch,
} from './commands/service.js';

// Permissions commands
import { handlePermissions, handleSettings } from './commands/permissions.js';
import { handleTheme } from './commands/theme.js';
import { handleWorkflow } from './commands/workflow.js';
import { handleResume } from './commands/resume.js';
import { handleCancelTurn, handleDiffReview } from './commands/review.js';
import { handleFork, handleRewind } from './commands/threadBranch.js';
import { CommandPalette } from '../ui/palette.js';
import { KeybindingRemapWizard } from '../ui/keybindingRemap.js';
import { KeybindingManager } from '../ui/keybindings.js';

// Help
import { showHelp } from './help.js';
import { handleConnectionCommand } from '../commands/connectionCommands.js';
import { runProviderSetup } from '../services/providerSetup.js';
import { withSavedPlanApplication } from '../services/savedPlan.js';

export async function handleCommand(ctx: ReplContext, input: string): Promise<void> {
  const parts = input.slice(1).split(' ');
  const cmd = parts[0]?.toLowerCase() ?? '';
  const args = parts.slice(1);

  switch (cmd) {
    case 'apply': {
      const id = args[0] ?? ctx.state.savedPlanId;
      if (!id) throw new Error('Use /apply <plan-id> after producing a plan.');
      const target = ctx.resolveCurrentTarget();
      await withSavedPlanApplication(id, { projectRoot: target.targetRoot, operatorMode: ctx.state.operatorMode, execute: async plan => {
        const { executeGovernedTask } = await import('./execution/governed.js');
        await executeGovernedTask(ctx, input, `Implement this approved plan within current permissions.\nTask: ${plan.task}\nPlan: ${plan.body}`, target, 'deep');
        if (ctx.state.lastRunUserStatus !== 'complete') throw new Error('Plan implementation stopped; inspect the run evidence.');
      } });
      break;
    }
    case 'setup': {
      const setup = () => runProviderSetup();
      if (ctx.withExclusiveTerminal) await ctx.withExclusiveTerminal('provider-setup', setup);
      else await setup();
      const { selectedConnectionModel, connectionStatus } = await import('../services/connectionSettings.js');
      const root = ctx.resolveCurrentTarget().targetRoot;
      const selected = selectedConnectionModel({}, root);
      const status = connectionStatus({}, root);
      delete ctx.state.model; delete ctx.state.connectionId; delete ctx.state.resolvedModelId;
      if (selected) { ctx.state.model = selected; ctx.resolveSessionModel(); }
      if (status.connection) ctx.state.connectionId = status.connection;
      if (status.model) ctx.state.resolvedModelId = status.model;
      ctx.state.modelSource = status.modelSource;
      ctx.state.readinessState = status.state as NonNullable<typeof ctx.state.readinessState>;
      delete ctx.state.savedPlanId;
      delete ctx.state.pendingPlanBody;
      ctx.chatEngine?.closeAdmissionStore?.();
      ctx.chatEngine = undefined;
      ctx.saveSessionState();
      break;
    }
    // ── Session control ──────────────────────────────────────────────
    case 'exit':
    case 'quit':
    case 'q':
      ctx.exit();
      break;
    case 'clear':
      handleClear(ctx, []);
      break;
    case 'header':
      handleHeader(ctx, []);
      break;
    case 'scrollback':
      await handleScrollback(ctx, []);
      break;
    case 'history':
      handleHistory(ctx, []);
      break;
    case 'chat':
    case 'transcript':
      handleChat(ctx, []);
      break;
    case 'last':
      handleLast(ctx, []);
      break;
    case 'copy':
      handleCopy(ctx, []);
      break;
    case 'dashboard':
      handleDashboard(ctx, []);
      break;
    case 'verbose':
      handleVerbose(ctx, []);
      break;
    case 'compact':
      console.log('Legacy display alias. Use /display renderer conversational|stages|auto; this does not compact model context.');
      handleCompact(ctx, args);
      break;
    case 'display': {
      if (args[0] !== 'renderer' || !['conversational', 'stages', 'auto'].includes(args[1] ?? '')) throw new Error('Use /display renderer conversational|stages|auto.');
      if (args[1] === 'auto') { delete ctx.state.compactMode; ctx.saveSessionState(); }
      else handleCompact(ctx, [args[1] === 'conversational' ? 'on' : 'off']);
      break;
    }
    case 'notifications':
      handleNotifications(ctx, args);
      break;
    case 'settings':
      if (args.length && !['show', 'set'].includes(args[0]!)) handleSettings(ctx, args);
      else await handleConnectionCommand(ctx, 'settings', args);
      break;
    case 'provider':
      await handleConnectionCommand(ctx, 'provider', args);
      break;
    case 'theme':
      await handleTheme(ctx, args);
      break;
    case 'palette':
      if (ctx.withExclusiveTerminal) {
        await ctx.withExclusiveTerminal('command-palette', () => CommandPalette.show(ctx));
      } else {
        await CommandPalette.show(ctx);
      }
      break;

    // ── Help ─────────────────────────────────────────────────────────
    case 'help':
    case 'h':
      showHelp(args);
      break;

    // ── Keybinding Remap ──────────────────────────────────────────────
    case 'keymap':
      {
        const kbManager = KeybindingManager.getInstance();
        const wizard = new KeybindingRemapWizard(kbManager);
        const result = await wizard.run();
        if (result !== null) {
          console.log(accentBright('\n  Keybindings updated successfully.'));
        }
      }
      break;

    // ── Status ───────────────────────────────────────────────────────
    case 'status':
      handleStatus(ctx, []);
      break;
    case 'why-stopped':
    case 'whystopped':
    case 'why':
      handleWhyStopped(ctx, args);
      break;
    case 'doctor':
      await handleDoctor(ctx, []);
      break;
    case 'permissions':
      handlePermissions(ctx, args);
      break;
    case 'mcp':
      await handleMcpServers(ctx, args);
      break;
    case 'tools':
      handleTools(ctx, []);
      break;
    case 'plugins':
      handlePlugins(ctx, args);
      break;
    case 'plugin':
      await handlePluginCommand(ctx, args);
      break;
    case 'checkpoint':
      handleCheckpoint(ctx, args);
      break;
    case 'restore':
      handleRestore(ctx, args);
      break;
    case 'conversation':
      if (args[0] !== 'list' && args[0] !== 'resume') throw new Error('Use /conversation list or /conversation resume <id>.');
      return handleCommand(ctx, `/session ${args.join(' ')}`);
    case 'session':
      if (args[0] === 'resume') await handleResume(ctx, args.slice(1));
      else if (args[0] === 'list') {
        const { listResumableSessions } = await import('../services/chatSessionIndex.js');
        console.log(JSON.stringify(await listResumableSessions({ limit: 30 }), null, 2));
      } else handleSession(ctx, args);
      break;
    case 'run':
      if (args[0] !== 'resume') throw new Error('Use /run resume <run> for execution recovery; /session resume <id> resumes a conversation.');
      await handleContinue(ctx, args.slice(1));
      break;
    case 'continue':
      await handleContinue(ctx, args);
      break;
    case 'chain':
      handleChain(ctx, args);
      break;
    case 'agents':
      handleAgents(ctx, args);
      break;
    case 'memory':
      handleMemory(ctx, []);
      break;
    case 'git':
      await handleGit(ctx, args);
      break;
    case 'diff':
    case 'd':
      await handleDiffReview(ctx);
      break;
    case 'cancel':
      handleCancelTurn(ctx);
      break;
    case 'ship':
      handleShip(ctx, args);
      break;
    case 'evidence':
      handleEvidence(ctx, args);
      break;

    // ── Mode ─────────────────────────────────────────────────────────
    case 'mode':
      handleMode(ctx, args);
      break;
    case 'execute-plan':
    case 'executeplan':
    case 'implement-plan':
      handleExecutePlan(ctx, args);
      break;

    // ── Project ──────────────────────────────────────────────────────
    case 'project':
    case 'p':
      handleProject(ctx, args);
      break;
    case 'target':
      handleTarget(ctx, []);
      break;
    case 'retarget':
      handleRetarget(ctx, args);
      break;

    // ── Model ────────────────────────────────────────────────────────
    case 'model':
    case 'm':
      if (args.length && !['list', 'use', 'show'].includes(args[0]!)) handleModel(ctx, args);
      else await handleConnectionCommand(ctx, 'model', args);
      break;

    // ── Thinking ─────────────────────────────────────────────────────
    case 'thinking':
    case 'think':
      handleThinking(ctx, args);
      break;
      break;

    // ── Runs / Inspect ───────────────────────────────────────────────
    case 'runs':
      handleRuns(ctx, []);
      break;
    case 'inspect':
      handleInspect(ctx, []);
      break;
    case 'policy':
      handlePolicy(ctx, []);
      break;
    case 'cost':
      handleCost(ctx, []);
      break;
    case 'stats':
      handleStats(ctx, args);
      break;
    case 'reverse-search':
      await handleReverseSearch(ctx);
      break;
    case 'workflow':
      await handleWorkflow(ctx, args);
      break;
    case 'resume':
      await handleResume(ctx, args);
      break;
    case 'fork':
      await handleFork(ctx, args);
      break;
    case 'rewind':
      await handleRewind(ctx, args);
      break;

    default: {
      const suggestions = findClosestCommands(cmd, 2, 3);
      if (suggestions.length > 0) {
        const hint = suggestions.map((s) => s).join(', ');
        console.log(
          `${accentBright(`\n  Unknown command: "/${cmd}".`)}\n  ${muted('Did you mean:')} ${accentBright(hint)}?`,
        );
      } else {
        console.log(
          accentBright(`\n  Unknown command: "/${cmd}". Type /help for available commands.`),
        );
      }
    }
  }
}
