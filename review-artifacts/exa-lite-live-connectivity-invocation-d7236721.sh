#!/usr/bin/env bash
# Frozen invocation record for the successful live run @ d7236721 (do not re-run from this receipt without explicit release).
set -euo pipefail
WT="/tmp/babel-exa-preflight-d723672/babel-cli"
unset NODE_PATH
export BABEL_WEB_SEARCH_PROVIDER=exa_lite
export BABEL_EXA_CONNECTIVITY_BABEL_CLI_ROOT="$WT"
# EXA_API_KEY must already be present in the environment; never export or echo it here.
node /workspace/review-artifacts/exa-lite-live-connectivity-harness-d7236721.mjs
