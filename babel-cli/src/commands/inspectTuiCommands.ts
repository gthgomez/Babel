import type { Command } from 'commander';
import { formatInspectTui, resolveInspectTuiPath, type InspectTuiView } from '../ui/observe/inspectTui.js';

/**
 * Attach `inspect tui` under the existing inspect command.
 *
 * @param inspectCommand Commander inspect parent
 */
export function registerInspectTuiCommand(inspectCommand: Command): void {
  inspectCommand
    .command("tui")
    .description(
      "Inspect the recorded TUI observation (virtual cell grid + semantics, not a projector dump)",
    )
    .argument("[path]", "tui-session dir, chat run dir, or latest")
    .option("--view <view>", "screen | semantic | both | diff", "both")
    .addHelpText(
      "after",
      `
Notes:
  - latest.txt is the virtual terminal cell grid derived from actual stdout bytes.
  - latest.semantic.json is the semantic oracle (tools, stall, mutations).
  - These are independent truths. Agreement is high confidence; disagreement localizes the bug.
  - BABEL_A11Y and turnViewProjector are not the visual screen.
`,
    )
    .action((pathArg: string | undefined, options: { view?: string }) => {
      const view = normalizeView(options.view);
      const dir = resolveInspectTuiPath(pathArg);
      process.stdout.write(formatInspectTui(dir, view));
    });
}

function normalizeView(raw: string | undefined): InspectTuiView {
  if (
    raw === "screen" ||
    raw === "semantic" ||
    raw === "both" ||
    raw === "diff"
  )
    return raw;
  return "both";
}
