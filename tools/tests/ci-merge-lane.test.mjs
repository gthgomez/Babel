import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyMergeLane,
  trustedPathForcesFullLane,
  installerSensitiveChange,
} from "../ci-merge-lane.mjs";

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

test("installer-sensitive desktop paths require installer qualification", () => {
  for (const file of [
    "babel-desktop/scripts/package-windows-setup.mjs",
    "babel-desktop/test/installer-lifecycle/run-lifecycle.ps1",
    ".github/workflows/release.yml",
  ]) {
    assert.equal(installerSensitiveChange([file]), true, file);
    const lane = classifyMergeLane({ event: "pull_request", files: [file] });
    assert.equal(lane.full, true, file);
    assert.equal(lane.installer, true, file);
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

test("trusted paths block unsafe fast-lane downgrade even for docs-only diffs", () => {
  assert.equal(
    trustedPathForcesFullLane(["README.md", ".github/workflows/typecheck.yml"]),
    true,
  );
  const lane = classifyMergeLane({
    event: "pull_request",
    files: ["README.md", ".github/workflows/typecheck.yml"],
  });
  assert.deepEqual(lane, { full: true, installer: false });
});

test("editing the merge-lane classifier cannot classify workflow changes into the fast lane", () => {
  const files = ["tools/ci-merge-lane.mjs", "README.md"];
  assert.equal(trustedPathForcesFullLane(files), true);
  assert.deepEqual(classifyMergeLane({ event: "pull_request", files }), { full: true, installer: false });
});

test("prompt_catalog changes stay on the full lane", () => {
  assert.deepEqual(
    classifyMergeLane({ event: "pull_request", files: ["prompt_catalog.yaml"] }),
    { full: true, installer: false },
  );
});
