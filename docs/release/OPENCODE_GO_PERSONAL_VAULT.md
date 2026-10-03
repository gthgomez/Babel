<!-- License: Apache-2.0 — see LICENSE -->
# OpenCode Go Personal Vault adapter

The source-only Go pilot can use
[`tools/opencode-go-network-secret-helper.cjs`](../../tools/opencode-go-network-secret-helper.cjs)
with the existing `opencode-auth-helper` credential source. Set the nonsecret
`BABEL_OPENCODE_GO_HELPER` variable to that file's absolute path in the prepared
checkout. Babel invokes it through Node with captured stdout; never run it
interactively, echo its output, or log an Authorization header.

Request **`BABEL_OPENCODE_GO_API_KEY` as a Network secret** in the saved cloud
environment, with **`opencode.ai`** as the allowed destination. The owner supplies
the matching key in **Settings > Codex Cloud > Personal vault**, Type **Network
secret**, Applies to **Selected environments**, selecting the Babel environment.
Do not also configure that key as a direct environment variable. A helper-path
variable alone cannot deliver an unrequested Personal Vault value.

For a personal value, allow `opencode.ai` in the environment's network policy
separately: personal values do not add allowed domains. Substitution works for
HTTPS on port 443. After changing the environment requirements or helper setup,
save and **Republish**, then start a **new task**. Existing saved tasks retain
their state; restarting the shell does not apply a new published environment.
These delivery rules come from the
[Codex Cloud environment documentation](https://learn.chatgpt.com/docs/environments/cloud-environments).

The helper only reads the requested variable, validates a bounded printable
header value, and returns it through the resolver's pipe. It makes no network
requests, reads no credential files, and writes no state. Missing or invalid
values produce a content-free error. The proxy supplies the credential at the
allowed destination. The helper cannot prove that an input is a placeholder:
raw-key isolation depends on provisioning it as a Network secret, not on a
guessed token pattern. Dummy child-process tests qualify the adapter; they do
not prove configured proxy substitution or live provider authentication.

This prepares credential delivery only. The preview tarball does not contain
the Go pilot. The native Go route remains limited to direct source embedding
with its mandatory caller-owned durable budget and fixed Go endpoint; CLI
registry integration and auxiliary/fallback budget sharing are not qualified.
Windows native budget persistence fails closed. Confirm provider-side allowance,
paid-balance use, automatic top-up and fallback settings, then obtain the owner's
action-time approval before a real pilot. No live request or spend is authorized
by this setup document.
