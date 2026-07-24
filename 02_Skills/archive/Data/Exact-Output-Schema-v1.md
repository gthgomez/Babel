# Exact Output Schema Skill v1

## Activation

Load for tasks that require a generated CSV, JSON, TSV, text report, CLI output, or data file to
match a requested schema, fixture, or literal example.

## Rules

1. Treat the requested output example as a contract, not a suggestion.
2. Copy literal headers, keys, labels, row order, casing, underscores, delimiters, and file paths exactly.
3. Do not rename machine labels to prose labels. For example, `last_7_days` must not become
   `last 7 days`, `last week`, or `Last 7 days`.
4. Do not pivot a row-oriented schema into a column-oriented schema, or the reverse, unless the task
   explicitly asks for that transformation.
5. Emit every required row or field from the example, even when a count is zero.
6. Before completion, compare the generated artifact shape against the requested schema literally:
   header/key set, row count, row order, delimiter, and label spelling.

## CSV Checklist

- Header is byte-for-byte equal to the requested header.
- Data rows follow the exact requested order.
- Each row has the exact requested column count.
- Counts and numeric values are serialized as plain decimal numbers unless another format is requested.
- No extra columns, summary rows, explanatory comments, or renamed labels are added.
