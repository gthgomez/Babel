/**
 * ChatEngine service facade.
 *
 * This is the composition boundary shared by chat, plan, and deep profiles.
 * The profiles may choose different orchestration policy, but conversation
 * serialization, tool vocabulary, progress control, and durable event access
 * must come from the same kernel services.
 */

import {
  buildChatSystemPrompt,
  buildChatToolDefinitions,
  buildProviderMessages,
  buildRestrictedChatToolDefinitions,
  buildChatTurnPrompt,
  type ChatSystemPromptOptions,
  type ChatTurnPromptOptions,
} from "./chatToolDefinitions.js";
import type { ToolDefinition } from "../runners/base.js";
import {
  recordAssistantMessage,
  rebuildProviderMessagesFromEvents,
} from "./threadEventLog.js";
import { ProgressController } from "./progressController.js";
import {
  executorToolNameToModel,
  getCanonicalToolMappings,
  modelToolNameToExecutor,
  normalizeExecutorToolName,
  normalizeModelToolName,
} from "./canonicalToolMapping.js";
import { createToolExecutor, type ToolExecutor } from "./toolExecutor.js";

export type ChatExecutionProfile = "chat" | "plan" | "deep";

export interface ChatEngineServices {
  readonly conversation: {
    buildSystemPrompt: (options: ChatSystemPromptOptions) => string;
    buildTurnPrompt: (options: ChatTurnPromptOptions) => string;
    buildProviderMessages: typeof buildProviderMessages;
    rebuildProviderMessages: typeof rebuildProviderMessagesFromEvents;
    recordAssistantMessage: typeof recordAssistantMessage;
  };
  readonly tools: {
    buildDefinitions: () => ToolDefinition[];
    buildRestrictedDefinitions: (
      mode?: "mutate_only" | "act_or_verify",
    ) => ToolDefinition[];
    normalizeModelName: typeof normalizeModelToolName;
    normalizeExecutorName: typeof normalizeExecutorToolName;
    modelToExecutor: typeof modelToolNameToExecutor;
    executorToModel: typeof executorToolNameToModel;
    mappings: typeof getCanonicalToolMappings;
    createExecutor: () => ToolExecutor;
  };
  readonly progress: {
    createController: () => ProgressController;
  };
}

/** Create the shared service graph used by every execution profile. */
export function createChatEngineServices(): ChatEngineServices {
  return {
    conversation: {
      buildSystemPrompt: buildChatSystemPrompt,
      buildTurnPrompt: buildChatTurnPrompt,
      buildProviderMessages,
      rebuildProviderMessages: rebuildProviderMessagesFromEvents,
      recordAssistantMessage,
    },
    tools: {
      buildDefinitions: () => buildChatToolDefinitions(),
      buildRestrictedDefinitions: (mode) =>
        buildRestrictedChatToolDefinitions(mode),
      normalizeModelName: normalizeModelToolName,
      normalizeExecutorName: normalizeExecutorToolName,
      modelToExecutor: modelToolNameToExecutor,
      executorToModel: executorToolNameToModel,
      mappings: getCanonicalToolMappings,
      createExecutor: () => createToolExecutor(),
    },
    progress: {
      createController: () => new ProgressController(),
    },
  };
}

export interface ChatEngineKernel {
  readonly profile: ChatExecutionProfile;
  readonly services: ChatEngineServices;
  readonly mutationsAllowed: boolean;
}

/**
 * Build the profile-independent kernel metadata. Plan is read-only; deep and
 * chat retain mutation capability subject to their existing gates and policy.
 */
export function createChatEngineKernel(
  profile: ChatExecutionProfile = "chat",
  services: ChatEngineServices = createChatEngineServices(),
): ChatEngineKernel {
  return {
    profile,
    services,
    mutationsAllowed: profile !== "plan",
  };
}
