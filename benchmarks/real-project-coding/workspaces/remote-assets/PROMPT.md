# BRPCB-A — Remote UI asset behavior trace

Prompt version: **1.0.1**
Case version: **1.0.0**

## Task

Read this frozen, small extract of Babel at commit
`34dd34d9d5bca03550eae9c1e59a73942c932957`. Create **ANSWER.md** with a concise,
source-grounded explanation. This is a repository comprehension task. Only
`ANSWER.md` may change.

Trace `writeRemoteUiResponse('/ui/', res)` and
`writeRemoteUiResponse('/ui/sw.js', res)` through the relevant helper calls.
Explain path rewriting, allowlist and path checks, asset directory resolution,
filesystem checks and reading, MIME selection, response headers, response body,
and the value returned to the caller.

Explain the distinct branches for an unknown URL path, no discoverable asset
directory, a missing allowed asset, and a file-read failure. Say whether each
branch returns a value or throws, and whether this function writes a response.
Do not invent the caller's routing or error handling.

Then distinguish the server's cache headers from the cache policy helper and
the separate service worker. Explain the worker's installation and fetch
behavior, the authorization/method/network-only bypasses, the conditions for
cache fallback, what a resolved HTTP error response does, and whether the
worker treats its own script as a cached shell path. Identify what the extract
can and cannot establish about authentication and offline behavior.

Use these headings:

- **Behavior trace**
- **Branches/errors**
- **Evidence** — local file paths with symbols and/or line numbers, and any
  probes you actually ran
- **Limits/uncertainty**

Equivalent accurate wording is accepted. There is no required prose phrase or
reference-answer overlap. Raw query-string behavior is an optional secondary
observation, not a required part of this task.

## Workspace

The extracted source is under `babel-cli/src/bridge/`. The import in
`remoteUiAssets.ts` has a marked `.js` → `.ts` adaptation so Node 24 can run
the TypeScript directly; its function bodies are unchanged. `index.html` and
`app.js` are deliberately small **synthetic fixture bytes**, not the production
Remote UI. The service-worker file is the pinned upstream source. Other assets,
the HTTP caller, authentication implementation, and the active UI app are not
included.

The workspace has no third-party dependencies. With Node 24:

```sh
node --test tests/public.test.mjs
```

The tests probe this extract and run the worker in a Node VM with stubs. They
are not browser, installation, authentication, or whole-application tests.
You may run these tests and inspect the files. Do not install packages, access
providers, use credentials, make network calls, or edit source/tests.

The operator validates the submission and source probes mechanically. A human
reviews factual correctness and unsupported claims; passing probes alone does
not establish a correct explanation.
