/**
 * Deterministic, no-credentials Remote UI fixture server.
 *
 * This is intentionally separate from BridgeServer. It serves the real PWA
 * shell plus read-only scenario data on a loopback-only development port. It
 * never creates a session, opens a provider, accepts a token, or mutates a
 * workspace.
 */

import { createServer, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";

import { assertLoopbackBind, assertRemoteListenConfig } from "./bindGuard.js";
import { resolveRemoteUiDir, writeRemoteUiResponse } from "./remoteUiAssets.js";

export type RemoteUiFixtureStatus =
  | "VERIFIED"
  | "FAILED"
  | "PARTIAL"
  | "NOT_VERIFIED"
  | "UNKNOWN";

export interface RemoteUiFixtureEvent {
  type: string;
  text?: string;
  tool?: string;
  target?: string;
  error?: string;
  role?: "user" | "assistant" | "tool" | "system";
}

export interface RemoteUiFixtureScenario {
  id: string;
  label: string;
  host: "UNKNOWN" | "CONNECTING" | "ONLINE" | "OFFLINE" | "RECONNECTING";
  thread: "NONE" | "READY" | "RUNNING" | "WAITING_APPROVAL" | "FAILED";
  turn: "IDLE" | "STREAMING" | "COMPLETED" | "FAILED" | "UNKNOWN";
  approval: "NONE" | "PENDING" | "RESOLVED";
  workspace: string;
  harness: string;
  threadId: string;
  action: string;
  actionDetail: string;
  transcript: RemoteUiFixtureEvent[];
  files: Array<{ status: string; path: string }>;
  diff: string;
  verification: { status: RemoteUiFixtureStatus; reason: string };
  approvalRequest?: {
    actionType: string;
    command: string;
    cwd: string;
    targetPath: string;
    digest: string;
  };
  reconnectLabel?: string;
  longPrompt?: string;
}

const LONG_PATH =
  "workspace/projects/babel-monorepo/packages/remote-control/src/features/supervisory-session/recovery/connection-boundary.ts";

const LARGE_DIFF = [
  "diff --git a/babel-cli/src/bridge/remote-ui/app.js b/babel-cli/src/bridge/remote-ui/app.js",
  "index 03aa111..09bb222 100644",
  "--- a/babel-cli/src/bridge/remote-ui/app.js",
  "+++ b/babel-cli/src/bridge/remote-ui/app.js",
  "@@ -118,18 +118,47 @@ function renderChrome() {",
  "+  renderStatusSummary();",
  "+  renderConnectionRecovery();",
  "+  renderVerificationState();",
  ...Array.from(
    { length: 38 },
    (_, index) =>
      `${index % 3 === 0 ? "+" : index % 3 === 1 ? "-" : " "}const stableFixtureLine${String(index + 1).padStart(2, "0")} = 'responsive remote state ${index + 1}';`,
  ),
  "@@ -248,7 +277,19 @@ function observeThread() {",
  "+  if (fixtureMode) return;",
  "+  await recoverHistoryWithoutResubmitting();",
].join("\n");

const LONG_PROMPT = [
  "Please review the Remote connection recovery path and make the smallest safe change.",
  "",
  "Constraints:",
  ...Array.from(
    { length: 18 },
    (_, index) =>
      `${index + 1}. Preserve the loopback-only bind, single-use ticket, and in-memory token boundary while checking ${LONG_PATH}.`,
  ),
].join("\n");

function baseScenario(
  overrides: Partial<RemoteUiFixtureScenario> &
    Pick<RemoteUiFixtureScenario, "id" | "label">,
): RemoteUiFixtureScenario {
  const { id, label, ...custom } = overrides;
  return {
    id,
    label,
    host: "ONLINE",
    thread: "READY",
    turn: "IDLE",
    approval: "NONE",
    workspace: "workspace/Babel",
    harness: "Babel native",
    threadId: "remote-thread-042",
    action: "Ready for your next instruction",
    actionDetail: "The host is connected and no turn is running.",
    transcript: [
      {
        type: "system",
        role: "system",
        text: "Remote session connected. Host remains authoritative.",
      },
      {
        type: "user",
        role: "user",
        text: "Review the latest changes and tell me what still needs attention.",
      },
      {
        type: "assistant",
        role: "assistant",
        text: "I am ready to inspect the workspace when you send a prompt.",
      },
    ],
    files: [],
    diff: "No diff loaded yet. Choose “View diff” after a turn completes.",
    verification: {
      status: "NOT_VERIFIED",
      reason: "No verification has been recorded for this thread.",
    },
    ...custom,
  };
}

export const REMOTE_UI_FIXTURE_SCENARIOS: readonly RemoteUiFixtureScenario[] = [
  baseScenario({
    id: "disconnected",
    label: "Disconnected",
    host: "OFFLINE",
    thread: "NONE",
    action: "Host unavailable",
    actionDetail:
      "The bridge did not answer. Reconnect only after checking the host.",
    transcript: [
      {
        type: "connection",
        role: "system",
        error: "Host unavailable. No request was sent.",
      },
    ],
  }),
  baseScenario({
    id: "connecting",
    label: "Connecting",
    host: "CONNECTING",
    thread: "NONE",
    action: "Opening secure session",
    actionDetail:
      "Checking host reachability before opening a WebSocket ticket.",
    transcript: [
      {
        type: "connection",
        role: "system",
        text: "Connecting to the loopback bridge through the configured private route…",
      },
    ],
  }),
  baseScenario({ id: "connected-idle", label: "Connected / idle" }),
  baseScenario({
    id: "running",
    label: "Turn running",
    thread: "RUNNING",
    turn: "STREAMING",
    action: "Inspecting repository",
    actionDetail: "tool: rg · searching Remote surfaces and validation scripts",
    transcript: [
      {
        type: "user",
        role: "user",
        text: "Audit the Remote UI at narrow phone widths and preserve the security boundary.",
      },
      {
        type: "tool_start",
        role: "tool",
        tool: "rg",
        target: "babel-cli/src/bridge/remote-ui",
      },
      {
        type: "answer_chunk",
        role: "assistant",
        text: "I found the existing PWA shell. Next I am checking its responsive constraints and safe text rendering.",
      },
    ],
  }),
  baseScenario({
    id: "streaming",
    label: "Streaming response",
    thread: "RUNNING",
    turn: "STREAMING",
    action: "Writing response",
    actionDetail: "Streaming structured answer chunks to this thread.",
    transcript: [
      {
        type: "user",
        role: "user",
        text: "Explain the failing verification result in plain language.",
      },
      {
        type: "answer_chunk",
        role: "assistant",
        text: "The verification step is still running. I will keep the state visible until a terminal result arrives.",
      },
      {
        type: "answer_chunk",
        role: "assistant",
        text: "No success is implied while the result is incomplete.",
      },
    ],
  }),
  baseScenario({
    id: "long-transcript",
    label: "Long transcript",
    thread: "READY",
    turn: "COMPLETED",
    action: "Turn complete",
    actionDetail: "The latest response completed. Review the evidence below.",
    transcript: Array.from({ length: 22 }, (_, index) => ({
      type:
        index % 4 === 0
          ? "user"
          : index % 4 === 1
            ? "tool_start"
            : "answer_chunk",
      role: index % 4 === 0 ? "user" : index % 4 === 1 ? "tool" : "assistant",
      text:
        index % 4 === 1
          ? `npm test -- remote/ui/${index + 1}`
          : `Checkpoint ${index + 1}: preserved structured events, readable paths, and explicit verification semantics. ${index % 3 === 0 ? "The long line stays contained without forcing the page wider than the viewport." : ""}`,
    })),
  }),
  baseScenario({
    id: "approval-required",
    label: "Approval required",
    thread: "WAITING_APPROVAL",
    turn: "STREAMING",
    approval: "PENDING",
    action: "Waiting for your approval",
    actionDetail:
      "A consequential action is paused. Review the exact operation before deciding.",
    transcript: [
      {
        type: "tool_start",
        role: "tool",
        tool: "write_file",
        target: LONG_PATH,
      },
    ],
    approvalRequest: {
      actionType: "write_file",
      command: "",
      cwd: "workspace/Babel",
      targetPath: LONG_PATH,
      digest: "fixture-digest-allow-once-0001",
    },
  }),
  baseScenario({
    id: "approval-denied",
    label: "Approval denied",
    thread: "READY",
    turn: "COMPLETED",
    approval: "RESOLVED",
    action: "Action denied",
    actionDetail: "The requested operation was not executed.",
    transcript: [
      {
        type: "permission",
        role: "system",
        text: "DENY recorded. No mutation was performed.",
      },
    ],
  }),
  baseScenario({
    id: "changed-files",
    label: "Changed files",
    thread: "READY",
    turn: "COMPLETED",
    action: "Changes ready to review",
    actionDetail: "Three files changed in the active workspace.",
    files: [
      { status: "M", path: "babel-cli/src/bridge/remote-ui/index.html" },
      { status: "M", path: "babel-cli/src/bridge/remote-ui/styles.css" },
      { status: "A", path: "babel-cli/src/bridge/remoteUiFixture.ts" },
    ],
    verification: {
      status: "PARTIAL",
      reason: "Typecheck passed; physical Android behavior is not verified.",
    },
  }),
  baseScenario({
    id: "large-diff",
    label: "Large diff",
    thread: "READY",
    turn: "COMPLETED",
    action: "Large diff available",
    actionDetail:
      "Review file boundaries and use horizontal scrolling only for code lines that need it.",
    files: [{ status: "M", path: "babel-cli/src/bridge/remote-ui/app.js" }],
    diff: LARGE_DIFF,
  }),
  baseScenario({
    id: "verification-pass",
    label: "Verification pass",
    thread: "READY",
    turn: "COMPLETED",
    action: "Verification passed",
    actionDetail: "All declared checks completed successfully.",
    verification: {
      status: "VERIFIED",
      reason: "typecheck · remote tests · browser checks",
    },
  }),
  baseScenario({
    id: "verification-failure",
    label: "Verification failure",
    thread: "FAILED",
    turn: "FAILED",
    action: "Verification failed",
    actionDetail: "The result is actionable, but it is not a successful turn.",
    verification: {
      status: "FAILED",
      reason: "2 checks failed · inspect the transcript and changed files",
    },
    transcript: [
      {
        type: "failed",
        role: "system",
        error: "npm run test:remote-ui exited with code 1",
      },
    ],
  }),
  baseScenario({
    id: "verification-partial",
    label: "Partial / not verified",
    action: "Evidence incomplete",
    actionDetail: "Some checks completed; do not treat this as a green result.",
    verification: {
      status: "PARTIAL",
      reason:
        "Browser coverage passed; physical Android certification remains open.",
    },
  }),
  baseScenario({
    id: "verification-unknown",
    label: "Unknown verification",
    action: "Verification state unknown",
    actionDetail: "The host did not provide a trustworthy terminal result.",
    verification: {
      status: "UNKNOWN",
      reason: "The connection ended before verification status was received.",
    },
  }),
  baseScenario({
    id: "connection-lost",
    label: "Connection lost",
    host: "OFFLINE",
    thread: "RUNNING",
    turn: "UNKNOWN",
    action: "Connection lost during turn",
    actionDetail:
      "Outcome is ambiguous. The client will not silently resubmit the request.",
    reconnectLabel: "Resume to reconcile",
    transcript: [
      {
        type: "connection",
        role: "system",
        error:
          "Transport closed while the turn was running. Outcome is UNKNOWN.",
      },
    ],
  }),
  baseScenario({
    id: "reconnecting",
    label: "Reconnecting",
    host: "RECONNECTING",
    thread: "READY",
    action: "Reconnecting to host",
    actionDetail:
      "Recovering the thread history without resubmitting a mutation.",
    reconnectLabel: "Retry connection",
  }),
  baseScenario({
    id: "reconnected",
    label: "Reconnected",
    reconnectLabel: "Connected",
    action: "Session recovered",
    actionDetail:
      "History was reconciled. The next prompt will use a new command id.",
  }),
  baseScenario({
    id: "protocol-error",
    label: "Protocol error",
    host: "ONLINE",
    thread: "FAILED",
    turn: "UNKNOWN",
    action: "Protocol error",
    actionDetail:
      "The host sent an invalid or unsupported message. State is fail-closed.",
    transcript: [
      {
        type: "protocol_error",
        role: "system",
        error: "Malformed fixture message rejected; no action was taken.",
      },
    ],
  }),
  baseScenario({
    id: "long-prompt",
    label: "Very long prompt",
    longPrompt: LONG_PROMPT,
    action: "Composer ready",
    actionDetail:
      "Long structured text remains available for review before sending.",
  }),
];

export function getRemoteUiFixtureScenario(
  id: string | null | undefined,
): RemoteUiFixtureScenario {
  const requested = id ?? "connected-idle";
  const scenario = REMOTE_UI_FIXTURE_SCENARIOS.find(
    (candidate) => candidate.id === requested,
  );
  if (!scenario)
    throw new Error(`Unknown Remote UI fixture scenario: ${requested}`);
  return structuredClone(scenario);
}

function sendText(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: string,
): void {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'",
  });
  res.end(body);
}

export interface RemoteUiFixtureServer {
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

export async function startRemoteUiFixtureServer(
  options: { port?: number } = {},
): Promise<RemoteUiFixtureServer> {
  assertRemoteListenConfig();
  const host = "127.0.0.1";
  assertLoopbackBind(host);
  const server: Server = createServer((req, res) => {
    let url: URL;
    try {
      url = new URL(
        req.url ?? "/",
        `http://${req.headers.host ?? `${host}:0`}`,
      );
    } catch {
      sendText(res, 400, "text/plain; charset=utf-8", "Invalid request URL");
      return;
    }

    if (req.method !== "GET") {
      sendText(
        res,
        405,
        "text/plain; charset=utf-8",
        "Fixture server is read-only",
      );
      return;
    }

    if (url.pathname === "/fixture" || url.pathname === "/fixture/") {
      const index = readFileSync(`${resolveRemoteUiDir()}/index.html`, "utf8");
      sendText(res, 200, "text/html; charset=utf-8", index);
      return;
    }

    if (url.pathname === "/fixture/config") {
      try {
        sendText(
          res,
          200,
          "application/json; charset=utf-8",
          JSON.stringify({
            mode: "remote-ui-fixture",
            scenario: getRemoteUiFixtureScenario(
              url.searchParams.get("scenario"),
            ),
          }),
        );
      } catch (error) {
        sendText(
          res,
          404,
          "application/json; charset=utf-8",
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      return;
    }

    if (
      url.pathname === "/rpc" ||
      url.pathname.startsWith("/ws") ||
      url.pathname.startsWith("/sessions")
    ) {
      sendText(
        res,
        404,
        "text/plain; charset=utf-8",
        "Fixture server exposes no Remote mutation or transport endpoints",
      );
      return;
    }

    if (url.pathname === "/ui" || url.pathname.startsWith("/ui/")) {
      if (writeRemoteUiResponse(url.pathname, res)) return;
    }

    sendText(res, 404, "text/plain; charset=utf-8", "Not found");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Fixture server did not expose a TCP address");
  }

  return {
    port: address.port,
    url: `http://${host}:${address.port}/fixture`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
