import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { resolve, extname, join, sep } from 'node:path';
import { RULES_BY_EXT } from './repoSearch.js';
import { isPathInside } from '../services/targetResolver.js';
import { parseCatalog } from '../control-plane/catalog.js';
import type { ToolResult } from '../localTools.js';

const SUPPORTED_EXTENSIONS = new Set(['ts', 'js', 'py', 'go', 'rs', 'java', 'tsx', 'jsx', 'mjs', 'cjs']);

/** Helper to check if a resolved file path is allowed to be read. */
function isPathAllowed(filePath: string, approvedReadRoots?: string[]): boolean {
  if (!approvedReadRoots || approvedReadRoots.length === 0) {
    return true;
  }
  const resolved = resolve(filePath);
  return approvedReadRoots.some((root) => isPathInside(resolve(root), resolved));
}

/** Outline scanner for get_code_outline. */
export async function handleGetCodeOutline(
  filePath: string,
  approvedReadRoots?: string[],
): Promise<ToolResult> {
  const projectRoot = process.env['BABEL_PROJECT_ROOT'] ?? process.cwd();
  const absPath = resolve(projectRoot, filePath);

  if (!isPathAllowed(absPath, approvedReadRoots)) {
    return {
      exit_code: 1,
      stdout: '',
      stderr: `Access Denied: Path ${filePath} is outside the allowed read roots.`,
    };
  }

  if (!existsSync(absPath)) {
    return {
      exit_code: 1,
      stdout: '',
      stderr: `Error: File not found at ${absPath}`,
    };
  }

  const ext = extname(absPath).slice(1).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    return {
      exit_code: 1,
      stdout: '',
      stderr: `Unsupported file type: .${ext} outline only supports ts, js, py, go, rs, java (and variants).`,
    };
  }

  try {
    const content = readFileSync(absPath, 'utf-8');
    const lines = content.split(/\r?\n/);
    const rules = RULES_BY_EXT[ext] || [];
    const outline: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      for (const rule of rules) {
        const match = line.match(rule.pattern);
        if (match) {
          const symbolName = match[1] || 'anonymous';
          outline.push(`Line ${i + 1}: [${rule.kind}] ${symbolName} - "${line.trim()}"`);
          break;
        }
      }
    }

    return {
      exit_code: 0,
      stdout: outline.length > 0 ? outline.join('\n') : 'No outline symbols found in file.',
      stderr: '',
    };
  } catch (error: any) {
    return {
      exit_code: 1,
      stdout: '',
      stderr: error.message || String(error),
    };
  }
}

/** Recursively lists supported files in the workspace. */
function getFilesRecursive(dir: string, approvedReadRoots?: string[]): string[] {
  let results: string[] = [];
  try {
    const list = readdirSync(dir, { withFileTypes: true });
    for (const dirent of list) {
      const res = join(dir, dirent.name);
      if (
        dirent.name === 'node_modules' ||
        dirent.name === '.git' ||
        dirent.name === '.compiled' ||
        dirent.name === 'dist'
      ) {
        continue;
      }
      if (dirent.isDirectory()) {
        results = results.concat(getFilesRecursive(res, approvedReadRoots));
      } else {
        const ext = extname(dirent.name).slice(1).toLowerCase();
        if (SUPPORTED_EXTENSIONS.has(ext) && isPathAllowed(res, approvedReadRoots)) {
          results.push(res);
        }
      }
    }
  } catch {
    // ignore unreadable/missing directory errors
  }
  return results;
}

/** Definition extractor helper for find_code_definition. */
export async function handleFindCodeDefinition(
  symbolName: string,
  approvedReadRoots?: string[],
): Promise<ToolResult> {
  const projectRoot = process.env['BABEL_PROJECT_ROOT'] ?? process.cwd();
  const files = getFilesRecursive(projectRoot, approvedReadRoots);

  let foundFile: string | null = null;
  let foundLineIndex = -1;
  let foundExt = '';
  let foundKind = '';
  let lines: string[] = [];

  for (const file of files) {
    const ext = extname(file).slice(1).toLowerCase();
    const rules = RULES_BY_EXT[ext] || [];
    try {
      const content = readFileSync(file, 'utf-8');
      const fileLines = content.split(/\r?\n/);
      for (let i = 0; i < fileLines.length; i++) {
        const line = fileLines[i]!;
        for (const rule of rules) {
          const match = line.match(rule.pattern);
          if (match && match[1] === symbolName) {
            foundFile = file;
            foundLineIndex = i;
            foundExt = ext;
            foundKind = rule.kind;
            lines = fileLines;
            break;
          }
        }
        if (foundFile) break;
      }
    } catch {
      // skip unreadable files
    }
    if (foundFile) break;
  }

  if (!foundFile || foundLineIndex === -1) {
    return {
      exit_code: 0,
      stdout: `Symbol "${symbolName}" definition not found in workspace.`,
      stderr: '',
    };
  }

  try {
    // Indentation-based block extraction for Python
    if (foundExt === 'py') {
      const definitionLines = [lines[foundLineIndex]!];
      const baseIndentMatch = lines[foundLineIndex]!.match(/^\s*/);
      const baseIndent = baseIndentMatch ? baseIndentMatch[0].length : 0;

      for (let j = foundLineIndex + 1; j < lines.length; j++) {
        const nextLine = lines[j]!;
        const trimmed = nextLine.trim();
        if (trimmed === '' || trimmed.startsWith('#')) {
          definitionLines.push(nextLine);
          continue;
        }
        const indentMatch = nextLine.match(/^\s*/);
        const indent = indentMatch ? indentMatch[0].length : 0;
        if (indent <= baseIndent) {
          break;
        }
        definitionLines.push(nextLine);
      }

      return {
        exit_code: 0,
        stdout: `File: ${foundFile}\nLine: ${foundLineIndex + 1}\nKind: ${foundKind}\n\n${definitionLines.join('\n')}`,
        stderr: '',
      };
    }

    // Token-aware brace balancing character scanner for brace-based languages
    let braceCount = 0;
    let hasOpened = false;
    let inDoubleQuote = false;
    let inSingleQuote = false;
    let inTemplateLiteral = false;
    let inBlockComment = false;
    let inLineComment = false;
    let stopIndex = -1;

    const definitionLines: string[] = [];

    for (let j = foundLineIndex; j < lines.length; j++) {
      const line = lines[j]!;
      definitionLines.push(line);

      for (let c = 0; c < line.length; c++) {
        const char = line[c]!;
        const next = line[c + 1] || '';
        const prev = line[c - 1] || '';

        if (inLineComment) {
          continue;
        }
        if (inBlockComment) {
          if (char === '*' && next === '/') {
            inBlockComment = false;
            c++;
          }
          continue;
        }

        if ((inDoubleQuote || inSingleQuote || inTemplateLiteral) && prev === '\\') {
          continue;
        }

        if (inDoubleQuote) {
          if (char === '"') inDoubleQuote = false;
          continue;
        }
        if (inSingleQuote) {
          if (char === "'") inSingleQuote = false;
          continue;
        }
        if (inTemplateLiteral) {
          if (char === '`') inTemplateLiteral = false;
          continue;
        }

        if (char === '/' && next === '/') {
          inLineComment = true;
          c++;
          continue;
        }
        if (char === '/' && next === '*') {
          inBlockComment = true;
          c++;
          continue;
        }

        if (char === '"') {
          inDoubleQuote = true;
          continue;
        }
        if (char === "'") {
          inSingleQuote = true;
          continue;
        }
        if (char === '`') {
          inTemplateLiteral = true;
          continue;
        }

        if (char === '{') {
          braceCount++;
          hasOpened = true;
        } else if (char === '}') {
          braceCount--;
        }

        if (hasOpened && braceCount === 0) {
          stopIndex = j;
          break;
        }
      }

      inLineComment = false; // Reset line comment at newline

      if (stopIndex !== -1) {
        break;
      }
    }

    return {
      exit_code: 0,
      stdout: `File: ${foundFile}\nLine: ${foundLineIndex + 1}\nKind: ${foundKind}\n\n${definitionLines.join('\n')}`,
      stderr: '',
    };
  } catch (error: any) {
    return {
      exit_code: 1,
      stdout: '',
      stderr: error.message || String(error),
    };
  }
}

/** Reference locator for find_code_references. */
export async function handleFindCodeReferences(
  symbolName: string,
  approvedReadRoots?: string[],
  maxMatches = 100,
): Promise<ToolResult> {
  const projectRoot = process.env['BABEL_PROJECT_ROOT'] ?? process.cwd();
  const files = getFilesRecursive(projectRoot, approvedReadRoots);
  const refRegex = new RegExp(`\\b${symbolName}\\b`);
  const matches: Array<{ file: string; line: number; content: string }> = [];

  for (const file of files) {
    const ext = extname(file).slice(1).toLowerCase();
    const rules = RULES_BY_EXT[ext] || [];
    try {
      const content = readFileSync(file, 'utf-8');
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (refRegex.test(line)) {
          // Check if this line is actually the definition itself
          let isDef = false;
          for (const rule of rules) {
            const match = line.match(rule.pattern);
            if (match && match[1] === symbolName) {
              isDef = true;
              break;
            }
          }
          if (!isDef) {
            matches.push({
              file: file.replace(projectRoot + sep, ''),
              line: i + 1,
              content: line.trim(),
            });
            if (matches.length >= maxMatches) {
              break;
            }
          }
        }
      }
    } catch {
      // skip unreadable files
    }
    if (matches.length >= maxMatches) {
      break;
    }
  }

  const output = matches
    .map((m) => `${m.file}:${m.line}: ${m.content}`)
    .join('\n');

  return {
    exit_code: 0,
    stdout: output.length > 0 ? output : `No references to "${symbolName}" found in workspace.`,
    stderr: '',
  };
}

let parsedCatalogCache: any[] | null = null;

/** Skill manifest loader with in-memory YAML parse cache. */
export async function handleLoadSkillManifest(
  skillId: string,
  babelRoot: string,
): Promise<ToolResult> {
  const catalogPath = join(babelRoot, 'prompt_catalog.yaml');
  if (!existsSync(catalogPath)) {
    return {
      exit_code: 1,
      stdout: '',
      stderr: `Error: prompt_catalog.yaml not found at ${catalogPath}`,
    };
  }

  try {
    if (!parsedCatalogCache) {
      parsedCatalogCache = parseCatalog(catalogPath);
    }

    const entry = parsedCatalogCache.find((e) => e.id === skillId);
    if (!entry) {
      return {
        exit_code: 1,
        stdout: '',
        stderr: `Error: Skill ID "${skillId}" not found in prompt_catalog.yaml`,
      };
    }

    if (!entry.path) {
      return {
        exit_code: 1,
        stdout: '',
        stderr: `Error: Skill "${skillId}" has no file path defined in catalog.`,
      };
    }

    const absSkillPath = resolve(babelRoot, entry.path);
    if (!existsSync(absSkillPath)) {
      return {
        exit_code: 1,
        stdout: '',
        stderr: `Error: Skill manifest file not found at ${absSkillPath}`,
      };
    }

    const manifestContent = readFileSync(absSkillPath, 'utf-8');
    return {
      exit_code: 0,
      stdout: manifestContent,
      stderr: '',
    };
  } catch (error: any) {
    return {
      exit_code: 1,
      stdout: '',
      stderr: error.message || String(error),
    };
  }
}
