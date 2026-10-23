# Reference Remote UI trace

For `/ui/`, `writeRemoteUiResponse` calls `remoteUiFileForPath`, which rewrites
the path to `/ui/index.html`. For `/ui/sw.js`, the path is unchanged. Both are
allowed shell paths. The helper then removes the `/ui/` prefix and rejects a
relative name containing `..` or changed by `normalize` before looking for
assets. The two relative names here are `index.html` and `sw.js`.

`resolveRemoteUiDir` first looks for `remote-ui/index.html` beside its module.
Only if that sentinel is absent does it check
`../../src/bridge/remote-ui/index.html`; it throws if neither exists. The frozen
workspace uses the adjacent directory. After directory discovery, the resolver
joins the requested relative name to that directory and separately checks that
file's existence. The extension selects the MIME map entry, with an
`application/octet-stream` fallback for an unmapped extension.

The writer synchronously reads the resolved file as bytes. It then writes
status 200, sends that buffer through `res.end(body)`, and returns `true`:

| Request | Body and Content-Type | Other headers |
|---|---|---|
| `/ui/` | Synthetic `index.html` bytes; `text/html; charset=utf-8` | `Cache-Control: no-store`; the source's restrictive Content-Security-Policy |
| `/ui/sw.js` | Pinned `sw.js` bytes; `text/javascript; charset=utf-8` | The same cache/CSP headers, plus `Service-Worker-Allowed: /ui` |

The CSP mostly limits resources to `self`, additionally permits `data:` images,
and sets `base-uri` and `form-action` to `none`. It is not credential validation.

The TypeScript cache-policy helper defaults the method to GET, uppercases it,
and rejects non-GET methods, a truthy `hasAuthorization`, and `/rpc`, `/ws`,
`/sessions`, and `/health` paths or their descendants. It otherwise accepts
members of its shell list. This predicate is separate from the worker's code.

The worker attempts to precache its own `SHELL` list in
`babel-remote-shell-v1` during install using `waitUntil`/`addAll`, calls
`skipWaiting`, and claims clients during activation. That literal list omits
`/ui/sw.js` even though the server/policy allow it. On fetch, non-GET requests,
requests whose `authorization` header has a nonempty (truthy) value,
runtime-prefix paths, and paths outside its
shell list return without `respondWith`. The stub therefore observes no fetch
or cache call for those bypasses; normal browser handling is outside this probe.

For a permitted shell request, the worker tries the network first. Only a
rejected `fetch` promise invokes `caches.match(event.request)`. A resolved HTTP
503 response is returned without cache fallback; this code does not test
`response.ok`. The successful-fetch path does not update the cache. The
server's HTTP `no-store` header and this explicit worker precache/fallback logic
must be described separately; they do not establish a usable offline application.

# Branches/errors

| Condition | Behavior in these functions |
|---|---|
| Unknown/disallowed path | Resolution returns `null` before directory discovery; the writer returns `false` and does not write a response. |
| Neither directory has its `index.html` sentinel | Directory discovery throws; the writer does not catch it and has not written a response. |
| Allowed file missing inside a discoverable directory | The file existence check returns `null`; the writer returns `false`, without a response. Missing fixture `styles.css` demonstrates this. |
| File read fails after resolution | `readFileSync` throws before headers are written; the error propagates. A controlled read-failure probe confirms this order. |

No caller is included, so these branches do not establish any eventual 404,
500, alternate route, or caller-side exception handling.

# Evidence

Paths below are relative to the task workspace. These local lines are pinned
to the supplied copy; the assets file has a marked extra first-line notice.

| Claim | Source |
|---|---|
| MIME and directory selection | `babel-cli/src/bridge/remoteUiAssets.ts`, `CONTENT_TYPES` lines 13–18 and `resolveRemoteUiDir` lines 21–27 |
| Rewrite, allowlist, path/file checks | Same file, `remoteUiFileForPath` lines 30–45 |
| Read order, status, headers, body, return | Same file, `writeRemoteUiResponse` lines 48–63 |
| Policy shell list and request predicate | `babel-cli/src/bridge/remoteUiCachePolicy.ts` lines 6–18 and 22–50 |
| Worker list, lifecycle, fetch/catch behavior | `babel-cli/src/bridge/remote-ui/sw.js` lines 1–13, 33–44, and 46–59 |

During reference preparation, `node --test tests/public.test.mjs` exited 0.
The direct named run, `node --test-reporter=tap tests/public.test.mjs`, reported
17 tests and 17 passes. Those probes execute the extracted functions, isolated
directory fixtures, a controlled filesystem failure, and the actual worker
source in a Node VM. Worker stubs observed network success, rejection fallback,
HTTP-error non-fallback, a cache miss, and bypasses. These are source-level
observations, not browser observations.

# Limits/uncertainty

This extract omits the HTTP caller, authentication implementation, full active
UI, and several shell assets; the HTML/app payloads are synthetic. The worker
installation probe only confirms calls to stubs, not successful browser
precaching. A cache miss after network rejection yields no usable fallback
response in the probe. Offline behavior depends on actual installation, cache
entries, requests, and browser behavior. Security and authentication correctness
are not established by the authorization bypass or the CSP. These tests do not
establish full-application behavior, deployment readiness, or browser offline
support.
