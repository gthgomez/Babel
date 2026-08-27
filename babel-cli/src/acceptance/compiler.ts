import type {
  AcceptanceClaimV0,
  AcceptanceInputSnapshotV0,
  ExecutableAcceptanceContractV0,
} from "./types.js";
import {
  buildAcceptanceClaim,
  buildExecutableAcceptanceContract,
} from "./artifacts.js";

const PLACEHOLDER_CRITERIA =
  /^task acceptance criteria as stated in the user request$/i;

function isPlaceholder(value: string, request: string): boolean {
  const normalized = value.trim();
  return PLACEHOLDER_CRITERIA.test(normalized) || normalized === request.trim();
}

function criterionPolarity(statement: string): AcceptanceClaimV0["polarity"] {
  return /\b(?:must not|should not|never|do not|does not)\b/i.test(statement)
    ? "must_not_hold"
    : "must_hold";
}

function scopeFor(statement: string): AcceptanceClaimV0["scope"] {
  const paths = [...statement.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1] ?? "")
    .filter((value) => /[\\/]|\.[a-z0-9]{1,8}$/i.test(value));
  return paths.length > 0 ? { paths: [...new Set(paths)] } : {};
}

function normalizeCriterion(value: string): string {
  return value
    .trim()
    .replace(/^[-*•]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .trim();
}

function extractExplicitCriteria(request: string): string[] {
  const criteria: string[] = [];
  for (const line of request.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.+?)\s*$/);
    if (match?.[1]) criteria.push(normalizeCriterion(match[1]));
    const inline = line.match(
      /^\s*(?:acceptance criteria|requirements?)\s*:\s*(.+?)\s*$/i,
    );
    if (inline?.[1]) criteria.push(normalizeCriterion(inline[1]));
  }
  return [...new Set(criteria.filter((criterion) => criterion.length > 0))];
}

function extractExplicitRequirementSentences(request: string): string[] {
  return [
    ...new Set(
      request
        .split(/\r?\n|(?<=[.!?])\s+/)
        .map((part) => part.trim())
        .filter((part) =>
          /\b(?:must|should|required|expected|allow|support|return|display|preserve|reject|accept|prevent|ensure)\b/i.test(
            part,
          ),
        )
        .filter((part) => part.length > 0),
    ),
  ];
}

function claimFor(
  statement: string,
  status: AcceptanceClaimV0["epistemicStatus"],
  sourceKind: "user_request" | "task_contract",
  sourceRef: string,
  ordinal: number,
): AcceptanceClaimV0 {
  const unverifiable =
    /\b(?:unverifiable|cannot be observed|not observable|no oracle)\b/i.test(
      statement,
    );
  const finalStatus = unverifiable ? "unverifiable" : status;
  return buildAcceptanceClaim({
    statement,
    polarity: criterionPolarity(statement),
    epistemicStatus: finalStatus,
    provenance: [{ sourceKind, sourceRef }],
    scope: scopeFor(statement),
    falsifier: `A candidate state exists in the declared scope where this statement does not hold: ${statement}`,
    required: true,
    assurance:
      finalStatus === "ambiguous" || finalStatus === "unverifiable"
        ? "elevated"
        : "normal",
    ordinal,
  });
}

/**
 * Compile only the immutable pre-implementation snapshot.
 *
 * This module intentionally has no filesystem, Git, process, ChatEngine, or
 * BDNS imports. The function boundary is the patch-blindness enforcement.
 */
export function compileAcceptance(snapshot: AcceptanceInputSnapshotV0) {
  const criteria = extractExplicitCriteria(snapshot.userRequest);
  const taskCriteria = (snapshot.taskContractAcceptanceCriteria ?? [])
    .map((criterion) => criterion.trim())
    .filter(
      (criterion) =>
        criterion.length > 0 && !isPlaceholder(criterion, snapshot.userRequest),
    );
  const claims: AcceptanceClaimV0[] = [];
  const seen = new Set<string>();

  const add = (
    statement: string,
    status: AcceptanceClaimV0["epistemicStatus"],
    sourceKind: "user_request" | "task_contract",
    sourceRef: string,
  ) => {
    const normalized = statement.trim();
    if (!normalized || seen.has(normalized.toLowerCase())) return;
    seen.add(normalized.toLowerCase());
    claims.push(
      claimFor(normalized, status, sourceKind, sourceRef, claims.length),
    );
  };

  criteria.forEach((criterion, index) =>
    add(
      criterion,
      "explicit",
      "user_request",
      `userRequest.criteria[${index}]`,
    ),
  );
  taskCriteria.forEach((criterion, index) =>
    add(
      criterion,
      "explicit",
      "task_contract",
      `taskContract.acceptanceCriteria[${index}]`,
    ),
  );

  if (claims.length === 0) {
    const requirements = extractExplicitRequirementSentences(
      snapshot.userRequest,
    );
    requirements.forEach((requirement, index) =>
      add(
        requirement,
        "inferred",
        "user_request",
        `userRequest.requirement[${index}]`,
      ),
    );
  }

  if (claims.length === 0) {
    add(
      "The task has a complete, authoritative, and observable acceptance meaning.",
      "ambiguous",
      "user_request",
      "userRequest.acceptance-meaning-unresolved",
    );
  }

  return buildExecutableAcceptanceContract({
    snapshot,
    claims,
    createdAt: snapshot.createdAt,
  });
}

export interface PatchBlindCompilerV0 {
  name: string;
  version: string;
  compile(snapshot: AcceptanceInputSnapshotV0): readonly AcceptanceClaimV0[];
}

/**
 * Explicit H0/H1 seam. H1 is callback-injected for experiments only; this
 * module still provides the callback exactly one frozen snapshot and never
 * constructs an LLM client or exposes runtime state.
 */
export function compileAcceptanceVariant(input: {
  snapshot: AcceptanceInputSnapshotV0;
  variant: "H0_deterministic" | "H1_patch_blind_llm";
  h1Compiler?: PatchBlindCompilerV0;
}): ExecutableAcceptanceContractV0 {
  if (input.variant === "H0_deterministic")
    return compileAcceptance(input.snapshot);
  if (!input.h1Compiler) {
    throw new Error(
      "H1_patch_blind_llm requires an explicit snapshot-only compiler",
    );
  }
  const claims = input.h1Compiler.compile(input.snapshot);
  return buildExecutableAcceptanceContract({
    snapshot: input.snapshot,
    claims: [...claims],
    compiler: {
      name: input.h1Compiler.name,
      version: input.h1Compiler.version,
      patchBlind: true,
    },
    createdAt: input.snapshot.createdAt,
  });
}

export const compileExecutableAcceptance = compileAcceptance;
