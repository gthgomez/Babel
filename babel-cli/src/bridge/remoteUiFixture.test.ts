import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  getRemoteUiFixtureScenario,
  REMOTE_UI_FIXTURE_SCENARIOS,
  startRemoteUiFixtureServer,
} from "./remoteUiFixture.js";

describe("Remote UI deterministic fixtures", () => {
  it("catalogs the required supervisory states with stable identifiers", () => {
    const ids = REMOTE_UI_FIXTURE_SCENARIOS.map(({ id }) => id);
    for (const id of [
      "disconnected",
      "connecting",
      "connected-idle",
      "running",
      "long-transcript",
      "approval-required",
      "approval-denied",
      "changed-files",
      "large-diff",
      "verification-pass",
      "verification-failure",
      "verification-partial",
      "verification-unknown",
      "connection-lost",
      "reconnecting",
      "reconnected",
      "protocol-error",
      "long-prompt",
    ])
      assert.ok(ids.includes(id), `missing fixture scenario ${id}`);
    assert.throws(
      () => getRemoteUiFixtureScenario("does-not-exist"),
      /Unknown Remote UI fixture/,
    );
    assert.notEqual(
      getRemoteUiFixtureScenario("connected-idle"),
      getRemoteUiFixtureScenario("connected-idle"),
    );
  });

  it("serves read-only fixture data and never exposes mutation routes", async () => {
    const server = await startRemoteUiFixtureServer();
    try {
      const shell = await fetch(server.url);
      assert.equal(shell.status, 200);
      assert.match(await shell.text(), /Babel Remote/);
      const config = await fetch(
        `${server.url}/config?scenario=verification-unknown`,
      );
      assert.equal(config.status, 200);
      const payload = (await config.json()) as {
        mode: string;
        scenario: { verification: { status: string } };
      };
      assert.equal(payload.mode, "remote-ui-fixture");
      assert.equal(payload.scenario.verification.status, "UNKNOWN");
      assert.equal(
        (await fetch(`${server.url.replace(/\/fixture$/, "")}/rpc`)).status,
        404,
      );
      assert.equal(
        (await fetch(`${server.url.replace(/\/fixture$/, "")}/ws`)).status,
        404,
      );
    } finally {
      await server.close();
    }
  });
});
