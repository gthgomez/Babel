/**
 * Admission-side verifier freeze command set for ChatEngine. Expands the
 * dependency hash seed list without changing verifierIntegrity resolution (#507).
 */
import { inferTaskAcceptanceV3 } from './taskAcceptanceMeaning.js';
import { explicitCriterionVerifierCommands } from './taskAcceptanceExecutableBinding.js';
import { initializeVerifierDependencyHashes } from './chatEngineVerifierSession.js';

export function admissionVerifierFreezeCommands(input: {
  task: string;
  resolvedVerifierCommands: readonly string[];
  discoveredTestCommands: readonly string[];
}): string[] {
  const meaning = inferTaskAcceptanceV3(input.task);
  return [...new Set([
    ...input.resolvedVerifierCommands,
    ...explicitCriterionVerifierCommands(meaning),
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
}): boolean {
  const commands = admissionVerifierFreezeCommands({
    task: input.task,
    resolvedVerifierCommands: input.resolvedVerifierCommands,
    discoveredTestCommands: input.discoveredTestCommands,
  });
  return initializeVerifierDependencyHashes(
    input.task,
    input.projectRoot,
    input.hashes,
    commands,
  ).length > 0;
}
