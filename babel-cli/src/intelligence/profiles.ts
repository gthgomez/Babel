import { deepFreeze, hashCanonical } from "./hash.js";
import type {
  HarnessTuningProfile,
  LabModelSpec,
  ProviderModelProfile,
  ModelQualificationRecord,
} from "./types.js";

function materialize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(materialize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "observedAt" && key !== "retrievedAt")
      .map(([key, child]) => [key, materialize(child)]),
  );
}

function withHash<T extends { profileHash: string }>(
  value: Omit<T, "profileHash">,
): T {
  const profile = { ...value, profileHash: "" } as T;
  // Retrieval timestamps describe provenance, not model/provider identity.
  // Excluding them prevents harmless metadata refreshes from staling a
  // qualification while retaining all timestamps in the stored profile.
  profile.profileHash = hashCanonical(
    materialize({ ...profile, profileHash: undefined }),
  );
  return deepFreeze(profile);
}

/** Build a model profile whose identity excludes its derived hash field. */
export function createLabModelSpec(
  input: Omit<LabModelSpec, "profileHash">,
): LabModelSpec {
  return withHash(input);
}

/** Build a provider-hosted profile with a stable material capability hash. */
export function createProviderModelProfile(
  input: Omit<ProviderModelProfile, "profileHash">,
): ProviderModelProfile {
  return withHash(input);
}

/** Build a provisional harness recommendation profile. */
export function createHarnessTuningProfile(
  input: Omit<HarnessTuningProfile, "profileHash">,
): HarnessTuningProfile {
  return withHash(input);
}

const MATERIAL_PROVIDER_FIELDS = [
  "provider",
  "canonicalModelId",
  "providerModelId",
  "upstreamProvider",
  "endpointId",
  "protocolProfiles",
  "endpointProfiles",
  "providerLimits",
  "tokenizer",
  "quantization",
  "pricing",
  "routingCapabilities",
  "cacheCapabilities",
  "lifecycle",
] as const;

/** Detect capability drift without treating source timestamps as capability drift. */
export function detectProviderProfileDrift(
  previous: ProviderModelProfile,
  current: ProviderModelProfile,
): { changed: boolean; fields: string[] } {
  const fields = MATERIAL_PROVIDER_FIELDS.filter(
    (field) => hashCanonical(previous[field]) !== hashCanonical(current[field]),
  );
  return { changed: fields.length > 0, fields: [...fields] };
}

/** A qualification is stale when either material profile hash no longer matches. */
export function qualificationStaleness(
  record: Pick<
    ModelQualificationRecord,
    "modelProfileHash" | "providerProfileHash"
  >,
  current: Pick<ProviderModelProfile, "profileHash"> & {
    modelProfileHash: string;
  },
): { stale: boolean; reason?: string } {
  const reasons: string[] = [];
  if (record.modelProfileHash !== current.modelProfileHash)
    reasons.push("lab model profile changed");
  if (record.providerProfileHash !== current.profileHash)
    reasons.push("provider model profile changed");
  return reasons.length > 0
    ? { stale: true, reason: reasons.join("; ") }
    : { stale: false };
}
