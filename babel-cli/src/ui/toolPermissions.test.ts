/**
 * toolPermissions.test.ts — Tests for per-tool permission renderers and registry.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ToolPermissionRegistry,
  getPermissionSeverity,
  hasDestructivePattern,
  createBashPermissionRenderer,
  createFileReadPermissionRenderer,
  createFileWritePermissionRenderer,
  createFilePatchPermissionRenderer,
  createWebFetchPermissionRenderer,
  createWebSearchPermissionRenderer,
  createGenericPermissionRenderer,
  defaultPermissionRegistry,
} from './toolPermissions.js';
import type {
  ToolPermissionContext,
  ToolPermissionRenderer,
  PermissionSeverity,
} from './toolPermissions.js';

// ── Utilities ──────────────────────────────────────────────────────────────────

const EMPTY_INPUT: Record<string, unknown> = {};

function makeContext(
  toolName: string,
  toolInput: Record<string, unknown> = EMPTY_INPUT,
  toolDisplayName?: string,
): ToolPermissionContext {
  return {
    toolName,
    toolInput,
    toolDisplayName: toolDisplayName ?? toolName,
  };
}

/** Strip ANSI codes from a string for assertion purposes. */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Registry
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('ToolPermissionRegistry', () => {
  test('register and get a renderer', () => {
    const registry = new ToolPermissionRegistry();
    const renderer: ToolPermissionRenderer = {
      toolName: 'test_tool',
      severity: 'normal',
      render() {
        return 'rendered';
      },
      renderConfirmationPrompt() {
        return 'proceed?';
      },
    };

    registry.register(renderer);
    assert.equal(registry.get('test_tool'), renderer);
  });

  test('has returns true for registered tools', () => {
    const registry = new ToolPermissionRegistry();
    const renderer: ToolPermissionRenderer = {
      toolName: 'my_tool',
      severity: 'safe',
      render() {
        return '';
      },
      renderConfirmationPrompt() {
        return '';
      },
    };
    registry.register(renderer);
    assert.ok(registry.has('my_tool'));
    assert.equal(registry.has('unknown_tool'), false);
  });

  test('get returns undefined for unregistered tool without fallback', () => {
    const registry = new ToolPermissionRegistry();
    assert.equal(registry.get('nonexistent'), undefined);
  });

  test('generic fallback is returned for unregistered tools', () => {
    const registry = new ToolPermissionRegistry();
    const generic = createGenericPermissionRenderer();
    const dedicated = createBashPermissionRenderer();

    registry.register(dedicated);
    registry.register(generic);

    // Dedicated tool returns its own renderer
    assert.equal(registry.get('run_command'), dedicated);

    // Unregistered tool falls back to generic
    assert.equal(registry.get('unknown_tool'), generic);
  });

  test('getRegisteredTools returns only dedicated tool names', () => {
    const registry = new ToolPermissionRegistry();
    registry.register(createBashPermissionRenderer());
    registry.register(createFileReadPermissionRenderer());
    registry.register(createGenericPermissionRenderer());

    const tools = registry.getRegisteredTools();
    assert.ok(tools.includes('run_command'));
    assert.ok(tools.includes('read_file'));
    // Generic fallback ('*') should not appear
    assert.equal(tools.includes('*'), false);
  });

  test('register overwrites existing renderer for same tool', () => {
    const registry = new ToolPermissionRegistry();

    const first: ToolPermissionRenderer = {
      toolName: 'dup',
      severity: 'safe',
      render() {
        return 'first';
      },
      renderConfirmationPrompt() {
        return '';
      },
    };

    const second: ToolPermissionRenderer = {
      toolName: 'dup',
      severity: 'dangerous',
      render() {
        return 'second';
      },
      renderConfirmationPrompt() {
        return 'confirm?';
      },
    };

    registry.register(first);
    registry.register(second);

    // Second overwrites first
    const retrieved = registry.get('dup');
    assert.equal(retrieved?.severity, 'dangerous');
    assert.equal(stripAnsi(retrieved!.render(makeContext('dup'))), 'second');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Severity classification
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('getPermissionSeverity', () => {
  test('classifies read-only tools as safe', () => {
    const safeTools = ['read_file', 'list_dir', 'list_files', 'grep', 'glob', 'search', 'semantic_search', 'git_context', 'mcp_tool_search'];
    for (const tool of safeTools) {
      assert.equal(
        getPermissionSeverity(tool, {}),
        'safe',
        `expected "${tool}" to be safe`,
      );
    }
  });

  test('classifies delete tools as dangerous', () => {
    assert.equal(getPermissionSeverity('delete_file', {}), 'dangerous');
    assert.equal(getPermissionSeverity('delete_files', {}), 'dangerous');
    assert.equal(getPermissionSeverity('delete', {}), 'dangerous');
    assert.equal(getPermissionSeverity('destroy', {}), 'dangerous');
  });

  test('classifies run_command with sudo as dangerous', () => {
    const severity = getPermissionSeverity('run_command', {
      command: 'sudo apt-get install nginx',
    });
    assert.equal(severity, 'dangerous');
  });

  test('classifies run_command with rm as dangerous', () => {
    const severity = getPermissionSeverity('run_command', {
      command: 'rm -rf /tmp/foo',
    });
    assert.equal(severity, 'dangerous');
  });

  test('classifies run_command with chmod as dangerous', () => {
    const severity = getPermissionSeverity('run_command', {
      command: 'chmod 777 script.sh',
    });
    assert.equal(severity, 'dangerous');
  });

  test('classifies run_command with chown as dangerous', () => {
    const severity = getPermissionSeverity('run_command', {
      command: 'chown root:root file.txt',
    });
    assert.equal(severity, 'dangerous');
  });

  test('classifies run_command without destructive patterns as normal', () => {
    const severity = getPermissionSeverity('run_command', {
      command: 'npm test',
    });
    assert.equal(severity, 'normal');
  });

  test('classifies execute_command alias as normal', () => {
    const severity = getPermissionSeverity('execute_command', {
      command: 'ls -la',
    });
    assert.equal(severity, 'normal');
  });

  test('classifies shell_exec alias with destructive as dangerous', () => {
    const severity = getPermissionSeverity('shell_exec', {
      command: 'sudo rm -rf /',
    });
    assert.equal(severity, 'dangerous');
  });

  test('classifies write_file as normal', () => {
    assert.equal(getPermissionSeverity('write_file', { path: 'test.ts', content: '' }), 'normal');
  });

  test('classifies apply_patch as normal', () => {
    assert.equal(getPermissionSeverity('apply_patch', { patch: 'diff' }), 'normal');
  });

  test('classifies web_fetch as normal', () => {
    assert.equal(getPermissionSeverity('web_fetch', { url: 'https://example.com' }), 'normal');
  });

  test('classifies web_search as normal', () => {
    assert.equal(getPermissionSeverity('web_search', { query: 'hello' }), 'normal');
  });

  test('handles empty input gracefully', () => {
    assert.equal(getPermissionSeverity('run_command', {}), 'normal');
  });

  test('is case-insensitive for tool names', () => {
    assert.equal(getPermissionSeverity('READ_FILE', {}), 'safe');
    assert.equal(getPermissionSeverity('Run_Command', { command: 'ls' }), 'normal');
    assert.equal(getPermissionSeverity('DELETE_FILE', {}), 'dangerous');
  });

  test('classifies unknown tool as normal', () => {
    assert.equal(getPermissionSeverity('some_random_tool', {}), 'normal');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// hasDestructivePattern
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('hasDestructivePattern', () => {
  test('detects sudo in command', () => {
    assert.notEqual(hasDestructivePattern('sudo apt update'), null);
  });

  test('detects rm command', () => {
    assert.notEqual(hasDestructivePattern('rm -rf /tmp/build'), null);
  });

  test('detects chmod', () => {
    assert.notEqual(hasDestructivePattern('chmod +x script.sh'), null);
  });

  test('detects chown', () => {
    assert.notEqual(hasDestructivePattern('chown user:group file'), null);
  });

  test('detects dd', () => {
    assert.notEqual(hasDestructivePattern('dd if=/dev/zero of=/dev/sda'), null);
  });

  test('returns null for safe commands', () => {
    assert.equal(hasDestructivePattern('npm install'), null);
    assert.equal(hasDestructivePattern('ls -la'), null);
    assert.equal(hasDestructivePattern('cat file.txt'), null);
    assert.equal(hasDestructivePattern('node server.js'), null);
    assert.equal(hasDestructivePattern(''), null);
  });

  test('detects multiple destructive patterns', () => {
    assert.notEqual(hasDestructivePattern('sudo rm -rf /'), null);
  });

  test('detects mkfs', () => {
    assert.notEqual(hasDestructivePattern('mkfs.ext4 /dev/sdb1'), null);
  });

  test('detects fdisk', () => {
    assert.notEqual(hasDestructivePattern('fdisk /dev/sda'), null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Bash / Shell Command renderer
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('BashPermissionRenderer', () => {
  const renderer = createBashPermissionRenderer();

  test('renders command and metadata', () => {
    const ctx = makeContext('run_command', {
      command: 'node build.js',
    });
    const output = renderer.render(ctx);
    const plain = stripAnsi(output);

    assert.ok(plain.includes('Shell Command'));
    assert.ok(plain.includes('node build.js'));
    assert.ok(plain.includes('Lines:'));
  });

  test('renders working directory when provided', () => {
    const ctx = makeContext('run_command', {
      command: 'npm test',
      cwd: '/var/tmp/project',
    });
    const output = stripAnsi(renderer.render(ctx));

    assert.ok(output.includes('Directory:'));
    assert.ok(output.includes('/var/tmp/project'));
  });

  test('renders destructive pattern warning', () => {
    const ctx = makeContext('run_command', {
      command: 'sudo rm -rf /tmp/data',
    });
    const output = stripAnsi(renderer.render(ctx));

    assert.ok(output.includes('Destructive pattern detected'));
  });

  test('supports cmd alias for command field', () => {
    const ctx = makeContext('run_command', {
      cmd: 'echo hello',
    });
    const output = stripAnsi(renderer.render(ctx));
    assert.ok(output.includes('echo hello'));
  });

  test('multi-line command shows preview section', () => {
    const ctx = makeContext('run_command', {
      command: 'line1\nline2\nline3\nline4\nline5\nline6',
    });
    const output = stripAnsi(renderer.render(ctx));

    assert.ok(output.includes('Preview'));
    assert.ok(output.includes('line1'));
    assert.ok(output.includes('more lines'));
  });

  test('confirmation prompt is normal for safe commands', () => {
    const ctx = makeContext('run_command', {
      command: 'npm install',
    });
    assert.equal(renderer.renderConfirmationPrompt(ctx), 'Allow this shell command? [y/N]: ');
  });

  test('confirmation prompt is dangerous for destructive commands', () => {
    const ctx = makeContext('run_command', {
      command: 'sudo rm -rf /',
    });
    const prompt = stripAnsi(renderer.renderConfirmationPrompt(ctx));
    assert.ok(prompt.includes('Type "yes" to confirm'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// File Read renderer
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('FileReadPermissionRenderer', () => {
  const renderer = createFileReadPermissionRenderer();

  test('renders file path', () => {
    const ctx = makeContext('read_file', { path: '/var/tmp/file.ts' });
    const output = stripAnsi(renderer.render(ctx));

    assert.ok(output.includes('Read File'));
    assert.ok(output.includes('/var/tmp/file.ts'));
  });

  test('supports file alias for path field', () => {
    const ctx = makeContext('read_file', { file: 'src/index.ts' });
    const output = stripAnsi(renderer.render(ctx));
    assert.ok(output.includes('src/index.ts'));
  });

  test('supports filepath alias', () => {
    const ctx = makeContext('read_file', { filepath: 'lib/util.js' });
    const output = stripAnsi(renderer.render(ctx));
    assert.ok(output.includes('lib/util.js'));
  });

  test('renders content size and preview when content is available', () => {
    const ctx = makeContext('read_file', {
      path: 'test.ts',
      content: 'line1\nline2\nline3\nline4\nline5\nline6',
    });
    const output = stripAnsi(renderer.render(ctx));

    assert.ok(output.includes('Size:'));
    assert.ok(output.includes('Lines:'));
    assert.ok(output.includes('Preview'));
    assert.ok(output.includes('line1'));
    assert.ok(output.includes('more lines'));
  });

  test('renders small files without overflow marker', () => {
    const ctx = makeContext('read_file', {
      path: 'tiny.ts',
      content: 'just one line',
    });
    const output = stripAnsi(renderer.render(ctx));

    assert.ok(output.includes('just one line'));
    assert.equal(output.includes('more lines'), false);
  });

  test('empty path renders gracefully', () => {
    const ctx = makeContext('read_file', {});
    const output = stripAnsi(renderer.render(ctx));

    assert.ok(output.includes('Path:'));
    // Should not throw
  });

  test('confirmation prompt is empty (auto-approve)', () => {
    const ctx = makeContext('read_file', { path: 'file.ts' });
    assert.equal(renderer.renderConfirmationPrompt(ctx), '');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// File Write renderer
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('FileWritePermissionRenderer', () => {
  const renderer = createFileWritePermissionRenderer();

  test('renders file path and line count', () => {
    const ctx = makeContext('write_file', {
      path: 'output.ts',
      content: 'const x = 1;\nconst y = 2;',
    });
    const output = stripAnsi(renderer.render(ctx));

    assert.ok(output.includes('Write File'));
    assert.ok(output.includes('output.ts'));
    assert.ok(output.includes('Lines:'));
  });

  test('renders content preview', () => {
    const ctx = makeContext('write_file', {
      path: 'test.ts',
      content: 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8',
    });
    const output = stripAnsi(renderer.render(ctx));

    assert.ok(output.includes('Content Preview'));
    assert.ok(output.includes('line1'));
    assert.ok(output.includes('more lines'));
  });

  test('supports body alias for content field', () => {
    const ctx = makeContext('write_file', {
      path: 'test.ts',
      body: 'from body field',
    });
    const output = stripAnsi(renderer.render(ctx));
    assert.ok(output.includes('from body field'));
  });

  test('empty content renders gracefully', () => {
    const ctx = makeContext('write_file', { path: 'empty.ts', content: '' });
    const output = stripAnsi(renderer.render(ctx));

    assert.ok(output.includes('Lines:'));
    // Should not throw
  });

  test('empty path renders gracefully', () => {
    const ctx = makeContext('write_file', { content: 'data' });
    const output = stripAnsi(renderer.render(ctx));

    assert.ok(output.includes('Write File'));
    assert.ok(output.includes('Lines: 1'));
  });

  test('confirmation prompt is standard', () => {
    const ctx = makeContext('write_file', { path: 'f.ts', content: 'x' });
    assert.equal(renderer.renderConfirmationPrompt(ctx), 'Allow writing this file? [y/N]: ');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// File Patch renderer
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('FilePatchPermissionRenderer', () => {
  const renderer = createFilePatchPermissionRenderer();

  test('renders diff stats', () => {
    const ctx = makeContext('apply_patch', {
      patch: '--- a/file.ts\n+++ b/file.ts\n@@ -1 +1,2 @@\n old line\n+new line\n+another new\n',
    });
    const output = stripAnsi(renderer.render(ctx));

    assert.ok(output.includes('Apply Patch'));
    assert.ok(output.includes('+2') && output.includes('-1'), 'expected +2/-1 diff stats');
  });

  test('renders diff preview with color-coded lines', () => {
    const ctx = makeContext('apply_patch', {
      patch: '--- a/x.ts\n+++ b/x.ts\n@@ -1,3 +1,4 @@\n context\n-removed\n+added\n+added2\n',
    });
    const output = stripAnsi(renderer.render(ctx));

    assert.ok(output.includes('Diff Preview'));
    assert.ok(output.includes('-removed'));
    assert.ok(output.includes('+added'));
    assert.ok(output.includes('context'));
  });

  test('renders large diffs with overflow marker', () => {
    const lines: string[] = ['--- a/x.ts\n+++ b/x.ts'];
    for (let i = 0; i < 10; i++) {
      lines.push(`+line${i}`);
    }
    const ctx = makeContext('apply_patch', { patch: lines.join('\n') });
    const output = stripAnsi(renderer.render(ctx));

    assert.ok(output.includes('more lines'));
  });

  test('empty patch renders gracefully', () => {
    const ctx = makeContext('apply_patch', { patch: '' });
    const output = stripAnsi(renderer.render(ctx));

    assert.ok(output.includes('+0') && output.includes('-0'), 'expected +0/-0 diff stats');
    // Should not throw
  });

  test('confirmation prompt is standard', () => {
    const ctx = makeContext('apply_patch', { patch: 'diff' });
    assert.equal(renderer.renderConfirmationPrompt(ctx), 'Allow applying this patch? [y/N]: ');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Web Fetch renderer
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('WebFetchPermissionRenderer', () => {
  const renderer = createWebFetchPermissionRenderer();

  test('renders URL and domain', () => {
    const ctx = makeContext('web_fetch', {
      url: 'https://api.example.com/data',
    });
    const output = stripAnsi(renderer.render(ctx));

    assert.ok(output.includes('Web Fetch'));
    assert.ok(output.includes('https://api.example.com/data'));
    assert.ok(output.includes('api.example.com'));
  });

  test('supports uri alias', () => {
    const ctx = makeContext('web_fetch', { uri: 'https://example.org' });
    const output = stripAnsi(renderer.render(ctx));
    assert.ok(output.includes('https://example.org'));
  });

  test('handles invalid URL gracefully', () => {
    const ctx = makeContext('web_fetch', { url: 'not-a-valid-url' });
    const output = stripAnsi(renderer.render(ctx));

    assert.ok(output.includes('not-a-valid-url'));
    // Should not include domain line since URL parsing fails
    assert.ok(output.includes('URL:'));
  });

  test('empty URL renders gracefully', () => {
    const ctx = makeContext('web_fetch', {});
    const output = stripAnsi(renderer.render(ctx));

    assert.ok(output.includes('URL:'));
    // Should not throw
  });

  test('confirmation prompt is standard', () => {
    const ctx = makeContext('web_fetch', { url: 'https://example.com' });
    assert.equal(renderer.renderConfirmationPrompt(ctx), 'Allow fetching this URL? [y/N]: ');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Web Search renderer
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('WebSearchPermissionRenderer', () => {
  const renderer = createWebSearchPermissionRenderer();

  test('renders search query', () => {
    const ctx = makeContext('web_search', {
      query: 'how to use TypeScript',
    });
    const output = stripAnsi(renderer.render(ctx));

    assert.ok(output.includes('Web Search'));
    assert.ok(output.includes('how to use TypeScript'));
  });

  test('supports q alias for query', () => {
    const ctx = makeContext('web_search', { q: 'typescript generics' });
    const output = stripAnsi(renderer.render(ctx));
    assert.ok(output.includes('typescript generics'));
  });

  test('supports text alias for query', () => {
    const ctx = makeContext('web_search', { text: 'node.js async' });
    const output = stripAnsi(renderer.render(ctx));
    assert.ok(output.includes('node.js async'));
  });

  test('empty query renders gracefully', () => {
    const ctx = makeContext('web_search', {});
    const output = stripAnsi(renderer.render(ctx));

    assert.ok(output.includes('Query:'));
  });

  test('confirmation prompt is standard', () => {
    const ctx = makeContext('web_search', { query: 'test' });
    assert.equal(renderer.renderConfirmationPrompt(ctx), 'Allow this web search? [y/N]: ');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Generic renderer
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('GenericPermissionRenderer', () => {
  const renderer = createGenericPermissionRenderer();

  test('renders tool name and input JSON', () => {
    const ctx = makeContext('custom_tool', { key: 'value', num: 42 }, 'Custom Tool');
    const output = stripAnsi(renderer.render(ctx));

    assert.ok(output.includes('Tool Call'));
    assert.ok(output.includes('Custom Tool'));
    assert.ok(output.includes('"key"'));
    assert.ok(output.includes('"value"'));
    assert.ok(output.includes('"num"'));
  });

  test('renders complex nested input', () => {
    const ctx = makeContext('complex_tool', {
      items: [{ id: 1 }, { id: 2 }],
      enabled: true,
    }, 'Complex Tool');
    const output = stripAnsi(renderer.render(ctx));

    assert.ok(output.includes('items'));
    assert.ok(output.includes('enabled'));
    assert.ok(output.includes('true'));
  });

  test('renders empty input gracefully', () => {
    const ctx = makeContext('empty_tool', {}, 'Empty Tool');
    const output = stripAnsi(renderer.render(ctx));

    assert.ok(output.includes('Empty Tool'));
    assert.ok(output.includes('{}'));
  });

  test('confirmation prompt is generic', () => {
    const ctx = makeContext('unknown', { foo: 'bar' }, 'Unknown');
    assert.equal(renderer.renderConfirmationPrompt(ctx), 'Allow this tool call? [y/N]: ');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Default registry integration
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('defaultPermissionRegistry', () => {
  test('includes all built-in renderers', () => {
    const tools = [
      'run_command',
      'read_file',
      'write_file',
      'apply_patch',
      'web_fetch',
      'web_search',
    ];
    for (const tool of tools) {
      assert.ok(
        defaultPermissionRegistry.has(tool),
        `expected default registry to have "${tool}"`,
      );
    }
  });

  test('includes generic fallback for unregistered tools', () => {
    const renderer = defaultPermissionRegistry.get('unknown_tool_123');
    assert.notEqual(renderer, undefined);
    assert.equal(renderer!.toolName, '*');
  });

  test('each built-in renderer produces valid output', () => {
    const registry = defaultPermissionRegistry;

    const testCases: Array<{ tool: string; input: Record<string, unknown> }> = [
      { tool: 'run_command', input: { command: 'npm install' } },
      { tool: 'read_file', input: { path: 'file.ts', content: 'abc' } },
      { tool: 'write_file', input: { path: 'out.ts', content: 'line1\nline2' } },
      { tool: 'apply_patch', input: { patch: '+new\n-old' } },
      { tool: 'web_fetch', input: { url: 'https://example.com' } },
      { tool: 'web_search', input: { query: 'hello world' } },
    ];

    for (const { tool, input } of testCases) {
      const renderer = registry.get(tool);
      const ctx = makeContext(tool, input);
      const output = renderer!.render(ctx);
      const prompt = renderer!.renderConfirmationPrompt(ctx);

      // Output should not be empty
      assert.ok(stripAnsi(output).length > 0, `expected non-empty output for "${tool}"`);
      // Prompt should be a string (empty for safe, text for normal/dangerous)
      assert.equal(typeof prompt, 'string', `expected prompt to be a string for "${tool}"`);
    }
  });

  test('generic fallback handles any tool gracefully', () => {
    const renderer = defaultPermissionRegistry.get('some_random_api_call');
    assert.notEqual(renderer, undefined);

    const ctx = makeContext('some_random_api_call', { param1: 'value1' }, 'Random API Call');
    const output = stripAnsi(renderer!.render(ctx));

    assert.ok(output.includes('Random API Call'));
    assert.ok(output.includes('param1'));
    assert.ok(output.includes('value1'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Edge cases
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('Edge cases', () => {
  test('getPermissionSeverity is case-insensitive', () => {
    assert.equal(getPermissionSeverity('READ_FILE', {}), 'safe');
    assert.equal(getPermissionSeverity('Read_File', {}), 'safe');
    assert.equal(getPermissionSeverity('RUN_COMMAND', { command: 'ls' }), 'normal');
    assert.equal(getPermissionSeverity('DELETE_FILE', {}), 'dangerous');
  });

  test('renderer render method does not throw for empty input', () => {
    const renderers = [
      createBashPermissionRenderer(),
      createFileReadPermissionRenderer(),
      createFileWritePermissionRenderer(),
      createFilePatchPermissionRenderer(),
      createWebFetchPermissionRenderer(),
      createWebSearchPermissionRenderer(),
      createGenericPermissionRenderer(),
    ];

    for (const renderer of renderers) {
      const ctx = makeContext(renderer.toolName, {});
      assert.doesNotThrow(() => {
        renderer.render(ctx);
      }, `renderer "${renderer.toolName}" threw on empty input`);
    }
  });

  test('renderer renderConfirmationPrompt does not throw for empty input', () => {
    const renderers = [
      createBashPermissionRenderer(),
      createFileReadPermissionRenderer(),
      createFileWritePermissionRenderer(),
      createFilePatchPermissionRenderer(),
      createWebFetchPermissionRenderer(),
      createWebSearchPermissionRenderer(),
      createGenericPermissionRenderer(),
    ];

    for (const renderer of renderers) {
      const ctx = makeContext(renderer.toolName, {});
      assert.doesNotThrow(() => {
        renderer.renderConfirmationPrompt(ctx);
      }, `renderer "${renderer.toolName}" threw on empty input prompt`);
    }
  });

  test('all built-in renderers have correct toolName', () => {
    const renderers: ToolPermissionRenderer[] = [
      createBashPermissionRenderer(),
      createFileReadPermissionRenderer(),
      createFileWritePermissionRenderer(),
      createFilePatchPermissionRenderer(),
      createWebFetchPermissionRenderer(),
      createWebSearchPermissionRenderer(),
      createGenericPermissionRenderer(),
    ];

    const expectedNames = ['run_command', 'read_file', 'write_file', 'apply_patch', 'web_fetch', 'web_search', '*'];
    for (let i = 0; i < renderers.length; i++) {
      assert.equal(renderers[i]!.toolName, expectedNames[i]);
    }
  });
});
