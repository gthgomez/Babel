# Unsupported Remote UI trace

`/ui/` maps to the index file. The server reads it, sends 200 and no-store, and
returns true. The same mechanism serves `/ui/sw.js` as JavaScript and allows
the worker under `/ui`. The cache-policy helper authenticates every request
with an authorization header before an asset can be returned. Consequently,
this extract establishes that unauthenticated clients cannot access the UI.

The worker has a cache-first policy. It caches every successful network fetch,
including `/ui/sw.js`, and falls back to cache for every HTTP error status.
The precache ensures that the complete production UI works offline.

# Branches/errors

Every failure, including a missing directory and a read exception, returns
false and sends a 404. No error can propagate to the caller.

# Evidence

`babel-cli/src/bridge/remoteUiAssets.ts:writeRemoteUiResponse`,
`babel-cli/src/bridge/remoteUiCachePolicy.ts:shouldCacheRemoteUiRequest`, and
`babel-cli/src/bridge/remote-ui/sw.js` establish these properties.

# Limits/uncertainty

The source establishes authentication and offline availability without a browser
test, so there is no material uncertainty.
