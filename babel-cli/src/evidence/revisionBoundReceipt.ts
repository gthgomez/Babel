import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
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
 * Bind Git's index observation together with independently enumerated physical
 * inputs. Index flags never decide which tracked bytes are measured. Excluded
 * tracked paths, malformed enumeration, unsafe types and exceeded bounds make
 * the repository capture unavailable before input content is opened.
 */
function readGitTree(projectRoot: string): string | null {
  try {
    const gitRoot = fs.realpathSync.native(execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000, windowsHide: true,
    }).trim());
    const root = fs.realpathSync.native(projectRoot);
    const prefix = path.relative(gitRoot, root);
    if (path.isAbsolute(prefix) || prefix === ".." || prefix.startsWith(`..${path.sep}`)) return null;
    const scopePath = prefix ? `:(top,literal)${prefix.split(path.sep).join("/")}` : ".";
    // -v records skip-worktree / assume-unchanged as metadata; -z preserves
    // literal names, including newlines. Neither status nor flags select bytes.
    const index = execFileSync("git", ["ls-files", "-s", "-v", "-z", "--", scopePath], {
      cwd: gitRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000, maxBuffer: INPUT_CLOSURE_MAX_BYTES, windowsHide: true,
    });
    if (index && !index.endsWith("\0")) return null;
    const requiredPaths: string[] = [];
    const missing: string[] = [];
    const seen = new Set<string>();
    for (const record of index.split("\0").filter(Boolean)) {
      const match = /^([A-Za-z?]) ([0-7]{6}) ([0-9a-f]{40}) 0\t([\s\S]+)$/.exec(record);
      if (!match) return null;
      const absolute = path.resolve(gitRoot, match[4]!);
      const relative = assertProjectRelativePath(root, path.relative(root, absolute));
      if (seen.has(relative) || isCredentialTargetPath(relative) ||
        relative.split("/").some(part => INPUT_CLOSURE_SKIP_DIRS.has(part))) return null;
      seen.add(relative);
      // Admit tracked ancestors before the independent reader accesses bytes.
      let candidate = root;
      let absent = false;
      const parts = relative.split("/");
      for (let i = 0; i < parts.length; i += 1) {
        candidate = path.join(candidate, parts[i]!);
        let stats: fs.Stats;
        try { stats = fs.lstatSync(candidate); }
        catch (error) {
          if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
            absent = true;
            break;
          }
          return null;
        }
        if (i < parts.length - 1 && !stats.isDirectory()) return null;
      }
      if (absent) missing.push(relative);
      else requiredPaths.push(relative);
    }
    const physical = captureVerifierInputClosure(root, true, requiredPaths);
    if (physical.mode !== "bound") return null;
    return hashFileContent(canonicalJsonForHash({
      method: "physical-worktree-v1", root, index,
      excludedDirectories: [...INPUT_CLOSURE_SKIP_DIRS].sort(),
      digests: physical.digests, missing: missing.sort(),
    }));
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

type VerifierInputClosure =
  | { mode: "bound"; paths: string[]; digests: Record<string, string>; reuseEligible?: false }
  | { mode: "unsupported"; reason: string };

/**
 * Bind every eligible input, including ignored files. Cache discovery keeps its
 * 40-file bound; fresh proof reallocates that same worst-case content envelope
 * (40 x 1 MB) across files and path metadata, without granting cache reuse.
 * Complete metadata admission precedes content I/O in either mode.
 */
export function discoverVerifierInputClosure(projectRoot: string, freshProof = false): VerifierInputClosure {
  return captureVerifierInputClosure(projectRoot, freshProof);
}

// Repository mode also binds directory types and leaf link strings. A tracked
// path absent from independent enumeration is incomplete evidence, not deletion.
function captureVerifierInputClosure(
  projectRoot: string, freshProof: boolean, requiredPaths?: readonly string[],
): VerifierInputClosure {
  const unsupported = (reason: string): { mode: "unsupported"; reason: string } => ({ mode: "unsupported", reason });
  let root: string;
  try { root = fs.realpathSync.native(projectRoot); }
  catch { return unsupported("Input root is not resolvable"); }
  // Admit the physical root before opening a directory or any input content.
  if (closurePathIsCredential(root)) return unsupported("Input closure includes a credential path");
  const paths: string[] = [];
  const digests: Record<string, string> = Object.create(null);
  const files: Array<{ absolute: string; relativePath: string; size: number; kind: "file" | "symlink"; admittedStats: fs.Stats }> = [];
  const admitted = new Set<string>();
  const stack = [root];
  const maxBudgetBytes = INPUT_CLOSURE_MAX_FILES * INPUT_CLOSURE_MAX_BYTES;
  const started = Date.now();
  let budgetBytes = 0;
  while (stack.length > 0) {
    if (Date.now() - started >= 10_000) return unsupported("Input closure proof deadline exceeded");
    const dir = stack.pop()!;
    let directory: fs.Dir;
    try { directory = fs.opendirSync(dir); }
    catch { return unsupported("Input directory is not listable"); }
    try {
      let entry: fs.Dirent | null;
      while ((entry = directory.readSync()) !== null) {
        if (Date.now() - started >= 10_000) return unsupported("Input closure proof deadline exceeded");
        if (INPUT_CLOSURE_SKIP_DIRS.has(entry.name)) continue;
        const absolute = path.join(dir, entry.name);
        const relativePath = path.relative(root, absolute).split(path.sep).join("/");
        if (closurePathIsCredential(relativePath)) {
          if (freshProof) return unsupported("Input closure includes a credential path");
          continue;
        }
        let stats: fs.Stats;
        try {
          stats = fs.lstatSync(absolute);
        } catch { return unsupported("Input path is not readable"); }
        if (stats.isSymbolicLink() && !requiredPaths) return unsupported("Input closure cannot bind a symlink");
        if (!stats.isSymbolicLink()) {
          try { fs.accessSync(absolute, fs.constants.R_OK); }
          catch { return unsupported("Input path is not readable"); }
        }
        admitted.add(relativePath);
        budgetBytes += Buffer.byteLength(relativePath, "utf8") + 1;
        if (stats.isDirectory()) {
          stack.push(absolute);
          if (requiredPaths) digests[relativePath] = hashFileContent("directory");
        } else if (stats.isFile() || stats.isSymbolicLink()) {
          if (stats.size > INPUT_CLOSURE_MAX_BYTES) return unsupported("Input file exceeds the closure size cap");
          budgetBytes += stats.size;
          files.push({ absolute, relativePath, size: stats.size, kind: stats.isSymbolicLink() ? "symlink" : "file", admittedStats: stats });
          if (!freshProof && files.length > INPUT_CLOSURE_MAX_FILES) return unsupported("Input closure exceeds the file cap");
        } else return unsupported("Input closure includes an unsupported filesystem entry");
        if (budgetBytes > maxBudgetBytes) return unsupported("Input closure exceeds the proof byte budget");
      }
    } catch { return unsupported("Input directory is not listable"); }
    finally { directory.closeSync(); }
  }
  if (requiredPaths?.some(relativePath => !admitted.has(relativePath)))
    return unsupported("Tracked path was omitted from physical enumeration");
  // Refuse growth or changed entry types between admission and content access.
  for (const file of files) {
    if (Date.now() - started >= 10_000) return unsupported("Input closure proof deadline exceeded");
    let descriptor: number | undefined;
    try {
      let parent = root;
      for (const part of path.dirname(file.relativePath).split("/").filter(part => part !== ".")) {
        parent = path.join(parent, part);
        if (!fs.lstatSync(parent).isDirectory()) return unsupported("Input changed after admission");
      }
      const leaf = fs.lstatSync(file.absolute);
      if (!samePhysicalFile(file.admittedStats, leaf)) return unsupported("Input changed after admission");
      if (file.kind === "symlink") {
        if (!leaf.isSymbolicLink() || leaf.size !== file.size) return unsupported("Input changed after admission");
        const target = fs.readlinkSync(file.absolute);
        if (Buffer.byteLength(target, "utf8") !== file.size) return unsupported("Input changed after admission");
        paths.push(file.relativePath);
        digests[file.relativePath] = hashFileContent(canonicalJsonForHash({ kind: "symlink", target }));
        continue;
      }
      if (!leaf.isFile()) return unsupported("Input changed after admission");
      descriptor = fs.openSync(file.absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stats = fs.fstatSync(descriptor);
      if (!stats.isFile() || !samePhysicalFile(file.admittedStats, stats)) return unsupported("Input changed after admission");
      // Bound allocation and reads even if a file grows after metadata admission.
      const buffer = Buffer.alloc(file.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = fs.readSync(descriptor, buffer, length, buffer.length - length, length);
        if (read === 0) break;
        length += read;
      }
      if (length !== file.size || Date.now() - started >= 10_000) return unsupported("Input changed after admission");
      if (!samePhysicalFile(stats, fs.fstatSync(descriptor))) return unsupported("Input changed during capture");
      const content = buffer.subarray(0, length);
      paths.push(file.relativePath);
      digests[file.relativePath] = requiredPaths
        ? hashFileContent(canonicalJsonForHash({ kind: "file", digest: hashFileContent(content) }))
        : hashFileContent(content);
    } catch { return unsupported("Input file is not readable"); }
    finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  }
  paths.sort();
  return { mode: "bound", paths, digests, ...(freshProof ? { reuseEligible: false as const } : {}) };
}

function samePhysicalFile(before: fs.Stats, after: fs.Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino &&
    before.mode === after.mode && before.size === after.size &&
    before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
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
  if (bound.scope.kind === "repository" && (!bound.gitCommitHash || !current.gitCommitHash))
    return { stale: true, reason: "Repository physical revision is unavailable" };
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
  let gitCommitHash = readGitHead(projectRoot);
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
  const fileHashes: Record<string, string> = Object.create(null);
  if (scope.kind === "files") {
    if (scope.paths.some(isCredentialTargetPath))
      throw new Error("Revision scope includes a credential path.");
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
    // Optional callers retain an explicitly unknown revision, never a reusable
    // content proof. A valid HEAD alone cannot certify failed physical capture.
    if (!treeHash) gitCommitHash = null;
    fileHashes["<repository>"] = treeHash ?? hashFileContent(`unverified-contents:${crypto.randomUUID()}`);
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
  if (revision.scope.kind === "repository" && revision.gitCommitHash === null)
    errors.push("boundRevision.repository_physical_revision_unavailable");
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
