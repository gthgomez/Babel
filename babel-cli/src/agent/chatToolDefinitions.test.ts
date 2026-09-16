import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildChatSystemPrompt } from "./chatToolDefinitions.js";

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
});
