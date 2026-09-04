import type { ProviderOperationalProfile } from "./types.js";

/** Normalize volatile provider observations without folding account state into model identity. */
export function createProviderOperationalProfile(
  input: Omit<ProviderOperationalProfile, "schemaVersion"> & {
    schemaVersion?: number;
  },
): ProviderOperationalProfile {
  return Object.freeze({
    schemaVersion: input.schemaVersion ?? 1,
    provider: input.provider,
    ...(input.rateLimitEvidence === undefined
      ? {}
      : { rateLimitEvidence: Object.freeze({ ...input.rateLimitEvidence }) }),
    ...(input.affordabilityEvidence === undefined
      ? {}
      : {
          affordabilityEvidence: Object.freeze({
            ...input.affordabilityEvidence,
          }),
        }),
    retrySemantics: Object.freeze({ ...input.retrySemantics }),
    ...(input.latencyObservations === undefined
      ? {}
      : {
          latencyObservations: Object.freeze({ ...input.latencyObservations }),
        }),
    ...(input.throughputObservations === undefined
      ? {}
      : {
          throughputObservations: Object.freeze({
            ...input.throughputObservations,
          }),
        }),
    ...(input.availabilityObservations === undefined
      ? {}
      : {
          availabilityObservations: Object.freeze({
            ...input.availabilityObservations,
          }),
        }),
    ...(input.lastValidatedAt === undefined
      ? {}
      : { lastValidatedAt: input.lastValidatedAt }),
  });
}
