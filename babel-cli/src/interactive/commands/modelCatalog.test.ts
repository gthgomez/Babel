import test from 'node:test';
import assert from 'node:assert/strict';
import { formatModelCatalog, formatModelPricing } from './modelCatalog.js';
import { stripAnsi } from '../../ui/theme.js';
import { measureDisplayWidth } from '../../ui/textLayout.js';

test('catalog labels active identity, provider, credential prerequisite and both prices', () => {
  const entry = { provider: 'openrouter', model_id: 'fixture/model', tier: 'cheap' as const,
    estimated_cost_per_1m_input: 0, estimated_cost_per_1m_output: 0.25,
    selection_reason: 'Caller-owned durable budget and campaign internals should stay in details.' };
  const text = stripAnsi(formatModelCatalog([{ key: 'fixture-model', entry }], { activeKey: 'fixture-model', width: 60, env: {} }));
  assert.match(text, /fixture-model \(active\)/);
  assert.match(text, /openrouter/);
  assert.match(text, /requires OPENROUTER_API_KEY/);
  assert.match(text, /Input \$0\/M.*Output \$0.25\/M/);
  assert.doesNotMatch(text, /durable budget|campaign internals/);
  const normalizedText = text.replace(/\s+/g, ' ');
  assert.match(normalizedText, /OpenRouter may route across endpoints with different prices/);
  assert.match(normalizedText, /not a billing guarantee/);
  const { estimated_cost_per_1m_output: _output, ...unknown } = entry;
  assert.match(formatModelPricing(unknown), /Output unknown/);
  for (const line of text.split('\n').filter((s) => s.startsWith('    '))) assert.ok(measureDisplayWidth(line) < 60);
});
