# Incomplete Remote UI trace

The remote UI helper serves static files. `/ui/` returns the index page, and
`/ui/sw.js` returns JavaScript. Successful responses use status 200, send a body,
and have `Cache-Control: no-store`.

# Branches/errors

If the requested file is absent, the helper returns false and leaves routing to
its caller.

# Evidence

`babel-cli/src/bridge/remoteUiAssets.ts:writeRemoteUiResponse` shows the
headers and body write.

# Limits/uncertainty

This is a small fixture; the complete UI is not included.
