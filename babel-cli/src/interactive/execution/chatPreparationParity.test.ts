/**
 * chatPreparationParity.test.ts — Verifies TUI / headless chat preparation parity (F2 / P0).
 *
 * Asserts that when an existing ChatEngine instance is reused across turns in the TUI/REPL,
 * applyEngineTurnPreparation ensures it has identical:
 *   1. Effective system instructions (getOrBuildSystemPrompt('native')) including chatStack.system_context
 *   2. Injected intentPlanUserMessage (with first-move hint / preloop planning)
 *   3. Task-class limits (maxTurns, maxConversationMessages, maxEstimatedTokens)
 *   4. Tool schemas (services.tools.buildDefinitions())
 *   5. Serialized provider wire request payloads (mapProviderMessagesToWire)
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { ChatEngine, type ChatEngineOptions } from '../../agent/chatEngine.js';
import {
  applyEngineTurnPreparation,
  compileChatStackForRun,
  compileIntentPlanUserMessage,
  runChatEngineOnce,
} from './chatCore.js';
import { resolveChatEngineLimits } from '../../config/chatEngineLimits.js';
import { resolveChatTaskClass } from '../../config/chatTaskClass.js';
import {
  buildProviderMessages,
  mapProviderMessagesToWire,
  validateProviderMessageProtocol,
} from '../../runners/providerMessages.js';
import type { AgentTargetContext } from '../../services/targetResolver.js';
import type { ProviderMessage } from '../../runners/base.js';

function makeTempProjectDir(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'babel-parity-test-'));
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'test-parity-proj' }, null, 2));
  return tmp;
}

function makeTarget(root: string): AgentTargetContext {
  return {
    targetRoot: root,
    workspaceRoot: null,
    project: null,
    source: 'cwd',
    cwd: root,
  };
}

describe('F2 Parity: Headless vs TUI-reused ChatEngine preparation', () => {
  it('achieves 100% parity on system prompt, intent plan, limits, tools, and wire payload', async () => {
    const projectRoot = makeTempProjectDir();
    const model = 'deepseek-v4-flash';
    const taskTurn2 = 'Fix auth token validation logic in auth.ts and run npm test to verify';

    try {
      // ── Step 1: Simulate TUI turn 1 with a different initial task ───────────
      const taskTurn1 = 'Investigate potential security issues in repository';
      const taskClassTurn1 = resolveChatTaskClass({ taskText: taskTurn1, autoClassify: true });
      const limitsTurn1 = resolveChatEngineLimits({}, undefined, {
        taskClass: taskClassTurn1,
        taskText: taskTurn1,
      });
      const chatStackTurn1 = compileChatStackForRun({
        projectRoot,
        task: taskTurn1,
        model,
      });

      const tuiEngine = new ChatEngine({
        task: taskTurn1,
        projectRoot,
        systemContext: chatStackTurn1.system_context,
        model,
        maxTurns: limitsTurn1.maxTurns,
        maxConversationMessages: limitsTurn1.maxConversationMessages,
        maxEstimatedTokens: limitsTurn1.maxEstimatedTokens,
      });

      // Warm up TUI engine (caches system prompt from turn 1)
      const turn1SystemPrompt = (tuiEngine as any).getOrBuildSystemPrompt('native');
      assert.ok(turn1SystemPrompt.length > 0);
      assert.ok((tuiEngine as any).cachedSystemPromptNative !== null);

      // ── Step 2: Prepare TUI engine for Turn 2 (reuse) ────────────────────────
      const taskClassTurn2 = resolveChatTaskClass({ taskText: taskTurn2, autoClassify: true });
      const limitsTurn2 = resolveChatEngineLimits({}, undefined, {
        taskClass: taskClassTurn2,
        taskText: taskTurn2,
      });
      const chatStackTurn2 = compileChatStackForRun({
        projectRoot,
        task: taskTurn2,
        model,
      });
      const intentPlanUserMessageTurn2 = compileIntentPlanUserMessage(taskTurn2, taskClassTurn2);

      // Apply turn preparation to reused engine
      applyEngineTurnPreparation(tuiEngine, {
        task: taskTurn2,
        systemContext: chatStackTurn2.system_context,
        model,
        limits: limitsTurn2,
        intentPlanUserMessage: intentPlanUserMessageTurn2,
      });

      // ── Step 3: Create Headless Engine directly for Turn 2 ───────────────────
      const headlessEngine = new ChatEngine({
        task: taskTurn2,
        projectRoot,
        systemContext: chatStackTurn2.system_context,
        model,
        maxTurns: limitsTurn2.maxTurns,
        maxConversationMessages: limitsTurn2.maxConversationMessages,
        maxEstimatedTokens: limitsTurn2.maxEstimatedTokens,
        intentPlanUserMessage: intentPlanUserMessageTurn2,
      });

      // ── Parity Assertion 1: System Prompt ──────────────────────────────────
      const headlessSystemPrompt = (headlessEngine as any).getOrBuildSystemPrompt('native');
      const tuiSystemPrompt = (tuiEngine as any).getOrBuildSystemPrompt('native');

      assert.strictEqual(
        tuiSystemPrompt,
        headlessSystemPrompt,
        'Effective native system prompt must be 100% identical between headless and reused TUI engine',
      );
      assert.ok(
        tuiSystemPrompt.includes(chatStackTurn2.system_context),
        'TUI reused engine system prompt must include chatStack.system_context',
      );

      // ── Parity Assertion 2: intentPlanUserMessage ──────────────────────────
      const headlessIntentPlan = (headlessEngine as any).options.intentPlanUserMessage;
      const tuiIntentPlan = (tuiEngine as any).options.intentPlanUserMessage;

      assert.strictEqual(
        tuiIntentPlan,
        headlessIntentPlan,
        'intentPlanUserMessage must be identical between headless and reused TUI engine',
      );
      assert.ok(tuiIntentPlan !== undefined);
      assert.match(tuiIntentPlan, /## Intent Plan/);
      assert.match(tuiIntentPlan, /## First Move/);
      assert.match(tuiIntentPlan, /npm test/);

      // ── Parity Assertion 3: Task-class limits ──────────────────────────────
      const headlessLimits = (headlessEngine as any).limits;
      const tuiLimits = (tuiEngine as any).limits;

      assert.deepStrictEqual(
        tuiLimits,
        headlessLimits,
        'Resolved limits must be identical between headless and reused TUI engine',
      );
      assert.strictEqual((tuiEngine as any).options.maxTurns, (headlessEngine as any).options.maxTurns);
      assert.strictEqual(
        (tuiEngine as any).options.maxConversationMessages,
        (headlessEngine as any).options.maxConversationMessages,
      );
      assert.strictEqual(
        (tuiEngine as any).options.maxEstimatedTokens,
        (headlessEngine as any).options.maxEstimatedTokens,
      );

      // ── Parity Assertion 4: Tool Definitions ───────────────────────────────
      const headlessTools = (headlessEngine as any).services.tools.buildDefinitions();
      const tuiTools = (tuiEngine as any).services.tools.buildDefinitions();

      assert.deepStrictEqual(
        tuiTools,
        headlessTools,
        'Tool schema definitions must be identical between headless and reused TUI engine',
      );

      // ── Parity Assertion 5: Serialized Provider Wire Payloads ──────────────
      // Construct provider wire messages that would be transmitted to the LLM
      const headlessProviderMessages: ProviderMessage[] = [
        { role: 'user', content: taskTurn2 },
        { role: 'user', content: headlessIntentPlan },
      ];
      const tuiProviderMessages: ProviderMessage[] = [
        { role: 'user', content: taskTurn2 },
        { role: 'user', content: tuiIntentPlan },
      ];

      const headlessWire = mapProviderMessagesToWire(headlessProviderMessages, headlessSystemPrompt);
      const tuiWire = mapProviderMessagesToWire(tuiProviderMessages, tuiSystemPrompt);

      assert.deepStrictEqual(
        validateProviderMessageProtocol(headlessWire),
        [],
        'Headless wire messages must satisfy provider protocol',
      );
      assert.deepStrictEqual(
        validateProviderMessageProtocol(tuiWire),
        [],
        'TUI reused wire messages must satisfy provider protocol',
      );
      assert.deepStrictEqual(
        tuiWire,
        headlessWire,
        'Serialized provider wire payloads must be 100% identical between headless and reused TUI engine',
      );
    } finally {
      try {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      } catch {}
    }
  });

  it('runChatEngineOnce automatically applies turn preparation to reused engines', async () => {
    const projectRoot = makeTempProjectDir();
    const target = makeTarget(projectRoot);
    const task = 'Fix the histogram density range calculation';

    try {
      // Create a pre-existing engine
      const initialLimits = resolveChatEngineLimits({}, undefined, { taskClass: 'investigate' });
      const reusedEngine = new ChatEngine({
        task: 'initial investigate task',
        projectRoot,
        maxTurns: initialLimits.maxTurns,
      });

      // Warm up cache
      (reusedEngine as any).getOrBuildSystemPrompt('native');
      assert.ok((reusedEngine as any).cachedSystemPromptNative !== null);

      // Mock submitMessage so the test runs in-process without network
      (reusedEngine as any).submitMessage = async () => ({
        status: 'completed',
        answer: 'reused engine completed',
        usage: {
          promptTokens: 10,
          completionTokens: 10,
          totalTokens: 20,
          costUsd: 0,
        },
        conversation: [],
      });

      // Call runChatEngineOnce passing the existing engine
      const result = await runChatEngineOnce({
        task,
        target,
        engine: reusedEngine,
        useStreaming: false,
        engineFactory: () => {
          throw new Error('Factory should not be called when engine is provided');
        },
      });

      assert.strictEqual(result.status, 'completed');

      // Verify that reusedEngine received the new task, intent plan, limits, and system context
      const expectedTaskClass = resolveChatTaskClass({ taskText: task, autoClassify: false });
      const expectedLimits = resolveChatEngineLimits({}, undefined, {
        taskClass: expectedTaskClass,
        taskText: task,
      });

      assert.strictEqual((reusedEngine as any).options.task, task);
      assert.ok((reusedEngine as any).options.intentPlanUserMessage);
      assert.match((reusedEngine as any).options.intentPlanUserMessage, /## Intent Plan/);
      assert.deepStrictEqual((reusedEngine as any).limits, expectedLimits);
    } finally {
      try {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      } catch {}
    }
  });

  it('dynamically adapts limits from general_swe to quick_fix across engine turns', async () => {
    const projectRoot = makeTempProjectDir();
    try {
      const sweLimits = resolveChatEngineLimits({}, undefined, { taskClass: 'general_swe' });
      const quickFixLimits = resolveChatEngineLimits({}, undefined, { taskClass: 'quick_fix' });

      // general_swe has higher maxTurns than quick_fix
      assert.ok(sweLimits.maxTurns > quickFixLimits.maxTurns);

      const engine = new ChatEngine({
        task: 'Large refactor and migration of subsystem',
        projectRoot,
        maxTurns: sweLimits.maxTurns,
        maxConversationMessages: sweLimits.maxConversationMessages,
        maxEstimatedTokens: sweLimits.maxEstimatedTokens,
      });

      assert.strictEqual((engine as any).limits.maxTurns, sweLimits.maxTurns);

      // Reuse engine for a quick_fix task
      const quickFixTask = 'Fix typo in auth.ts';
      applyEngineTurnPreparation(engine, {
        task: quickFixTask,
        limits: quickFixLimits,
      });

      assert.strictEqual(
        (engine as any).limits.maxTurns,
        quickFixLimits.maxTurns,
        'Engine limits must update to quick_fix maxTurns',
      );
      assert.strictEqual(
        (engine as any).options.maxTurns,
        quickFixLimits.maxTurns,
        'Engine options maxTurns must update to quick_fix maxTurns',
      );
    } finally {
      try {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      } catch {}
    }
  });
});
