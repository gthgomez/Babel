import { describe, it, before, after } from "node:test";
import * as assert from "node:assert";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERIFIER_RECEIPT_V2, type VerifierReceiptV2 } from "../agent/verifierKernel.js";
import {
  EpisodeStore,
  foldSearchRecords,
  parseSearchRecordLine,
  type SearchRecord,
} from "./episodeStore.js";
import {
  createSearchEpisode,
  newHypothesisId,
  scoreDominates,
  SEARCH_EPISODE_VERSION,
  validateCurrentBestConsistency,
  validateScoreReceipt,
  validateScoreVector,
  validateSearchEpisode,
  type Candidate,
  type LineageEdgeKind,
  type ScoreReceipt,
  type ScoreVector,
  type SearchEpisode,
} from "./types.js";
import { buildScoreReceipt } from "./receipts.js";

const T0 = "2026-01-01T00:00:00.000Z";

function makeVerifierReceipt(overrides?: {
  exit_code?: number;
  timed_out?: boolean;
}): VerifierReceiptV2 {
  return {
    schema_version: VERIFIER_RECEIPT_V2,
    receipt_id: `vr_${Math.random().toString(36).slice(2)}`,
    verifier_id: "test-verifier",
    argv: ["npm", "test"],
    cwd: ".",
    env_profile_hash: "env-hash",
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    exit_code: overrides?.exit_code ?? 0,
    timed_out: overrides?.timed_out ?? false,
    stdout_hash: "out",
    stderr_hash: "err",
    workspace_revision: { compositeTreeHash: `tree_${Math.random()}` },
    scope: "targeted",
    command: "npm test",
    authoritative: true,
    freshness: "fresh",
    evidence_refs: [],
  };
}

function throughputVector(value: number): ScoreVector {
  return {
    metrics: { throughput_tops: value },
    higher_is_better: { throughput_tops: true },
  };
}

function fakeCandidate(id: string, parentId?: string): Candidate {
  return {
    schema_version: SEARCH_EPISODE_VERSION,
    candidate_id: id,
    ...(parentId !== undefined ? { parent_candidate_id: parentId } : {}),
    workspace_revision: { compositeTreeHash: `tree_${id}` },
    mutation_refs: [],
    receipts: [],
    status: "working",
    created_at: T0,
  };
}

function fakeScoreReceipt(
  candidateId: string,
  overrides?: Partial<ScoreReceipt>,
): ScoreReceipt {
  return {
    schema_version: SEARCH_EPISODE_VERSION,
    receipt_id: `sr_${candidateId}`,
    candidate_id: candidateId,
    verifier_receipt_ids: ["vr_1"],
    score_vector: throughputVector(1),
    correct: true,
    evaluated_at: T0,
    evaluator_profile: "bench-v1",
    ...overrides,
  };
}

function headerRecord(): SearchRecord {
  return {
    type: "episode_header",
    recorded_at: T0,
    payload: createSearchEpisode({ task_contract_id: "tc_1", objective: "x" }),
  };
}

function edgeRecord(overrides: {
  edge_id: string;
  kind: LineageEdgeKind;
  from_ref: string;
  to_ref: string;
}): SearchRecord {
  return {
    type: "lineage_edge",
    recorded_at: T0,
    payload: {
      schema_version: SEARCH_EPISODE_VERSION,
      ...overrides,
      created_at: T0,
    },
  };
}

describe("createSearchEpisode", () => {
  it("builds a valid empty episode", () => {
    const ep = createSearchEpisode({
      task_contract_id: "tc_1",
      objective: "maximize attention kernel throughput",
    });
    assert.strictEqual(ep.schema_version, SEARCH_EPISODE_VERSION);
    assert.ok(ep.episode_id.startsWith("ep_"));
    assert.deepStrictEqual(validateSearchEpisode(ep), []);
  });

  it("flags a missing objective", () => {
    const ep = createSearchEpisode({ task_contract_id: "tc_1", objective: "" });
    assert.ok(validateSearchEpisode(ep).some((e) => e.includes("objective")));
  });
});

describe("EpisodeStore", () => {
  const dir = mkdtempSync(join(tmpdir(), "babel-search-test-"));
  const filePath = join(dir, "episodes", "ep.jsonl");
  let store: EpisodeStore;
  let parent: Candidate;

  before(() => {
    const episode = createSearchEpisode({
      task_contract_id: "tc_1",
      objective: "optimize kernel throughput",
    });
    EpisodeStore.init(filePath, episode);
    store = EpisodeStore.load(filePath);
    parent = store.addCandidate({
      workspace_revision: { compositeTreeHash: "tree_a" },
      mutation_refs: ["a.patch"],
    });
  });

  it("refuses to overwrite an existing episode store", () => {
    assert.throws(() =>
      EpisodeStore.init(
        filePath,
        createSearchEpisode({ task_contract_id: "tc_1", objective: "opt" }),
      ),
    );
  });

  it("records candidates and parent lineage", () => {
    const child = store.addCandidate({
      parent_candidate_id: parent.candidate_id,
      workspace_revision: { compositeTreeHash: "tree_b" },
      mutation_refs: ["b.patch"],
    });
    const loaded = EpisodeStore.load(filePath).episode;
    const loadedChild = loaded.candidates.find(
      (c) => c.candidate_id === child.candidate_id,
    );
    assert.notStrictEqual(loadedChild, undefined);
    assert.strictEqual(loadedChild?.parent_candidate_id, parent.candidate_id);
    assert.ok(
      loaded.lineage_edges.some(
        (e) =>
          e.kind === "parent_of" &&
          e.from_ref === parent.candidate_id &&
          e.to_ref === child.candidate_id,
      ),
    );
  });

  it("auto-rejects working candidates on failed evaluation with provenance edge", () => {
    const cand = store.addCandidate({
      workspace_revision: { compositeTreeHash: "tree_c" },
      mutation_refs: ["c.patch"],
    });
    store.recordScoreReceipt(
      buildScoreReceipt({
        candidate_id: cand.candidate_id,
        verifier_receipts: [makeVerifierReceipt({ exit_code: 1 })],
        score_vector: throughputVector(10),
        evaluator_profile: "bench-v1",
      }),
    );
    const loaded = EpisodeStore.load(filePath).episode;
    const rejected = loaded.candidates.find(
      (c) => c.candidate_id === cand.candidate_id,
    );
    assert.strictEqual(rejected?.status, "rejected");
    const edge = loaded.lineage_edges.find(
      (e) =>
        e.kind === "rejected_because" &&
        e.from_ref === cand.candidate_id &&
        e.to_ref === "failed_evaluation",
    );
    assert.notStrictEqual(edge, undefined);
    assert.ok(edge !== undefined && edge.created_at.length > 0);
  });

  it("promotes through controller policy and supersedes displaced bests", () => {
    const a = store.addCandidate({
      workspace_revision: { compositeTreeHash: "tree_d" },
      mutation_refs: ["d.patch"],
    });
    store.recordScoreReceipt(
      buildScoreReceipt({
        candidate_id: a.candidate_id,
        verifier_receipts: [makeVerifierReceipt()],
        score_vector: throughputVector(100),
        evaluator_profile: "bench-v1",
      }),
    );

    const unproven = store.addCandidate({
      workspace_revision: { compositeTreeHash: "tree_empty" },
      mutation_refs: [],
    });
    assert.throws(() => store.promoteCandidate(unproven.candidate_id));

    store.promoteCandidate(a.candidate_id);

    const b = store.addCandidate({
      parent_candidate_id: a.candidate_id,
      workspace_revision: { compositeTreeHash: "tree_e" },
      mutation_refs: ["e.patch"],
    });
    store.recordScoreReceipt(
      buildScoreReceipt({
        candidate_id: b.candidate_id,
        verifier_receipts: [makeVerifierReceipt()],
        score_vector: throughputVector(120),
        evaluator_profile: "bench-v1",
      }),
    );
    store.promoteCandidate(b.candidate_id);

    const loaded = EpisodeStore.load(filePath).episode;
    assert.strictEqual(loaded.search_state.current_best, b.candidate_id);
    assert.strictEqual(
      loaded.candidates.find((c) => c.candidate_id === a.candidate_id)?.status,
      "superseded",
    );
    assert.strictEqual(
      loaded.candidates.find((c) => c.candidate_id === b.candidate_id)?.status,
      "best",
    );
    assert.ok(
      loaded.lineage_edges.some(
        (e) =>
          e.kind === "supersedes" &&
          e.from_ref === b.candidate_id &&
          e.to_ref === a.candidate_id,
      ),
    );
  });

  it("round-trips identical state through reload", () => {
    const before = JSON.stringify(store.episode);
    const after = JSON.stringify(EpisodeStore.load(filePath).episode);
    assert.strictEqual(after, before);
  });

  it("keeps every persisted record well-formed and append-only", () => {
    const countLines = (): number =>
      readFileSync(filePath, "utf-8").split("\n").filter((l) => l.trim()).length;
    const baseline = countLines();
    store.recordHypothesis({
      hypothesis_id: newHypothesisId(),
      claim: "tiling improves throughput",
      family_id: "tiling",
      evidence_for: [],
      evidence_against: [],
      disposition: "open",
    });
    assert.ok(countLines() > baseline);
    for (const line of readFileSync(filePath, "utf-8")
      .split("\n")
      .filter((l) => l.trim())) {
      const rec = JSON.parse(line) as { type: string; recorded_at: string };
      assert.ok(rec.type.length > 0);
      assert.ok(rec.recorded_at.length > 0);
    }
  });

  it("fails closed on corrupt records", () => {
    const badPath = join(dir, "corrupt.jsonl");
    EpisodeStore.init(
      badPath,
      createSearchEpisode({ task_contract_id: "tc_1", objective: "x" }),
    );
    writeFileSync(badPath, "{not json}\n", "utf-8");
    assert.throws(() => EpisodeStore.load(badPath), /corrupt search episode/);
  });

  it("rejects supervisor events outside the 2-5 direction contract", () => {
    assert.throws(() => {
      store.recordSupervisorEvent({
        event_id: "sev_1",
        created_at: new Date().toISOString(),
        diagnosis: "plateau",
        directions: [
          {
            rationale: "only one",
            evidence_refs: [],
            falsification_experiment: "x",
          },
        ],
      });
    });
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("scoreDominates", () => {
  it("respects declared metric direction", () => {
    assert.strictEqual(
      scoreDominates(throughputVector(200), throughputVector(150)),
      true,
    );
    assert.strictEqual(
      scoreDominates(throughputVector(150), throughputVector(200)),
      false,
    );
    const latency = (ms: number): ScoreVector => ({
      metrics: { p50_ms: ms },
      higher_is_better: { p50_ms: false },
    });
    assert.strictEqual(scoreDominates(latency(5), latency(9)), true);
    assert.strictEqual(scoreDominates(latency(9), latency(5)), false);
  });

  it("treats partial dimension overlap as incomparable", () => {
    const wider = {
      metrics: { throughput_tops: 100, p50_ms: 500 },
      higher_is_better: { throughput_tops: true, p50_ms: false },
    };
    assert.strictEqual(scoreDominates(throughputVector(100), wider), false);
    assert.strictEqual(scoreDominates(wider, throughputVector(1)), false);
  });

  it("rejects undeclared directions and non-finite values", () => {
    const undeclared = {
      metrics: { throughput_tops: 100 },
      higher_is_better: {},
    };
    assert.strictEqual(
      scoreDominates(undeclared, throughputVector(1)),
      false,
    );
    const nanVector = {
      metrics: { throughput_tops: Number.NaN },
      higher_is_better: { throughput_tops: true },
    };
    assert.strictEqual(scoreDominates(nanVector, throughputVector(1)), false);
    assert.strictEqual(scoreDominates(throughputVector(1), nanVector), false);
  });

  it("ties and empty vectors dominate nothing", () => {
    assert.strictEqual(
      scoreDominates(throughputVector(100), throughputVector(100)),
      false,
    );
    const empty: ScoreVector = { metrics: {}, higher_is_better: {} };
    assert.strictEqual(scoreDominates(empty, empty), false);
    assert.strictEqual(scoreDominates(throughputVector(100), empty), false);
  });
});

describe("buildScoreReceipt binding", () => {
  it("requires at least one verifier receipt (fail closed)", () => {
    assert.throws(() =>
      buildScoreReceipt({
        candidate_id: "cand_x",
        verifier_receipts: [],
        score_vector: throughputVector(1),
        evaluator_profile: "bench-v1",
      }),
    );
  });

  it("rejects invalid score vectors before binding", () => {
    assert.throws(() =>
      buildScoreReceipt({
        candidate_id: "cand_x",
        verifier_receipts: [makeVerifierReceipt()],
        score_vector: {
          metrics: { throughput_tops: Number.NaN },
          higher_is_better: { throughput_tops: true },
        },
        evaluator_profile: "bench-v1",
      }),
      /not finite/,
    );
    assert.throws(() =>
      buildScoreReceipt({
        candidate_id: "cand_x",
        verifier_receipts: [makeVerifierReceipt()],
        score_vector: { metrics: { throughput_tops: 1 }, higher_is_better: {} },
        evaluator_profile: "bench-v1",
      }),
      /declared direction/,
    );
  });

  it("requires a non-empty evaluator profile", () => {
    assert.throws(() =>
      buildScoreReceipt({
        candidate_id: "cand_x",
        verifier_receipts: [makeVerifierReceipt()],
        score_vector: throughputVector(1),
        evaluator_profile: "",
      }),
      /evaluator_profile/,
    );
  });
});

describe("Wave-1 fail-closed folding", () => {
  const dir = mkdtempSync(join(tmpdir(), "babel-search-hardening-"));

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function newStorePath(name: string): string {
    return join(dir, `${name}.jsonl`);
  }

  function initStore(name: string): void {
    EpisodeStore.init(
      newStorePath(name),
      createSearchEpisode({ task_contract_id: "tc_1", objective: "x" }),
    );
  }

  function readRecordLines(path: string): SearchRecord[] {
    return readFileSync(path, "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l, i) => parseSearchRecordLine(l, i + 1));
  }

  it("fails closed on unknown record types with the offending type named", () => {
    initStore("unknown-type");
    appendFileSync(
      newStorePath("unknown-type"),
      `${JSON.stringify({ type: "quantum_flush", recorded_at: T0, payload: {} })}\n`,
      "utf-8",
    );
    assert.throws(
      () => EpisodeStore.load(newStorePath("unknown-type")),
      /unknown search episode record type "quantum_flush" at line 2/,
    );
  });

  it("rejects duplicate candidate records instead of overwriting lineage", () => {
    initStore("dup-candidate");
    const store = EpisodeStore.load(newStorePath("dup-candidate"));
    const cand = store.addCandidate({
      workspace_revision: { compositeTreeHash: "tree_a" },
      mutation_refs: [],
    });
    const lines = readFileSync(newStorePath("dup-candidate"), "utf-8")
      .split("\n")
      .filter((l) => l.trim());
    const candidateLine = lines.find((l) => l.includes(cand.candidate_id));
    assert.ok(candidateLine !== undefined);
    appendFileSync(newStorePath("dup-candidate"), `${candidateLine}\n`, "utf-8");
    assert.throws(
      () => EpisodeStore.load(newStorePath("dup-candidate")),
      /duplicate candidate record for cand_/,
    );
  });

  it("rejects duplicate lineage edge ids across reload", () => {
    initStore("dup-edge");
    const store = EpisodeStore.load(newStorePath("dup-edge"));
    const parent = store.addCandidate({
      workspace_revision: { compositeTreeHash: "tree_a" },
      mutation_refs: [],
    });
    store.addCandidate({
      parent_candidate_id: parent.candidate_id,
      workspace_revision: { compositeTreeHash: "tree_b" },
      mutation_refs: [],
    });
    const edgeLine = readFileSync(newStorePath("dup-edge"), "utf-8")
      .split("\n")
      .filter((l) => l.includes('"lineage_edge"'))[0];
    assert.ok(edgeLine !== undefined);
    appendFileSync(newStorePath("dup-edge"), `${edgeLine}\n`, "utf-8");
    assert.throws(
      () => EpisodeStore.load(newStorePath("dup-edge")),
      /duplicate lineage edge/,
    );
  });

  it("rejects out-of-order score receipts deterministically", () => {
    assert.throws(
      () =>
        foldSearchRecords([
          headerRecord(),
          {
            type: "score_receipt",
            recorded_at: T0,
            payload: fakeScoreReceipt("cand_missing"),
          },
        ]),
      /references unknown candidate cand_missing/,
    );
    assert.throws(
      () =>
        foldSearchRecords([
          {
            type: "candidate",
            recorded_at: T0,
            payload: fakeCandidate("a"),
          },
        ]),
      /must begin with an episode_header/,
    );
  });

  it("rejects score receipts without verifier receipt bindings", () => {
    assert.throws(
      () =>
        foldSearchRecords([
          headerRecord(),
          { type: "candidate", recorded_at: T0, payload: fakeCandidate("a") },
          {
            type: "score_receipt",
            recorded_at: T0,
            payload: fakeScoreReceipt("a", { verifier_receipt_ids: [] }),
          },
        ]),
      /at least one verifier receipt id is required/,
    );
  });

  it("supersedes edges must reference an existing promoted candidate", () => {
    assert.throws(
      () =>
        foldSearchRecords([
          headerRecord(),
          { type: "candidate", recorded_at: T0, payload: fakeCandidate("a") },
          { type: "candidate", recorded_at: T0, payload: fakeCandidate("b") },
          edgeRecord({
            edge_id: "edge_s1",
            kind: "supersedes",
            from_ref: "b",
            to_ref: "a",
          }),
        ]),
      /targets non-promoted candidate a/,
    );
    const promoted = foldSearchRecords([
      headerRecord(),
      { type: "candidate", recorded_at: T0, payload: fakeCandidate("a") },
      { type: "candidate", recorded_at: T0, payload: fakeCandidate("b") },
      {
        type: "status_change",
        recorded_at: T0,
        payload: { candidate_id: "a", status: "best" },
      },
      edgeRecord({
        edge_id: "edge_s2",
        kind: "supersedes",
        from_ref: "b",
        to_ref: "a",
      }),
    ]);
    assert.strictEqual(promoted.search_state.current_best, "a");
  });

  it("detects parent chain cycles", () => {
    assert.throws(
      () =>
        foldSearchRecords([
          headerRecord(),
          { type: "candidate", recorded_at: T0, payload: fakeCandidate("a", "b") },
          { type: "candidate", recorded_at: T0, payload: fakeCandidate("b", "a") },
        ]),
      /parent chain contains a cycle/,
    );
  });

  it("folding the same JSONL twice yields identical state", () => {
    initStore("double-fold");
    const store = EpisodeStore.load(newStorePath("double-fold"));
    const parent = store.addCandidate({
      workspace_revision: { compositeTreeHash: "tree_a" },
      mutation_refs: ["a.patch"],
    });
    store.recordScoreReceipt(
      buildScoreReceipt({
        candidate_id: parent.candidate_id,
        verifier_receipts: [makeVerifierReceipt()],
        score_vector: throughputVector(42),
        evaluator_profile: "bench-v1",
      }),
    );
    const records = readRecordLines(newStorePath("double-fold"));
    const foldOne = JSON.stringify(foldSearchRecords([...records]));
    const foldTwo = JSON.stringify(foldSearchRecords([...records]));
    assert.strictEqual(foldTwo, foldOne);
    assert.strictEqual(
      JSON.stringify(EpisodeStore.load(newStorePath("double-fold")).episode),
      foldOne,
    );
  });

  it("keeps hypothesis replay deterministic as last-write-wins", () => {
    const hyp = {
      hypothesis_id: "hyp_1",
      claim: "tiling improves throughput",
      family_id: "tiling",
      evidence_for: [] as string[],
      evidence_against: [] as string[],
      disposition: "open" as const,
    };
    const revised = { ...hyp, disposition: "supported" as const };
    const records: SearchRecord[] = [
      headerRecord(),
      { type: "hypothesis", recorded_at: T0, payload: hyp },
      { type: "hypothesis", recorded_at: T0, payload: revised },
    ];
    const once = JSON.stringify(foldSearchRecords([...records]));
    assert.strictEqual(JSON.stringify(foldSearchRecords([...records])), once);
    const folded = foldSearchRecords([...records]);
    assert.strictEqual(folded.hypotheses.length, 1);
    assert.strictEqual(folded.hypotheses[0]?.disposition, "supported");
  });

  it("never persists a record the folder would reject (no poisoned stores)", () => {
    initStore("dry-run");
    const store = EpisodeStore.load(newStorePath("dry-run"));
    const path = newStorePath("dry-run");
    const baseline = readFileSync(path, "utf-8").length;
    assert.throws(() =>
      store.recordLineageEdge("forked_from", "ghost_a", "ghost_b"),
    );
    assert.strictEqual(readFileSync(path, "utf-8").length, baseline);
    assert.doesNotThrow(() => EpisodeStore.load(path));
  });
});

describe("Wave-1 validator hardening", () => {
  it("validators reject cross-type payloads without crashing", () => {
    const notAReceipt = fakeCandidate("a") as unknown as ScoreReceipt;
    const receiptErrors = validateScoreReceipt(notAReceipt);
    assert.ok(receiptErrors.some((e) => e.includes("receipt_id")));
    assert.ok(
      validateScoreVector(fakeCandidate("a") as unknown as ScoreVector).some(
        (e) => e.includes("metrics"),
      ),
    );
    assert.deepStrictEqual(
      validateSearchEpisode("not an episode" as unknown as SearchEpisode),
      ["search episode payload is not an object"],
    );
    assert.ok(
      validateScoreReceipt(null as unknown as ScoreReceipt).includes(
        "score receipt payload is not an object",
      ),
    );
  });

  it("recordScoreReceipt rejects duplicate receipt ids live", () => {
    const dir = mkdtempSync(join(tmpdir(), "babel-search-dup-receipt-"));
    try {
      const path = join(dir, "ep.jsonl");
      EpisodeStore.init(
        path,
        createSearchEpisode({ task_contract_id: "tc_1", objective: "x" }),
      );
      const store = EpisodeStore.load(path);
      const cand = store.addCandidate({
        workspace_revision: { compositeTreeHash: "tree_a" },
        mutation_refs: [],
      });
      const receipt = buildScoreReceipt({
        candidate_id: cand.candidate_id,
        verifier_receipts: [makeVerifierReceipt()],
        score_vector: throughputVector(10),
        evaluator_profile: "bench-v1",
      });
      store.recordScoreReceipt(receipt);
      assert.throws(
        () => store.recordScoreReceipt(receipt),
        /duplicate score receipt/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Wave-A M1 hardening: late failing receipts vs the crowned best", () => {
  const dir = mkdtempSync(join(tmpdir(), "babel-search-m1-"));

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function newStorePath(name: string): string {
    return join(dir, `${name}.jsonl`);
  }

  it("does not dethrone the promoted best when a late failing receipt arrives (review attack M1)", () => {
    const path = newStorePath("m1-live");
    EpisodeStore.init(
      path,
      createSearchEpisode({ task_contract_id: "tc_1", objective: "x" }),
    );
    const store = EpisodeStore.load(path);
    const cand = store.addCandidate({
      workspace_revision: { compositeTreeHash: "tree_m1" },
      mutation_refs: ["m1.patch"],
    });
    store.recordScoreReceipt(
      buildScoreReceipt({
        candidate_id: cand.candidate_id,
        verifier_receipts: [makeVerifierReceipt()],
        score_vector: throughputVector(100),
        evaluator_profile: "bench-v1",
      }),
    );
    store.promoteCandidate(cand.candidate_id);

    // Chosen semantic (documented): current_best stays UNCHANGED. The store
    // never implicitly clears or demotes the crown; only the controller may
    // demote/supersede via explicit status_change records.
    store.recordScoreReceipt(
      buildScoreReceipt({
        candidate_id: cand.candidate_id,
        verifier_receipts: [makeVerifierReceipt({ exit_code: 1 })],
        score_vector: throughputVector(1),
        evaluator_profile: "bench-v1",
      }),
    );

    const live = store.episode;
    const reloaded = EpisodeStore.load(path).episode;

    for (const state of [live, reloaded]) {
      const target = state.candidates.find(
        (c) => c.candidate_id === cand.candidate_id,
      );
      assert.strictEqual(
        target?.status,
        "best",
        "failing receipt must not demote a crowned best",
      );
      assert.strictEqual(
        state.search_state.current_best,
        cand.candidate_id,
        "current_best must stay unchanged (not silently cleared)",
      );
      assert.ok(
        target?.receipts.some((r) => r.correct === false),
        "the late failing receipt must be recorded as evidence",
      );
      // Validator states the invariant result explicitly: consistent crown.
      assert.deepStrictEqual(validateSearchEpisode(state), []);
    }
    assert.strictEqual(
      JSON.stringify(live),
      JSON.stringify(reloaded),
      "write path and fold must agree on the outcome",
    );
  });

  it("fold succeeds on legacy unconditional-reject JSONL but the validator flags the dangling best", () => {
    const correctReceipt = fakeScoreReceipt("legacy_a");
    const failingReceipt = fakeScoreReceipt("legacy_a_fail", {
      candidate_id: "legacy_a",
      correct: false,
    });
    // Records exactly as the pre-fix writer emitted them: an explicit
    // status_change:'rejected' appended unconditionally after a failing
    // receipt, here landing on a crowned best.
    const records: SearchRecord[] = [
      headerRecord(),
      { type: "candidate", recorded_at: T0, payload: fakeCandidate("legacy_a") },
      { type: "score_receipt", recorded_at: T0, payload: correctReceipt },
      {
        type: "status_change",
        recorded_at: T0,
        payload: { candidate_id: "legacy_a", status: "best" },
      },
      { type: "score_receipt", recorded_at: T0, payload: failingReceipt },
      {
        type: "status_change",
        recorded_at: T0,
        payload: { candidate_id: "legacy_a", status: "rejected" },
      },
    ];

    // Detection is independent of the write path: fold succeeds (deterministic
    // replay, no mid-fold throw) and reproduces the dangling-best state.
    let folded: SearchEpisode | undefined;
    assert.doesNotThrow(() => {
      folded = foldSearchRecords([...records]);
    }, "fold must stay deterministic and complete for legacy logs");
    assert.strictEqual(folded?.candidates[0]?.status, "rejected");
    assert.strictEqual(folded?.search_state.current_best, "legacy_a");

    const problems = validateSearchEpisode(folded as SearchEpisode);
    assert.ok(
      problems.some(
        (p) =>
          p.includes("current_best") &&
          p.includes("'rejected'") &&
          p.includes("expected 'best'"),
      ),
      `validator must flag the dangling crown, got: ${JSON.stringify(problems)}`,
    );

    // Same records through the real JSONL load path behave identically.
    const path = newStorePath("m1-legacy-jsonl");
    writeFileSync(
      path,
      `${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
      "utf-8",
    );
    const loaded = EpisodeStore.load(path).episode;
    assert.strictEqual(JSON.stringify(loaded), JSON.stringify(folded));
    assert.ok(validateSearchEpisode(loaded).length > 0);
  });

  it("leaves promoted-status candidates intact when a failing receipt lands", () => {
    const folded = foldSearchRecords([
      headerRecord(),
      { type: "candidate", recorded_at: T0, payload: fakeCandidate("p_a") },
      { type: "score_receipt", recorded_at: T0, payload: fakeScoreReceipt("p_a") },
      {
        type: "status_change",
        recorded_at: T0,
        payload: { candidate_id: "p_a", status: "promoted" },
      },
      {
        type: "score_receipt",
        recorded_at: T0,
        payload: fakeScoreReceipt("p_a_fail", {
          candidate_id: "p_a",
          correct: false,
        }),
      },
    ]);
    assert.strictEqual(folded.candidates[0]?.status, "promoted");
    assert.deepStrictEqual(validateSearchEpisode(folded), []);
  });

  it("validateCurrentBestConsistency covers the crown matrix without crashing on garbage", () => {
    // No crown, no best: clean.
    assert.deepStrictEqual(
      validateCurrentBestConsistency(
        createSearchEpisode({ task_contract_id: "tc_1", objective: "x" }),
      ),
      [],
    );

    function episodeWith(
      candidates: Candidate[],
      currentBest?: string,
    ): SearchEpisode {
      const ep = headerRecord().payload as SearchEpisode;
      ep.candidates = candidates.map((c) => ({ ...c }));
      if (currentBest !== undefined) ep.search_state.current_best = currentBest;
      return ep;
    }

    // Consistent crown: clean.
    const crowned = episodeWith(
      [{ ...fakeCandidate("a"), status: "best" }],
      "a",
    );
    assert.deepStrictEqual(validateCurrentBestConsistency(crowned), []);

    // Dangling pointer at a rejected candidate.
    const dangling = validateCurrentBestConsistency(
      episodeWith([{ ...fakeCandidate("a"), status: "rejected" }], "a"),
    );
    assert.ok(dangling.some((p) => p.includes("expected 'best'")));

    // Rival best not pointed at by current_best.
    const rival = validateCurrentBestConsistency(
      episodeWith(
        [
          { ...fakeCandidate("a"), status: "best" },
          { ...fakeCandidate("b"), status: "best" },
        ],
        "a",
      ),
    );
    assert.ok(rival.some((p) => p.includes("candidate b has status 'best'")));

    // Orphaned best with no crown set.
    const orphan = validateCurrentBestConsistency(
      episodeWith([{ ...fakeCandidate("a"), status: "best" }]),
    );
    assert.ok(orphan.some((p) => p.includes("current_best is unset")));

    // Superseded history stays clean when the new best holds the crown.
    assert.deepStrictEqual(
      validateCurrentBestConsistency(
        episodeWith(
          [
            { ...fakeCandidate("old"), status: "superseded" },
            { ...fakeCandidate("new"), status: "best" },
          ],
          "new",
        ),
      ),
      [],
    );

    // Cross-type payloads are rejected without crashing.
    assert.deepStrictEqual(
      validateCurrentBestConsistency(
        "not an episode" as unknown as SearchEpisode,
      ),
      [],
    );
  });
});
