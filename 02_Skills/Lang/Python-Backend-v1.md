# Python Backend Skill v1

## Activation

Load for Python implementation tasks, small data-processing scripts, command-line helpers, and backend-style file processing work.

## Rules

1. Prefer small, deterministic standard-library Python scripts for local data processing unless the task requires a specific framework.
2. Keep entrypoints simple: parse local files, write the exact requested output, and exit nonzero only on real failure.
3. Preserve requested schemas exactly for CSV, JSON, and text artifacts.
4. Avoid hidden test assumptions. Infer behavior from the prompt and visible project files.
5. Write outputs under the current project root using relative paths unless the task explicitly names another location.
