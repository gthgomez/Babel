import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { routeShellInput, type ShellInputState } from "./shellInputRouter.js";
import {
  buildShellFrameInput,
  type ShellPanelSnapshot,
} from "./shellPanels.js";
import { planShellLayout } from "./shellLayout.js";
import {
  projectShellPresentation,
  type ShellPresentation,
} from "./shellPresentation.js";
import { composeShellRows } from "./shellFrameRenderer.js";
import { stripAnsi, supportsColor } from "../theme.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

function key(name: string, overrides: { shift?: boolean } = {}) {
  return {
    name,
    ctrl: false,
    meta: false,
    shift: overrides.shift ?? false,
    sequence: name,
  };
}

const base: ShellInputState = {
  focus: "composer",
  leftDrawerOpen: true,
  rightDrawerOpen: true,
};

function snapshot(presentation: ShellPresentation): ShellPanelSnapshot & {
  presentation: ShellPresentation;
} {
  return {
    mode: "chat",
    model: "auto",
    project: "Babel",
    conversation: ["  conversation"],
    prompt: { rows: ["› draft"], cursor: { row: 0, col: 7, visible: true } },
    presentation,
  };
}

test("projection exposes drawer-backed surfaces and selected focus in one effective state", () => {
  const presentation = projectShellPresentation(
    planShellLayout({ cols: 160, rows: 40 }),
    base,
  );

  assert.deepEqual(presentation.availableSurfaces, [
    "composer",
    "sessions",
    "project",
    "actions",
    "inspector",
    "conversation",
  ]);
  assert.equal(presentation.focus, "composer");
  assert.equal(presentation.selectedSurface, "composer");
  assert.equal(presentation.leftDrawerOpen, true);
  assert.equal(presentation.rightDrawerOpen, true);
});

test("resize reconciles focus to a visible surface and routing uses that same state", () => {
  const layout = planShellLayout({ cols: 80, rows: 20 });
  const presentation = projectShellPresentation(layout, {
    ...base,
    focus: "inspector",
  });

  assert.deepEqual(presentation.availableSurfaces, [
    "composer",
    "conversation",
  ]);
  assert.equal(presentation.focus, "composer");
  assert.equal(
    routeShellInput(key("a"), presentation.inputState).handled,
    false,
  );
  assert.equal(
    routeShellInput(key("f6"), presentation.inputState).state.focus,
    "conversation",
  );
});

test("focus changes and Escape change the rendered frame and close both drawers", () => {
  const layout = planShellLayout({ cols: 160, rows: 40 });
  const focused = projectShellPresentation(layout, {
    ...base,
    focus: "sessions",
  });
  const focusedFrame = buildShellFrameInput(layout, snapshot(focused));
  const composerFrame = buildShellFrameInput(
    layout,
    snapshot(projectShellPresentation(layout, base)),
  );

  assert.notDeepEqual(
    composeShellRows(focusedFrame),
    composeShellRows(composerFrame),
  );
  assert.equal(focusedFrame.cursor?.visible, false);
  const leftRow =
    focusedFrame.surfaces.find((surface) => surface.id === "left")?.rows[0] ??
    "";
  assert.match(stripAnsi(leftRow), /^›\s*SESSIONS/);

  const conversationFrame = buildShellFrameInput(
    layout,
    snapshot(
      projectShellPresentation(layout, { ...base, focus: "conversation" }),
    ),
  );
  const conversationRow =
    conversationFrame.surfaces.find((surface) => surface.id === "conversation")
      ?.rows[0] ?? "";
  assert.match(stripAnsi(conversationRow), /^›\s*CONVERSATION/);

  if (supportsColor()) {
    assert.match(leftRow, /\x1b\[/);
    assert.match(conversationRow, /\x1b\[/);
  } else {
    assert.equal(leftRow, stripAnsi(leftRow));
    assert.equal(conversationRow, stripAnsi(conversationRow));
  }

  const closedState = routeShellInput(key("escape"), focused.inputState).state;
  const closed = projectShellPresentation(layout, closedState);
  const closedFrame = buildShellFrameInput(layout, snapshot(closed));

  assert.equal(closed.leftDrawerOpen, false);
  assert.equal(closed.rightDrawerOpen, false);
  assert.equal(closedFrame.cursor?.visible, true);
  assert.deepEqual(
    closedFrame.surfaces.map((surface) => surface.id),
    ["header", "conversation", "composer", "footer"],
  );
  assert.equal(
    closedFrame.rules?.some((rule) => rule.orientation === "vertical"),
    false,
  );
});

test("non-composer focus blocks composer keys after projection", () => {
  const layout = planShellLayout({ cols: 160, rows: 40 });
  const presentation = projectShellPresentation(layout, {
    ...base,
    focus: "conversation",
  });

  assert.equal(
    routeShellInput(key("a"), presentation.inputState).handled,
    true,
  );
});

test("shell surface presentation honors colored and uncolored output controls", () => {
  const layout = planShellLayout({ cols: 160, rows: 40 });
  const focused = projectShellPresentation(layout, {
    ...base,
    focus: "sessions",
  });
  const frame = buildShellFrameInput(layout, snapshot(focused));
  const leftRow =
    frame.surfaces.find((surface) => surface.id === "left")?.rows[0] ?? "";

  // Semantic marker is always present when ANSI styling is stripped
  assert.match(stripAnsi(leftRow), /^›\s*SESSIONS/);

  // Spawning subprocesses to verify both FORCE_COLOR=1 (colored) and NO_COLOR=1 (uncolored) environments
  const runSubprocess = (envOverrides: Record<string, string>) => {
    const script = `
      import { planShellLayout } from './src/ui/shell/shellLayout.js';
      import { projectShellPresentation } from './src/ui/shell/shellPresentation.js';
      import { buildShellFrameInput } from './src/ui/shell/shellPanels.js';
      import { stripAnsi } from './src/ui/theme.js';
      const base = { focus: 'composer', leftDrawerOpen: true, rightDrawerOpen: true };
      const layout = planShellLayout({ cols: 160, rows: 40 });
      const focused = projectShellPresentation(layout, { ...base, focus: 'sessions' });
      const frame = buildShellFrameInput(layout, {
        mode: 'chat', model: 'auto', project: 'Babel', conversation: ['  conversation'],
        prompt: { rows: ['› draft'], cursor: { row: 0, col: 7, visible: true } },
        presentation: focused,
      });
      const row = frame.surfaces.find(s => s.id === 'left')?.rows[0] ?? '';
      console.log(JSON.stringify({ raw: row, stripped: stripAnsi(row) }));
    `;
    const env = { ...process.env, ...envOverrides };
    for (const [k, v] of Object.entries(envOverrides)) {
      if (v === "") delete env[k];
    }
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "-e", script],
      {
        cwd: PACKAGE_ROOT,
        env,
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000,
      },
    );
    if (result.status !== 0) {
      throw new Error(
        `Subprocess failed (status ${result.status}): ${result.stderr || result.stdout}`,
      );
    }
    return JSON.parse(result.stdout.trim()) as {
      raw: string;
      stripped: string;
    };
  };

  // 1. Colored environment (FORCE_COLOR=1): ANSI escapes are present, stripped text matches prompt marker
  const colored = runSubprocess({ FORCE_COLOR: "1", NO_COLOR: "" });
  assert.match(colored.raw, /\x1b\[/);
  assert.match(colored.stripped, /^›\s*SESSIONS/);

  // 2. Uncolored environment (FORCE_COLOR=0, NO_COLOR=1): No ANSI escapes, raw matches prompt marker
  const uncolored = runSubprocess({ FORCE_COLOR: "0", NO_COLOR: "1" });
  assert.doesNotMatch(uncolored.raw, /\x1b\[/);
  assert.equal(uncolored.raw, uncolored.stripped);
  assert.match(uncolored.raw, /^›\s*SESSIONS/);
});
