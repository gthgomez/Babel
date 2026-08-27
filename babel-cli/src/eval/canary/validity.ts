import { createHash } from "node:crypto";

import { gradeInCleanRoom, type CleanRoomFile } from "../cleanRoomGrade.js";
import type { CanaryTaskSpec } from "./types.js";

export interface TaskValidityReceipt {
  task_id: string;
  baseline_verified: boolean;
  reference_verified: boolean;
  oracle_stable: boolean;
  verifier_digest: string;
  notes: string[];
}

function startFiles(spec: CanaryTaskSpec): CleanRoomFile[] {
  return spec.files.map((f) => ({
    relativePath: f.relativePath,
    contents: f.start,
  }));
}

function goldFiles(spec: CanaryTaskSpec): CleanRoomFile[] {
  return spec.files
    .filter((f) => typeof f.gold === "string")
    .map((f) => ({ relativePath: f.relativePath, contents: f.gold as string }));
}

function oracle(spec: CanaryTaskSpec): CleanRoomFile[] {
  return [{ relativePath: "hidden.test.mjs", contents: spec.oracle_test }];
}

function cmd(): string[] {
  return [process.execPath, "hidden.test.mjs"];
}

/**
 * Construction-time validity: baseline/reference/oracle stability.
 */
export function verifyCanaryTaskValidity(
  spec: CanaryTaskSpec,
  repeats = 2,
): TaskValidityReceipt {
  const notes: string[] = [];
  const verifier_digest = createHash("sha256")
    .update(spec.oracle_test)
    .digest("hex");
  const baselineRuns = Array.from({ length: repeats }, () =>
    gradeInCleanRoom({
      startFiles: startFiles(spec),
      candidateDiffFiles: [],
      oracleFiles: oracle(spec),
      verifierCommand: cmd(),
    }),
  );
  const referenceRuns = Array.from({ length: repeats }, () =>
    gradeInCleanRoom({
      startFiles: startFiles(spec),
      candidateDiffFiles: goldFiles(spec),
      oracleFiles: oracle(spec),
      verifierCommand: cmd(),
    }),
  );

  let baseline_verified = false;
  let reference_verified = false;
  if (spec.intended_terminal === "NO_CHANGE_REQUIRED") {
    baseline_verified = baselineRuns.every((r) => r.hidden_ok);
    reference_verified = referenceRuns.every((r) => r.hidden_ok);
  } else if (spec.intended_terminal === "honest_block") {
    baseline_verified = baselineRuns.every((r) => !r.hidden_ok);
    reference_verified = true;
    notes.push(
      "C09: oracle is expected to fail; block is the intended agent terminal",
    );
  } else if (spec.intended_terminal === "false_complete_probe") {
    const inadequate = spec.files
      .filter((f) => typeof f.inadequate === "string")
      .map((f) => ({
        relativePath: f.relativePath,
        contents: f.inadequate as string,
      }));
    const vis = spec.visible_test
      ? gradeInCleanRoom({
          startFiles: startFiles(spec),
          candidateDiffFiles: inadequate,
          oracleFiles: [
            { relativePath: "hidden.test.mjs", contents: spec.visible_test },
          ],
          verifierCommand: cmd(),
        })
      : null;
    const hid = gradeInCleanRoom({
      startFiles: startFiles(spec),
      candidateDiffFiles: inadequate,
      oracleFiles: oracle(spec),
      verifierCommand: cmd(),
    });
    baseline_verified = vis?.hidden_ok === true && hid.hidden_ok === false;
    reference_verified = referenceRuns.every((r) => r.hidden_ok);
    notes.push(
      `${spec.id}: inadequate patch must pass visible and fail hidden`,
    );
  } else {
    baseline_verified = baselineRuns.every((r) => !r.hidden_ok);
    reference_verified = referenceRuns.every((r) => r.hidden_ok);
  }

  const oracle_stable =
    baselineRuns.every((r) => r.hidden_ok === baselineRuns[0]!.hidden_ok) &&
    referenceRuns.every((r) => r.hidden_ok === referenceRuns[0]!.hidden_ok);

  return {
    task_id: spec.id,
    baseline_verified,
    reference_verified,
    oracle_stable,
    verifier_digest,
    notes,
  };
}

export function isLiveCanaryEligible(receipt: TaskValidityReceipt): boolean {
  return (
    receipt.baseline_verified &&
    receipt.reference_verified &&
    receipt.oracle_stable
  );
}
