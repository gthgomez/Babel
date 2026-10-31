/** Validate an explicitly selected endpoint before resolving or sending credentials. */
export function validateProviderBaseUrl(value: string): string {
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('Provider endpoint requires HTTPS or loopback HTTP, without embedded credentials, query or fragment.')
  }
  return value.replace(/\/$/, '')
}
