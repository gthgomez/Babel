/**
 * researchCommands.ts — `babel research` command group
 *
 * Slice B surface: `hunt` runs discovery up through the diversity
 * shortlist (query plan → GitHub search → dedup → deterministic triage →
 * shortlist), and `inspect` explains a persisted mission run. Deep model
 * reading, evidence, and Pattern Cards arrive in Slice C/D.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Command } from "commander";

import { BABEL_RUNS_DIR } from "../cli/constants.js";
import { createResearchMission } from "../research/missionPlanner.js";
import { GitHubResearchProvider } from "../research/discovery/githubProvider.js";
import { RateBudget } from "../research/rateBudget.js";
import { runHuntDiscovery } from "../research/hunt.js";
import { readJsonl } from "../research/artifacts.js";
import type { CandidateRecordV1 } from "../research/contracts.js";
import { printJsonErrorAndExit, printJsonOrHuman } from "./output.js";

/**
 * Host-owned GitHub credential for authenticated discovery. The token is
 * passed to the provider only and never enters prompts, logs, artifacts,
 * or error messages (the provider redacts it).
 */
function researchTokenFromEnv(): string | undefined {
  return process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"] ?? undefined;
}

function findRunDirForMission(runsRoot: string, missionId: string): string | null {
  if (!existsSync(runsRoot)) return null;
  for (const entry of readdirSync(runsRoot)) {
    if (entry.endsWith(`_${missionId}`)) return join(runsRoot, entry);
  }
  return null;
}

export function registerResearchCommands(program: Command): void {
  const research = program
    .command("research")
    .description("Repo Hunt research missions (discover, inspect, and learn from OSS evidence)");

  research
    .command("hunt <problem>")
    .description("hunt OSS for implementations analogous to the problem (discovery through shortlist)")
    .requiredOption("--project <path>", "target project root")
    .option("--budget <preset>", "named budget preset: low | normal | deep", "normal")
    .option("--json", "emit machine-readable output", false)
    .action(
      async (
        problem: string,
        options: { project: string; budget: string; json: boolean },
      ) => {
        if (!["low", "normal", "deep"].includes(options.budget)) {
          printJsonErrorAndExit(
            `unknown budget preset "${options.budget}" (expected low|normal|deep)`,
            options.json,
          );
          return;
        }
        const projectRoot = resolve(options.project);
        const mission = createResearchMission({
          problem,
          projectRoot,
          budgetPreset: options.budget as "low" | "normal" | "deep",
        });
        const token = researchTokenFromEnv();
        const rateBudget = new RateBudget(undefined, mission.budget.max_search_queries, mission.budget.max_remote_bytes);
        const provider = new GitHubResearchProvider({ ...(token ? { token } : {}), rateBudget });
        try {
          const result = await runHuntDiscovery(mission, provider);
          const shortlistIds = new Set(result.shortlist.map((s) => s.candidate.candidate_id));
          const shortlist = readJsonl<CandidateRecordV1>(result.paths.candidatesJsonl).filter((c) =>
            shortlistIds.has(c.candidate_id),
          );
          const human = [
            `research mission ${mission.mission_id} (${result.status}${result.reason ? `: ${result.reason}` : ""})`,
            `run: ${result.paths.researchDir}`,
            `candidates: ${result.metrics.candidate_count_after_dedup} after dedup, shortlist: ${result.metrics.shortlist_count}`,
            ...shortlist.map(
              (c) => `  - ${c.identity.observed_full_name} (${c.language ?? "?"}, ★${c.stars})`,
            ),
          ].join("\n");
          printJsonOrHuman(
            {
              mission_id: mission.mission_id,
              status: result.status,
              reason: result.reason,
              run_dir: result.paths.researchDir,
              metrics: result.metrics,
              budget: result.budget,
              shortlist: shortlist.map((c) => ({
                candidate_id: c.candidate_id,
                full_name: c.identity.observed_full_name,
              })),
            },
            human,
            options.json,
          );
          if (result.status !== "COMPLETE") process.exitCode = 3;
        } catch (error) {
          printJsonErrorAndExit(error instanceof Error ? error.message : String(error), options.json);
        }
      },
    );

  research
    .command("inspect <mission-id>")
    .description("explain a persisted research mission run (mission, candidates, scores, budget)")
    .option("--runs-root <path>", "runs root to search", BABEL_RUNS_DIR)
    .option("--json", "emit machine-readable output", false)
    .action((missionId: string, options: { runsRoot: string; json: boolean }) => {
      const runDir = findRunDirForMission(options.runsRoot, missionId);
      if (!runDir) {
        printJsonErrorAndExit(`no research run found for mission ${missionId}`, options.json);
        return;
      }
      const researchDir = join(runDir, "research");
      const missionPath = join(researchDir, "mission.json");
      if (!existsSync(missionPath)) {
        printJsonErrorAndExit(`research run for ${missionId} is missing mission.json`, options.json);
        return;
      }
      const mission = JSON.parse(readFileSync(missionPath, "utf8"));
      const candidates = readJsonl<CandidateRecordV1>(join(researchDir, "discovery", "candidates.jsonl"));
      const scores = readJsonl<{ candidate_id: string; total: number }>(
        join(researchDir, "discovery", "score-breakdown.jsonl"),
      );
      const scoreById = new Map(scores.map((s) => [s.candidate_id, s.total]));
      printJsonOrHuman(
        {
          mission,
          candidates: candidates.map((c) => ({
            candidate_id: c.candidate_id,
            full_name: c.identity.observed_full_name,
            matched_hypotheses: c.matched_hypothesis_ids,
            score: scoreById.get(c.candidate_id) ?? null,
          })),
        },
        JSON.stringify({ mission, candidates }, null, 2),
        options.json,
      );
    });
}
