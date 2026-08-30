import type { AuxiliaryInferencePolicy } from "./types.js";

export type InferenceComponentRole =
  | "PRIMARY"
  | "AUXILIARY_COMPACTION"
  | "AUXILIARY_CRITIC"
  | "AUXILIARY_REVIEWER"
  | "AUXILIARY_SUMMARIZER"
  | "AUXILIARY_VERIFIER"
  | "OTHER";

export interface InferenceComponent {
  id: string;
  role: InferenceComponentRole;
  policyRequired: boolean;
  notes: string;
}

/** The known inference-producing roles that must be represented in a campaign manifest. */
export const KNOWN_INFERENCE_COMPONENTS: readonly InferenceComponent[] =
  Object.freeze([
    {
      id: "primary",
      role: "PRIMARY",
      policyRequired: true,
      notes: "Task-facing model calls.",
    },
    {
      id: "compaction",
      role: "AUXILIARY_COMPACTION",
      policyRequired: true,
      notes: "Conversation compaction or summarization.",
    },
    {
      id: "diff-critic",
      role: "AUXILIARY_CRITIC",
      policyRequired: true,
      notes: "Diff-focused critique.",
    },
    {
      id: "pro-critic",
      role: "AUXILIARY_CRITIC",
      policyRequired: true,
      notes: "Pro/quality critique.",
    },
    {
      id: "reviewer",
      role: "AUXILIARY_REVIEWER",
      policyRequired: true,
      notes: "Review or adjudication inference.",
    },
    {
      id: "summarizer",
      role: "AUXILIARY_SUMMARIZER",
      policyRequired: true,
      notes: "Explicit summarization inference.",
    },
    {
      id: "verifier",
      role: "AUXILIARY_VERIFIER",
      policyRequired: true,
      notes: "Model-based verification inference.",
    },
    {
      id: "fallback",
      role: "OTHER",
      policyRequired: true,
      notes: "Any model fallback path.",
    },
  ]);

/** Require a declared policy for every auxiliary role before strict fan-out. */
export function assertAuxiliaryInferenceInventory(
  policies: ReadonlyMap<string, AuxiliaryInferencePolicy>,
  options: { strict: boolean } = { strict: true },
): void {
  if (!options.strict) return;
  const requiredRoles = new Set<AuxiliaryInferencePolicy["role"]>([
    "compaction",
    "critic",
    "reviewer",
    "summarizer",
    "verifier",
  ]);
  for (const role of requiredRoles) {
    if (!policies.has(role)) {
      throw new Error(
        `Strict execution has no explicit auxiliary inference policy for ${role}.`,
      );
    }
  }
}
