import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  testCommandsFromPackageJson,
  testCommandsFromMakefile,
  testCommandsFromConventions,
  mergeTestCommands,
  formatTestCommandsForGate,
} from './projectTestDiscovery.js';

describe('projectTestDiscovery', () => {
  describe('testCommandsFromPackageJson', () => {
    test('extracts npm test when scripts.test exists', () => {
      const cmds = testCommandsFromPackageJson({
        scripts: { test: 'jest', build: 'tsc' },
      });
      assert.equal(cmds.length, 1);
      assert.equal(cmds[0]!.command, 'npm run test');
      assert.match(cmds[0]!.source, /package.json/);
    });

    test('extracts multiple test-related scripts', () => {
      const cmds = testCommandsFromPackageJson({
        scripts: {
          test: 'jest',
          'test:unit': 'jest --selectProjects unit',
          'test:e2e': 'playwright test',
          build: 'tsc',
          lint: 'eslint .',
        },
      });
      assert.equal(cmds.length, 3);
      assert.ok(cmds.some((c) => c.command === 'npm run test:unit'));
      assert.ok(cmds.some((c) => c.command === 'npm run test:e2e'));
    });

    test('returns empty for no scripts', () => {
      assert.equal(testCommandsFromPackageJson(null).length, 0);
      assert.equal(testCommandsFromPackageJson({}).length, 0);
      assert.equal(testCommandsFromPackageJson({ scripts: {} }).length, 0);
    });

    test('skips empty command strings', () => {
      const cmds = testCommandsFromPackageJson({
        scripts: { test: '', lint: 'eslint' },
      });
      assert.equal(cmds.length, 0);
    });
  });

  describe('testCommandsFromMakefile', () => {
    test('detects test target', () => {
      const cmds = testCommandsFromMakefile('build:\n\tcargo build\n\ntest:\n\tcargo test\n');
      assert.equal(cmds.length, 1);
      assert.equal(cmds[0]!.command, 'make test');
    });

    test('detects check target', () => {
      const cmds = testCommandsFromMakefile('check:\n\tcargo check\n');
      assert.equal(cmds.length, 1);
      assert.equal(cmds[0]!.command, 'make check');
    });

    test('detects both test and check', () => {
      const cmds = testCommandsFromMakefile('test:\n\techo ok\ncheck:\n\techo ok\n');
      assert.equal(cmds.length, 2);
    });

    test('returns empty for null content', () => {
      assert.equal(testCommandsFromMakefile(null).length, 0);
      assert.equal(testCommandsFromMakefile('').length, 0);
    });
  });

  describe('testCommandsFromConventions', () => {
    test('detects pytest from config presence', () => {
      const cmds = testCommandsFromConventions({
        hasPytestConfig: true,
        hasJestConfig: false,
        hasCargoToml: false,
        hasGoMod: false,
        hasGradleBuild: false,
        hasMavenPom: false,
      });
      assert.equal(cmds.length, 1);
      assert.equal(cmds[0]!.command, 'python -m pytest');
    });

    test('detects multiple conventions', () => {
      const cmds = testCommandsFromConventions({
        hasPytestConfig: false,
        hasJestConfig: true,
        hasCargoToml: true,
        hasGoMod: false,
        hasGradleBuild: false,
        hasMavenPom: false,
      });
      assert.equal(cmds.length, 2);
      assert.ok(cmds.some((c) => c.command === 'npx jest'));
      assert.ok(cmds.some((c) => c.command === 'cargo test'));
    });
  });

  describe('mergeTestCommands', () => {
    test('deduplicates by command string', () => {
      const a = [{ command: 'npm test', source: 'package.json' }];
      const b = [{ command: 'npm test', source: 'convention' }];
      const merged = mergeTestCommands(a, b);
      assert.equal(merged.length, 1);
      assert.equal(merged[0]!.source, 'package.json'); // first wins
    });

    test('preserves order across sources', () => {
      const a = [{ command: 'npm test', source: 'pkg' }];
      const b = [{ command: 'npx jest', source: 'convention' }];
      const merged = mergeTestCommands(a, b);
      assert.equal(merged.length, 2);
      assert.equal(merged[0]!.command, 'npm test');
      assert.equal(merged[1]!.command, 'npx jest');
    });
  });

  describe('formatTestCommandsForGate', () => {
    test('returns comma-separated commands', () => {
      const cmds = [
        { command: 'npm test', source: 'pkg' },
        { command: 'npx jest', source: 'convention' },
      ];
      assert.equal(formatTestCommandsForGate(cmds), 'npm test, npx jest');
    });

    test('truncates at 4 commands', () => {
      const cmds = [
        { command: 'a', source: 'x' },
        { command: 'b', source: 'x' },
        { command: 'c', source: 'x' },
        { command: 'd', source: 'x' },
        { command: 'e', source: 'x' },
      ];
      const formatted = formatTestCommandsForGate(cmds);
      assert.match(formatted, /\.\.\./);
      assert.equal(formatted.split(', ').length, 5); // 4 + "..."
    });

    test('returns empty for no commands', () => {
      assert.equal(formatTestCommandsForGate([]), '');
    });
  });
});
