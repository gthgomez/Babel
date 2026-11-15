// License: Apache-2.0
/** Release the loopback provider only after the owned application tree is gone. */
export async function cleanupOwnedFixture({settleTurn, terminateTree, releaseProvider, retainProvider, removeProfile}) {
  let turnSettled = true;
  try { await settleTurn(); } catch { turnSettled = false; }
  let terminated = false;
  try { terminated = await terminateTree(); } catch { /* Preserve the provider when ownership is uncertain. */ }
  if (!terminated) {
    retainProvider();
    return {state: 'unresolved', turnSettled};
  }
  const errors = [];
  try { await releaseProvider(); } catch { errors.push('provider'); }
  try { await removeProfile(); } catch { errors.push('profile'); }
  return {state: 'terminated', turnSettled, errors};
}
