import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BABEL_ROOT } from '../cli/constants.js';
import { type SmallFixAnswer, type SmallFixOptions } from './smallFixProvider.js';

const LITE_TRUST_DEMO_FIXTURE_DIR = join(
  BABEL_ROOT,
  'babel-cli',
  'src',
  'fixtures',
  'lite-trust-demo',
);

const PARITY_CORPUS_FIXTURE_DIR = join(
  BABEL_ROOT,
  'babel-cli',
  'src',
  'fixtures',
  'parity-corpus',
);

function listLiteTrustDemoFixturePaths(): string[] {
  const paths = [join(LITE_TRUST_DEMO_FIXTURE_DIR, 'scenario.json')];
  const scenariosDir = join(LITE_TRUST_DEMO_FIXTURE_DIR, 'scenarios');
  if (existsSync(scenariosDir)) {
    for (const name of readdirSync(scenariosDir)) {
      if (name.endsWith('.json')) {
        paths.push(join(scenariosDir, name));
      }
    }
  }
  return paths.filter((path) => existsSync(path));
}

function listParityCorpusFixturePaths(): string[] {
  const manifestPath = join(PARITY_CORPUS_FIXTURE_DIR, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return [];
  }
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      tasks?: string[];
    };
    if (!Array.isArray(manifest.tasks)) {
      return [];
    }
    return manifest.tasks
      .map((taskId) => join(PARITY_CORPUS_FIXTURE_DIR, `${taskId}.json`))
      .filter((path) => existsSync(path));
  } catch {
    return [];
  }
}

/**
 * Extract exported function/const names from a JavaScript/TypeScript source string.
 * Matches `export const NAME` and `export function NAME` patterns.
 * Used by the mock-provider fixture guard to verify that a fixture's
 * fixed_implementation covers all exports from the on-disk broken file.
 */
function extractExportedFunctionNames(source: string): string[] {
  const names: string[] = [];
  const re = /export\s+(?:const|function)\s+(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if (m[1]) names.push(m[1]);
  }
  return names;
}

function offlineDemoAnswerFromFixture(
  options: SmallFixOptions,
  detected: { targetFile: string },
  fixturePath: string,
  expectedFixtureType: 'babel_lite_trust_demo' | 'babel_parity_corpus_task',
): SmallFixAnswer | null {
  try {
    const parsed = JSON.parse(readFileSync(fixturePath, 'utf-8')) as {
      fixture_type?: string;
      task?: string;
      target_file?: string;
      broken_implementation?: string;
      fixed_implementation?: string;
      mock_provider_answer?: string;
      files?: Record<string, { broken?: string; fixed?: string }>;
    };
    if (
      parsed.fixture_type !== expectedFixtureType ||
      typeof parsed.task !== 'string' ||
      typeof parsed.target_file !== 'string' ||
      typeof parsed.fixed_implementation !== 'string'
    ) {
      return null;
    }

    let brokenImplementation: string | undefined = parsed.broken_implementation;
    let replacement: string =
      typeof parsed.mock_provider_answer === 'string'
        ? parsed.mock_provider_answer
        : parsed.fixed_implementation!;

    if (detected.targetFile === parsed.target_file) {
      if (typeof brokenImplementation !== 'string') {
        return null;
      }
    } else {
      const extraFile = parsed.files?.[detected.targetFile];
      if (
        typeof extraFile?.broken !== 'string' ||
        typeof extraFile.fixed !== 'string'
      ) {
        return null;
      }
      brokenImplementation = extraFile.broken;
      replacement = extraFile.fixed;
    }

    const taskMatches = options.task.trim() === parsed.task.trim();
    if (!taskMatches) {
      if (
        expectedFixtureType !== 'babel_parity_corpus_task' ||
        options.projectRoot === undefined ||
        typeof brokenImplementation !== 'string'
      ) {
        return null;
      }
      const targetPath = resolve(options.projectRoot, detected.targetFile);
      if (
        !existsSync(targetPath) ||
        readFileSync(targetPath, 'utf-8') !== brokenImplementation
      ) {
        return null;
      }
      // Guard: verify the fixture's fixed_implementation exports cover all
      // functions exported by the on-disk broken file. Prevents mock-fixture
      // mismatches when the project has tests for functions the fixture doesn't
      // know about (e.g. dynamically-generated subtract test alongside the add fixture).
      const onDiskExports = extractExportedFunctionNames(
        readFileSync(targetPath, 'utf-8'),
      );
      const fixtureExports = extractExportedFunctionNames(replacement);
      const missingExports = onDiskExports.filter(
        (n) => !fixtureExports.includes(n),
      );
      if (missingExports.length > 0) {
        return null;
      }
    }
    return {
      schema_version: 1,
      summary:
        expectedFixtureType === 'babel_parity_corpus_task'
          ? 'Updated parity corpus implementation (offline demo).'
          : 'Updated math implementation (offline demo).',
      replacement_content: replacement,
      confidence: 'high',
    };
  } catch {
    return null;
  }
}


export function tryOfflineDemoAnswer(
  options: SmallFixOptions,
  detected: { targetFile: string },
): SmallFixAnswer | null {
  for (const fixturePath of listLiteTrustDemoFixturePaths()) {
    const answer = offlineDemoAnswerFromFixture(
      options,
      detected,
      fixturePath,
      'babel_lite_trust_demo',
    );
    if (answer) {
      return answer;
    }
  }
  for (const fixturePath of listParityCorpusFixturePaths()) {
    const answer = offlineDemoAnswerFromFixture(
      options,
      detected,
      fixturePath,
      'babel_parity_corpus_task',
    );
    if (answer) {
      return answer;
    }
  }
  return null;
}
