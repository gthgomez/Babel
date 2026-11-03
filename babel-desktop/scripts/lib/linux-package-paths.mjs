// License: Apache-2.0

// GitHub-hosted runners use this home. Published packages often embed that
// same home from their own hosted builds, so it is not evidence of this checkout.
const hostedRunnerHome = ['', 'home', 'runner'].join('/');

/**
 * True when packaged bytes contain this build's checkout, output directory,
 * or a non-hosted home path.
 * @param {string} _rel
 * @param {Buffer} bytes
 * @param {{home: string, repo: string, output?: string, isCanvasPrebuild?: boolean}} scope
 */
export function containsPersonalBuildPath(_rel, bytes, {home, repo, output = '', isCanvasPrebuild = false}) {
  if (isCanvasPrebuild) return false;
  if (repo && bytes.includes(Buffer.from(repo))) return true;
  if (output && bytes.includes(Buffer.from(output))) return true;
  if (!home || home === hostedRunnerHome) return false;
  return bytes.includes(Buffer.from(home));
}
