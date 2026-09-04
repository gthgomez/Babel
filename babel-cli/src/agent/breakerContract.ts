import {
  PROJECT_CODE_CAPABILITIES,
  isCapabilityId,
  type CapabilityId,
} from "../authority/capabilities.js";
import {
  validateTaskContractV1ForCompletion,
  type AcceptanceRequirementV1,
  type TaskContractV1,
} from "./taskContract.js";
import type { EvidenceNode } from "../evidence/evidenceGraph.js";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const BREAKER_CONTRACT_VERSION = 1 as const;
export const BREAKER_READ_ONLY_CAPABILITIES: readonly CapabilityId[] = [
  "inspect_repository",
  "search_repository",
  "run_tests",
  "run_build",
  "run_lint",
  "run_typecheck",
];
const BREAKER_ALLOWED_CAPABILITIES = new Set<CapabilityId>(
  BREAKER_READ_ONLY_CAPABILITIES,
);

export type BreakerSeverity = "low" | "medium" | "high" | "critical";
export type BreakerFindingStatus =
  | "open"
  | "reproduced"
  | "dismissed"
  | "unknown";

export interface BreakerContractV1 {
  schema_version: typeof BREAKER_CONTRACT_VERSION;
  breaker_id: string;
  role: "breaker";
  task_id: string;
  run_id: string;
  contract_hash: string;
  repository: string;
  base_sha: string | null;
  candidate_sha: string;
  acceptance: readonly AcceptanceRequirementV1[];
  relevant_evidence: readonly string[];
  capabilities: readonly CapabilityId[];
  execution_domain: "isolated-sandbox";
  project_code_execution: true;
  credential_access: false;
  publication_allowed: false;
  mutation_allowed: false;
}

export interface BreakerFindingV1 {
  finding_id: string;
  severity: BreakerSeverity;
  contract_requirement: string;
  counterexample: string;
  reproduction: string;
  evidence: string[];
  confidence: "low" | "medium" | "high" | "unknown";
  status: BreakerFindingStatus;
}

export interface BreakerReportV1 {
  schema_version: typeof BREAKER_CONTRACT_VERSION;
  breaker_id: string;
  task_id: string;
  run_id: string;
  contract_hash: string;
  candidate_sha: string;
  status: "PASS" | "FINDINGS" | "UNKNOWN";
  findings: BreakerFindingV1[];
}

/** Validate that a breaker remains independently read-only even if a caller delegates mutation. */
export function assertBreakerReadOnly(
  capabilities: readonly string[],
  options: { execution_domain?: string } = {},
): void {
  const unknown = capabilities.filter(
    (capability) => !isCapabilityId(capability),
  );
  if (unknown.length > 0 || capabilities.includes("unknown")) {
    throw new Error("Breaker authority widening rejected: unknown capability.");
  }
  if (
    capabilities.some(
      (capability) =>
        !BREAKER_ALLOWED_CAPABILITIES.has(capability as CapabilityId),
    )
  ) {
    throw new Error(
      "Breaker authority widening rejected: the BREAKER role is read-only.",
    );
  }
  if (
    capabilities.some((capability) =>
      PROJECT_CODE_CAPABILITIES.has(capability as CapabilityId),
    ) &&
    options.execution_domain !== "isolated-sandbox"
  ) {
    throw new Error(
      "Breaker project-code execution requires an isolated-sandbox execution domain.",
    );
  }
}

export function buildBreakerContractV1(input: {
  breaker_id: string;
  taskContract: TaskContractV1;
  repository: string;
  base_sha?: string | null;
  candidate_sha: string;
  run_id?: string;
  relevant_evidence?: string[];
}): BreakerContractV1 {
  const contractErrors = validateTaskContractV1ForCompletion(
    input.taskContract,
  );
  if (!input.taskContract.frozen || contractErrors.length > 0) {
    throw new Error(
      `Breaker requires a valid frozen task contract: ${contractErrors.join(", ")}`,
    );
  }
  assertBreakerReadOnly(BREAKER_READ_ONLY_CAPABILITIES, {
    execution_domain: "isolated-sandbox",
  });
  if (
    !input.breaker_id.trim() ||
    !input.repository.trim() ||
    !input.candidate_sha.trim()
  ) {
    throw new Error(
      "Breaker contract requires durable identity and candidate provenance.",
    );
  }
  return {
    schema_version: BREAKER_CONTRACT_VERSION,
    breaker_id: input.breaker_id,
    role: "breaker",
    task_id: input.taskContract.task_id,
    run_id: input.run_id ?? "run:breaker",
    contract_hash: input.taskContract.contract_hash,
    repository: input.repository,
    base_sha: input.base_sha ?? input.taskContract.base_sha,
    candidate_sha: input.candidate_sha,
    acceptance: [...input.taskContract.acceptance],
    relevant_evidence: [...(input.relevant_evidence ?? [])],
    capabilities: BREAKER_READ_ONLY_CAPABILITIES,
    execution_domain: "isolated-sandbox",
    project_code_execution: true,
    credential_access: false,
    publication_allowed: false,
    mutation_allowed: false,
  };
}

export function createBreakerFindingV1(input: {
  finding_id: string;
  severity: BreakerSeverity;
  contract_requirement: string;
  counterexample: string;
  reproduction: string;
  evidence: string[];
  confidence?: BreakerFindingV1["confidence"];
  status?: BreakerFindingStatus;
}): BreakerFindingV1 {
  if (
    !input.finding_id.trim() ||
    !input.contract_requirement.trim() ||
    !input.counterexample.trim() ||
    !input.reproduction.trim()
  ) {
    throw new Error(
      "Breaker findings require a structured requirement, counterexample, and reproduction.",
    );
  }
  return {
    finding_id: input.finding_id,
    severity: input.severity,
    contract_requirement: input.contract_requirement,
    counterexample: input.counterexample,
    reproduction: input.reproduction,
    evidence: [...input.evidence],
    confidence: input.confidence ?? "unknown",
    status: input.status ?? "open",
  };
}

/** Execute the read-only Breaker lane against frozen context. */
export async function executeBreakerLaneV1(input: {
  contract: BreakerContractV1;
  inspect: (
    context: Readonly<BreakerContractV1>,
  ) => Promise<readonly BreakerFindingV1[]>;
}): Promise<BreakerReportV1> {
  try {
    assertBreakerReadOnly(input.contract.capabilities, {
      execution_domain: input.contract.execution_domain,
    });
    const findings = [
      ...(await input.inspect(
        Object.freeze({
          ...input.contract,
          acceptance: Object.freeze([...input.contract.acceptance]),
          relevant_evidence: Object.freeze([
            ...input.contract.relevant_evidence,
          ]),
          capabilities: Object.freeze([...input.contract.capabilities]),
        }),
      )),
    ];
    return {
      schema_version: BREAKER_CONTRACT_VERSION,
      breaker_id: input.contract.breaker_id,
      task_id: input.contract.task_id,
      run_id: input.contract.run_id,
      contract_hash: input.contract.contract_hash,
      candidate_sha: input.contract.candidate_sha,
      status: findings.length > 0 ? "FINDINGS" : "PASS",
      findings,
    };
  } catch {
    return {
      schema_version: BREAKER_CONTRACT_VERSION,
      breaker_id: input.contract.breaker_id,
      task_id: input.contract.task_id,
      run_id: input.contract.run_id,
      contract_hash: input.contract.contract_hash,
      candidate_sha: input.contract.candidate_sha,
      status: "UNKNOWN",
      findings: [],
    };
  }
}

function directoryFingerprint(root: string): string {
  const entries: string[] = [];
  const visit = (current: string, relative: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const child = join(current, entry.name);
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(child, childRelative);
      else if (entry.isFile())
        entries.push(
          `${childRelative}:${createHash("sha256").update(readFileSync(child)).digest("hex")}`,
        );
    }
  };
  visit(root, "");
  return createHash("sha256").update(entries.sort().join("\n")).digest("hex");
}

/** Run a Breaker outside the builder process against a disposable snapshot. */
export async function executeIsolatedBreakerProcessV1(input: {
  contract: BreakerContractV1;
  project_root: string;
  executable: string;
  args: readonly string[];
  timeout_ms?: number;
}): Promise<BreakerReportV1> {
  const unknown = (): BreakerReportV1 => ({
    schema_version: BREAKER_CONTRACT_VERSION,
    breaker_id: input.contract.breaker_id,
    task_id: input.contract.task_id,
    run_id: input.contract.run_id,
    contract_hash: input.contract.contract_hash,
    candidate_sha: input.contract.candidate_sha,
    status: "UNKNOWN",
    findings: [],
  });
  try {
    assertBreakerReadOnly(input.contract.capabilities, {
      execution_domain: input.contract.execution_domain,
    });
    if (
      !existsSync(input.project_root) ||
      input.contract.mutation_allowed ||
      input.contract.credential_access
    )
      return unknown();
    const sandbox = mkdtempSync(join(tmpdir(), "babel-breaker-"));
    try {
      const snapshot = join(sandbox, "project");
      cpSync(input.project_root, snapshot, {
        recursive: true,
        force: false,
        filter: (source) => {
          const name = source.split(/[\\/]/).pop();
          return name !== ".git" && name !== "node_modules";
        },
      });
      const before = directoryFingerprint(snapshot);
      const result = spawnSync(input.executable, [...input.args], {
        cwd: snapshot,
        shell: false,
        windowsHide: true,
        timeout: input.timeout_ms ?? 120_000,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          SystemRoot: process.env.SystemRoot ?? "",
          TEMP: sandbox,
          TMP: sandbox,
          BABEL_BREAKER_READ_ONLY: "1",
          BABEL_BREAKER_TASK_ID: input.contract.task_id,
          BABEL_BREAKER_RUN_ID: input.contract.run_id,
          BABEL_BREAKER_CONTRACT_HASH: input.contract.contract_hash,
          BABEL_BREAKER_CANDIDATE_SHA: input.contract.candidate_sha,
        },
      });
      if (
        before !== directoryFingerprint(snapshot) ||
        result.error ||
        result.status !== 0
      )
        return unknown();
      const report = JSON.parse(
        `${result.stdout ?? ""}`.trim(),
      ) as Partial<BreakerReportV1>;
      if (
        report.schema_version !== BREAKER_CONTRACT_VERSION ||
        report.breaker_id !== input.contract.breaker_id ||
        report.task_id !== input.contract.task_id ||
        report.run_id !== input.contract.run_id ||
        report.contract_hash !== input.contract.contract_hash ||
        report.candidate_sha !== input.contract.candidate_sha ||
        !["PASS", "FINDINGS", "UNKNOWN"].includes(report.status ?? "") ||
        !Array.isArray(report.findings)
      )
        return unknown();
      return report as BreakerReportV1;
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  } catch {
    return unknown();
  }
}

/** The breaker consumes structured inputs; no builder transcript is part of this boundary. */
export function breakerInputEvidence(nodes: readonly EvidenceNode[]): string[] {
  return nodes.map((node) => node.id);
}
