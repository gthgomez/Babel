/**
 * U1.4: Slim interactive stack — budget-aware compilation tests.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  compileChatStack,
  INTERACTIVE_STACK_BUDGET,
  resolveStackBudgetForClass,
  SWE_STACK_BUDGET,
} from "./chatStackCompile.js";

describe("resolveStackBudgetForClass", () => {
  it("returns INTERACTIVE_STACK_BUDGET (12_000) for non-SWE classes", () => {
    assert.equal(
      resolveStackBudgetForClass("default"),
      INTERACTIVE_STACK_BUDGET,
    );
    assert.equal(
      resolveStackBudgetForClass("quick_fix"),
      INTERACTIVE_STACK_BUDGET,
    );
    assert.equal(
      resolveStackBudgetForClass("investigate"),
      INTERACTIVE_STACK_BUDGET,
    );
    assert.equal(
      resolveStackBudgetForClass("governance"),
      INTERACTIVE_STACK_BUDGET,
    );
  });

  it("returns SWE_STACK_BUDGET (24_000) for general_swe", () => {
    assert.equal(resolveStackBudgetForClass("general_swe"), SWE_STACK_BUDGET);
  });

  it("returns INTERACTIVE_STACK_BUDGET for undefined class (safe default)", () => {
    assert.equal(
      resolveStackBudgetForClass(undefined),
      INTERACTIVE_STACK_BUDGET,
    );
  });

  it("interactive budget is lower than SWE budget", () => {
    assert.ok(
      INTERACTIVE_STACK_BUDGET < SWE_STACK_BUDGET,
      `INTERACTIVE_STACK_BUDGET (${INTERACTIVE_STACK_BUDGET}) must be < SWE_STACK_BUDGET (${SWE_STACK_BUDGET})`,
    );
  });

  it("interactive budget ≤ 12_000 as documented", () => {
    assert.ok(
      INTERACTIVE_STACK_BUDGET <= 12_000,
      "Interactive budget must be ≤ 12_000 per U1.4 spec",
    );
  });
});

describe("compileChatStack budget behavior", () => {
  it("respects explicit promptBudgetChars option", () => {
    const stack = compileChatStack({
      projectRoot: "/tmp/test",
      task: "fix a bug",
      promptBudgetChars: 5_000,
      includeDomainSkill: false,
    });

    assert.ok(stack.system_context.length <= 5_000 + 50); // small tolerance for trim marker
    assert.ok(stack.selected_entries.length >= 3); // identity + safety + verifier at minimum
  });

  it("interactive budget (12_000) produces system_context ≤ 12_000", () => {
    const stack = compileChatStack({
      projectRoot: "/tmp/test",
      task: "fix a bug",
      promptBudgetChars: INTERACTIVE_STACK_BUDGET,
      includeDomainSkill: false,
    });

    // Budget trim may add ~35 chars for the trim marker
    assert.ok(
      stack.system_context.length <= INTERACTIVE_STACK_BUDGET + 50,
      `system_context length ${stack.system_context.length} should be ≤ ${INTERACTIVE_STACK_BUDGET + 50}`,
    );
  });

  it("SWE budget (24_000) produces system_context ≤ 24_000", () => {
    const stack = compileChatStack({
      projectRoot: "/tmp/test",
      task: "fix a bug",
      promptBudgetChars: SWE_STACK_BUDGET,
      includeDomainSkill: false,
    });

    assert.ok(
      stack.system_context.length <= SWE_STACK_BUDGET + 50,
      `system_context length ${stack.system_context.length} should be ≤ ${SWE_STACK_BUDGET + 50}`,
    );
  });

  it("interactive budget stack has lower estimated_tokens than SWE stack for same input", () => {
    const interactive = compileChatStack({
      projectRoot: "/tmp/test",
      task: "fix a bug",
      promptBudgetChars: INTERACTIVE_STACK_BUDGET,
      includeDomainSkill: false,
    });

    const swe = compileChatStack({
      projectRoot: "/tmp/test",
      task: "fix a bug",
      promptBudgetChars: SWE_STACK_BUDGET,
      includeDomainSkill: false,
    });

    // With the same input, the interactive budget may trim earlier.
    // If both fit within 12_000, they'll be equal; otherwise interactive < swe.
    assert.ok(
      interactive.estimated_tokens <= swe.estimated_tokens,
      `interactive tokens (${interactive.estimated_tokens}) should be ≤ SWE tokens (${swe.estimated_tokens})`,
    );
  });

  it("estimated_tokens is derived from system_context length", () => {
    const stack = compileChatStack({
      projectRoot: "/tmp/test",
      task: "fix a bug",
      promptBudgetChars: 6_000,
      includeDomainSkill: false,
    });

    const expected = Math.ceil(stack.system_context.length / 4);
    assert.equal(stack.estimated_tokens, expected);
  });

  it("packs optional sections without dropping the mandatory safety core", () => {
    const stack = compileChatStack({
      projectRoot: process.cwd(),
      task: "fix a cli shell bug",
      promptBudgetChars: 2_000,
    });
    assert.ok(stack.system_context.length <= 2_000);
    assert.match(stack.system_context, /# Chat safety adapter/);
    assert.match(stack.system_context, /# Provider \/ model adapter/);
    assert.match(stack.system_context, /# Task verifier guidance/);
    assert.equal(stack.delivered_content_digest.length, 64);
    assert.equal(stack.context_error, undefined);
    assert.ok(stack.content_disposition.some((item) => item.status === "omitted" || item.status === "truncated"));
  });

  it("packs decisive project context before generic identity at a tight budget", () => {
    const root = mkdtempSync(join(tmpdir(), "babel-chat-stack-priority-"));
    try {
      writeFileSync(join(root, "AGENTS.md"), "generic identity\n" + "x".repeat(8_000), "utf8");
      writeFileSync(join(root, "PROJECT_CONTEXT.md"), "PROJECT_REQUIREMENT: preserve the public API\n", "utf8");
      const stack = compileChatStack({
        projectRoot: root,
        promptBudgetChars: 2_000,
        includeDomainSkill: false,
      });

      assert.match(stack.system_context, /PROJECT_REQUIREMENT: preserve the public API/);
      assert.equal(
        stack.content_disposition.find((item) => item.id === "project:context")?.status,
        "included",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns an explicit context error when mandatory content cannot fit", () => {
    const stack = compileChatStack({
      projectRoot: "/tmp/test",
      promptBudgetChars: 1,
      includeDomainSkill: false,
    });
    assert.equal(stack.context_error, "mandatory_instruction_core_exceeds_prompt_budget");
    assert.equal(stack.system_context, "");
  });

  it("honors the declared UTF-16 budget without overflowing on emoji", () => {
    const root = mkdtempSync(join(tmpdir(), "babel-chat-stack-"));
    try {
      writeFileSync(join(root, "AGENTS.md"), "😀".repeat(7_000), "utf8");
      const stack = compileChatStack({
        projectRoot: root,
        promptBudgetChars: 2_000,
        includeDomainSkill: false,
      });

      assert.equal(stack.budget_unit, "utf16_code_units");
      assert.ok(stack.system_context.length <= 2_000);
      assert.ok(stack.content_disposition.every((item) => item.delivered_content_digest.length === 64));
      assert.equal(stack.system_context.includes("\uD800"), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records full source identity separately from a pre-read-truncated fragment", () => {
    const root = mkdtempSync(join(tmpdir(), "babel-chat-stack-"));
    try {
      const prefix = "# instructions\n" + "x".repeat(12_500);
      writeFileSync(join(root, "AGENTS.md"), prefix + "A", "utf8");
      const first = compileChatStack({ projectRoot: root, includeDomainSkill: false });
      const firstIdentity = first.selected_entries.find((entry) => entry.id === "identity:agents")!;

      writeFileSync(join(root, "AGENTS.md"), prefix + "B", "utf8");
      const second = compileChatStack({ projectRoot: root, includeDomainSkill: false });
      const secondIdentity = second.selected_entries.find((entry) => entry.id === "identity:agents")!;

      assert.equal(firstIdentity.source_truncated, true);
      assert.equal(secondIdentity.source_truncated, true);
      assert.notEqual(firstIdentity.source_digest, secondIdentity.source_digest);
      assert.equal(firstIdentity.content_digest, secondIdentity.content_digest);
      assert.equal(firstIdentity.source_length, secondIdentity.source_length);
      assert.ok((firstIdentity.source_length ?? 0) > (firstIdentity.content_length ?? 0));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("compileChatStack shape invariants", () => {
  it("always includes deep_stages_excluded: true", () => {
    const stack = compileChatStack({
      projectRoot: "/tmp/test",
      task: "fix a bug",
    });

    assert.equal(stack.deep_stages_excluded, true);
  });

  it("always includes identity, safety, provider, and verifier entries", () => {
    const stack = compileChatStack({
      projectRoot: "/tmp/test",
      task: "fix a bug",
      includeDomainSkill: false,
    });

    const layers = new Set(stack.selected_entries.map((e) => e.layer));
    assert.ok(layers.has("identity"), "must have identity layer");
    assert.ok(layers.has("safety"), "must have safety layer");
    assert.ok(layers.has("provider"), "must have provider layer");
    assert.ok(layers.has("verifier"), "must have verifier layer");
  });

  it("produces a stable manifest_hash for same inputs", () => {
    const a = compileChatStack({
      projectRoot: "/tmp/test",
      task: "fix a bug",
      promptBudgetChars: 12_000,
      includeDomainSkill: false,
    });

    const b = compileChatStack({
      projectRoot: "/tmp/test",
      task: "fix a bug",
      promptBudgetChars: 12_000,
      includeDomainSkill: false,
    });

    assert.equal(a.manifest_hash, b.manifest_hash);
  });

  it("different budgets can produce different hashes when trimming changes content", () => {
    // Same project root + task but different budgets — hash may differ
    // if the system_context was trimmed.
    const a = compileChatStack({
      projectRoot: "/tmp/test",
      task: "fix a bug",
      promptBudgetChars: 2_000,
      includeDomainSkill: false,
    });

    const b = compileChatStack({
      projectRoot: "/tmp/test",
      task: "fix a bug",
      promptBudgetChars: 24_000,
      includeDomainSkill: false,
    });

    // Entries should be identical (same selection), just different trim
    const aIds = a.selected_entries
      .map((e) => e.id)
      .sort()
      .join(",");
    const bIds = b.selected_entries
      .map((e) => e.id)
      .sort()
      .join(",");
    assert.equal(aIds, bIds);
  });

  it("project_root is resolved to absolute path", () => {
    const stack = compileChatStack({
      projectRoot: "/tmp/test",
      task: "fix",
    });

    assert.ok(stack.project_root.includes("tmp"));
    assert.ok(stack.project_root.includes("test"));
  });

  it("includes domain/skill hints when task matches and includeDomainSkill is default", () => {
    const stack = compileChatStack({
      projectRoot: "/tmp/test",
      task: "fix the React component rendering",
    });

    const domain = stack.selected_entries.find((e) => e.layer === "domain");
    assert.ok(domain, "should include domain entry for React task");
  });

  it("skips domain/skill when includeDomainSkill is false", () => {
    const stack = compileChatStack({
      projectRoot: "/tmp/test",
      task: "fix the React component rendering",
      includeDomainSkill: false,
    });

    const domain = stack.selected_entries.find((e) => e.layer === "domain");
    assert.equal(domain, undefined);
  });
});

describe("compileChatStack with real project root", () => {
  it("loads identity from AGENTS.md when present in project root", () => {
    // Use the real repo root which has AGENTS.md
    const stack = compileChatStack({
      projectRoot: process.cwd(),
      task: "fix a bug",
      promptBudgetChars: 12_000,
    });

    const identity = stack.selected_entries.find((e) => e.layer === "identity");
    assert.ok(identity, "must have identity entry");
    // When AGENTS.md exists, it should be loaded from repo root
    assert.ok(
      identity!.path.includes("AGENTS.md") ||
        identity!.path.includes("CLAUDE.md"),
      `identity path should be AGENTS.md or CLAUDE.md, got: ${identity!.path}`,
    );
    assert.ok(identity!.contentPreview, "identity should have content preview");
  });
});
