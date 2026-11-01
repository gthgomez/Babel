# Babel offline CLI walkthrough

This showcase captures the actual source CLI, reporting **0.2.0**, from revision [`9f70c0abf384e21f6755a72c0524c35403155060`](https://github.com/gthgomez/Babel/commit/9f70c0abf384e21f6755a72c0524c35403155060). It demonstrates version/help output and environment diagnostics. It contains no model session, coding task, edited project, benchmark run, or claimed verification of a coding result.

- [18-second video](offline-cli.mp4) and [animated preview](offline-cli.gif)
- [Command-guide screenshot](cli-help.png) and [doctor screenshot](cli-doctor.png)
- Complete output: [version](version.txt), [help](help.txt), [doctor text](doctor.txt), [doctor JSON](doctor.json)
- Recorded Node runtime notices: [text command stderr](doctor.txt.stderr.txt), [JSON command stderr](doctor.json.stderr.txt)
- [Source capture metadata](capture.json), [media hashes and dimensions](media.json), and [local transcript viewer](viewer.html)

## Reproduce the command output

Build the source checkout using the root README, then run from the repository root:

```sh
node docs/assets/showcase/capture-offline.mjs
```

The capture script needs the built CLI, Git, and PowerShell 7+ available on `PATH`. It uses Node.js in Babel's supported range. The recorded run used Node.js 24.19.0 and PowerShell 7.6.9 on Linux; complete tool/output details are in `capture.json`. Re-running writes fresh output and metadata in this directory, so inspect the diff before committing.

The runner creates temporary home, project, config, state, cache, and run directories before spawning the CLI. It passes an allowlisted environment without provider credentials and preloads `offline-guard.mjs`, which rejects fetch/HTTP(S)/TCP connections. The normalized capture argv and working directory, including that preload, are recorded in metadata. Shell and PowerShell health probes are real. Source/workspace/temp paths, the Node executable, Node warning process IDs, and trailing blank lines are normalized as documented; output statuses and messages are preserved.

The doctor reports **WARN**, with two passes and one warning: the isolated profile deliberately has no provider API key. This does not indicate missing credentials in the operator's real profile or certify provider health. Node also emitted an experimental WebAssembly notice, preserved in the linked stderr files. Only the `env` scope ran; this is not a full repository doctor or release validation.

## Reproduce the media

The optional media step uses Python with Playwright, a local Chromium executable, and FFmpeg/FFprobe on `PATH`. Playwright's video encoder must be installed for that environment. `CHROMIUM_PATH` can select the installed browser; the default is `/usr/bin/chromium`.

```sh
python docs/assets/showcase/capture-media.py
```

This script builds a self-contained HTML viewer from the saved stdout, serves it on loopback, and records the actual browser viewport. The help panel is an explicitly labeled excerpt; the complete help remains linked above. Screenshots capture that viewer, and the GIF is encoded from the same MP4. The recording is paced playback, not real-time typing, the interactive Babel TUI, or a simulated successful agent conversation. The viewer loads no external resources. All three panels were checked at a 390px viewport without horizontal overflow.

The CLI capture is a source build and does not assert npm package or Desktop release parity. Ordinary coding-loop qualification remains documented in [project status](../../STATUS.md). No provider inference, deployment, or release is needed for this walkthrough. Code, text, and captures use the repository's [Apache-2.0 license](../../../LICENSE).

## Desktop renderer preview

The root README also shows a current-source preview of the Desktop renderer:

- [Empty setup-required screen](desktop-renderer-preview.png)
- [Setup dialog](desktop-setup-preview.png)
- [Interface preview video](desktop-renderer-preview.mp4)
- [Capture metadata and file hashes](desktop-capture.json)

Rebuild and capture it with:

```sh
python docs/assets/showcase/capture-desktop-preview.py
```

The capture uses the source renderer in headless Chromium. It has no Electron native bridge, project, conversation, provider, or model response; setup details are unconfigured. External requests are blocked. This is an interface preview, not a recording of the installed Windows app or evidence of task execution. The downloaded Windows x64 release remains 0.1.3 and is described by its [release-pinned setup guide](https://github.com/gthgomez/Babel/blob/v0.1.3/babel-desktop/docs/INSTALL-WINDOWS.md). Reproduction requires Python Playwright, Chromium, the Playwright FFmpeg component, and system FFmpeg.
