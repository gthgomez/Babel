"""Render recorded CLI stdout; optional Python Playwright, Chromium and FFmpeg required."""
from pathlib import Path
from functools import partial
from html import escape
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import threading
from playwright.sync_api import sync_playwright

folder = Path(__file__).resolve().parent
capture = json.loads((folder / 'capture.json').read_text())
version = (folder / 'version.txt').read_text().strip()
help_text = (folder / 'help.txt').read_text()
doctor = (folder / 'doctor.txt').read_text()
guide = help_text[help_text.index('Command Guide:'):help_text.index('Notes:')].strip()
intro = help_text[:help_text.index('Commands:')].strip()
scenes = [
    ('Version and entrypoint', '$ node babel-cli/dist/index.js --version\n' + version + '\n\n$ node babel-cli/dist/index.js --help\n' + intro),
    ('Choose an entrypoint', '$ node babel-cli/dist/index.js --help\n[Command Guide excerpt from the recorded stdout]\n\n' + guide),
    ('Read the environment diagnosis', '$ node babel-cli/dist/index.js doctor --scope env\n' + doctor.strip()),
]
html = '''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Babel — offline CLI stdout</title><style>
*{box-sizing:border-box}body{margin:0;padding:36px;background:#10131c;color:#e8ebf5;font-family:system-ui,sans-serif}.wrap{max-width:1200px;margin:auto}header{display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:1px solid #3c4258;padding-bottom:22px}h1{font-size:28px;margin:0}header p{color:#bcc1d3;font-size:16px;margin:8px 0 0}.badge{padding:10px 12px;border:1px solid #50698e;background:#202e45;border-radius:5px;font-size:14px;white-space:nowrap}h2{font-size:21px;color:#adbdff;margin:24px 0 16px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#1a2030;border:1px solid #3c4258;border-radius:7px;padding:24px;font:18px/1.5 "DejaVu Sans Mono",monospace;margin:0}.scene{display:none}.scene.active{display:block}footer{color:#b6bed3;font-size:15px;margin-top:21px;line-height:1.5}nav{margin-top:16px}button{background:#28334c;border:1px solid #66789e;border-radius:5px;color:#edf1ff;padding:7px 12px;margin:0 6px 6px 0;cursor:pointer}button:focus{outline:2px solid #adbdff}@media(max-width:600px){body{padding:16px}header{display:block}header p{font-size:14px}.badge{display:inline-block;margin-top:12px}pre{font-size:13px;padding:14px}h1{font-size:24px}}
</style><div class="wrap"><header><div><h1>Babel · real CLI stdout</h1><p>Paced playback of local commands · source ''' + escape(capture['sourceRevision'][:12]) + '''</p></div><span class="badge">OFFLINE · CLI ''' + escape(version) + '</span></header>'
for i, (title, output) in enumerate(scenes):
    html += f'<section class="scene {"active" if i == 0 else ""}"><h2>{i+1}/3 · {escape(title)}</h2><pre>{escape(output)}</pre></section>'
html += '''<footer>CLI orientation · temporary empty provider profile · network denied<br>No model session, code edits, or verified coding result. Runtime warnings and full stdout are recorded alongside this viewer.</footer><nav aria-label="Playback controls"><button onclick="pick(0)">Version</button><button onclick="pick(1)">Command guide</button><button onclick="pick(2)">Doctor</button><button onclick="clearInterval(timer)">Pause</button></nav></div><script>let current=0;function pick(index){current=index;document.querySelectorAll('.scene').forEach((s,i)=>s.classList.toggle('active',i===index))}const timer=setInterval(()=>pick((current+1)%3),6000);</script></html>'''
(folder / 'viewer.html').write_text(html)

class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietHandler, directory=str(folder)))
threading.Thread(target=server.serve_forever, daemon=True).start()
url = f'http://127.0.0.1:{server.server_port}/viewer.html'
try:
    with tempfile.TemporaryDirectory(prefix='babel-showcase-media-') as temp:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), args=['--no-sandbox'])
            context = browser.new_context(viewport={'width':1280,'height':900}, record_video_dir=temp, record_video_size={'width':1280,'height':900})
            page = context.new_page()
            page.goto(url)
            page.wait_for_timeout(6500)
            assert page.locator('.scene.active').inner_text().startswith('2/3')
            page.locator('.wrap').screenshot(path=str(folder / 'cli-help.png'))
            page.wait_for_timeout(6000)
            assert page.locator('.scene.active').inner_text().startswith('3/3')
            page.locator('.wrap').screenshot(path=str(folder / 'cli-doctor.png'))
            page.wait_for_timeout(5500)
            video = page.video
            context.close()
            video_path = video.path()
            mobile = browser.new_page(viewport={'width':390,'height':844})
            mobile.goto(url)
            mobile.evaluate('clearInterval(timer)')
            for i in range(3):
                mobile.evaluate('pick', i)
                assert mobile.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
            browser.close()
        subprocess.run(['ffmpeg','-v','error','-y','-i',video_path,'-t','18','-an','-c:v','libx264','-crf','25','-pix_fmt','yuv420p','-movflags','+faststart',str(folder/'offline-cli.mp4')],check=True)
        subprocess.run(['ffmpeg','-v','error','-y','-i',str(folder/'offline-cli.mp4'),'-filter_complex','fps=4,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer','-loop','0',str(folder/'offline-cli.gif')],check=True)
    probe = json.loads(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration:stream=width,height','-of','json',str(folder/'offline-cli.mp4')]))
    assets = []
    for name in ['cli-help.png','cli-doctor.png','offline-cli.mp4','offline-cli.gif','viewer.html']:
        path = folder/name
        assets.append({'path':name,'bytes':path.stat().st_size,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
    (folder/'media.json').write_text(json.dumps({'sourceCaptureSha256':hashlib.sha256((folder/'capture.json').read_bytes()).hexdigest(),'method':'Chromium recording/screenshots of the local stdout viewer; GIF encoded from the same video','mobileCheck':'all three scenes fit 390px without horizontal overflow','video':probe,'assets':assets},indent=2)+'\n')
    print('Captured 18-second stdout playback, GIF, two screenshots, and media hashes; mobile layout passed.')
finally:
    server.shutdown()
