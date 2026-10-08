import test from 'node:test'
import assert from 'node:assert/strict'

test('consumer environment strips provider prefixes, preloads and credential configuration', async () => {
  const { consumerEnvironment } = await import('../../babel-cli/scripts/consumer_environment.mjs')
  const canary = 'fixture-inherited-sentinel'
  const inherited = Object.fromEntries(['BABEL_PROVIDER', 'OPENCODE_CONFIG', 'babel_config_dir',
    'OPENAI_API_KEY', 'MY_TOKEN_PATH', 'GOOGLE_APPLICATION_CREDENTIALS', 'NODE_OPTIONS', 'NODE_PATH', 'npm_config_userconfig',
    'NPM_CONFIG_REGISTRY', 'BABEL_ROOT', 'APPDATA', 'LOCALAPPDATA', 'home', 'userprofile',
    'xdg_config_home', 'temp', 'tmp', 'OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL', 'OLLAMA_HOST'].map(key => [key, canary]))
  inherited.PATH = 'fixture-system-path'
  const env = consumerEnvironment(inherited, '/private-fixture')
  assert.equal(env.PATH, inherited.PATH)
  assert.ok(!Object.values(env).includes(canary))
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'BABEL_CONFIG_DIR', 'BABEL_CACHE_DIR', 'BABEL_STATE_DIR',
    'XDG_CONFIG_HOME', 'npm_config_cache', 'npm_config_userconfig']) assert.ok(env[key].replaceAll('\\', '/').startsWith('/private-fixture/'), key)
})
