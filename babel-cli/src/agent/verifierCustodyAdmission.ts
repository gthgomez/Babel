/**
 * Admission-side verifier custody: ties protected verifier inputs to live tamper state (#506).
 * Path normalization overlap with #507 is limited to posix rel keys on the dependency hash map.
 */
import { normalizeIntegrityPath } from './verifierIntegrity.js';
import type { VerifierTamperState } from './chatEngineVerifierSession.js';

export function normalizeVerifierCustodyKey(filePath: string): string {
  return normalizeIntegrityPath(filePath.replace(/\\/g, '/'));
}

/** True when the path is a frozen verifier dependency and/or contract-protected verifier input. */
export function pathUnderVerifierCustody(
  relativePath: string,
  dependencyHashes: ReadonlyMap<string, string>,
  protectedPaths?: readonly string[],
): boolean {
  const norm = normalizeVerifierCustodyKey(relativePath);
  if (dependencyHashes.has(norm)) return true;
  return protectedPaths?.some((p) => normalizeVerifierCustodyKey(p) === norm) ?? false;
}

export function recordVerifierCustodyViolation(state: VerifierTamperState): void {
  state.verifierTampered = true;
  state.tamperCount += 1;
  state.tamperedThisTurn = true;
}

export interface VerifierCustodyAdmissionHost {
  verifierDependencyHashes: Map<string, string>;
  verifierTampered: boolean;
  tamperCount: number;
  tamperedThisTurn: boolean;
  protectedPaths?: readonly string[];
}

export function admitVerifierCustodyViolation(host: VerifierCustodyAdmissionHost, filePath: string): void {
  if (!pathUnderVerifierCustody(filePath, host.verifierDependencyHashes, host.protectedPaths)) return;
  const state: VerifierTamperState = {
    verifierDependencyHashes: host.verifierDependencyHashes,
    verifierTampered: host.verifierTampered,
    tamperCount: host.tamperCount,
    tamperedThisTurn: host.tamperedThisTurn,
  };
  recordVerifierCustodyViolation(state);
  host.verifierTampered = state.verifierTampered;
  host.tamperCount = state.tamperCount;
  host.tamperedThisTurn = state.tamperedThisTurn;
}
