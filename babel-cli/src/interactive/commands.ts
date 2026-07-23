// ─── Command Router ───────────────────────────────────────────────────────────
// Centralized command dispatch: routes slash commands to extracted handler
// modules. Replaces the ~315-line switch statement that was in BabelRepl.

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
import { handleFork, handleRewind } from './commands/threadBranch.js';
import { CommandPalette } from '../ui/palette.js';
import { KeybindingRemapWizard } from '../ui/keybindingRemap.js';
import { KeybindingManager } from '../ui/keybindings.js';

// Help
import { showHelp } from './help.js';

export async function handleCommand(ctx: ReplContext, input: string): Promise<void> {
  const parts = input.slice(1).split(' ');
  const cmd = parts[0]?.toLowerCase() ?? '';
  const args = parts.slice(1);

  switch (cmd) {
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
      handleCompact(ctx, args);
      break;
    case 'notifications':
      handleNotifications(ctx, args);
      break;
    case 'settings':
      handleSettings(ctx, args);
      break;
    case 'theme':
      await handleTheme(ctx, args);
      break;
    case 'palette':
      await CommandPalette.show(ctx);
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
    case 'session':
      handleSession(ctx, args);
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
      handleModel(ctx, args);
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
