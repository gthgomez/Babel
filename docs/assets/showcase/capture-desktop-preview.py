#!/usr/bin/env python3
"""Capture the source desktop renderer without a native bridge or model calls."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[3]
SHOWCASE = Path(__file__).resolve().parent
WIDTH, HEIGHT = 1440, 900
VIDEO_WIDTH, VIDEO_HEIGHT = 1280, 800


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    browser_path = os.environ.get("CHROMIUM_PATH") or shutil.which("chromium")
    ffmpeg = shutil.which("ffmpeg")
    if not browser_path or not ffmpeg:
        raise SystemExit("Set CHROMIUM_PATH and install FFmpeg to capture the desktop preview.")

    subprocess.run(["node", str(ROOT / "babel-desktop/scripts/build.mjs")], cwd=ROOT, check=True)
    html = (ROOT / "babel-desktop/dist/index.html").read_text(encoding="utf-8")

    with tempfile.TemporaryDirectory(prefix="babel-desktop-preview-") as temporary:
        temporary_path = Path(temporary)
        video_dir = temporary_path / "video"
        video_dir.mkdir()
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(
                executable_path=browser_path,
                headless=True,
                args=["--no-sandbox"],
            )
            context = browser.new_context(
                viewport={"width": WIDTH, "height": HEIGHT},
                record_video_dir=str(video_dir),
                record_video_size={"width": VIDEO_WIDTH, "height": VIDEO_HEIGHT},
            )
            page = context.new_page()
            network_requests: list[str] = []

            def deny_network(route) -> None:
                network_requests.append(route.request.url)
                route.abort()

            page.route("https://**/*", deny_network)
            page.route("http://**/*", deny_network)
            page.add_init_script(
                """(() => {
                  const fixed = '2026-10-30T12:00:00.000Z';
                  const NativeDate = Date;
                  globalThis.Date = class extends NativeDate {
                    constructor(...args) { super(...(args.length ? args : [fixed])); }
                    static now() { return new NativeDate(fixed).getTime(); }
                  };
                })();"""
            )
            errors: list[str] = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.set_content(html, wait_until="load")
            page.wait_for_timeout(500)
            if page.locator("#status-detail").inner_text() != "Open the installed Babel Desktop app to run tasks.":
                raise RuntimeError("The browser-only preview no longer reports that native Desktop is required.")
            if page.locator("#conversation .reference-answer, #conversation .tool-row").count():
                raise RuntimeError("The empty renderer preview unexpectedly contains conversation activity.")

            image = SHOWCASE / "desktop-renderer-preview.png"
            setup_image = SHOWCASE / "desktop-setup-preview.png"
            video = SHOWCASE / "desktop-renderer-preview.mp4"
            page.screenshot(path=str(image), full_page=True)
            page.wait_for_timeout(2500)
            page.locator(".empty-actions button[data-action='connection']").click()
            page.locator("#dialog[open]").wait_for()
            if page.locator("#dialog").inner_text().find("Choose a provider and model") < 0:
                raise RuntimeError("The setup dialog did not render its provider guidance.")
            page.screenshot(path=str(setup_image), full_page=True)
            page.wait_for_timeout(4000)
            page.keyboard.press("Escape")
            page.wait_for_timeout(1500)
            if errors or network_requests:
                raise RuntimeError(f"Preview errors={errors}; external requests={network_requests}.")

            recording = page.video.path()
            page.close()
            context.close()
            browser.close()

        subprocess.run(
            [
                ffmpeg,
                "-y",
                "-i",
                recording,
                "-vf",
                f"scale={VIDEO_WIDTH}:{VIDEO_HEIGHT}:flags=lanczos,fps=20",
                "-c:v",
                "libx264",
                "-preset",
                "medium",
                "-crf",
                "23",
                "-pix_fmt",
                "yuv420p",
                "-an",
                "-movflags",
                "+faststart",
                str(video),
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    metadata = {
        "capture": "Browser rendering of the current Babel Desktop source renderer; native Desktop APIs are absent.",
        "desktopSourceCommit": subprocess.check_output(
            ["git", "log", "-1", "--format=%H", "HEAD", "--", "babel-desktop"],
            cwd=ROOT,
            text=True,
        ).strip(),
        "desktopPackageVersion": json.loads(
            (ROOT / "babel-desktop/package.json").read_text(encoding="utf-8")
        )["version"],
        "viewport": {"width": WIDTH, "height": HEIGHT},
        "videoViewport": {"width": VIDEO_WIDTH, "height": VIDEO_HEIGHT},
        "clock": "Fixed at 2026-10-30 12:00 UTC for repeatable screenshots.",
        "scenes": ["empty setup-required interface", "provider and project setup dialog"],
        "nativeBridge": False,
        "modelRequests": 0,
        "conversationOrToolFixtures": 0,
        "externalRequests": 0,
        "assets": [
            {
                "path": path.name,
                "bytes": path.stat().st_size,
                "sha256": sha256(path),
            }
            for path in (
                SHOWCASE / "desktop-renderer-preview.png",
                SHOWCASE / "desktop-setup-preview.png",
                SHOWCASE / "desktop-renderer-preview.mp4",
            )
        ],
    }
    (SHOWCASE / "desktop-capture.json").write_text(
        json.dumps(metadata, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(metadata, indent=2))


if __name__ == "__main__":
    main()
