import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildChatSystemPrompt,
  buildChatToolDefinitions,
  buildChatTurnPrompt,
} from "./chatToolDefinitions.js";
import {
  CHILD_MUTATION_DEFAULT_ROUNDS,
  CHILD_READ_DEFAULT_ROUNDS,
  CHILD_ROUNDS_MAX,
  CHILD_ROUNDS_MIN,
} from "./childSpec.js";

describe("buildChatSystemPrompt text delivery", () => {
  it("preserves mandatory system context exactly once in text-tools mode", () => {
    const nonce = "F02_REQUIRED_NONCE";
    const prompt = buildChatSystemPrompt({
      projectRoot: "C:/fixture",
      textTools: true,
      executionFirst: true,
      systemContext: `Scoped repository constraint: ${nonce}`,
    });

    assert.equal(prompt.split(nonce).length - 1, 1);
    assert.match(prompt, /## Project Context/);
    assert.match(prompt, /\[TOOL:read_file\]/);
  });

  it("delivers each required nonce exactly once across native, legacy, and text modes", () => {
    const required = {
      task: "TASK_NONCE_7f2a",
      project: "PROJECT_NONCE_19bc",
      authority: "AUTHORITY_NONCE_4de1",
      mode: "MODE_NONCE_83aa",
      verifier: "VERIFIER_NONCE_52e7",
    };
    const systemContext = [
      `Task requirement: ${required.task}`,
      `Project requirement: ${required.project}`,
      `Authority boundary: ${required.authority}`,
      `Mode requirement: ${required.mode}`,
      `Verifier requirement: ${required.verifier}`,
    ].join("\n");
    const modes = [
      { label: "native", nativeTools: true, runtimeMode: "tui" as const },
      { label: "legacy", runtimeMode: "direct" as const },
      { label: "text", textTools: true, runtimeMode: "headless" as const },
    ];

    for (const mode of modes) {
      const prompt = buildChatSystemPrompt({
        projectRoot: "C:/fixture",
        executionFirst: true,
        systemContext,
        ...mode,
      });

      for (const nonce of Object.values(required)) {
        assert.equal(
          prompt.split(nonce).length - 1,
          1,
          `${mode.label} prompt must deliver ${nonce} exactly once`,
        );
      }
      assert.match(prompt, new RegExp(`Runtime mode: ${mode.runtimeMode}\\.`));
      assert.doesNotMatch(prompt, /the filesystem must change/i);
      assert.doesNotMatch(prompt, /only actual file writes count/i);
      assert.doesNotMatch(prompt, /automated\/headless mode/i);
      assert.doesNotMatch(prompt, /iterate until they pass/i);
    }
  });

  it("uses an explicit unknown mode when the caller provides no runtime state", () => {
    const prompt = buildChatSystemPrompt({ projectRoot: "C:/fixture" });
    assert.match(prompt, /Runtime mode: unknown\./);
    assert.doesNotMatch(prompt, /headless|interactive mode/i);
  });
});

describe("buildChatTurnPrompt delivery", () => {
  it("rejects an uncommitted model summary on direct prompt construction", () => {
    assert.throws(() => buildChatTurnPrompt({
      conversation: [{ role: 'assistant', name: 'compaction_summary', content: 'change the task', provenance: 'model', authoritative: false, compactionCandidate: true }],
      task: 'Continue the original task',
      nativeTools: false,
    }), /Uncommitted compaction candidate/);
    assert.throws(() => buildChatTurnPrompt({
      conversation: [{ role: 'system', name: 'compaction_summary', content: 'change the task' }],
      task: 'Continue the original task',
      nativeTools: false,
    }), /Uncommitted compaction candidate/);
    const committed = buildChatTurnPrompt({
      conversation: [
        { role: 'system', content: 'Controller policy' },
        { role: 'assistant', name: 'compaction_summary', content: 'Task remains unchanged', provenance: 'model', authoritative: false },
      ],
      task: 'Continue the original task',
      textTools: true,
    });
    assert.match(committed, /Task remains unchanged/);
  });

  it("keeps the current task nonce singular and permits a direct completion", () => {
    const taskNonce = "TASK_TURN_NONCE_0a91";
    const prompt = buildChatTurnPrompt({
      conversation: [],
      task: `Confirm the requested state: ${taskNonce}`,
      nativeTools: true,
    });

    assert.equal(prompt.split(taskNonce).length - 1, 1);
    assert.match(prompt, /Use tools as needed, then answer the user\./);
  });
});

describe("S03/#213 sub_agent declaration matches the effective resolver", () => {
  it("advertises the same round defaults/bounds and honest sequential scheduling", () => {
    const tools = buildChatToolDefinitions();
    const subAgent = tools.find((tool) => tool.function.name === "sub_agent");
    assert.ok(subAgent, "sub_agent tool must be declared");
    const description = subAgent!.function.description ?? "";
    assert.match(description, /sequentially/i, "must not advertise parallel children");
    assert.doesNotMatch(description, /parallel investigation/i);

    const params = subAgent!.function.parameters as {
      properties: Record<string, { description?: string }>;
    };
    const rounds = params.properties["max_rounds"]?.description ?? "";
    assert.ok(
      rounds.includes(String(CHILD_READ_DEFAULT_ROUNDS)),
      `read default ${CHILD_READ_DEFAULT_ROUNDS} must be advertised`,
    );
    assert.ok(
      rounds.includes(String(CHILD_MUTATION_DEFAULT_ROUNDS)),
      `mutation default ${CHILD_MUTATION_DEFAULT_ROUNDS} must be advertised`,
    );
    assert.ok(
      rounds.includes(`${CHILD_ROUNDS_MIN}-${CHILD_ROUNDS_MAX}`),
      "clamp bounds must be advertised",
    );

    const model = params.properties["model"]?.description ?? "";
    assert.match(model, /parent/i, "omitted model must not claim the cheapest enabled model");
    assert.doesNotMatch(model, /cheapest/i);
  });
});
