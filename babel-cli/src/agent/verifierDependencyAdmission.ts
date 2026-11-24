/**
 * Admission-side verifier freeze command set for ChatEngine. Expands the
 * dependency hash seed list without changing verifierIntegrity resolution (#507).
 */
import { inferFreshTaskAcceptance } from './taskAcceptanceMeaning.js';
import {
  canonicalCommandFromFrozenVerification,
  contractMeaningVerifierCommands,
  explicitCriterionVerifierCommands,
} from './taskAcceptanceExecutableBinding.js';
import { initializeVerifierDependencyHashes } from './chatEngineVerifierSession.js';
import { verifierCommandInputFiles } from './verifierCommandInputs.js';
import type { AcceptanceRequirementV1, TaskContractV1 } from './taskContract.js';
import { advisoryDocsViolations } from './advisoryDocsGoal.js';
import { publicApiPreservationViolation, requestedExportNames } from './publicApiPreservation.js';

/** Commands frozen by executable acceptance criteria already admitted to the contract. */
export function contractVerifierCommands(
  acceptance: readonly AcceptanceRequirementV1[] | undefined,
): string[] {
  const commands: string[] = [];
  for (const requirement of acceptance ?? []) {
    const command = canonicalCommandFromFrozenVerification(requirement.verification);
    if (command) commands.push(command);
  }
  return [...new Set(commands)];
}

/** Meaning-derived executable criteria only; used for the tamper fail-closed check. */
export function contractMeaningCommands(
  acceptance: readonly AcceptanceRequirementV1[] | undefined,
): string[] {
  return contractMeaningVerifierCommands(acceptance ?? []);
}

export function admissionVerifierFreezeCommands(input: {
  task: string;
  resolvedVerifierCommands: readonly string[];
  discoveredTestCommands: readonly string[];
  /** Meaning-derived executable criteria already frozen by admission (witness/relevance). */
  meaningVerifierCommands?: readonly string[];
}): string[] {
  const meaning = inferFreshTaskAcceptance(input.task);
  return [...new Set([
    ...input.resolvedVerifierCommands,
    ...explicitCriterionVerifierCommands(meaning),
    ...(input.meaningVerifierCommands ?? []),
    ...input.discoveredTestCommands.map((command) => command.trim()).filter(Boolean),
  ])];
}

/** Seed ChatEngine verifier dependency hashes at admission (terminal wiring only). */
export function seedChatVerifierDependencyHashes(input: {
  task: string;
  projectRoot: string;
  hashes: Map<string, string>;
  resolvedVerifierCommands: readonly string[];
  discoveredTestCommands: readonly string[];
  meaningVerifierCommands?: readonly string[];
}): boolean {
  const commands = admissionVerifierFreezeCommands({
    task: input.task,
    resolvedVerifierCommands: input.resolvedVerifierCommands,
    discoveredTestCommands: input.discoveredTestCommands,
    ...(input.meaningVerifierCommands ? { meaningVerifierCommands: input.meaningVerifierCommands } : {}),
  });
  const unfrozen = initializeVerifierDependencyHashes(
    input.task,
    input.projectRoot,
    input.hashes,
    commands,
  );
  // A verifier that bound a requirement must freeze its actual inputs. The
  // global size check is insufficient because package.json is always hashed;
  // a glob script's executed test file would otherwise be neither watched nor
  // protected. Fail closed per admitted command.
  for (const command of input.meaningVerifierCommands ?? []) {
    const files = verifierCommandInputFiles(input.projectRoot, command)
      .filter(file => file !== 'package.json');
    if (files.length === 0) return true;
    if (files.some(file => !input.hashes.has(file))) return true;
  }
  return unfrozen.length > 0;
}

/** Mechanically checked preservation/documentation obligations, if admitted. */
export function contractPreservationErrors(
  contract: TaskContractV1 | undefined,
  projectRoot: string | null | undefined,
): string[] {
  if (!contract || !projectRoot) return [];
  const errors = advisoryDocsViolations({ acceptance: contract.acceptance, projectRoot });
  const publicApi = publicApiPreservationViolation({
    records: contract.provenance.records,
    projectRoot,
    requestedExports: requestedExportNames(contract.user_request),
  });
  if (publicApi) errors.push(publicApi);
  return errors;
}
