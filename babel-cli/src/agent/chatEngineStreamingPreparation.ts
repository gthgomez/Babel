import type {
  ChatEvent,
  ChatEngineStreamingLoopHost,
  SubmitMessageOptions,
  TaskIntent,
} from "./chatEngine.js";
import type { TaskOperation } from "../config/chatTaskClass.js";
import { formatPlanHandoffUserMessage } from "./planExecuteMode.js";
import { evaluateSubmitTaskAuthorityHalt } from "./chatEngineLiveSession.js";
import { parityOnUserTurn } from "./chatEngineParityBridge.js";
import { recordUserMessage } from "./threadEventLog.js";
import { ChatTurnTelemetryCollector } from "./chatTurnTelemetry.js";

/** Prepare one user submission before its first streaming attempt. */
export async function prepareStreamingSubmission(
  host: ChatEngineStreamingLoopHost,
  userInput: string,
  taskIntent?: TaskIntent,
  submitOpts?: SubmitMessageOptions,
) {
  // R0-7/R0-8: every submission owns a distinct generation. The non-stream
  // adapter supplies the generation it already incremented; a direct
  // streaming caller gets a fresh one here (the admission wrapper above
  // pre-computes it, so this adopts rather than increments). All ownership
  // guards compare against this value, so a superseded generator can neither
  // continue the loop nor let a late async continuation write the new task's state.
  const submissionGeneration =
    submitOpts?.submissionGeneration ?? ++host.generationCounter;
  host.activeSubmissionGeneration = submissionGeneration;
  host._cancelled = false;
  host.preparedAdmissionCompactionAttempts = 0;
  host.currentTurnTelemetry = new ChatTurnTelemetryCollector(performance.now());
  host.currentTurnTelemetry.markStarted();
  host.lastRequestPromptTokens = null;
  host.lastRequestCompletionTokens = null;
  host.lastRequestModelId = null;
  // W0.3: fresh TurnRuntime per user submission (isolate counters by default).
  const runtime = host.applyUserSubmission({
    userInput,
    ...(taskIntent !== undefined ? { taskIntent } : {}),
    ...(submitOpts?.continueTask !== undefined
      ? { continueTask: submitOpts.continueTask }
      : {}),
  });
  // D01/S01/M2: one effective-operation policy for this accepted submission,
  // resolved BEFORE any generated guidance is appended. TaskShape is
  // authoritative (derived from the same classifier that sets taskClass), so
  // read-only gating, preparation fuses, progress scoring, loop-control and
  // finalization all consume this decision.
  //
  // There are still two *inputs* by design: `resolvedIntent` is the legacy
  // text-intent classifier (`classifyChatTaskIntent`) and TaskShape is the
  // operation classifier. Neither is a second authority: `effectiveOperation`
  // (TaskShape) dominates, and `effectiveExecutePolicy` below ANDs the two so
  // the legacy `execute` label can never re-add mutation pressure to a
  // READ_ONLY shape. Zero-write is safe for the same reason — its
  // `executeIntent` is `effectiveExecutePolicy`, so a read-only shape cannot
  // reach the zero-write terminal even where a class tune left the threshold
  // non-zero. Older hydrated snapshots without the field fall back to their
  // persisted shape; unknown defaults to MUTATING (fail-safe: never silently
  // loosens mutation pressure).
  const effectiveOperation: TaskOperation =
    runtime.effectiveOperation ?? runtime.taskShape?.operation ?? "MUTATING";
  const isReadOnlyInspection = effectiveOperation === "READ_ONLY";

  host.conversation.push({ role: "user", content: userInput });
  // S01/#211: harness-generated repair guidance is only ever injected for an
  // execute-like operation. A READ_ONLY submission never receives the
  // generated edit mandate, and the injected text identifies itself as
  // guidance rather than user authorization (see compileIntentPlanUserMessage).
  if (host.options.intentPlanUserMessage && !isReadOnlyInspection)
    host.conversation.push({
      role: "user",
      content: host.options.intentPlanUserMessage,
    });
  // Implementor: inject plan→execute handoff once at first user message of session.
  if (host.planHandoff && host._turnIndex === 0) {
    host.conversation.push({
      role: "user",
      content: formatPlanHandoffUserMessage(host.planHandoff),
    });
    host.policyEventLog.record({
      at_turn: 0,
      kind: "progress_policy",
      detail: `plan_execute_handoff:${host.planHandoff.planId}`,
    });
  }
  // R11: Reset text-only turn counter for each new submitMessageStream round.
  host.stallState = { ...host.stallState, textOnlyTurns: 0 };

  const resolvedIntent = runtime.taskIntent;

  // F1/C1: finalization and loop-control consume the same effective operation
  // policy as gating/fuses/progress. The legacy text classifier can say
  // `execute` for a READ_ONLY TaskShape (bare "how to fix …", fenced evidence
  // with no directive), and such a submission must not be pressed to patch,
  // gated as an execute task, or fed a mutation-oriented critic.
  const effectiveExecutePolicy =
    resolvedIntent === "execute" && !isReadOnlyInspection;
  const effectiveIntent: TaskIntent = effectiveExecutePolicy
    ? "execute"
    : "explain";

  const authorityHalt = evaluateSubmitTaskAuthorityHalt(host.parity, userInput);
  if (authorityHalt) return { halted: true, haltEvent: authorityHalt } as const;

  // P1: open parity turn (loop + durable event log)
  // Record the resolved provider/model, not the backend shorthand supplied
  // by the caller. This is the first durable route fact for exact-lock runs;
  // later runner metadata records what was actually sent and observed.
  const modelName =
    host.modelPolicy?.providerModelId ??
    host.options.model ??
    host.modelPolicy?.family ??
    "unknown";
  const providerName =
    host.modelPolicy?.provider ??
    (modelName.toLowerCase().includes("deepseek")
      ? "deepseek"
      : modelName.toLowerCase().includes("ollama")
        ? "ollama"
        : "deepinfra");
  parityOnUserTurn(host.parity, {
    task: userInput,
    model: modelName,
    provider: providerName,
    projectRoot: host.options.projectRoot,
    policyPreset: "workspace_write",
    taskClass: runtime.taskClass,
    gatePolicy: runtime.gatePolicy ?? host.gatePolicy ?? "required",
    submissionIndex: runtime.submissionIndex,
    continuedTask: runtime.continuedTask,
  });
  if (
    host.options.intentPlanUserMessage &&
    !isReadOnlyInspection &&
    host.parity.turnId
  ) {
    recordUserMessage(
      host.parity.eventLog,
      host.parity.turnId,
      host.options.intentPlanUserMessage,
    );
  }
  // S04/#214 C1: the turn's execution context is scoped per step by
  // `submitMessageStream` (scopeAsyncGenerator), so no context survives the
  // turn and no global turn id has to be set or restored here.

  // R4: Fire-and-forget repo map generation, awaited before first LLM call
  const repoMapPromise =
    host.repoMapCache === null
      ? host
          .generateRepoMap()
          .then((map) => {
            // R0-8: a repository map produced for a superseded submission
            // must not seed the current task's cached context.
            if (map && host.isSubmissionCurrent(submissionGeneration)) {
              host.repoMapCache = map;
            }
          })
          .catch(() => {
            /* best-effort */
          })
      : Promise.resolve();

  if (
    host.conversation.length === 1 ||
    host.conversation[0]?.role !== "system"
  ) {
    // R4: Await repo map first so it's included in the system prompt
    await repoMapPromise;
    // R0-8: the repo-map await is a suspension point; a superseded generator
    // must not install its system turn or active-execution ownership.
    if (!host.isSubmissionCurrent(submissionGeneration))
      return { halted: true, haltEvent: null } as const;
    const useNativeInit = host.shouldUseNativeTools(
      host.resolveDeliberationRunner(),
    );
    const useTextInit = !useNativeInit && host.shouldUseTextTools();
    // P3: native preferred; legacy Markdown flatten only when no native tools
    const systemContent = host.getOrBuildSystemPrompt(
      useNativeInit ? "native" : useTextInit ? "text" : "legacy",
    );
    host.conversation.unshift({ role: "system", content: systemContent });
  }

  const maxTurns = Math.max(
    0,
    (host.taskAllowance?.grant.turnCap ?? host.limits.maxTurns) -
      (host.taskAllowance?.consumed.turns ?? 0),
  );
  host._sessionStartTime = Date.now();
  host.beginActiveExecution();

  return {
    halted: false,
    haltEvent: null,
    submissionGeneration,
    runtime,
    effectiveOperation,
    isReadOnlyInspection,
    resolvedIntent,
    effectiveExecutePolicy,
    effectiveIntent,
    modelName,
    providerName,
    repoMapPromise,
    maxTurns,
  };
}
