import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export const PROJECT_TEMPLATE_NAMES = ['node-cli', 'python-cli', 'vite-react'] as const;

export type ProjectTemplateName = (typeof PROJECT_TEMPLATE_NAMES)[number];

export interface ScaffoldFile {
  path: string;
  content: string;
}

export interface ScaffoldResult {
  status: 'created';
  template: ProjectTemplateName;
  target_root: string;
  files_written: string[];
  next_commands: string[];
}

export function normalizeProjectTemplate(
  value: string | null | undefined,
): ProjectTemplateName | null {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  return (PROJECT_TEMPLATE_NAMES as readonly string[]).includes(normalized)
    ? (normalized as ProjectTemplateName)
    : null;
}

export function listProjectTemplates(): ProjectTemplateName[] {
  return [...PROJECT_TEMPLATE_NAMES];
}

function packageNameFromTarget(targetRoot: string): string {
  return (
    basename(targetRoot)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'babel-project'
  );
}

function pythonPackageName(targetRoot: string): string {
  return packageNameFromTarget(targetRoot).replace(/-/g, '_');
}

function nodeCliFiles(targetRoot: string): { files: ScaffoldFile[]; nextCommands: string[] } {
  const name = packageNameFromTarget(targetRoot);
  return {
    nextCommands: ['npm install', 'npm test', 'npm start -- --name Babel'],
    files: [
      {
        path: 'package.json',
        content: `${JSON.stringify(
          {
            name,
            version: '0.1.0',
            type: 'module',
            private: true,
            scripts: {
              start: 'node src/index.js',
              test: 'node --test',
            },
          },
          null,
          2,
        )}\n`,
      },
      {
        path: 'src/index.js',
        content: `import { pathToFileURL } from 'node:url';\n\nexport function greet(name = 'world') {\n  return \`Hello, \${name}.\`;\n}\n\nif (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {\n  const nameIndex = process.argv.indexOf('--name');\n  const name = nameIndex >= 0 ? process.argv[nameIndex + 1] : undefined;\n  console.log(greet(name));\n}\n`,
      },
      {
        path: 'test/smoke.test.js',
        content: `import assert from 'node:assert/strict';\nimport test from 'node:test';\n\nimport { greet } from '../src/index.js';\n\ntest('greet returns a friendly message', () => {\n  assert.equal(greet('Babel'), 'Hello, Babel.');\n});\n`,
      },
      {
        path: 'README.md',
        content: `# ${name}\n\nSmall Node.js CLI scaffold created by Babel.\n\n## Commands\n\n\`\`\`bash\nnpm install\nnpm test\nnpm start -- --name Babel\n\`\`\`\n`,
      },
      {
        path: '.gitignore',
        content: `node_modules/\ndist/\n.env\n`,
      },
    ],
  };
}

function pythonCliFiles(targetRoot: string): { files: ScaffoldFile[]; nextCommands: string[] } {
  const name = packageNameFromTarget(targetRoot);
  const packageName = pythonPackageName(targetRoot);
  return {
    nextCommands: ['python -m pip install -e .', 'pytest', `${name} --name Babel`],
    files: [
      {
        path: 'pyproject.toml',
        content: `[project]\nname = "${name}"\nversion = "0.1.0"\ndescription = "Small Python CLI scaffold created by Babel."\nrequires-python = ">=3.11"\n\n[project.scripts]\n${name} = "${packageName}.cli:main"\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n`,
      },
      {
        path: `src/${packageName}/__init__.py`,
        content: `from .cli import greet\n\n__all__ = ["greet"]\n`,
      },
      {
        path: `src/${packageName}/cli.py`,
        content: `import argparse\n\n\ndef greet(name: str = "world") -> str:\n    return f"Hello, {name}."\n\n\ndef main() -> None:\n    parser = argparse.ArgumentParser()\n    parser.add_argument("--name", default="world")\n    args = parser.parse_args()\n    print(greet(args.name))\n`,
      },
      {
        path: 'tests/test_cli.py',
        content: `from ${packageName}.cli import greet\n\n\ndef test_greet() -> None:\n    assert greet("Babel") == "Hello, Babel."\n`,
      },
      {
        path: 'README.md',
        content: `# ${name}\n\nSmall Python CLI scaffold created by Babel.\n\n## Commands\n\n\`\`\`bash\npython -m pip install -e .\npytest\n${name} --name Babel\n\`\`\`\n`,
      },
      {
        path: '.gitignore',
        content: `__pycache__/\n.pytest_cache/\n.venv/\n.env\n`,
      },
    ],
  };
}

function viteReactFiles(targetRoot: string): { files: ScaffoldFile[]; nextCommands: string[] } {
  const name = packageNameFromTarget(targetRoot);
  return {
    nextCommands: ['npm install', 'npm run build', 'npm run dev'],
    files: [
      {
        path: 'package.json',
        content: `${JSON.stringify(
          {
            name,
            version: '0.1.0',
            private: true,
            type: 'module',
            scripts: {
              dev: 'vite',
              build: 'vite build',
              preview: 'vite preview',
            },
            dependencies: {
              '@vitejs/plugin-react': '^5.0.0',
              vite: '^7.0.0',
              react: '^19.0.0',
              'react-dom': '^19.0.0',
            },
            devDependencies: {},
          },
          null,
          2,
        )}\n`,
      },
      {
        path: 'index.html',
        content: `<div id="root"></div>\n<script type="module" src="/src/main.jsx"></script>\n`,
      },
      {
        path: 'src/main.jsx',
        content: `import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport './styles.css';\n\nfunction App() {\n  return (\n    <main className="app-shell">\n      <section className="workspace-panel">\n        <p className="eyebrow">Babel scaffold</p>\n        <h1>${name}</h1>\n        <p>Ready for real product work.</p>\n      </section>\n    </main>\n  );\n}\n\ncreateRoot(document.getElementById('root')).render(<App />);\n`,
      },
      {
        path: 'src/styles.css',
        content: `:root {\n  color: #172026;\n  background: #f7f8fb;\n  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;\n}\n\nbody {\n  margin: 0;\n}\n\n.app-shell {\n  min-height: 100vh;\n  display: grid;\n  place-items: center;\n  padding: 32px;\n}\n\n.workspace-panel {\n  width: min(640px, 100%);\n  border: 1px solid #d8dee8;\n  border-radius: 8px;\n  background: #ffffff;\n  padding: 32px;\n}\n\n.eyebrow {\n  margin: 0 0 12px;\n  color: #4b6b88;\n  font-size: 0.8rem;\n  font-weight: 700;\n  text-transform: uppercase;\n}\n\nh1 {\n  margin: 0 0 12px;\n  font-size: clamp(2rem, 4vw, 3.5rem);\n}\n\np {\n  margin: 0;\n  line-height: 1.6;\n}\n`,
      },
      {
        path: 'README.md',
        content: `# ${name}\n\nSmall Vite React scaffold created by Babel.\n\n## Commands\n\n\`\`\`bash\nnpm install\nnpm run build\nnpm run dev\n\`\`\`\n`,
      },
      {
        path: '.gitignore',
        content: `node_modules/\ndist/\n.env\n`,
      },
    ],
  };
}

function getTemplateFiles(
  template: ProjectTemplateName,
  targetRoot: string,
): { files: ScaffoldFile[]; nextCommands: string[] } {
  if (template === 'node-cli') return nodeCliFiles(targetRoot);
  if (template === 'python-cli') return pythonCliFiles(targetRoot);
  return viteReactFiles(targetRoot);
}

export function scaffoldProject(options: {
  template: ProjectTemplateName;
  targetRoot: string;
  force?: boolean;
}): ScaffoldResult {
  const targetRoot = resolve(options.targetRoot);
  const force = options.force === true;
  const { files, nextCommands } = getTemplateFiles(options.template, targetRoot);

  if (existsSync(targetRoot) && readdirSync(targetRoot).length > 0 && !force) {
    throw new Error(
      `Target directory is not empty: ${targetRoot}. Use --force to overwrite scaffold files.`,
    );
  }

  mkdirSync(targetRoot, { recursive: true });

  const filesWritten: string[] = [];
  for (const file of files) {
    const fullPath = join(targetRoot, file.path);
    if (existsSync(fullPath) && !force) {
      throw new Error(
        `Refusing to overwrite existing file: ${fullPath}. Use --force to overwrite scaffold files.`,
      );
    }
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, file.content, 'utf-8');
    filesWritten.push(fullPath);
  }

  return {
    status: 'created',
    template: options.template,
    target_root: targetRoot,
    files_written: filesWritten,
    next_commands: nextCommands,
  };
}
