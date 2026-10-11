import assert from "node:assert/strict";
import test from "node:test";
import { classifyMergeLane } from "../ci-merge-lane.mjs";

test("docs and skill pull requests use the fast lane", () => {
  const lane = classifyMergeLane({
    event: "pull_request",
    files: ["skills/session-retro/SKILL.md", "docs/guide.md", "README.md", ".agents/skills/ship/SKILL.md"],
  });
  assert.deepEqual(lane, { full: false, installer: false });
});

test("runtime, desktop, workflow, and tool changes use the full lane", () => {
  for (const file of ["babel-cli/src/agent/chatEngine.ts", "babel-desktop/package.json", ".github/workflows/typecheck.yml", "tools/ci-merge-lane.mjs", "AGENTS.md"]) {
    const lane = classifyMergeLane({ event: "pull_request", files: ["README.md", file] });
    assert.equal(lane.full, true, file);
    assert.equal(lane.installer, false, file);
  }
});

test("an empty pull request diff fails closed to the full lane", () => {
  assert.deepEqual(classifyMergeLane({ event: "pull_request", files: [] }), { full: true, installer: false });
});

test("full-ci forces the installer and the full lane", () => {
  assert.deepEqual(
    classifyMergeLane({ event: "pull_request", labels: ["full-ci"], files: ["README.md"] }),
    { full: true, installer: true },
  );
});

test("pushes to main run the full lane and the installer", () => {
  assert.deepEqual(classifyMergeLane({ event: "push", files: ["README.md"] }), { full: true, installer: true });
});
