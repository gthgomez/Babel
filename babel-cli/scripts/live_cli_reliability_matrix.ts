import {
  formatLiveCliReliabilityCaseListHuman,
  formatLiveCliReliabilityReportHuman,
  listLiveCliReliabilityCases,
  runLiveCliReliabilityMatrix,
} from '../src/services/liveCliReliabilityMatrix.js';
import {
  formatLiveCliReliabilityMatrixHelp,
  parseLiveCliReliabilityMatrixArgs,
} from '../src/services/liveCliReliabilityMatrixCliArgs.js';

try {
  const args = parseLiveCliReliabilityMatrixArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(`${formatLiveCliReliabilityMatrixHelp()}\n`);
    process.exit(0);
  }

  if (args.list) {
    const listing = listLiveCliReliabilityCases();
    process.stdout.write(args.json
      ? `${JSON.stringify(listing, null, 2)}\n`
      : `${formatLiveCliReliabilityCaseListHuman(listing)}\n`);
    process.exit(0);
  }

  const report = runLiveCliReliabilityMatrix({
    ...(args.outputDir ? { outputDir: args.outputDir } : {}),
    ...(args.caseFilter.length > 0 ? { caseFilter: args.caseFilter } : {}),
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
    ...(args.timeoutMultiplier !== undefined ? { timeoutMultiplier: args.timeoutMultiplier } : {}),
    ...(args.resumeDir ? { resumeDir: args.resumeDir } : {}),
    ...(args.onlyFailed ? { onlyFailed: true } : {}),
    ...(args.fromCase ? { fromCase: args.fromCase } : {}),
    profile: args.profile,
  });

  process.stdout.write(args.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : `${formatLiveCliReliabilityReportHuman(report)}\n`);

  if (report.final_status !== 'PASS') {
    process.exit(1);
  }
} catch (error) {
  process.stderr.write(`[babel] reliability matrix failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.stderr.write('Run with --help for usage.\n');
  process.exit(1);
}
