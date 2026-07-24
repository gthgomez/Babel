# Log Analysis Skill v1

## Activation

Load for tasks that require parsing log files, aggregating event counts, producing CSV/JSON summaries, or computing date-window metrics from timestamped operational records.

## Rules

1. Do not pass wildcard paths to file tools. List directories first, then read concrete files, or write a small helper program when many files must be processed.
2. For many-file log aggregation, prefer a deterministic helper program that iterates every concrete file in the input directory over manual file sampling.
3. For date-window reports, define inclusive boundaries before counting. Name the reference date explicitly.
4. Interpret "last N days including today" as exactly N calendar dates: start at `reference_date - (N - 1) days`, end at the reference date, and include both endpoints.
5. When logs encode severity as a field or token such as `[ERROR]`, count that exact field/token. Do not count prose mentions of the word inside the message text.
6. Count only the requested severities or event classes. Ignore unrelated levels such as DEBUG unless the task asks for them.
7. Preserve the exact requested output schema, row order, delimiter, header, and literal labels. Use the Exact Output Schema skill as the source of truth.

## CSV Output Checklist

- Header matches exactly.
- Required rows are present in the requested order.
- Period labels match the requested machine labels exactly, including underscores.
- Counts are serialized as plain integers.
- The file is written to the exact requested target path.
