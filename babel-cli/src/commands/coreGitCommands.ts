import { Command } from "commander";
import { printJsonErrorAndExit, printJsonOrHuman } from "./output.js";
import { registerShipCommand } from "./shipCommands.js";
import { runGitDraft, formatGitDraftHuman, type GitDraftKind } from "../services/gitDrafts.js";
import { createGitBranch, createGitCommit, createGitPullRequest, formatGitMutationHuman } from "../services/gitMutations.js";




export function registerCoreGitCommands(program: Command): void {
const gitCommand = program
    .command("git")
    .description("Draft and governed Git delivery surfaces")
    .addHelpText(
      "after",
      `
Commands include:
  diff-summary, commit-draft, pr-draft
  branch-create, commit-create, pr-create --allow-remote
`,
    )
    .action(() => {
      gitCommand.help({ error: false });
    });

const registerGitDraftCommand = (
    name: string,
    kind: GitDraftKind,
    description: string,
  ): void => {
    gitCommand
      .command(name)
      .description(description)
      .option("--project-root <path>", "Project root to inspect", process.cwd())
      .option("--base-ref <ref>", "Optional base ref")
      .option("--json", "Emit structured JSON only")
      .action(
        (options: {
          projectRoot?: string;
          baseRef?: string;
          json?: boolean;
        }) => {
          try {
            const report = runGitDraft(kind, {
              projectRoot: options.projectRoot ?? process.cwd(),
              ...(options.baseRef ? { baseRef: options.baseRef } : {}),
            });
            printJsonOrHuman(
              report,
              formatGitDraftHuman(report),
              options.json === true,
            );
          } catch (err: unknown) {
            printJsonErrorAndExit(
              err instanceof Error ? err.message : String(err),
              options.json === true,
            );
          }
        },
      );
  };

registerGitDraftCommand(
    "diff-summary",
    "diff_summary",
    "Draft a diff summary without mutating Git",
  );

registerGitDraftCommand(
    "commit-draft",
    "commit_draft",
    "Draft a commit message without committing",
  );

registerGitDraftCommand(
    "pr-draft",
    "pr_draft",
    "Draft PR metadata without opening a PR",
  );

gitCommand
    .command("branch-create")
    .description("Create a local branch and write evidence")
    .argument("<branch>", "Branch name")
    .option("--project-root <path>", "Project root", process.cwd())
    .option("--from <ref>", "Source ref", "HEAD")
    .option("--json", "Emit structured JSON only")
    .action(
      (
        branch: string,
        options: { projectRoot?: string; from?: string; json?: boolean },
      ) => {
        try {
          const report = createGitBranch({
            branchName: branch,
            projectRoot: options.projectRoot ?? process.cwd(),
            ...(options.from ? { fromRef: options.from } : {}),
          });
          printJsonOrHuman(
            report,
            formatGitMutationHuman(report),
            options.json === true,
          );
          if (report.action.status === "failed") {
            process.exit(1);
          }
        } catch (err: unknown) {
          printJsonErrorAndExit(
            err instanceof Error ? err.message : String(err),
            options.json === true,
          );
        }
      },
    );

gitCommand
    .command("commit-create")
    .description("Create a local commit and write evidence")
    .option("--project-root <path>", "Project root", process.cwd())
    .option("--message <message>", "Commit message")
    .option("--stage <mode>", "Stage mode: staged | tracked | all", "staged")
    .option("--json", "Emit structured JSON only")
    .action(
      (options: {
        projectRoot?: string;
        message?: string;
        stage?: string;
        json?: boolean;
      }) => {
        try {
          const stage =
            options.stage === "tracked" || options.stage === "all"
              ? options.stage
              : "staged";
          const report = createGitCommit({
            projectRoot: options.projectRoot ?? process.cwd(),
            stageMode: stage,
            ...(options.message ? { message: options.message } : {}),
          });
          printJsonOrHuman(
            report,
            formatGitMutationHuman(report),
            options.json === true,
          );
          if (report.action.status === "failed") {
            process.exit(1);
          }
        } catch (err: unknown) {
          printJsonErrorAndExit(
            err instanceof Error ? err.message : String(err),
            options.json === true,
          );
        }
      },
    );

gitCommand
    .command("pr-create")
    .description(
      "Plan PR creation by default; remote creation requires --allow-remote",
    )
    .option("--project-root <path>", "Project root", process.cwd())
    .option("--title <title>", "PR title")
    .option("--body <body>", "PR body")
    .option("--allow-remote", "Allow gh pr create remote side effect")
    .option("--json", "Emit structured JSON only")
    .action(
      (options: {
        projectRoot?: string;
        title?: string;
        body?: string;
        allowRemote?: boolean;
        json?: boolean;
      }) => {
        try {
          const report = createGitPullRequest({
            projectRoot: options.projectRoot ?? process.cwd(),
            ...(options.title ? { title: options.title } : {}),
            ...(options.body ? { body: options.body } : {}),
            allowRemote: options.allowRemote === true,
          });
          printJsonOrHuman(
            report,
            formatGitMutationHuman(report),
            options.json === true,
          );
          if (report.action.status === "failed") {
            process.exit(1);
          }
        } catch (err: unknown) {
          printJsonErrorAndExit(
            err instanceof Error ? err.message : String(err),
            options.json === true,
          );
        }
      },
    );

registerShipCommand(program);
}
