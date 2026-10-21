import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { version } = require('../../../../package.json') as { version: string }

/**
 * Application User-Agent for governed research-v2 HTTPS GET (GitHub REST and other admitted hosts).
 * @see https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api
 */
export const GOVERNED_HTTP_USER_AGENT = `Babel-Research/${version} (+https://github.com/gthgomez/Babel; governed-admitted-http-get)`

export function buildGovernedHttpGetRequestHeaders(): Record<string, string> {
  return {
    accept: '*/*',
    'user-agent': GOVERNED_HTTP_USER_AGENT,
  }
}
