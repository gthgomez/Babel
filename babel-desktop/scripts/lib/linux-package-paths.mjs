// License: Apache-2.0

const vendorClaudeCheckout = Buffer.from('/work/claude-cli-internal/');

/**
 * True when packaged bytes contain this build's repo or home path.
 * Anthropic's published Claude binary embeds its own GitHub Actions checkout
 * under /home/runner/work/claude-cli-internal, which shares a hosted runner's
 * home prefix and is not this repository.
 * @param {string} rel
 * @param {Buffer} bytes
 * @param {{home: string, repo: string, isCanvasPrebuild?: boolean}} scope
 */
export function containsPersonalBuildPath(rel, bytes, {home, repo, isCanvasPrebuild = false}) {
  if (isCanvasPrebuild) return false;
  if (repo && bytes.includes(Buffer.from(repo))) return true;
  if (!home) return false;
  const needle = Buffer.from(home);
  let offset = 0;
  while (offset < bytes.length) {
    const index = bytes.indexOf(needle, offset);
    if (index < 0) return false;
    const follow = bytes.subarray(index + needle.length, index + needle.length + vendorClaudeCheckout.length);
    const vendorBinary = rel.includes('node_modules/@anthropic-ai/claude-agent-sdk-linux') && follow.equals(vendorClaudeCheckout);
    if (!vendorBinary) return true;
    offset = index + needle.length;
  }
  return false;
}
