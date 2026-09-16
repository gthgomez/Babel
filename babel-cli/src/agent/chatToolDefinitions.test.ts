import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildChatSystemPrompt,
  buildChatTurnPrompt,
} from "./chatToolDefinitions.js";

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
