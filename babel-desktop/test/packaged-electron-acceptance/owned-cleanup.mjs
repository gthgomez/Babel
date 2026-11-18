// License: Apache-2.0
/** Release the loopback provider only after the owned application tree is gone. */

const retryableProfileRemovalCodes = new Set(['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM']);
const profileRemovalAttempts = 4;

async function removeOwnedProfile({removeProfile, profileAbsent}) {
  for (let attempts = 1; attempts <= profileRemovalAttempts; attempts += 1) {
    let failure;
    try { await removeProfile(); } catch (error) { failure = error; }

    try {
      if (await profileAbsent()) return {state: 'removed', attempts};
      failure ??= {code: 'PROFILE_REMAINS'};
    } catch (error) {
      failure ??= error;
    }

    const code = typeof failure?.code === 'string' ? failure.code : '';
    if (attempts === profileRemovalAttempts || !retryableProfileRemovalCodes.has(code)) {
      return {state: 'failed', code: retryableProfileRemovalCodes.has(code) ? code : 'OTHER', attempts};
    }
    await new Promise(resolve => setTimeout(resolve, attempts * 100));
  }
  return {state: 'failed', code: 'OTHER', attempts: profileRemovalAttempts};
}

export async function cleanupOwnedFixture({settleTurn, terminateTree, releaseProvider, retainProvider, removeProfile, profileAbsent, startupFailure}) {
  let turnSettled = true;
  try { await settleTurn(); } catch { turnSettled = false; }
  let terminated = false;
  try { terminated = await terminateTree(); } catch { /* Preserve the provider when ownership is uncertain. */ }
  if (startupFailure?.diagnostic?.cleanup === 'unresolved') terminated = false;
  if (!terminated) {
    retainProvider();
    return {state: 'unresolved', turnSettled};
  }
  const errors = [];
  try { await releaseProvider(); } catch { errors.push('provider'); }
  const profileCleanup = await removeOwnedProfile({removeProfile, profileAbsent});
  if (profileCleanup.state !== 'removed') errors.push('profile');
  return {state: 'terminated', turnSettled, errors, profileCleanup};
}
