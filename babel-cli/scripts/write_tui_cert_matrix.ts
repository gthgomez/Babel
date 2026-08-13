import { writeFileSync } from 'node:fs';
import { runDailyDriverScenarios } from '../src/ui/tuiDailyDriverCert.js';

const out = process.argv[2] ?? 'pty-matrix.json';
const m = await runDailyDriverScenarios({
  ptyAvailable: false,
  windowsTerminalAutomation: false,
});
writeFileSync(out, JSON.stringify(m, null, 2));
console.log(
  JSON.stringify(
    {
      count: m.scenarios.length,
      tasksAttempted: m.tasksAttempted,
      tuiFailures: m.tuiFailures,
      t24: m.scenarios.find((s) => s.id === 'T24')?.status,
    },
    null,
    2,
  ),
);
