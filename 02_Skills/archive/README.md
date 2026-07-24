# Archive — Superseded Skill Versions

Files in this directory are **superseded v1 versions** of skills that have active v2
replacements in the parent `02_Skills/` tree. They are kept on disk for:

- **Git history**: preserving the evolution of each skill across versions
- **Migration reference**: understanding what changed when a skill was upgraded
- **Rollback safety**: if a v2 replacement needs to be reverted, the v1 source is available

## Policy

- Archive files are **intentionally excluded** from `prompt_catalog.yaml`.
- The drift audit (`tools/audit-skill-disk-drift.ps1`) reports archive files as
  "unregistered on disk" — this is expected and not an error.
- When a v2 skill is created, move its v1 predecessor here preserving the
  subdirectory structure (e.g. `Game/Godot-HD2D-Sprite-Pipeline-v1.md` → `archive/Game/`).
- Do not delete archive files without confirming the v2 replacement is stable and
  has been the canonical version for at least one release cycle.
