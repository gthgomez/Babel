# Babel Desktop — Linux installation

This guide matches current source. No Linux Desktop build is published yet. The next tagged release is what attaches `Babel-Desktop-<version>-linux-x64.AppImage`. Until that draft is published, build from source with the command in the [Desktop README](../README.md).

The AppImage includes Babel Desktop, the Babel CLI, prompt assets, production dependencies, and Node 24.13.1. It is an unsigned linux x64 build. You do not need a separate Node or CLI install to open the window. Docker is not included.

## Run the AppImage

1. Verify `Babel-Desktop-<version>-linux-x64.AppImage` against the matching line in `SHA256SUMS`. Checksum verification confirms the bytes, not the publisher.
2. Mark it executable and start it:

```sh
chmod +x Babel-Desktop-<version>-linux-x64.AppImage
./Babel-Desktop-<version>-linux-x64.AppImage
```

If FUSE is unavailable, the same file still runs by extracting itself:

```sh
APPIMAGE_EXTRACT_AND_RUN=1 ./Babel-Desktop-<version>-linux-x64.AppImage
```

That needs a writable temp directory. `libfuse2` (or `libfuse2t64` on newer Ubuntu) and `/dev/fuse` are what a normal double-click mount uses. This build was exercised on Ubuntu with glibc 2.39. The bundled Node binary's highest versioned glibc symbol is GLIBC_2.28, and the bundled Electron binary's highest is GLIBC_2.25, so older systems than glibc 2.28 are outside the pinned runtime. Other distributions, Wayland-only sessions, and real GPUs were not part of that check.

3. First launch shows setup status. Choose a project with **Open project** when you need files or commands. Ordinary Chat can start without a project or Docker.
4. Open **Providers and models** and enter a key for a cloud provider, or choose Ollama. Private keys use Electron `safeStorage`. On Linux that needs a working secret service (typically gnome-keyring or KWallet through libsecret). If OS protection is unavailable, saving a private key fails closed and tells you so. The optional project `.env` choice is unchanged: it stays plaintext, and only after you select a trusted Git repository where `.env` is untracked and ignored.
5. For project tools, install Docker Engine yourself and start the daemon (`docker` on `PATH`). Docker Desktop is optional on Linux. In **Setup**, choose **Prepare recommended image** or validate an existing local image. Preparation pulls the pinned linux/amd64 Node 24 Bookworm image and runs an isolated shell, Git, Node, and npm check. It does not mount your project. The verified image id is saved for Desktop and the `babel-harness` launcher in the extracted AppImage. Desktop does not install Docker and does not switch to unrestricted host execution. Chat still runs without this step.

The AppImage does not register file associations or a package-manager uninstall entry. Closing the window quits the app. Profile data is stored under `$XDG_CONFIG_HOME/babel-desktop` or `~/.config/babel-desktop`, not inside the AppImage. If `babel-north-star-desktop` is still in that config directory, the first launch copies it into `babel-desktop`, writes `profile-migration.json` only after the copy verifies, and leaves the old directory in place. Files already in `babel-desktop` are not replaced. A failed copy keeps using the old directory. `babel-harness` uses the same folder.

For diagnostics without a provider call, extract the AppImage (`--appimage-extract` or `APPIMAGE_EXTRACT_AND_RUN=1`) and run the bundled launcher from the extracted directory:

```sh
./babel-harness --version
./babel-harness doctor --json
```

`babel-cli` is the same launcher. A separate profile uses `--profile-dir` with an absolute path, on both the AppImage and `babel-harness`.

## Updates and signing

Automatic Desktop self-update and AppImage update metadata are not configured. Install a newer verified AppImage beside the old one and keep the same profile. CLI update checks inside Desktop can still download a qualified CLI archive; they do not replace the AppImage. The package is unsigned. Do not treat a matching SHA256 as publisher identity.

Some Linux desktops reserve Alt+1, Alt+2, and Alt+3, which Desktop uses to switch Chat, Plan, and Deep. Ctrl+K and the on-screen mode controls still work. A tray icon needs a StatusNotifier or system-tray host; without one, background-tray controls are skipped and the window remains the control.
