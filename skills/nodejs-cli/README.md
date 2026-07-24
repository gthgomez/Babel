# Node.js CLI

Status: experimental

This governed skill packages Babel's reusable Node.js CLI guidance for Codex.
It is intended for CLI implementation and review tasks where correctness depends
on argument parsing, exit codes, stdout/stderr discipline, ESM path handling, and
real command smoke tests.

## Transfer Source

- Source Babel skill: `02_Skills/Framework/NodeJS-CLI-v1.md`
- Transfer target: `skills/nodejs-cli`

## Export

Experimental skills require:

```powershell
node .\dist\index.js codex export-skill nodejs-cli --allow-experimental
```

After human review, update `skill.yaml` to `status: reviewed` so default export is allowed.
