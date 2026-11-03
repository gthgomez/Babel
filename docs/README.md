# Documentation

Map of the docs in this repo. If you are new, you only need the first section.

Babel is a local **agent harness**. Chat-style tasks are the default. `plan` and `deep` are separate commands. The numbered folders in the repository are the instruction stack underneath that. You can try the CLI without reading them.

**Pre-1.0.** A command that exists is not a reliability claim. Limits are in [STATUS.md](./STATUS.md).

## Getting started

| Doc | Role |
| --- | --- |
| [README.md](../README.md) | What Babel is, and the shortest install |
| [START_HERE.md](../START_HERE.md) | Same npm path, plus Windows Desktop and a source build |
| [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) | Node version, command names, Docker, keys, warnings |
| [STATUS.md](./STATUS.md) | What is available, what was checked, what is not claimed |
| [ROADMAP.md](./ROADMAP.md) | Current gaps. Not a delivery schedule |
| [VISION.md](./VISION.md) | Product principles |

[CHANGELOG.md](../CHANGELOG.md) records 0.1.2, 0.1.3, and 0.2.0 from tags and release notes.

## CLI reference

| Doc | Role |
| --- | --- |
| [CLI_QUICKSTART.md](./CLI_QUICKSTART.md) | Commands that ran on `babel-harness@0.2.0` |
| [CHAT_MODE.md](./CHAT_MODE.md) | How the default loop is described in source |
| [CLI_COMMAND_CONTRACT.md](./CLI_COMMAND_CONTRACT.md) | Source-tree command grammar. It includes commands the 0.2.0 package does not install |
| [BABEL_USER_SHAPED_CLI_GUIDE.md](./BABEL_USER_SHAPED_CLI_GUIDE.md) | Older product-direction note, not the install guide |
| [babel-cli/README.md](../babel-cli/README.md) | Package readme for people building the CLI |

## Desktop

Published downloads are Windows x64 only.

- [babel-desktop/README.md](../babel-desktop/README.md) — current source behavior, which can differ from an installer
- [babel-desktop/docs/INSTALL-WINDOWS.md](../babel-desktop/docs/INSTALL-WINDOWS.md) — setup guide as shipped on the v0.2.0 tag
- [v0.2.0 release](https://github.com/gthgomez/Babel/releases/tag/v0.2.0) — Setup `.exe` and portable ZIP

## Concepts and architecture

Read these after you can start a session, or when you are changing the harness.

- [Architecture](./architecture/ARCHITECTURE.md)
- [Harness architecture v1](./architecture/HARNESS_ARCHITECTURE_V1.md) — normative runtime spec
- [Harness overview](./architecture/HARNESS_OVERVIEW.md) — explanatory map
- [Architecture index](./architecture/README.md)
- [ADRs](./adr/ADR-0001-canonical-public-source.md)
- [Internal comparison notes](./benchmarks/claude-babel-astra-lab/README.md) — a lab note about one comparison setup. Not a product benchmark and not a general claim against other tools.

## Safety and sandbox

- [Troubleshooting: Docker and the image](./TROUBLESHOOTING.md#doctor-fails-on-docker-and-the-sandbox-image)
- [CLI reference: execution profile](./CLI_QUICKSTART.md#execution-profile)
- [Chat mode: isolation](./CHAT_MODE.md#execution-profile-and-isolation-h13)
- [Docker isolation ADR](./adr/ADR-008-docker-isolation-strategy.md)
- [Autonomy policy](./AUTONOMY_POLICY.md)
- [Security](../SECURITY.md)

## Contributing and development

- [CONTRIBUTING.md](../CONTRIBUTING.md)
- [AGENTS.md](../AGENTS.md) — contributor operating policy
- [STRUCTURE.md](../STRUCTURE.md) — what the root folders are
- [INTEGRATION.md](../INTEGRATION.md)
- [PR review](./BABEL_PR_REVIEW.md)
- [Reviewer scope](./REVIEWER_SCOPE.md) — still cited by the CLI review commands
- [Guides](./guides/RELEASE.md) — release, git operations, and other maintainer notes
- [Repository layout for agents](../PROJECT_CONTEXT.md)

## Release notes

- [CHANGELOG.md](../CHANGELOG.md)
- [Release guide](./guides/RELEASE.md)
- [Release docs](./release/README.md)

## Archive

[docs/history/](./history/README.md) holds historical campaign notes, old readiness reports, and review receipts. They are not the current product description. The folder is named `history` because public content policy forbids a `docs/archive/` path. Experimental program notes that source files still cite stay in [roadmaps/](./roadmaps/).
