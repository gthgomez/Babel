import assert from "node:assert/strict";
import test from "node:test";

import {
  executorToolNameToModel,
  modelToolNameToExecutor,
  normalizeExecutorToolName,
  normalizeModelToolName,
} from "./canonicalToolMapping.js";
import {
  createChatEngineKernel,
  createChatEngineServices,
} from "./chatEngineServices.js";

test("canonical tool mapping normalizes model aliases to executor names", () => {
  assert.equal(normalizeModelToolName("file-read"), "read_file");
  assert.equal(normalizeModelToolName("shell_exec"), "run_command");
  assert.equal(modelToolNameToExecutor("read_file"), "file_read");
  assert.equal(modelToolNameToExecutor("run_command"), "shell_exec");
  assert.equal(normalizeExecutorToolName("directory-list"), "directory_list");
  assert.equal(executorToolNameToModel("file_write"), "write_file");
});

test("kernel profiles share one service graph while preserving plan read-only intent", () => {
  const services = createChatEngineServices();
  const chat = createChatEngineKernel("chat", services);
  const plan = createChatEngineKernel("plan", services);
  const deep = createChatEngineKernel("deep", services);

  assert.equal(chat.services, plan.services);
  assert.equal(plan.services, deep.services);
  assert.equal(plan.mutationsAllowed, false);
  assert.equal(deep.mutationsAllowed, true);
  assert.ok(
    services.tools
      .buildDefinitions()
      .some((tool) => tool.function.name === "read_file"),
  );
});

test("profile kernel keeps conversation and tool boundaries available to all modes", () => {
  const kernel = createChatEngineKernel("deep");
  assert.equal(kernel.profile, "deep");
  assert.equal(
    typeof kernel.services.conversation.buildProviderMessages,
    "function",
  );
  assert.equal(
    typeof kernel.services.conversation.rebuildProviderMessages,
    "function",
  );
  assert.equal(typeof kernel.services.tools.createExecutor, "function");
  assert.equal(typeof kernel.services.progress.createController, "function");
});
