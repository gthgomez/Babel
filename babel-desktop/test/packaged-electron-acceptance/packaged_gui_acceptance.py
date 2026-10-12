"""Launch the installed Babel Desktop Electron app (not a renderer API double)."""
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = ROOT / 'artifacts'
ARTIFACTS.mkdir(exist_ok=True)


def main():
    if os.name != 'nt':
        report = {
            'skipped': True,
            'reason': 'Packaged Electron GUI acceptance runs only on Windows installers',
            'platform': sys.platform,
        }
        (ARTIFACTS / 'packaged-electron-acceptance.json').write_text(json.dumps(report, indent=2))
        print(json.dumps(report, indent=2))
        return

    install_root = os.environ.get('BABEL_DESKTOP_INSTALL_ROOT')
    if not install_root:
        raise SystemExit('BABEL_DESKTOP_INSTALL_ROOT is required')
    install = Path(install_root)
    exe = install / 'Babel Desktop.exe'
    build_path = install / 'BUILD.json'
    if not exe.is_file():
        raise SystemExit(f'Missing packaged executable: {exe}')
    if not build_path.is_file():
        raise SystemExit(f'Missing BUILD.json beside install root: {build_path}')

    build = json.loads(build_path.read_text(encoding='utf-8'))
    source_sha = os.environ.get('BABEL_DESKTOP_SOURCE_SHA', '').strip()
    checks = []
    errors = []

    from playwright.sync_api import sync_playwright

    profile = tempfile.mkdtemp(prefix='babel-desktop-gui-')
    args = [str(exe), f'--profile-dir={profile}']
    with sync_playwright() as playwright:
        app = playwright.electron.launch(args=args, timeout=120_000)
        try:
            window = app.first_window
            window.wait_for_load_state('domcontentloaded', timeout=60_000)
            window.wait_for_selector('#preview-badge', timeout=60_000)
            badge = window.locator('#preview-badge').inner_text()
            assert badge == 'REFERENCE PREVIEW', badge
            checks.append('preview badge visible in packaged Electron renderer')
            window.screenshot(path=str(ARTIFACTS / 'packaged-electron-window.png'), full_page=True)
            checks.append('screenshot captured from packaged Electron window')
            if source_sha:
                recorded = str(build.get('sourceSha') or build.get('source_sha') or '')
                assert recorded.lower() == source_sha.lower(), f'BUILD.json source {recorded} != {source_sha}'
                checks.append('BUILD.json source identity matches CI checkout')
        finally:
            app.close()

    report = {
        'passed': len(checks),
        'basis': 'Installed Babel Desktop.exe via Playwright Electron driver',
        'installRoot': str(install),
        'build': {k: build.get(k) for k in ('version', 'sourceSha', 'source_sha', 'commit') if k in build},
        'checks': checks,
        'errors': errors,
    }
    (ARTIFACTS / 'packaged-electron-acceptance.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
    if errors:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
