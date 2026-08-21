import { existsSync, readFileSync } from 'node:fs';
if (existsSync('output.txt')) {
  if (readFileSync('output.txt', 'utf8') !== 'BABEL_PHASE4_SENTINEL') process.exit(1);
  process.exit(0);
}
if (!existsSync('reports/final-answer.json')) process.exit(1);
if (existsSync('reports/final_answer.json') || existsSync('reports/final-report.json')) process.exit(1);
