import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import type { Command } from "commander";

import { extractRunRoot } from "../runIntelligence/adapter.js";
import { RunIntelligenceCatalog } from "../runIntelligence/catalog.js";
import {
  SAVED_QUERY_DEFINITIONS,
  savedQueryDefinition,
  type SavedQueryName,
} from "../runIntelligence/contracts.js";
import { printJsonOrHuman } from "./output.js";

function catalogPath(option?: string): string {
  return resolve(
    option ??
      process.env["BABEL_RUN_INTELLIGENCE_CATALOG"] ??
      join(process.cwd(), ".babel", "run-intelligence", "catalog.sqlite"),
  );
}

function isInside(child: string, parent: string): boolean {
  const relation = relative(parent, child);
  return (
    relation === "" || (!relation.startsWith("..") && !relation.includes(":"))
  );
}

function canonicalForNewPath(path: string): string {
  let existing = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(existing)) {
    suffix.unshift(existing.split(/[\\/]/).pop()!);
    existing = dirname(existing);
  }
  const stat = lstatSync(existing);
  if (stat.isSymbolicLink())
    throw new Error(`Catalog path traverses a link: ${existing}`);
  return resolve(realpathSync.native(existing), ...suffix);
}

/** Reject a derived catalog that could alter, or be altered by, selected historical evidence. */
export function assertCatalogOutsideEvidence(
  source: string,
  catalog: string,
): void {
  if (lstatSync(source).isSymbolicLink())
    throw new Error("Evidence root must not be a link");
  const sourceCanonical = realpathSync.native(source);
  const catalogCanonical = canonicalForNewPath(catalog);
  if (
    isInside(catalogCanonical, sourceCanonical) ||
    isInside(sourceCanonical, catalogCanonical)
  ) {
    throw new Error("BRI catalog must be outside the selected evidence root");
  }
}

function human(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Register bounded BRI commands. Queries are names from a fixed registry, never SQL. */
export function registerRunIntelligenceCommands(program: Command): void {
  const runs = program
    .command("runs")
    .description(
      "Read-only historical run intelligence (derived local catalog)",
    );
  runs
    .command("inventory")
    .description("Read immediate evidence bundles into the local BRI catalog")
    .option("--source <path>", "Evidence-bundle root (default: ./runs)")
    .option("--catalog <path>", "Local derived SQLite catalog path")
    .option("--json", "Emit structured JSON")
    .action(
      (options: { source?: string; catalog?: string; json?: boolean }) => {
        const source = resolve(options.source ?? join(process.cwd(), "runs"));
        if (!existsSync(source))
          throw new Error(`Evidence root does not exist: ${source}`);
        const selectedCatalogPath = catalogPath(options.catalog);
        assertCatalogOutsideEvidence(source, selectedCatalogPath);
        const catalog = new RunIntelligenceCatalog(selectedCatalogPath);
        try {
          const receipts = extractRunRoot(source).map((run) =>
            catalog.ingest(run),
          );
          const report = {
            status: "ok",
            sourceId:
              receipts.length > 0 ? receipts[0]!.sourceLocatorDigest : null,
            ingested: receipts.length,
            receipts: receipts.map((receipt) => ({
              receiptId: receipt.receiptId,
              entitiesEmitted: receipt.entitiesEmitted,
              warnings: receipt.warnings.length,
            })),
          };
          printJsonOrHuman(report, human(report), options.json === true);
        } finally {
          catalog.close();
        }
      },
    );
  runs
    .command("coverage")
    .description("Show catalog extraction coverage")
    .option("--catalog <path>", "Local derived SQLite catalog path")
    .option("--json", "Emit structured JSON")
    .action((options: { catalog?: string; json?: boolean }) => {
      const catalog = new RunIntelligenceCatalog(catalogPath(options.catalog));
      try {
        const report = catalog.query("coverage");
        printJsonOrHuman(report, human(report), options.json === true);
      } finally {
        catalog.close();
      }
    });
  runs
    .command("query <name>")
    .description(
      `Run a saved BRI query (${SAVED_QUERY_DEFINITIONS.map((definition) => definition.name).join(", ")})`,
    )
    .option("--catalog <path>", "Local derived SQLite catalog path")
    .option("--json", "Emit structured JSON")
    .action((name: string, options: { catalog?: string; json?: boolean }) => {
      if (!savedQueryDefinition(name))
        throw new Error(`Unknown saved BRI query: ${name}`);
      const catalog = new RunIntelligenceCatalog(catalogPath(options.catalog));
      try {
        const report = catalog.query(name as SavedQueryName);
        printJsonOrHuman(report, human(report), options.json === true);
      } finally {
        catalog.close();
      }
    });
  runs
    .command("show <entityId>")
    .description(
      "Show a bounded, redaction-safe catalog entity by opaque logical ID",
    )
    .option("--catalog <path>", "Local derived SQLite catalog path")
    .option("--json", "Emit structured JSON")
    .action(
      (entityId: string, options: { catalog?: string; json?: boolean }) => {
        const catalog = new RunIntelligenceCatalog(
          catalogPath(options.catalog),
        );
        try {
          const report = catalog.show(entityId) ?? {
            status: "missing",
            entityId,
          };
          printJsonOrHuman(report, human(report), options.json === true);
        } finally {
          catalog.close();
        }
      },
    );
  runs
    .command("failures")
    .description("List deterministic failure clusters")
    .option("--catalog <path>", "Local derived SQLite catalog path")
    .option("--json", "Emit structured JSON")
    .action((options: { catalog?: string; json?: boolean }) => {
      const catalog = new RunIntelligenceCatalog(catalogPath(options.catalog));
      try {
        const report = catalog.query("failure-clusters");
        printJsonOrHuman(report, human(report), options.json === true);
      } finally {
        catalog.close();
      }
    });
  runs
    .command("verify")
    .description(
      "Run derived-catalog integrity checks; historical evidence is not modified",
    )
    .option("--catalog <path>", "Local derived SQLite catalog path")
    .option("--json", "Emit structured JSON")
    .action((options: { catalog?: string; json?: boolean }) => {
      const catalog = new RunIntelligenceCatalog(catalogPath(options.catalog));
      try {
        const report = catalog.verify();
        printJsonOrHuman(report, human(report), options.json === true);
        if (!report.ok) process.exitCode = 1;
      } finally {
        catalog.close();
      }
    });
}
