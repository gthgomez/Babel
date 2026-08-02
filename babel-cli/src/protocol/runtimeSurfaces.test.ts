import { test } from "node:test";
import * as assert from "node:assert";
import { Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonIpcServer, ipcRequest } from "../daemon/ipc.js";
import {
  createProtocolHostState,
  handleProtocolRequest,
} from "./client/host.js";
import { ChatEngine } from "../agent/chatEngine.js";
import {
  allocateThreadId,
  ensureThread,
  loadSessionDescriptor,
  resolveNextTurnId,
} from "../services/threadStore/index.js";

test("protocol host stub handles turn.submit with simulated events", async () => {
  const state = createProtocolHostState();
  const threadId = allocateThreadId();
  ensureThread(threadId, { project_root: process.cwd() });

  const engine = new ChatEngine({ task: "test", projectRoot: process.cwd() });
  engine.assignRunId(threadId);
  state.engines.set(threadId, engine);

  // Replace submitMessageStream with a mock
  engine.submitMessageStream = async function* (message: string) {
    yield { type: "thinking" };
    yield { type: "answer_chunk", text: "hello" };
    yield { type: "done", answer: "hello", usage: {} as any };
  } as any;

  const notifications: any[] = [];
  const response = await handleProtocolRequest(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "turn.submit",
      params: { thread_id: threadId, message: "hi" },
    } as any,
    state,
    (notif) => notifications.push(notif),
  );

  assert.ok(!("error" in response) && response.result);

  // Wait for async events to finish
  await new Promise((r) => setTimeout(r, 50));

  assert.ok(notifications.length > 0);
  assert.strictEqual(notifications[0].method, "turn.event");
  assert.strictEqual(notifications[0].params.event.type, "thinking");
  assert.strictEqual(notifications[1].params.event.type, "answer_chunk");

  // Disconnect shouldn't crash the server state
  const nextTurnId = resolveNextTurnId(threadId); // should be 1 because mock didn't write to DB
  assert.strictEqual(nextTurnId, 1);
});

export async function customIpcRequest(
  method: string,
  params?: Record<string, unknown>,
  port?: number,
): Promise<unknown> {
  const { connect } = await import("node:net");
  return new Promise((resolve, reject) => {
    const socket = connect(port ?? 45123, "127.0.0.1");
    let buffer = "";
    socket.on("connect", () => {
      socket.write(JSON.stringify({ id: Date.now(), method, params }) + "\n");
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      if (buffer.includes("\n")) {
        const response = JSON.parse(buffer.split("\n")[0]!);
        if (response.error) reject(new Error(response.error.message));
        else resolve(response.result);
        socket.end();
      }
    });
    socket.on("error", reject);
  });
}

test("daemon ipc handles protocol methods", async () => {
  // Test daemon/main style wiring
  const server = new DaemonIpcServer();
  const state = createProtocolHostState();

  server.on("thread.create", async (params, socket) => {
    const res = await handleProtocolRequest(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "thread.create",
        params: params as any,
      } as any,
      state,
      () => {},
    );
    return (res as any).result;
  });

  server.on("thread.resume", async (params, socket) => {
    const res = await handleProtocolRequest(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "thread.resume",
        params: params as any,
      } as any,
      state,
      () => {},
    );
    return (res as any).result;
  });

  await server.listen({ host: "127.0.0.1", port: 0 });
  const port = (server as any).server.address().port;

  const result = await customIpcRequest(
    "thread.create",
    { project_root: process.cwd() },
    port,
  );
  assert.ok((result as any).thread_id);

  const resumeResult = await customIpcRequest(
    "thread.resume",
    {
      thread_id: String((result as any).thread_id),
      project_root: process.cwd(),
    },
    port,
  );
  assert.strictEqual(
    (resumeResult as any).thread_id,
    (result as any).thread_id,
  );
  assert.strictEqual(typeof (resumeResult as any).turn_count, "number");

  await server.close();
});

test("thread.create durably registers a reconstructible runtime and disconnect does not cancel work", async () => {
  const previousRunsDir = process.env["BABEL_RUNS_DIR"];
  const runsDir = await mkdtemp(join(tmpdir(), "babel-protocol-runtime-"));
  process.env["BABEL_RUNS_DIR"] = runsDir;
  let executed = 0;
  const fakeEngine = {
    assignRunId: () => undefined,
    cancel: () => undefined,
    async *submitMessageStream() {
      executed += 1;
      yield { type: "thinking" };
      yield { type: "done", answer: "ok", usage: {} };
    },
  } as unknown as ChatEngine;
  const state = createProtocolHostState({
    engineFactory: () => fakeEngine,
    executeWithoutNotifications: true,
  });

  try {
    const created = await handleProtocolRequest(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "thread.create",
        params: {
          project_root: process.cwd(),
          mode: "chat",
          provider: "mock",
          model: "deterministic",
        },
      },
      state,
      () => undefined,
    );
    const threadId = (created as { result: { thread_id: string } }).result
      .thread_id;
    const descriptor = loadSessionDescriptor(threadId);
    assert.equal(descriptor?.mode, "chat");
    assert.equal(descriptor?.provider, "mock");
    assert.equal(state.descriptors.has(threadId), true);
    assert.equal(
      state.engines.has(threadId),
      false,
      "materialization may be lazy but descriptor must be present",
    );

    const submitted = await handleProtocolRequest(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "turn.submit",
        params: { thread_id: threadId, message: "continue" },
      },
      state,
      () => {
        throw new Error("client disconnected");
      },
    );
    assert.ok("result" in submitted);

    for (let i = 0; i < 20 && state.activeTurns.has(threadId); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(executed, 1);
    assert.equal(state.activeTurns.has(threadId), false);
    assert.equal(state.engines.has(threadId), true);
  } finally {
    if (previousRunsDir === undefined) delete process.env["BABEL_RUNS_DIR"];
    else process.env["BABEL_RUNS_DIR"] = previousRunsDir;
    await rm(runsDir, { recursive: true, force: true });
  }
});
