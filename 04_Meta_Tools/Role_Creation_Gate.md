<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Role Creation Gate

## Purpose

Govern the addition of new Babel prompt files so the library grows by clear deltas instead of prompt sprawl.

## Before Creating A New File

Ask these questions in order:

1. Is this a behavioral rule, a domain role, a model adapter, a project overlay, or a task overlay?
2. Does an existing file already cover at least 80 percent of the needed behavior?
3. Is the proposed file general-purpose or project-specific?
4. Can the need be solved with a thin overlay instead of a new domain role?

If the answer to question 4 is yes, prefer an overlay.

## Correct Placement

- `01_Behavioral_OS`: universal execution behavior only
- `02_Domain_Architects`: broad primary expertise domains only
- `03_Model_Adapters`: model-specific style and execution tuning only
- `05_Project_Overlays`: thin project context and invariants only
- `06_Task_Overlays`: optional reusable task-specific guidance

## Hard Stop Conditions

Do not create a new file if:
- it mostly duplicates an existing domain architect
- it mixes project context with generic task guidance
- it weakens or overrides behavioral rules
- it exists only to restate model personality

## Required Delta Declaration

Every new file proposal must state:
- parent layer
- overlap with existing files
- what is new
- why an overlay is not sufficient, if proposing a new domain role
- how it will be loaded

## Catalog Update Rule

No new file is complete until:
- the file exists on disk
- `prompt_catalog.yaml` contains an entry for it if it is a routable asset
- any router logic needed to discover it is updated
- obsolete references are removed or deprecated

## Validation Checklist

Before approving a new Babel file, verify:
- path exists
- naming is versioned when appropriate
- layer assignment is correct
- no dead references remain
- no stronger layer is being duplicated in a weaker one

## Recommended Bias

Prefer:
- extending thin overlays
- adding optional task overlays
- improving routing logic

Avoid:
- multiplying domain roles for minor style differences
- putting project-specific guidance into model adapters
- putting task-specific guidance into project overlays unless it is always-on for that project
