import assert from 'node:assert/strict';
import test from 'node:test';
import { readLangfuseConfig } from './langfuseExporter.js';

test('readLangfuseConfig returns null when keys are missing', () => {
  const config = readLangfuseConfig();
  // In test environment, keys are typically not set
  assert.equal(config, null);
});

test('readLangfuseConfig reads host from env', () => {
  process.env['LANGFUSE_PUBLIC_KEY'] = 'pk-test';
  process.env['LANGFUSE_SECRET_KEY'] = 'sk-test';
  try {
    const config = readLangfuseConfig();
    assert.notEqual(config, null);
    assert.equal(config!.host, 'http://localhost:3000');
  } finally {
    delete process.env['LANGFUSE_PUBLIC_KEY'];
    delete process.env['LANGFUSE_SECRET_KEY'];
  }
});

test('readLangfuseConfig respects custom host', () => {
  process.env['LANGFUSE_HOST'] = 'https://cloud.langfuse.com';
  process.env['LANGFUSE_PUBLIC_KEY'] = 'pk-test';
  process.env['LANGFUSE_SECRET_KEY'] = 'sk-test';
  try {
    const config = readLangfuseConfig();
    assert.notEqual(config, null);
    assert.equal(config!.host, 'https://cloud.langfuse.com');
  } finally {
    delete process.env['LANGFUSE_HOST'];
    delete process.env['LANGFUSE_PUBLIC_KEY'];
    delete process.env['LANGFUSE_SECRET_KEY'];
  }
});
