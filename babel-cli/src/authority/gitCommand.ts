/**
 * gitCommand.ts — structured git/gh command decoding into ActionRequests (P0-2).
 *
 * Convergence shim: parsing now lives in `authority/commandDecoder.ts` (one
 * quote/escape-aware tokenizer + semantic decoder, shared with the autonomy
 * layer). This module keeps the `parseGitCommand` surface the PDP consumes —
 * the PDP decides on STRUCTURED fields (capability, remote, source/dest
 * branch, force, delete), never raw strings.
 *
 * Known residual risk (R8, unchanged): aliases, env expansion, and
 * indirection through scripts can disguise intent; the harness deny layers
 * and sandbox remain the enforcement complement.
 */

import { decodeCommand } from './commandDecoder.js';
import type { CapabilityId } from './capabilities.js';

export interface ParsedGitCommand {
  capability: CapabilityId;
  remote?: string;
  sourceBranch?: string;
  destinationBranch?: string;
  force: boolean;
  delete: boolean;
  /** Concrete PR number, path, or other target identity. */
  target?: string;
  /** Deploy/target environment when the command names one. */
  environment?: string;
  /** Set when the raw command was unparseable but privileged-looking. */
  ambiguous?: boolean;
  /** True when execution runs repository-controlled code and needs a sandbox. */
  requiresIsolation?: boolean;
}

/** Decode a command string into a structured ParsedGitCommand (fail-closed). */
export function parseGitCommand(cmd: string, opts: { repoRoot?: string } = {}): ParsedGitCommand {
  const decoded = decodeCommand(cmd, opts);
  return {
    capability: decoded.capability === 'unknown' ? 'unknown' : decoded.capability,
    ...(decoded.remote !== undefined ? { remote: decoded.remote } : {}),
    ...(decoded.sourceBranch !== undefined ? { sourceBranch: decoded.sourceBranch } : {}),
    ...(decoded.destinationBranch !== undefined ? { destinationBranch: decoded.destinationBranch } : {}),
    force: decoded.force,
    delete: decoded.delete,
    ...(decoded.target !== undefined ? { target: decoded.target } : {}),
    ...(decoded.environment !== undefined ? { environment: decoded.environment } : {}),
    ...(decoded.ambiguous === true ? { ambiguous: true } : {}),
    ...(decoded.requiresIsolation === true ? { requiresIsolation: true } : {}),
  };
}
