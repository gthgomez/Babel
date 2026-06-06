import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildTaskGrounding,
  classifyTaskContract,
  formatGroundingContext,
} from '../src/taskCompletion.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const tempRoot = mkdtempSync(join(tmpdir(), 'babel-frontend-grounding-'));
  const projectRoot = join(tempRoot, 'example_web_audit');

  try {
    mkdirSync(join(projectRoot, 'audit-frontend', 'src', 'app', 'dashboard'), { recursive: true });
    mkdirSync(join(projectRoot, 'audit-frontend', 'src', 'components', 'layout'), { recursive: true });
    mkdirSync(join(projectRoot, 'audit-frontend', 'src', 'styles'), { recursive: true });

    writeFileSync(join(projectRoot, 'audit-frontend', 'src', 'app', 'page.tsx'), 'export default function Page() { return null; }\n', 'utf-8');
    writeFileSync(join(projectRoot, 'audit-frontend', 'src', 'app', 'dashboard', 'page.tsx'), 'export default function DashboardPage() { return null; }\n', 'utf-8');
    writeFileSync(join(projectRoot, 'audit-frontend', 'src', 'components', 'layout', 'GlobalNav.tsx'), 'export function GlobalNav() { return null; }\n', 'utf-8');
    writeFileSync(join(projectRoot, 'audit-frontend', 'src', 'styles', 'globals.css'), ':root { --bg: white; }\n', 'utf-8');

    const taskContract = classifyTaskContract(
      'Fix and improve the UI of the existing Next.js app landing page and dashboard overview without changing backend contracts.',
    );
    const grounding = buildTaskGrounding(taskContract, projectRoot);
    const groundingContext = formatGroundingContext(grounding);

    assert(grounding !== null, 'expected frontend task grounding to be created');
    assert(grounding.grounded === true, 'expected frontend task grounding to mark files as grounded');
    assert(
      grounding.files.some((filePath: string) => filePath.endsWith('audit-frontend\\src\\app\\page.tsx')),
      'expected grounded files to include audit-frontend/src/app/page.tsx',
    );
    assert(
      grounding.files.some((filePath: string) => filePath.endsWith('audit-frontend\\src\\app\\dashboard\\page.tsx')),
      'expected grounded files to include audit-frontend/src/app/dashboard/page.tsx',
    );
    assert(
      grounding.files.some((filePath: string) => filePath.endsWith('audit-frontend\\src\\styles\\globals.css')),
      'expected grounded files to include audit-frontend/src/styles/globals.css',
    );
    assert(
      groundingContext.includes('audit-frontend/src/app/page.tsx') &&
      groundingContext.includes('audit-frontend/src/app/dashboard/page.tsx'),
      'expected grounding context to list grounded frontend files in project-relative form',
    );

    console.log('frontend grounding regression test passed');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
