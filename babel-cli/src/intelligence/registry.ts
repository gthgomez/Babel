import type {
  ModelQualificationRecord,
  LabModelSpec,
  ProviderModelProfile,
} from "./types.js";

export interface VersionedModelRegistryEntry {
  schemaVersion: number;
  id: string;
  labModel: LabModelSpec;
  providerProfile: ProviderModelProfile;
  qualifications: readonly ModelQualificationRecord[];
  liveEligibility:
    | "not_eligible"
    | "qualification_required"
    | "eligible"
    | "deprecated";
}

/** Build a frozen registry snapshot instead of extending model-name switches. */
export function createModelRegistry(
  entries: readonly VersionedModelRegistryEntry[],
): readonly VersionedModelRegistryEntry[] {
  return Object.freeze(
    entries.map((entry) =>
      Object.freeze({
        ...entry,
        qualifications: Object.freeze(
          entry.qualifications.map((qualification) =>
            Object.freeze({ ...qualification }),
          ),
        ),
      }),
    ),
  );
}

/** A model is benchmark/live eligible only when lifecycle, profile, and qualification agree. */
export function isModelRegistryEntryEligible(
  entry: VersionedModelRegistryEntry,
  input: {
    labModelProfileHash?: string;
    providerProfileHash?: string;
    qualificationId?: string;
  } = {},
): boolean {
  if (entry.liveEligibility !== "eligible") return false;
  if (entry.providerProfile.lifecycle.status !== "active") return false;
  if (
    input.labModelProfileHash &&
    input.labModelProfileHash !== entry.labModel.profileHash
  )
    return false;
  if (
    input.providerProfileHash &&
    input.providerProfileHash !== entry.providerProfile.profileHash
  )
    return false;
  return entry.qualifications.some(
    (qualification) =>
      qualification.overallStatus === "qualified" &&
      qualification.modelProfileHash === entry.labModel.profileHash &&
      qualification.providerProfileHash === entry.providerProfile.profileHash &&
      (input.qualificationId === undefined ||
        qualification.qualificationId === input.qualificationId),
  );
}
