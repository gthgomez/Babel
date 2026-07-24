# Example

User task:

```text
Add --json support to this Node.js CLI without breaking human output.
```

Expected skill-guided behavior:

- Find the actual package `bin` entry and command registration file.
- Keep progress and diagnostics on stderr.
- Emit only JSON on stdout when `--json` is present.
- Return exit code `1` for invalid flags and `2` for unexpected runtime failures.
- Run the built command and parse stdout as JSON before claiming success.
