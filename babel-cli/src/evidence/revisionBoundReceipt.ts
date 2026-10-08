import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import { isCredentialTargetPath } from "../agent/autonomyEnforcement.js";

export type RevisionScopeV1 =
  | { kind: "files"; paths: string[] }
  | { kind: "repository" };

export type GitBindingModeV1 = "required" | "optional";

export interface WorkspaceRevision {
  gitCommitHash: string | null;
  compositeTreeHash: string;
  fileHashes: Record<string, string>;
  capturedAt: number;
  /** Explicitly distinguishes a file set from whole-repository evidence. */
  scope?: RevisionScopeV1;
  /** A null Git hash is valid only when this mode is explicitly optional. */
  gitBinding?: GitBindingModeV1;
}

export interface RevisionBoundReceipt {
  receiptId: string;
  command: string;
  exitCode: number;
  boundRevision: WorkspaceRevision;
  stale: boolean;
  authority?: boolean;
  authoritySource?: string;
  staleReason?: string;
}

const sha256 = z.string().regex(/^[0-9a-f]{64}$/i);
const gitSha = z.string().regex(/^[0-9a-f]{40}$/i);
const scopeSchema = z.union([
  z
    .object({
      kind: z.literal("files"),
      paths: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  z.object({ kind: z.literal("repository") }).strict(),
]);

export const WorkspaceRevisionSchema = z
  .object({
    gitCommitHash: gitSha.nullable(),
    compositeTreeHash: sha256,
    fileHashes: z.record(
      z.string().min(1),
      z.union([sha256, z.literal("deleted")]),
    ),
    capturedAt: z.number().int().finite().nonnegative(),
    scope: scopeSchema,
    gitBinding: z.enum(["required", "optional"]),
  })
  .strict();

export const VerifierReceiptEvidenceV1Schema = z
  .object({
    schema_version: z.literal(1),
    receipt: z
      .object({
        receiptId: z.string().trim().min(1),
        command: z.string().trim().min(1),
        exitCode: z.number().int(),
        boundRevision: WorkspaceRevisionSchema,
        stale: z.boolean(),
        staleReason: z.string().optional(),
      })
      .strict(),
  })
  .strict();

export type VerifierReceiptEvidenceV1 = z.infer<
  typeof VerifierReceiptEvidenceV1Schema
>;

function hashFileContent(content: Buffer | string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function assertProjectRelativePath(projectRoot: string, value: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error("Revision scope path is empty.");
  const slash = value.replaceAll("\\", "/");
  if (/^(?:[A-Za-z]:|\\|\/)/.test(slash))
    throw new Error(
      `Revision scope path must be repository-relative: ${value}`,
    );
  const normalized = path.posix.normalize(slash);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../"))
    throw new Error(`Revision scope path traverses the repository: ${value}`);
  const root = path.resolve(projectRoot);
  const resolved = path.resolve(root, normalized);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..${path.sep}") || path.isAbsolute(relative))
    throw new Error(`Revision scope path is outside the repository: ${value}`);
  return normalized;
}

function canonicalFiles(
  projectRoot: string,
  paths: readonly string[],
): string[] {
  const canonical = paths.map((value) =>
    assertProjectRelativePath(projectRoot, value),
  );
  const unique = new Set(canonical);
  if (unique.size !== canonical.length)
    throw new Error("Revision scope contains duplicate canonical paths.");
  return [...unique].sort();
}

function compositeFromFileHashes(
  scope: RevisionScopeV1,
  fileHashes: Record<string, string>,
): string {
  return hashFileContent(canonicalJsonForHash({ scope, fileHashes }));
}

function canonicalJsonForHash(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(canonicalJsonForHash).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJsonForHash((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}

function readGitHead(projectRoot: string): string | null {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
      windowsHide: true,
    }).trim();
    return gitSha.safeParse(head).success ? head : null;
  } catch {
    return null;
  }
}

/**
 * Hash the repository's ACTUAL verification-relevant state.
 *
 * `ls-files -s` contributes the blob hash of every clean tracked file. The
 * Git status (`--porcelain -z --untracked-files=all`) identifies the
 * divergent paths — worktree-modified tracked files and untracked files —
 * and for each of those the ACTUAL worktree bytes are hashed here, together
 * with existence and type. A metadata-only fingerprint (hashing the status
 * text itself) could not see a byte change A→B in a file that was already
 * dirty, or in an untracked file that already existed: the status output is
 * identical for both states. Hashing the bytes closes that gap.
 *
 * Type is part of the evidence: a path that vanished hashes as "missing", a
 * directory as "dir", a symlink by its target string. Without Git this
 * capture returns null — unknown stays unknown.
 */
function readGitTree(projectRoot: string): string | null {
  try {
    const gitRoot = fs.realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
      windowsHide: true,
    }).trim());
    const physicalProjectRoot = fs.realpathSync(projectRoot);
    const projectPrefix = path.relative(gitRoot, physicalProjectRoot);
    if (
      path.isAbsolute(projectPrefix) || projectPrefix === ".." ||
      projectPrefix.startsWith(`..${path.sep}`)
    ) return null;
    const scopePath = projectPrefix ? `:(top,literal)${projectPrefix.split(path.sep).join("/")}` : ".";
    const index = execFileSync("git", ["ls-files", "-s", "--", scopePath], {
      cwd: gitRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
      windowsHide: true,
    });
    const status = execFileSync(
      "git",
      ["status", "--porcelain", "-z", "--untracked-files=all", "--", scopePath],
      {
        cwd: gitRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10_000,
        windowsHide: true,
      },
    );

    const divergent: string[] = [];
    const tokens = status.split("\0").filter((token) => token.length > 0);
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i]!;
      // Porcelain v1: exactly two status bytes, one space, then the path.
      if (token.length < 4) continue;
      const xy = token.slice(0, 2);
      const recordPath = token.slice(3);
      divergent.push(recordPath);
      if (xy.includes("R") || xy.includes("C")) i += 1; // skip origPath token
    }

    const contentDigests = divergent
      .sort()
      .map((relativePath) => {
        // Private divergent paths cannot be content-bound without opening a
        // credential store. Refuse the repository binding before content I/O.
        if (isCredentialTargetPath(relativePath)) throw new Error("Repository revision includes a credential path.");
        const absolute = path.resolve(gitRoot, relativePath);
        const withinProject = path.relative(physicalProjectRoot, absolute);
        if (
          path.isAbsolute(withinProject) || withinProject === ".." ||
          withinProject.startsWith(`..${path.sep}`)
        ) throw new Error("Git status returned a path outside the requested project scope.");
        // The lexical check above is not enough: an in-project parent may be
        // replaced by a symlink to an outside directory. Validate each parent
        // physically before reading the leaf. The leaf itself is inspected
        // with lstat below, so a final symlink is hashed as a link, not followed.
        let parent = physicalProjectRoot;
        const parentParts = path.dirname(withinProject).split(path.sep).filter(Boolean);
        for (const part of parentParts) {
          parent = path.resolve(parent, part);
          let parentStats: fs.Stats;
          try {
            parentStats = fs.lstatSync(parent);
          } catch (error) {
            if (
              error && typeof error === "object" && "code" in error &&
              (error as { code?: string }).code === "ENOENT"
            ) return `${relativePath}:missing`;
            throw error;
          }
          if (parentStats.isSymbolicLink() || !parentStats.isDirectory())
            throw new Error("Git status path traverses a non-directory or symlink parent.");
          const physicalParent = fs.realpathSync(parent);
          const physicalRelative = path.relative(physicalProjectRoot, physicalParent);
          if (
            path.isAbsolute(physicalRelative) || physicalRelative === ".." ||
            physicalRelative.startsWith(`..${path.sep}`)
          ) throw new Error("Git status path resolves outside the requested project scope.");
        }
        let stats: fs.Stats;
        try {
          stats = fs.lstatSync(absolute);
        } catch {
          return `${relativePath}:missing`;
        }
        if (stats.isDirectory()) return `${relativePath}:dir`;
        if (stats.isSymbolicLink())
          return `${relativePath}:symlink:${hashFileContent(fs.readlinkSync(absolute))}`;
        return `${relativePath}:${hashFileContent(fs.readFileSync(absolute))}`;
      });

    return hashFileContent(`${index}\0${contentDigests.join("\n")}`);
  } catch {
    return null;
  }
}

const INPUT_CLOSURE_SKIP_DIRS = new Set([
  "node_modules", ".git",
]);
const INPUT_CLOSURE_MAX_FILES = 40;
const INPUT_CLOSURE_MAX_BYTES = 1_000_000;

function closurePathIsCredential(relativePath: string): boolean {
  return isCredentialTargetPath(relativePath);
}

/**
 * Bounded relevant-input closure for verifier reuse. Credential paths are
 * skipped without a content read. Oversized or too-wide trees are unsupported,
 * which forbids reuse rather than pretending the tree was bound.
 */
export function discoverVerifierInputClosure(projectRoot: string):
  | { mode: "bound"; paths: string[]; digests: Record<string, string> }
  | { mode: "unsupported"; reason: string } {
  const root = path.resolve(projectRoot);
  const paths: string[] = [];
  const digests: Record<string, string> = {};
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return { mode: "unsupported", reason: "Input directory is not listable" };
    }
    for (const entry of entries) {
      if (INPUT_CLOSURE_SKIP_DIRS.has(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      const relativePath = path.relative(root, absolute).split(path.sep).join("/");
      if (closurePathIsCredential(relativePath)) continue;
      let stats: fs.Stats;
      try {
        stats = fs.lstatSync(absolute);
      } catch {
        return { mode: "unsupported", reason: "Input path is not stat-able" };
      }
      if (stats.isSymbolicLink()) {
        return { mode: "unsupported", reason: "Input closure cannot bind a symlink" };
      }
      if (stats.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      if (!stats.isFile()) continue;
      if (stats.size > INPUT_CLOSURE_MAX_BYTES) {
        return { mode: "unsupported", reason: "Input file exceeds the closure size cap" };
      }
      let content: Buffer;
      try {
        content = fs.readFileSync(absolute);
      } catch {
        return { mode: "unsupported", reason: "Input file is not readable" };
      }
      paths.push(relativePath);
      digests[relativePath] = hashFileContent(content);
      if (paths.length > INPUT_CLOSURE_MAX_FILES) {
        return { mode: "unsupported", reason: "Input closure exceeds the file cap" };
      }
    }
  }
  paths.sort();
  return { mode: "bound", paths, digests };
}

export function compareRevisions(
  bound: WorkspaceRevision,
  current: WorkspaceRevision,
): { stale: boolean; reason?: string } {
  if (!bound.scope || !current.scope)
    return { stale: true, reason: "Revision scope is not explicit" };
  if (canonicalJsonForHash(bound.scope) !== canonicalJsonForHash(current.scope))
    return { stale: true, reason: "Revision scope changed" };
  if (
    bound.gitBinding === "required" &&
    (!bound.gitCommitHash || !current.gitCommitHash)
  )
    return { stale: true, reason: "Required Git revision is unavailable" };
  if (bound.gitCommitHash !== current.gitCommitHash)
    return { stale: true, reason: "Git commit changed after verification" };
  if (bound.compositeTreeHash !== current.compositeTreeHash)
    return { stale: true, reason: "Composite tree hash mismatch" };
  for (const file of Object.keys(bound.fileHashes)) {
    if (bound.fileHashes[file] !== current.fileHashes[file])
      return {
        stale: true,
        reason: `File modified after verification: ${file}`,
      };
  }
  return { stale: false };
}

function computeRevision(
  projectRoot: string,
  touchedFiles: string[],
  options: {
    scope_kind?: "files" | "repository";
    git_binding?: GitBindingModeV1;
  } = {},
): WorkspaceRevision {
  const scopeKind = options.scope_kind ?? "files";
  const gitCommitHash = readGitHead(projectRoot);
  const gitBinding = options.git_binding ?? "optional";
  if (gitBinding === "required" && !gitCommitHash)
    throw new Error("Required Git revision cannot be established.");
  const scope: RevisionScopeV1 =
    scopeKind === "repository"
      ? { kind: "repository" }
      : { kind: "files", paths: canonicalFiles(projectRoot, touchedFiles) };
  if (scope.kind === "files" && scope.paths.length === 0)
    throw new Error(
      "Revision-bound file scope must not be empty; use scope_kind=repository explicitly.",
    );
  const fileHashes: Record<string, string> = {};
  if (scope.kind === "files") {
    for (const file of scope.paths) {
      try {
        fileHashes[file] = hashFileContent(
          fs.readFileSync(path.resolve(projectRoot, file)),
        );
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          (error as { code?: string }).code === "ENOENT"
        )
          fileHashes[file] = "deleted";
        else throw error;
      }
    }
  } else {
    const treeHash = readGitTree(projectRoot);
    if (!treeHash && gitBinding === "required")
      throw new Error("Required Git tree cannot be established.");
    // Without Git the repository's contents are UNVERIFIED: the legacy
    // fallback hashed the directory PATH string, which is constant across
    // content changes and could therefore "prove" an unchanged tree that had
    // in fact moved. Keep a revision for optional-binding callers, but make
    // its provenance explicit in the digest so it can never be confused with
    // content-derived evidence; downstream consumers must treat a repository
    // scope without a Git hash as an unknown state, not a fresh capture.
    fileHashes["<repository>"] =
      treeHash ?? hashFileContent(`unverified-contents:${projectRoot}`);
  }
  return {
    gitCommitHash,
    compositeTreeHash: compositeFromFileHashes(scope, fileHashes),
    fileHashes,
    capturedAt: Date.now(),
    scope,
    gitBinding,
  };
}

/** Validate the strict certifying receipt shape; empty scope is rejected. */
export function validateRevisionBoundReceipt(value: unknown): string[] {
  const candidate =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const receipt = {
    receiptId: candidate["receiptId"],
    command: candidate["command"],
    exitCode: candidate["exitCode"],
    boundRevision: candidate["boundRevision"],
    stale: candidate["stale"],
    ...(candidate["authority"] !== undefined
      ? { authority: candidate["authority"] }
      : {}),
    ...(candidate["authoritySource"] !== undefined
      ? { authoritySource: candidate["authoritySource"] }
      : {}),
    ...(candidate["staleReason"] !== undefined
      ? { staleReason: candidate["staleReason"] }
      : {}),
  };
  const parsed = z
    .object({
      receiptId: z.string().min(1),
      command: z.string().min(1),
      exitCode: z.number().int(),
      boundRevision: WorkspaceRevisionSchema,
      stale: z.boolean(),
      authority: z.boolean().optional(),
      authoritySource: z.string().min(1).optional(),
      staleReason: z.string().min(1).optional(),
    })
    .strict()
    .safeParse(receipt);
  if (!parsed.success)
    return parsed.error.issues.map((issue) => issue.path.join(".") || "$");

  const revision = parsed.data.boundRevision;
  const errors: string[] = [];
  if (revision.scope.kind === "files") {
    const canonicalPaths = revision.scope.paths.map((candidate) => {
      const normalized = candidate.replaceAll("\\", "/");
      return path.posix.normalize(normalized);
    });
    if (
      canonicalPaths.some(
        (candidate) =>
          candidate === "." ||
          candidate === ".." ||
          candidate.startsWith("../") ||
          /^(?:[A-Za-z]:|\/|\\)/.test(candidate),
      )
    )
      errors.push("boundRevision.scope.paths");
    if (new Set(canonicalPaths).size !== canonicalPaths.length)
      errors.push("boundRevision.scope.paths_duplicate");
    const declared = [...Object.keys(revision.fileHashes)].sort();
    const expected = [...canonicalPaths].sort();
    if (
      declared.length !== expected.length ||
      declared.some((key, i) => key !== expected[i])
    )
      errors.push("boundRevision.fileHashes_scope_mismatch");
  } else if (
    Object.keys(revision.fileHashes).length !== 1 ||
    revision.fileHashes["<repository>"] === undefined
  ) {
    errors.push("boundRevision.repository_scope_mismatch");
  }
  if (revision.gitBinding === "required" && revision.gitCommitHash === null)
    errors.push("boundRevision.gitCommitHash_required");
  if (
    compositeFromFileHashes(revision.scope, revision.fileHashes) !==
    revision.compositeTreeHash
  )
    errors.push("boundRevision.compositeTreeHash");
  return errors;
}

export class RevisionManager {
  static computeRevisionSync(
    projectRoot: string,
    touchedFiles: string[],
    options?: {
      scope_kind?: "files" | "repository";
      git_binding?: GitBindingModeV1;
    },
  ): WorkspaceRevision {
    return computeRevision(projectRoot, touchedFiles, options);
  }

  static async computeRevision(
    projectRoot: string,
    touchedFiles: string[],
    options?: {
      scope_kind?: "files" | "repository";
      git_binding?: GitBindingModeV1;
    },
  ): Promise<WorkspaceRevision> {
    return computeRevision(projectRoot, touchedFiles, options);
  }

  static isReceiptStaleSync(
    receipt: RevisionBoundReceipt,
    projectRoot: string,
  ): { stale: boolean; reason?: string } {
    if (receipt.stale)
      return receipt.staleReason
        ? { stale: true, reason: receipt.staleReason }
        : { stale: true };
    const revision = receipt.boundRevision;
    if (!revision.scope || !revision.gitBinding)
      return {
        stale: true,
        reason: "Receipt has no explicit revision scope or Git binding mode",
      };
    const paths = revision.scope.kind === "files" ? revision.scope.paths : [];
    return compareRevisions(
      revision,
      computeRevision(projectRoot, paths, {
        scope_kind: revision.scope.kind,
        git_binding: revision.gitBinding,
      }),
    );
  }

  static async isReceiptStale(
    receipt: RevisionBoundReceipt,
    projectRoot: string,
  ): Promise<{ stale: boolean; reason?: string }> {
    return this.isReceiptStaleSync(receipt, projectRoot);
  }
}
