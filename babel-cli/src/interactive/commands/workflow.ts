// ─── /workflow REPL Command ─────────────────────────────────────────────────
// Runs a DAG workflow from a JSON definition file. Each node is a ChatEngine
// session; the engine topologically sorts and parallel-dispatches nodes.
//
// Usage:  /workflow <path-to-workflow.json>

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { ReplContext } from '../context.js';
import { ChatEngine } from '../../agent/chatEngine.js';
import { WorkflowEngine } from '../../orchestrator/workflowEngine.js';
import type {
  ChatEngineFactory,
  WorkflowDefinition,
  WorkflowEvent,
} from '../../orchestrator/workflowNode.js';
import {
  stdinCoordinatorPauseForRun,
  stdinCoordinatorResumeAfterRun,
} from '../../ui/inputCoordinator.js';
import { error, muted, bold, success } from '../../ui/theme.js';

export async function handleWorkflow(
  ctx: ReplContext,
  args: string[],
): Promise<void> {
  if (args.length === 0) {
    console.log(`  ${muted('Usage: /workflow <path-to-workflow.json>')}`);
    return;
  }

  const filePath = resolve(args.join(' '));

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    console.log(
      `  ${error('✖')} Cannot read file: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  let definition: WorkflowDefinition;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.id || !Array.isArray(parsed.nodes)) {
      throw new Error(
        'Workflow definition must have "id" (string) and "nodes" (array)',
      );
    }
    definition = parsed as WorkflowDefinition;
  } catch (err) {
    console.log(
      `  ${error('✖')} Invalid workflow JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  // Resolve target for project root fallback
  const target = ctx.resolveCurrentTarget();

  const effectiveProjectRoot =
    definition.projectRoot !== undefined ? definition.projectRoot : (target.targetRoot || process.cwd());

  // Build factory that creates ChatEngines with REPL context
  const factory: ChatEngineFactory = ({ node, projectRoot, workspaceRoot, systemContext }) => {
    return new ChatEngine({
      task: node.task,
      projectRoot,
      ...(workspaceRoot ? { workspaceRoot } : {}),
      ...(systemContext ? { systemContext } : {}),
      ...(node.model || ctx.state.model
        ? { model: node.model ?? ctx.state.model }
        : {}),
      ...(node.modelTier ? { modelTier: node.modelTier } : {}),
      maxTurns: 30,
    });
  };

  const engine = new WorkflowEngine(
    { ...definition, projectRoot: effectiveProjectRoot },
    factory,
  );

  // Pause REPL input while workflow runs
  ctx.isRunning = true;
  stdinCoordinatorPauseForRun(ctx.rl);

  const startedAt = Date.now();

  try {
    let nodeCount = 0;
    let failCount = 0;
    let skipCount = 0;

    for await (const event of engine.run()) {
      switch (event.type) {
        case 'workflow_start':
          console.log(
            `\n  ${bold('⚙ Workflow')} ${event.workflowId}  ${muted(`(${event.totalNodes} nodes)`)}\n`,
          );
          break;

        case 'node_start':
          nodeCount++;
          console.log(`  … ${bold(event.nodeId)}  ${muted(event.task.slice(0, 80))}`);
          break;

        case 'node_retry':
          console.log(
            `  ${muted('↻')} ${event.nodeId}  retry ${event.attempt}/${event.maxRetries}  ${muted(event.error.slice(0, 60))}`,
          );
          break;

        case 'node_complete':
          console.log(`  ${success('✓')} ${event.nodeId} complete`);
          break;

        case 'node_failed':
          failCount++;
          console.log(
            `  ${error('✖')} ${event.nodeId} failed  ${muted(event.error.slice(0, 80))}`,
          );
          break;

        case 'node_skipped':
          skipCount++;
          console.log(
            `  ${muted('—')} ${event.nodeId} skipped  ${muted(event.reason)}`,
          );
          break;

        case 'workflow_complete': {
          const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
          const statusIcon =
            event.status === 'completed'
              ? success('✓')
              : event.status === 'partial'
                ? muted('◐')
                : error('✖');
          console.log(
            `\n  ${statusIcon} Workflow ${event.workflowId} ${event.status}  ${muted(`(${elapsed}s)`)}`,
          );
          console.log(
            `  ${nodeCount} run  ${failCount} failed  ${skipCount} skipped\n`,
          );
          break;
        }
      }
    }
  } catch (err) {
    console.log(
      `\n  ${error('✖')} Workflow error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  } finally {
    ctx.isRunning = false;
    stdinCoordinatorResumeAfterRun(ctx.rl);
  }
}
