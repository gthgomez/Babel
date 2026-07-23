/**
 * LSP Client Tests — mock LSP server with Content-Length framed JSON-RPC 2.0.
 */
import assert from 'node:assert/strict';
import { describe, test, afterEach } from 'node:test';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLspClient } from './client.js';

describe('LSP Client', () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
      tempDir = null;
    }
  });

  /**
   * Create a temporary mock LSP server script.
   * The script speaks Content-Length framed JSON-RPC 2.0 over stdio.
   */
  function createMockScript(): string {
    tempDir = mkdtempSync(join(tmpdir(), 'lsp-test-'));
    const scriptPath = join(tempDir, 'mock-server.mjs');

    const scriptContent = `
import { stdin, stdout } from 'node:process';

let buffer = '';
let initialized = false;

function writeMessage(msg) {
  const body = JSON.stringify(msg);
  const header = 'Content-Length: ' + Buffer.byteLength(body, 'utf8') + '\\r\\n\\r\\n';
  stdout.write(header + body);
}

stdin.on('data', (chunk) => {
  buffer += chunk.toString();

  while (true) {
    const headerEnd = buffer.indexOf('\\r\\n\\r\\n');
    if (headerEnd === -1) break;

    const headerLine = buffer.substring(0, headerEnd);
    const match = headerLine.match(/Content-Length:\\s*(\\d+)/i);
    if (!match) break;

    const contentLength = parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + contentLength;
    if (buffer.length < bodyEnd) break;

    const body = buffer.substring(bodyStart, bodyEnd);
    buffer = buffer.substring(bodyEnd);

    try {
      const msg = JSON.parse(body);

      if (msg.method === 'initialize') {
        initialized = true;
        writeMessage({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            capabilities: {
              textDocumentSync: 1,
              hoverProvider: true,
              definitionProvider: true,
              referencesProvider: true,
              documentSymbolProvider: true,
              workspaceSymbolProvider: true,
            },
            serverInfo: { name: 'mock-lsp', version: '1.0.0' },
          },
        });
      } else if (msg.method === 'initialized') {
        // no response needed
      } else if (msg.method === 'shutdown') {
        writeMessage({ jsonrpc: '2.0', id: msg.id, result: null });
      } else if (msg.method === 'exit') {
        stdin.removeAllListeners('data');
        process.exit(0);
      } else if (msg.method === 'textDocument/didOpen') {
        // no response needed
      } else if (msg.method === 'textDocument/didClose') {
        // no response needed
      } else if (msg.method === 'textDocument/definition') {
        writeMessage({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            uri: msg.params.textDocument.uri,
            range: { start: { line: 10, character: 5 }, end: { line: 10, character: 20 } },
          },
        });
      } else if (msg.method === 'textDocument/hover') {
        writeMessage({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            contents: {
              kind: 'markdown',
              value: 'mock hover content',
            },
          },
        });
      } else if (msg.method === 'textDocument/references') {
        writeMessage({
          jsonrpc: '2.0',
          id: msg.id,
          result: [
            {
              uri: msg.params.textDocument.uri,
              range: { start: { line: 10, character: 5 }, end: { line: 10, character: 20 } },
            },
            {
              uri: msg.params.textDocument.uri.replace('test.ts', 'other.ts'),
              range: { start: { line: 42, character: 10 }, end: { line: 42, character: 25 } },
            },
          ],
        });
      } else if (msg.method === 'textDocument/documentSymbol') {
        writeMessage({
          jsonrpc: '2.0',
          id: msg.id,
          result: [
            {
              name: 'foo',
              kind: 12,
              range: { start: { line: 0, character: 0 }, end: { line: 5, character: 1 } },
              selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
            },
          ],
        });
      } else if (msg.method === 'workspace/symbol') {
        writeMessage({
          jsonrpc: '2.0',
          id: msg.id,
          result: [
            {
              name: 'foo',
              kind: 12,
              location: {
                uri: 'file:///project/src/index.ts',
                range: { start: { line: 0, character: 0 }, end: { line: 5, character: 1 } },
              },
              containerName: 'ModuleA',
            },
          ],
        });
      } else {
        writeMessage({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: 'Method not found: ' + msg.method },
        });
      }
    } catch (e) {
      writeMessage({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
    }
  }
});

stdin.on('end', () => {
  process.exit(0);
});
`;

    writeFileSync(scriptPath, scriptContent, 'utf-8');
    return scriptPath;
  }

  test('start and initialize successfully', async () => {
    const scriptPath = createMockScript();
    const client = createLspClient('mock-test');

    await client.start(process.execPath, [scriptPath]);

    const result = await client.initialize({
      processId: process.pid,
      rootUri: 'file:///project',
      capabilities: {},
    });

    assert.ok(client.isInitialized, 'Client should be initialized');
    assert.ok(result.capabilities, 'Should have capabilities');
    assert.equal(result.serverInfo?.name, 'mock-lsp');
    assert.ok(result.capabilities.hoverProvider);
    assert.ok(result.capabilities.definitionProvider);
    assert.ok(result.capabilities.referencesProvider);

    await client.stop();
  });

  test('send hover request and receive response', async () => {
    const scriptPath = createMockScript();
    const client = createLspClient('mock-hover');

    await client.start(process.execPath, [scriptPath]);
    await client.initialize({
      processId: process.pid,
      rootUri: 'file:///project',
      capabilities: {},
    });

    const result = await client.sendRequest<{ contents: { kind: string; value: string } }>(
      'textDocument/hover',
      {
        textDocument: { uri: 'file:///project/src/test.ts' },
        position: { line: 10, character: 5 },
      },
    );

    assert.ok(result.contents);
    assert.equal(result.contents.value, 'mock hover content');

    await client.stop();
  });

  test('send textDocument/didOpen notification', async () => {
    const scriptPath = createMockScript();
    const client = createLspClient('mock-didopen');

    await client.start(process.execPath, [scriptPath]);
    await client.initialize({
      processId: process.pid,
      rootUri: 'file:///project',
      capabilities: {},
    });

    // didOpen is a notification — should not throw
    await client.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri: 'file:///project/src/test.ts',
        languageId: 'typescript',
        version: 1,
        text: 'export function foo(): string { return "hello"; }',
      },
    });

    // After didOpen we can make requests
    const result = await client.sendRequest<{ uri: string }>(
      'textDocument/definition',
      {
        textDocument: { uri: 'file:///project/src/test.ts' },
        position: { line: 0, character: 16 },
      },
    );

    assert.ok(result.uri);
    assert.ok(result.uri.includes('test.ts'));

    await client.stop();
  });

  test('shutdown stops the server gracefully', async () => {
    const scriptPath = createMockScript();
    const client = createLspClient('mock-shutdown');

    await client.start(process.execPath, [scriptPath]);
    await client.initialize({
      processId: process.pid,
      rootUri: 'file:///project',
      capabilities: {},
    });

    // Should not throw
    await client.stop();

    assert.equal(client.isInitialized, false);
  });

  test('sendRequest throws when client is not initialized', async () => {
    const scriptPath = createMockScript();
    const client = createLspClient('mock-not-init');

    await client.start(process.execPath, [scriptPath]);

    await assert.rejects(
      async () => {
        await client.sendRequest('textDocument/definition', {});
      },
      { message: /not initialized/i },
    );

    await client.stop();
  });
});
