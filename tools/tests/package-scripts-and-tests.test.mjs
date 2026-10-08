import assert from 'node:assert/strict';
import { existsSync, globSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const babelCliDir = join(repoRoot, 'babel-cli');
const pkgPath = join(babelCliDir, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const workflowPath = join(repoRoot, '.github/workflows/typecheck.yml');
const workflowYaml = readFileSync(workflowPath, 'utf8');

/**
 * Shell-style tokenizer supporting single/double quotes and whitespace splitting.
 */
export function tokenizeCommand(cmdStr) {
  const tokens = [];
  let current = '';
  let inQuote = null;
  for (let i = 0; i < cmdStr.length; i++) {
    const ch = cmdStr[i];
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === '|') {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      if (cmdStr[i + 1] === '|') {
        tokens.push('||');
        i++;
      } else {
        tokens.push('|');
      }
    } else if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (inQuote) {
    throw new Error(`Unterminated quote in command: ${cmdStr}`);
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

/**
 * Formal npm script grammar validator distinguishing checked-in inputs from build outputs.
 */
export function parseAndValidateScriptTargets(scripts, options = {}) {
  const root = options.repoRoot || repoRoot;
  const pkgDir = options.packageDir || babelCliDir;
  const missing = [];
  const parsedTargets = [];

  for (const [name, script] of Object.entries(scripts)) {
    const pipeline = script.split(/\s*&&\s*/);
    for (const pipelineStep of pipeline) {
      const tokens = tokenizeCommand(pipelineStep);
      if (tokens.length === 0) continue;

      if (tokens.includes('|') || tokens.includes('||')) {
        const pipeToken = tokens.find(t => t === '|' || t === '||');
        missing.push({
          script: name,
          target: pipeToken,
          resolved: pipeToken,
          kind: 'unsupported_syntax',
          reason: `Unquoted shell pipe/or '${pipeToken}' is not supported in package script grammar`,
        });
        continue;
      }

      let idx = 0;
      // Skip environment variable prefixes (e.g. UPDATE_SNAPSHOTS=1)
      while (idx < tokens.length && /^[A-Z0-9_]+=.*/.test(tokens[idx])) {
        idx++;
      }
      if (idx >= tokens.length) continue;

      const tool = tokens[idx];
      idx++;

      if (tool === 'npm') {
        if (tokens[idx] === 'run') {
          idx++;
          const targetScript = tokens[idx];
          if (!targetScript || !scripts[targetScript]) {
            missing.push({
              script: name,
              target: `npm run ${targetScript ?? ''}`,
              resolved: targetScript,
              kind: 'missing_subscript',
              reason: `Referenced script '${targetScript}' is not defined in package scripts`,
            });
          }
        }
        continue;
      }

      if (tool === 'pwsh' || tool === 'powershell') {
        while (idx < tokens.length) {
          const t = tokens[idx];
          if (t === '-File') {
            if (idx + 1 < tokens.length && !tokens[idx + 1].startsWith('-')) {
              idx++;
              parsedTargets.push({ script: name, target: tokens[idx], kind: 'input' });
            } else {
              missing.push({
                script: name,
                target: '-File',
                resolved: '-File',
                kind: 'unsupported_syntax',
                reason: "Missing script target argument for '-File' in pwsh command",
              });
            }
          } else if (t.startsWith('-File=')) {
            const target = t.slice('-File='.length);
            if (target.length > 0) {
              parsedTargets.push({ script: name, target, kind: 'input' });
            } else {
              missing.push({
                script: name,
                target: t,
                resolved: t,
                kind: 'unsupported_syntax',
                reason: "Empty script target argument in '-File='",
              });
            }
          } else if (t === '-Command' && idx + 1 < tokens.length) {
            idx++;
            const cmd = tokens[idx];
            const match = /& ['"]([^'"]+)['"]/.exec(cmd);
            if (match) {
              parsedTargets.push({ script: name, target: match[1], kind: 'input' });
            }
          }
          idx++;
        }
        continue;
      }

      if (tool === 'tsc') {
        while (idx < tokens.length) {
          const t = tokens[idx];
          if (t === '-p' || t === '--project') {
            if (idx + 1 < tokens.length && !tokens[idx + 1].startsWith('-')) {
              idx++;
              parsedTargets.push({ script: name, target: tokens[idx], kind: 'input' });
            } else {
              missing.push({
                script: name,
                target: t,
                resolved: t,
                kind: 'unsupported_syntax',
                reason: `Missing project target argument for '${t}' in tsc command`,
              });
            }
          } else if (t.startsWith('-p=') || t.startsWith('--project=')) {
            const target = t.split('=')[1];
            if (target && target.length > 0) {
              parsedTargets.push({ script: name, target, kind: 'input' });
            } else {
              missing.push({
                script: name,
                target: t,
                resolved: t,
                kind: 'unsupported_syntax',
                reason: `Empty project target argument in '${t}'`,
              });
            }
          }
          idx++;
        }
        continue;
      }

      if (tool === 'eslint' || tool === 'prettier') {
        while (idx < tokens.length) {
          const t = tokens[idx];
          if (!t.startsWith('-') && !t.startsWith('--')) {
            parsedTargets.push({ script: name, target: t, kind: 'input' });
          }
          idx++;
        }
        continue;
      }

      if (tool === 'knip') {
        continue;
      }

      if (tool === 'node' || tool === 'tsx' || tool === 'npx') {
        if (tool === 'npx') {
          if (tokens[idx] !== 'promptfoo') {
            missing.push({
              script: name,
              target: tokens[idx] || 'npx',
              resolved: `npx ${tokens[idx] || ''}`,
              kind: 'unsupported_syntax',
              reason: `Unsupported npx tool '${tokens[idx] || ''}'; only 'npx promptfoo' is permitted in package scripts`,
            });
            continue;
          }
          idx++;
        }
        while (idx < tokens.length) {
          const t = tokens[idx];
          if (t === '--output' || t === '-o') {
            if (idx + 1 < tokens.length && !tokens[idx + 1].startsWith('-')) {
              idx++;
              parsedTargets.push({ script: name, target: tokens[idx], kind: 'generated_output' });
            } else {
              missing.push({
                script: name,
                target: t,
                resolved: t,
                kind: 'unsupported_syntax',
                reason: `Missing target argument for '${t}'`,
              });
            }
          } else if (t.startsWith('--output=') || t.startsWith('-o=')) {
            const val = t.slice(t.indexOf('=') + 1);
            if (val) {
              parsedTargets.push({ script: name, target: val, kind: 'generated_output' });
            } else {
              missing.push({
                script: name,
                target: t,
                resolved: t,
                kind: 'unsupported_syntax',
                reason: `Empty target argument in '${t}'`,
              });
            }
          } else if (t === '--config' || t === '-c') {
            if (idx + 1 < tokens.length && !tokens[idx + 1].startsWith('-')) {
              idx++;
              parsedTargets.push({ script: name, target: tokens[idx], kind: 'input' });
            } else {
              missing.push({
                script: name,
                target: t,
                resolved: t,
                kind: 'unsupported_syntax',
                reason: `Missing target argument for '${t}'`,
              });
            }
          } else if (t.startsWith('--config=') || t.startsWith('-c=')) {
            const val = t.slice(t.indexOf('=') + 1);
            if (val) {
              parsedTargets.push({ script: name, target: val, kind: 'input' });
            } else {
              missing.push({
                script: name,
                target: t,
                resolved: t,
                kind: 'unsupported_syntax',
                reason: `Empty target argument in '${t}'`,
              });
            }
          } else if (t === '--import') {
            if (idx + 1 < tokens.length && !tokens[idx + 1].startsWith('-')) {
              idx++;
              const imp = tokens[idx];
              if (imp.startsWith('.') || imp.startsWith('src/') || imp.endsWith('.js') || imp.endsWith('.mjs') || imp.endsWith('.ts')) {
                parsedTargets.push({ script: name, target: imp, kind: 'input' });
              }
            } else {
              missing.push({
                script: name,
                target: t,
                resolved: t,
                kind: 'unsupported_syntax',
                reason: `Missing target argument for '${t}'`,
              });
            }
          } else if (t.startsWith('--import=')) {
            const imp = t.slice('--import='.length);
            if (imp.length === 0) {
              missing.push({
                script: name,
                target: t,
                resolved: t,
                kind: 'unsupported_syntax',
                reason: `Empty target argument in '${t}'`,
              });
            } else if (imp.startsWith('.') || imp.startsWith('src/') || imp.endsWith('.js') || imp.endsWith('.mjs') || imp.endsWith('.ts')) {
              parsedTargets.push({ script: name, target: imp, kind: 'input' });
            }
          } else if (t.startsWith('--env-file=')) {
            // env-file is runtime configuration
          } else if (t.startsWith('-')) {
            // flag
          } else if (['eval', 'watch', 'benchmark', 'parity', 'production', 'product', 'evidence', 'scorecard'].includes(t)) {
            // CLI subcommands and verbs
          } else {
            if (t.startsWith('dist/')) {
              parsedTargets.push({ script: name, target: t, kind: 'generated_output' });
            } else if (
              t.startsWith('src/') ||
              t.startsWith('scripts/') ||
              t.startsWith('tools/') ||
              t.startsWith('../tools/') ||
              t.startsWith('promptfoo/') ||
              t.startsWith('bin/') ||
              t.endsWith('.ts') ||
              t.endsWith('.mjs') ||
              t.endsWith('.js') ||
              t.endsWith('.ps1') ||
              t.endsWith('.yaml') ||
              t.endsWith('.yml') ||
              t.endsWith('.json')
            ) {
              parsedTargets.push({ script: name, target: t, kind: 'input' });
            }
          }
          idx++;
        }
        continue;
      }

      missing.push({
        script: name,
        target: tool,
        resolved: tool,
        kind: 'unsupported_syntax',
        reason: `Unsupported tool/command in script grammar: ${tool}`,
      });
    }
  }

  for (const pt of parsedTargets) {
    if (pt.kind === 'generated_output') continue;
    const target = pt.target;
    let resolved;
    if (target.startsWith('../')) {
      resolved = resolve(root, target.slice(3));
    } else {
      resolved = resolve(pkgDir, target);
    }

    if (target.includes('*')) {
      const matches = globSync(target, { cwd: pkgDir });
      if (matches.length === 0) {
        missing.push({
          script: pt.script,
          target,
          resolved,
          kind: 'empty_glob',
          reason: `Glob matched 0 files in ${pkgDir}`,
        });
      }
    } else {
      if (!existsSync(resolved)) {
        missing.push({
          script: pt.script,
          target,
          resolved,
          kind: 'missing_file',
          reason: `File does not exist: ${resolved}`,
        });
      }
    }
  }

  return { missing, parsedTargets };
}

/**
 * Explicit registry of specialized (non-unit-shard) test suites.
 * Each entry details command, loader, environment, OS matrix coverage, required workflow job,
 * or justified exclusion with owner and restoration criteria.
 */
export const SPECIALIZED_LANES = {
  'acceptance-v0': {
    files: [
      'src/acceptance/acceptance.test.ts',
      'src/acceptance/architecture.test.ts',
      'src/acceptance/hardening.test.ts',
    ],
    command: 'npm run test:acceptance-v0',
    loader: 'tsx',
    environment: 'node',
    osCoverage: ['ubuntu-latest', 'windows-latest'],
    requiredJob: 'platform-core',
    exclusion: null,
  },
  'interactive-harness-specialized': {
    files: [
      'src/interactive/testing/chatDailyDriverCertification.test.ts',
      'src/interactive/testing/multiModelTelemetryAudit.test.ts',
      'src/interactive/testing/realCliInteractiveProcess.test.ts',
      'src/interactive/testing/simulatedTtyInteractive.test.ts',
      'src/interactive/projection/turnViewProjector.test.ts',
    ],
    command: 'npm run test:harness-runtime',
    loader: 'tsx',
    environment: 'node',
    osCoverage: ['ubuntu-latest', 'windows-latest'],
    requiredJob: 'harness-runtime',
    exclusion: null,
  },
  'daemon-integration': {
    files: [
      'src/daemon/client.test.ts',
      'src/daemon/evidenceTruthfulness.test.ts',
      'src/daemon/integration.test.ts',
      'src/daemon/ipc.test.ts',
      'src/daemon/queue.test.ts',
      'src/daemon/recovery.test.ts',
    ],
    command: 'npm run test:daemon',
    loader: 'tsx',
    environment: 'daemon-ipc',
    osCoverage: ['local-only'],
    requiredJob: null,
    exclusion: {
      reason: 'Background daemon process socket lifecycle exhibits Windows CI PID/socket timing races and unisolated daemon instances',
      owner: 'daemon-runtime',
      restorationCriteria: 'Hermetic mock IPC socket transport without background PID locks, deterministically tested on Windows and Linux',
    },
  },
  'claude-babel-astra-lab': {
    files: [
      'src/claude-babel-astra-lab/claudeHarness.test.ts',
      'src/claude-babel-astra-lab/comparison-contract-v3.test.ts',
      'src/claude-babel-astra-lab/comparison-contract.test.ts',
      'src/claude-babel-astra-lab/comparison-runner.test.ts',
      'src/claude-babel-astra-lab/frozen-evaluator.test.ts',
      'src/claude-babel-astra-lab/lab.test.ts',
      'src/claude-babel-astra-lab/recovery-observation.test.ts',
    ],
    command: 'npm run test:comparison',
    commandsByFile: {
      'src/claude-babel-astra-lab/claudeHarness.test.ts': 'npm run test:claude-babel-lab',
      'src/claude-babel-astra-lab/lab.test.ts': 'npm run test:claude-babel-lab',
      'src/claude-babel-astra-lab/comparison-contract-v3.test.ts': 'npm run test:comparison',
      'src/claude-babel-astra-lab/comparison-contract.test.ts': 'npm run test:comparison',
      'src/claude-babel-astra-lab/comparison-runner.test.ts': 'npm run test:comparison',
      'src/claude-babel-astra-lab/frozen-evaluator.test.ts': 'npm run test:comparison',
      'src/claude-babel-astra-lab/recovery-observation.test.ts': 'npm run test:comparison',
    },
    loader: 'tsx',
    environment: 'offline-lab',
    osCoverage: ['local-only'],
    requiredJob: null,
    exclusion: {
      reason: 'Multi-model comparison evaluation suites designed for offline benchmark campaigns and cross-model audits; not part of fast branch verification',
      owner: 'lab-eval',
      restorationCriteria: 'Deterministic golden fixture runner wired into an optional evaluation workflow without live provider credentials',
    },
  },
};

/**
 * Validates that all source test files belong to either canonical unit inventory or specialized lanes,
 * with disjoint set partitioning, disk file existence, npm command validity, workflow job mapping,
 * and justified exclusion requirements.
 */
export function validateTestClassification(allTests, unitInventorySet, specializedLanes, pkgScripts, workflowContent, options = {}) {
  const pkgDir = options.packageDir || babelCliDir;
  const errors = [];

  function getJobBlock(jobName) {
    const lines = workflowContent.split(/\r?\n/);
    let inJob = false;
    const jobLines = [];
    for (const rawLine of lines) {
      if (!inJob) {
        if (rawLine === `  ${jobName}:`) inJob = true;
      } else {
        if (/^  [a-zA-Z0-9_-]+:/.test(rawLine)) break;
        jobLines.push(rawLine);
      }
    }
    return inJob ? jobLines.join('\n') : null;
  }

  function getJobNeeds(jobName) {
    const block = getJobBlock(jobName);
    if (!block) return [];
    const lines = block.split('\n');
    let inNeeds = false;
    const needs = [];
    for (const rawLine of lines) {
      if (!inNeeds) {
        if (/^\s*needs:/.test(rawLine)) inNeeds = true;
      } else {
        const itemMatch = /^\s*-\s*([a-zA-Z0-9_-]+)/.exec(rawLine);
        if (itemMatch) {
          needs.push(itemMatch[1]);
        } else if (/^\s*[a-zA-Z0-9_-]+:/.test(rawLine)) {
          break;
        }
      }
    }
    return needs;
  }

  const linuxValidationNeeds = getJobNeeds('linux-validation');
  const windowsPortabilityNeeds = getJobNeeds('windows-portability');

  function globToRegex(globStr) {
    let reStr = '^';
    let i = 0;
    while (i < globStr.length) {
      const c = globStr[i];
      if (c === '*' && globStr[i + 1] === '*' && globStr[i + 2] === '/') {
        reStr += '(?:.*/)?';
        i += 3;
      } else if (c === '*' && globStr[i + 1] === '*') {
        reStr += '.*';
        i += 2;
      } else if (c === '*') {
        reStr += '[^/]*';
        i += 1;
      } else if (/[.+?^${}()|[\]\\]/.test(c)) {
        reStr += '\\' + c;
        i += 1;
      } else {
        reStr += c;
        i += 1;
      }
    }
    reStr += '$';
    return new RegExp(reStr);
  }

  function scriptCoversFile(scriptDef, file) {
    if (!scriptDef) return false;
    if (scriptDef.includes(file)) return true;
    const tokens = tokenizeCommand(scriptDef);
    for (const token of tokens) {
      const cleanToken = token.replace(/^["']|["']$/g, '');
      if (cleanToken.includes('*')) {
        const globRegex = globToRegex(cleanToken);
        if (globRegex.test(file)) return true;
      }
    }
    return false;
  }

  function jobExecutesCommand(jobBlock, scriptName) {
    const lines = jobBlock.split(/\r?\n/);
    const targetPattern = new RegExp(`\\bnpm run ${scriptName}\\b`);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || /^\s*(?:-\s*run:\s*)?#/.test(line)) continue;
      if (targetPattern.test(line)) {
        if (/\becho\s+.*npm run\b/.test(line) || /^\s*(?:-\s*run:\s*)?echo\b/.test(line)) continue;
        if (/\|\|\s*true\b|\|\|\s*exit 0\b/.test(line)) continue;
        return true;
      }
    }
    return false;
  }

  const specializedSet = new Set();
  for (const [lane, entry] of Object.entries(specializedLanes)) {
    // 1. Validate files exist on disk
    if (!Array.isArray(entry.files) || entry.files.length === 0) {
      errors.push(`Specialized lane '${lane}' has no files defined`);
      continue;
    }

    for (const file of entry.files) {
      const fullPath = join(pkgDir, file);
      if (!existsSync(fullPath)) {
        errors.push(`Specialized lane '${lane}' references missing file: ${file}`);
      }
      specializedSet.add(file);
    }

    // 2. Validate commands mapping and execution proof
    const commandsToCheck = new Set();

    if (entry.commandsByFile !== undefined) {
      if (typeof entry.commandsByFile !== 'object' || entry.commandsByFile === null || Object.keys(entry.commandsByFile).length === 0) {
        errors.push(`Specialized lane '${lane}' specifies commandsByFile, but it is empty or invalid`);
      } else {
        for (const file of entry.files) {
          const cmd = entry.commandsByFile[file];
          if (!cmd || typeof cmd !== 'string' || !cmd.startsWith('npm run ')) {
            errors.push(`Specialized lane '${lane}' file '${file}' is missing a valid npm run command in commandsByFile`);
          } else {
            commandsToCheck.add(cmd);
            const scriptName = cmd.replace(/^npm run\s+/, '').trim();
            const scriptDef = pkgScripts[scriptName];
            if (!scriptDef) {
              errors.push(`Lane '${lane}' command '${cmd}' (script '${scriptName}') for file '${file}' is missing from package.json scripts`);
            } else if (!scriptCoversFile(scriptDef, file)) {
              errors.push(`Lane '${lane}' file '${file}' is assigned to command '${cmd}', but script '${scriptName}' does not target or match this file`);
            }
          }
        }
      }
    } else {
      if (!entry.command || typeof entry.command !== 'string' || !entry.command.startsWith('npm run ')) {
        errors.push(`Specialized lane '${lane}' is missing a valid default command ('npm run ...')`);
      } else {
        commandsToCheck.add(entry.command);
        const scriptName = entry.command.replace(/^npm run\s+/, '').trim();
        const scriptDef = pkgScripts[scriptName];
        if (!scriptDef) {
          errors.push(`Lane '${lane}' command '${entry.command}' (script '${scriptName}') is missing from package.json scripts`);
        } else {
          for (const file of entry.files) {
            if (!scriptCoversFile(scriptDef, file)) {
              errors.push(`Lane '${lane}' file '${file}' is assigned to command '${entry.command}', but script '${scriptName}' does not target or match this file`);
            }
          }
        }
      }
    }

    // 3. Validate requiredJob in workflow or justified exclusion
    if (entry.requiredJob !== null) {
      const jobBlock = getJobBlock(entry.requiredJob);
      if (!jobBlock) {
        errors.push(`Lane '${lane}' specifies requiredJob '${entry.requiredJob}', but that job is not in workflow`);
      } else {
        for (const cmd of commandsToCheck) {
          const scriptName = cmd.replace(/^npm run\s+/, '').trim();
          if (!jobExecutesCommand(jobBlock, scriptName)) {
            errors.push(`Required job '${entry.requiredJob}' for lane '${lane}' does not actively execute command '${cmd}'`);
          }
        }

        if (!linuxValidationNeeds.includes(entry.requiredJob)) {
          errors.push(`Required job '${entry.requiredJob}' for lane '${lane}' is not in 'needs:' list of linux-validation`);
        }
        if (!windowsPortabilityNeeds.includes(entry.requiredJob)) {
          errors.push(`Required job '${entry.requiredJob}' for lane '${lane}' is not in 'needs:' list of windows-portability`);
        }
      }
    } else {
      if (
        !entry.exclusion ||
        typeof entry.exclusion.reason !== 'string' ||
        !entry.exclusion.reason.trim() ||
        typeof entry.exclusion.owner !== 'string' ||
        !entry.exclusion.owner.trim() ||
        typeof entry.exclusion.restorationCriteria !== 'string' ||
        !entry.exclusion.restorationCriteria.trim()
      ) {
        errors.push(`Lane '${lane}' is excluded from required CI but missing complete exclusion justification (reason, owner, restorationCriteria)`);
      }
    }
  }

  // 4. Overlap check between unit and specialized
  const overlap = [];
  for (const f of specializedSet) {
    if (unitInventorySet.has(f)) {
      overlap.push(f);
    }
  }
  if (overlap.length > 0) {
    errors.push(`Found ${overlap.length} file(s) present in BOTH unit inventory and specialized lanes: ${overlap.join(', ')}`);
  }

  // 5. Unclassified / orphan test check
  const unclassified = [];
  for (const testFile of allTests) {
    if (!unitInventorySet.has(testFile) && !specializedSet.has(testFile)) {
      unclassified.push(testFile);
    }
  }
  if (unclassified.length > 0) {
    errors.push(`Found ${unclassified.length} unclassified/orphan source test file(s):\n` + unclassified.map(f => `  ${f}`).join('\n'));
  }

  return { errors, specializedSet, unclassified, overlap };
}

test('every npm script target reference exists on disk and adheres to command grammar', () => {
  const { missing, parsedTargets } = parseAndValidateScriptTargets(pkg.scripts);

  assert.equal(
    missing.length,
    0,
    `Found ${missing.length} missing/invalid npm script target(s):\n` +
      missing.map(m => `  [${m.script}] ${m.target} -> ${m.resolved} (${m.kind}: ${m.reason})`).join('\n')
  );

  const inputCount = parsedTargets.filter(t => t.kind === 'input').length;
  const outputCount = parsedTargets.filter(t => t.kind === 'generated_output').length;
  assert.ok(inputCount >= 300, `Expected at least 300 checked-in input targets, found ${inputCount}`);
  assert.ok(outputCount >= 5, `Expected at least 5 generated output targets, found ${outputCount}`);
});

test('script target validation negative fixtures (missing files, empty globs, invalid syntax, missing subscripts, equals-form, pipes, npx)', () => {
  // Negative 1: Missing file
  const missingFileRes = parseAndValidateScriptTargets({
    'bad:file': 'tsx src/does-not-exist-at-all-xyz.ts',
  });
  assert.equal(missingFileRes.missing.length, 1);
  assert.equal(missingFileRes.missing[0].kind, 'missing_file');

  // Negative 2: Empty glob
  const emptyGlobRes = parseAndValidateScriptTargets({
    'bad:glob': 'tsx "src/nonexistent_folder_xyz/**/*.test.ts"',
  });
  assert.equal(emptyGlobRes.missing.length, 1);
  assert.equal(emptyGlobRes.missing[0].kind, 'empty_glob');

  // Negative 3: Missing sub-script
  const missingSubscriptRes = parseAndValidateScriptTargets({
    'bad:chain': 'npm run nonexistent_target_script_xyz',
  });
  assert.equal(missingSubscriptRes.missing.length, 1);
  assert.equal(missingSubscriptRes.missing[0].kind, 'missing_subscript');

  // Negative 4: Unsupported syntax
  const unsupportedSyntaxRes = parseAndValidateScriptTargets({
    'bad:tool': 'unsupported_binary_xyz --option',
  });
  assert.equal(unsupportedSyntaxRes.missing.length, 1);
  assert.equal(unsupportedSyntaxRes.missing[0].kind, 'unsupported_syntax');

  // Negative 5: Unterminated quote
  assert.throws(() => {
    tokenizeCommand('node "unclosed string');
  }, /Unterminated quote/);

  // Negative 6: Equals-form missing file
  const equalsMissingFileRes = parseAndValidateScriptTargets({
    'bad:import': 'node --import=./src/missing_import_file_xyz.mjs',
  });
  assert.equal(equalsMissingFileRes.missing.length, 1);
  assert.equal(equalsMissingFileRes.missing[0].kind, 'missing_file');

  // Negative 7: Equals-form missing config
  const equalsMissingConfigRes = parseAndValidateScriptTargets({
    'bad:config': 'npx promptfoo eval --config=promptfoo/missing_config_xyz.yaml',
  });
  assert.equal(equalsMissingConfigRes.missing.length, 1);
  assert.equal(equalsMissingConfigRes.missing[0].kind, 'missing_file');

  // Negative 8: Equals-form missing pwsh file
  const equalsMissingPwshRes = parseAndValidateScriptTargets({
    'bad:pwsh': 'pwsh -File=../tools/missing_script_xyz.ps1',
  });
  assert.equal(equalsMissingPwshRes.missing.length, 1);
  assert.equal(equalsMissingPwshRes.missing[0].kind, 'missing_file');

  // Negative 9: Equals-form missing tsc project
  const equalsMissingTscRes = parseAndValidateScriptTargets({
    'bad:tsc': 'tsc -p=tsconfig.missing_xyz.json',
  });
  assert.equal(equalsMissingTscRes.missing.length, 1);
  assert.equal(equalsMissingTscRes.missing[0].kind, 'missing_file');

  // Negative 10: Unsupported npx tool
  const unsupportedNpxRes = parseAndValidateScriptTargets({
    'bad:npx': 'npx some-unsupported-tool-xyz --flag',
  });
  assert.equal(unsupportedNpxRes.missing.length, 1);
  assert.equal(unsupportedNpxRes.missing[0].kind, 'unsupported_syntax');
  assert.ok(unsupportedNpxRes.missing[0].reason.includes('Unsupported npx tool'));

  // Negative 11: Bare -File without target argument
  const barePwshFileRes = parseAndValidateScriptTargets({
    'bad:bare-file': 'pwsh -NoProfile -File',
  });
  assert.equal(barePwshFileRes.missing.length, 1);
  assert.equal(barePwshFileRes.missing[0].kind, 'unsupported_syntax');

  // Negative 12: Unquoted shell pipe
  const pipeRes = parseAndValidateScriptTargets({
    'bad:pipe': 'node dist/index.js | grep something',
  });
  assert.equal(pipeRes.missing.length, 1);
  assert.equal(pipeRes.missing[0].kind, 'unsupported_syntax');
  assert.ok(pipeRes.missing[0].reason.includes('Unquoted shell pipe/or'));

  // Negative 13: Unquoted shell or
  const orRes = parseAndValidateScriptTargets({
    'bad:or': 'node dist/index.js || true',
  });
  assert.equal(orRes.missing.length, 1);
  assert.equal(orRes.missing[0].kind, 'unsupported_syntax');

  // Positive control: Generated build outputs are recognized without requiring pre-build existence
  const outputRes = parseAndValidateScriptTargets({
    'build:test': 'node dist/index.js --output promptfoo/results.json',
  });
  assert.equal(outputRes.missing.length, 0);
  assert.equal(outputRes.parsedTargets.filter(t => t.kind === 'generated_output').length, 2);
});

test('every discovered source test belongs to canonical unit lane or an explicit specialized lane', async () => {
  const allTests = globSync('src/**/*.test.ts', { cwd: babelCliDir })
    .map(f => f.split(sep).join('/'))
    .sort();

  assert.ok(allTests.length > 0, 'Source test discovery must not be empty');
  assert.equal(new Set(allTests).size, allTests.length, 'Source test discovery must be unique');

  // Load canonical unit shard inventory using repo helper
  const { prepareUnitShard } = await import('../../babel-cli/scripts/run_ci_unit_shard.mjs');
  const unitShard = prepareUnitShard(babelCliDir, 0, 1);
  const unitInventory = new Set(unitShard.inventory);

  assert.ok(unitInventory.size > 0, 'Canonical unit inventory must not be empty');
  assert.equal(unitInventory.size, unitShard.inventory.length, 'Canonical unit inventory must be unique');
  for (const path of ['src/agent/desktopApproval.test.ts', 'src/cli/chatStreamNdjson.test.ts', 'src/interactive/execution/chatResumeHeadless.test.ts',
    'src/agent/chatEngineVerifierAdapter.noChange.test.ts', 'src/agent/chatHarnessFeedback.test.ts',
    'src/agent/chatLspPolicy.test.ts', 'src/agent/chatOperationExplicit.test.ts',
    'src/agent/chatProductiveInvestigation.test.ts', 'src/agent/codingLoopRepair.test.ts',
    'src/agent/codingLoopSimplification.test.ts', 'src/services/lsp/manager.test.ts']) {
    assert.ok(unitInventory.has(path), `Regression test must be covered by the canonical unit lane: ${path}`);
  }

  const totalSpecializedFiles = Object.values(SPECIALIZED_LANES).reduce((acc, l) => acc + l.files.length, 0);
  assert.equal(totalSpecializedFiles, 21, `Expected exactly 21 specialized test files, found ${totalSpecializedFiles}`);

  const { errors, specializedSet, unclassified, overlap } = validateTestClassification(
    allTests,
    unitInventory,
    SPECIALIZED_LANES,
    pkg.scripts,
    workflowYaml
  );

  assert.equal(errors.length, 0, `Test classification errors:\n${errors.join('\n')}`);
  assert.equal(specializedSet.size, 21);
  assert.equal(unclassified.length, 0);
  assert.equal(overlap.length, 0);
  const classified = [...unitInventory, ...specializedSet].sort();
  assert.equal(new Set(classified).size, classified.length, 'Unit and specialized lanes must form a unique partition');
  assert.deepEqual(classified, allTests, 'Unit and specialized lanes must exhaust exactly the discovered source tests');
});

test('test classification negative fixtures (orphan file, deleted lane command, lane absent from CI, missing file, unjustified exclusion, empty commandsByFile, unrelated test match, masked CI, echo CI)', () => {
  const mockUnit = new Set(['src/a.test.ts']);
  const baseSpecialized = {
    'lane-a': {
      files: ['src/acceptance/acceptance.test.ts'],
      command: 'npm run test:acceptance-v0',
      requiredJob: 'platform-core',
      exclusion: null,
    },
  };

  // Negative 1: Orphan file
  const orphanRes = validateTestClassification(
    ['src/a.test.ts', 'src/acceptance/acceptance.test.ts', 'src/orphan/lost.test.ts'],
    mockUnit,
    baseSpecialized,
    pkg.scripts,
    workflowYaml
  );
  assert.ok(orphanRes.unclassified.includes('src/orphan/lost.test.ts'));
  assert.ok(orphanRes.errors.some(e => e.includes('unclassified/orphan source test file(s)')));

  // Negative 2: Deleted lane command
  const deletedCmdSpecialized = {
    'lane-bad-cmd': {
      files: ['src/acceptance/acceptance.test.ts'],
      command: 'npm run test:deleted-script-target',
      requiredJob: 'platform-core',
      exclusion: null,
    },
  };
  const deletedCmdRes = validateTestClassification(
    ['src/acceptance/acceptance.test.ts'],
    new Set(),
    deletedCmdSpecialized,
    pkg.scripts,
    workflowYaml
  );
  assert.ok(deletedCmdRes.errors.some(e => e.includes('missing from package.json scripts')));

  // Negative 3: Lane absent from required CI
  const absentCiSpecialized = {
    'lane-bad-ci': {
      files: ['src/acceptance/acceptance.test.ts'],
      command: 'npm run test:acceptance-v0',
      requiredJob: 'nonexistent-ci-job-matrix',
      exclusion: null,
    },
  };
  const absentCiRes = validateTestClassification(
    ['src/acceptance/acceptance.test.ts'],
    new Set(),
    absentCiSpecialized,
    pkg.scripts,
    workflowYaml
  );
  assert.ok(absentCiRes.errors.some(e => e.includes('that job is not in workflow')));

  // Negative 4: Missing specialized file
  const missingFileSpecialized = {
    'lane-missing-file': {
      files: ['src/acceptance/ghost-nonexistent.test.ts'],
      command: 'npm run test:acceptance-v0',
      requiredJob: 'platform-core',
      exclusion: null,
    },
  };
  const missingFileRes = validateTestClassification(
    ['src/acceptance/ghost-nonexistent.test.ts'],
    new Set(),
    missingFileSpecialized,
    pkg.scripts,
    workflowYaml
  );
  assert.ok(missingFileRes.errors.some(e => e.includes('references missing file')));

  // Negative 5: Unjustified exclusion (missing owner / reason / restoration criteria)
  const unjustifiedSpecialized = {
    'lane-unjustified': {
      files: ['src/acceptance/acceptance.test.ts'],
      command: 'npm run test:acceptance-v0',
      requiredJob: null,
      exclusion: { reason: 'Skipped for now' }, // missing owner and restorationCriteria
    },
  };
  const unjustifiedRes = validateTestClassification(
    ['src/acceptance/acceptance.test.ts'],
    new Set(),
    unjustifiedSpecialized,
    pkg.scripts,
    workflowYaml
  );
  assert.ok(unjustifiedRes.errors.some(e => e.includes('missing complete exclusion justification')));

  // Negative 6: Empty commandsByFile
  const emptyCommandsByFileSpecialized = {
    'lane-empty-cbf': {
      files: ['src/acceptance/acceptance.test.ts'],
      command: 'npm run test:acceptance-v0',
      commandsByFile: {},
      requiredJob: 'platform-core',
      exclusion: null,
    },
  };
  const emptyCbfRes = validateTestClassification(
    ['src/acceptance/acceptance.test.ts'],
    new Set(),
    emptyCommandsByFileSpecialized,
    pkg.scripts,
    workflowYaml
  );
  assert.ok(emptyCbfRes.errors.some(e => e.includes('commandsByFile, but it is empty or invalid')));

  // Negative 7: Script command does not target or match the file
  const unrelatedMatchSpecialized = {
    'lane-unrelated': {
      files: ['src/acceptance/acceptance.test.ts'],
      command: 'npm run test:contrast', // test:contrast tests src/ui/contrast.test.ts, NOT src/acceptance/acceptance.test.ts
      requiredJob: null,
      exclusion: {
        reason: 'test',
        owner: 'test',
        restorationCriteria: 'test',
      },
    },
  };
  const unrelatedRes = validateTestClassification(
    ['src/acceptance/acceptance.test.ts'],
    new Set(),
    unrelatedMatchSpecialized,
    pkg.scripts,
    workflowYaml
  );
  assert.ok(unrelatedRes.errors.some(e => e.includes('does not target or match this file')));

  // Negative 8: CI step is commented out
  const commentedWorkflow = `
jobs:
  fake-job:
    runs-on: ubuntu-latest
    steps:
      - run: |
          # npm run test:acceptance-v0
  linux-validation:
    needs:
      - fake-job
  windows-portability:
    needs:
      - fake-job
`;
  const commentedRes = validateTestClassification(
    ['src/acceptance/acceptance.test.ts'],
    new Set(),
    {
      'lane-fake': {
        files: ['src/acceptance/acceptance.test.ts'],
        command: 'npm run test:acceptance-v0',
        requiredJob: 'fake-job',
        exclusion: null,
      },
    },
    pkg.scripts,
    commentedWorkflow
  );
  assert.ok(commentedRes.errors.some(e => e.includes('does not actively execute command')));

  // Negative 9: CI step is masked with || true
  const maskedWorkflow = `
jobs:
  fake-job:
    runs-on: ubuntu-latest
    steps:
      - run: npm run test:acceptance-v0 || true
  linux-validation:
    needs:
      - fake-job
  windows-portability:
    needs:
      - fake-job
`;
  const maskedRes = validateTestClassification(
    ['src/acceptance/acceptance.test.ts'],
    new Set(),
    {
      'lane-fake': {
        files: ['src/acceptance/acceptance.test.ts'],
        command: 'npm run test:acceptance-v0',
        requiredJob: 'fake-job',
        exclusion: null,
      },
    },
    pkg.scripts,
    maskedWorkflow
  );
  assert.ok(maskedRes.errors.some(e => e.includes('does not actively execute command')));

  // Negative 10: CI step is merely echo
  const echoWorkflow = `
jobs:
  fake-job:
    runs-on: ubuntu-latest
    steps:
      - run: echo npm run test:acceptance-v0
  linux-validation:
    needs:
      - fake-job
  windows-portability:
    needs:
      - fake-job
`;
  const echoRes = validateTestClassification(
    ['src/acceptance/acceptance.test.ts'],
    new Set(),
    {
      'lane-fake': {
        files: ['src/acceptance/acceptance.test.ts'],
        command: 'npm run test:acceptance-v0',
        requiredJob: 'fake-job',
        exclusion: null,
      },
    },
    pkg.scripts,
    echoWorkflow
  );
  assert.ok(echoRes.errors.some(e => e.includes('does not actively execute command')));

  // Negative 11: requiredJob not in needs of portability gates
  const unneededWorkflow = `
jobs:
  fake-job:
    runs-on: ubuntu-latest
    steps:
      - run: npm run test:acceptance-v0
  linux-validation:
    needs:
      - other-job
  windows-portability:
    needs:
      - other-job
`;
  const unneededRes = validateTestClassification(
    ['src/acceptance/acceptance.test.ts'],
    new Set(),
    {
      'lane-fake': {
        files: ['src/acceptance/acceptance.test.ts'],
        command: 'npm run test:acceptance-v0',
        requiredJob: 'fake-job',
        exclusion: null,
      },
    },
    pkg.scripts,
    unneededWorkflow
  );
  assert.ok(unneededRes.errors.some(e => e.includes("not in 'needs:' list")));
});
