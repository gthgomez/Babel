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

test('consumer environment rejects ambient SDK and unknown config while preserving mixed-case runtime keys', async () => {
  const { consumerEnvironment } = await import('../../babel-cli/scripts/consumer_environment.mjs')
  const windows = process.platform === 'win32'
  const inherited = {
    AWS_ACCESS_KEY_ID: 'synthetic-aws-access-id-canary',
    AWS_CONFIG_FILE: 'synthetic-aws-config-path',
    AWS_PROFILE: 'synthetic-aws-profile',
    AZURE_CONFIG_DIR: 'synthetic-azure-config-path',
    CLOUDSDK_CONFIG: 'synthetic-cloudsdk-config-path',
    SSH_AUTH_SOCK: 'synthetic-ssh-agent-socket',
    CUSTOM_PROVIDER_CONFIG: 'synthetic-unknown-provider-config',
    [windows ? 'pAtH' : 'PATH']: 'fixture-path',
    [windows ? 'pAtHeXt' : 'PATHEXT']: '.COM;.EXE',
    [windows ? 'cOmSpEc' : 'ComSpec']: 'C:\\fixture\\cmd.exe',
    [windows ? 'sYsTeMrOoT' : 'SystemRoot']: 'C:\\fixture\\windows',
    [windows ? 'wInDiR' : 'WINDIR']: 'C:\\fixture\\windows',
    [windows ? 'lAnG' : 'LANG']: 'fixture-locale',
    [windows ? 'lC_cTyPe' : 'LC_CTYPE']: 'fixture-locale-type',
    [windows ? 'pRoCeSsOr_ArChItEcTuRe' : 'PROCESSOR_ARCHITECTURE']: 'fixture-architecture',
    [windows ? 'nUmBeR_oF_pRoCeSsOrS' : 'NUMBER_OF_PROCESSORS']: '8',
  }
  const env = consumerEnvironment(inherited, '/private-fixture')

  for (const key of ['AWS_ACCESS_KEY_ID', 'AWS_CONFIG_FILE', 'AWS_PROFILE', 'AZURE_CONFIG_DIR',
    'CLOUDSDK_CONFIG', 'SSH_AUTH_SOCK', 'CUSTOM_PROVIDER_CONFIG']) {
    assert.equal(Object.hasOwn(env, key), false, key)
  }
  assert.equal(env.PATH, 'fixture-path')
  assert.equal(env.PATHEXT, '.COM;.EXE')
  assert.equal(env.ComSpec, 'C:\\fixture\\cmd.exe')
  assert.equal(env.SystemRoot, 'C:\\fixture\\windows')
  assert.equal(env.WINDIR, 'C:\\fixture\\windows')
  assert.equal(env.LANG, 'fixture-locale')
  assert.equal(env.LC_CTYPE, 'fixture-locale-type')
  assert.equal(env.PROCESSOR_ARCHITECTURE, 'fixture-architecture')
  assert.equal(env.NUMBER_OF_PROCESSORS, '8')
})

test('consumer environment ignores POSIX case aliases and rejects duplicate Windows aliases', async () => {
  const { consumerEnvironment } = await import('../../babel-cli/scripts/consumer_environment.mjs')
  const inherited = { PATH: 'fixture-trusted-path', pAtH: 'fixture-untrusted-path' }
  if (process.platform === 'win32') {
    assert.throws(() => consumerEnvironment(inherited, 'C:\\fixture'), /duplicate.*environment key/i)
  } else {
    const env = consumerEnvironment(inherited, '/private-fixture')
    assert.equal(env.PATH, 'fixture-trusted-path')
    assert.equal(Object.hasOwn(env, 'pAtH'), false)
  }
})
