#!/usr/bin/env python3
"""
InkWell Marketing Motion Design Video Renderer
Renders high-definition (1920x1080 @ 30fps) motion design video from index.html
via Playwright + Chromium and pipes frames directly into FFmpeg with synchronized audio.
"""

import http.server
import os
import pathlib
import shutil
import subprocess
import sys
import threading
import time
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent
PROJECT_ROOT = ROOT.parent
SOUNDTRACK = ROOT / "soundtrack.wav"
OUTPUT_VIDEO = ROOT / "inkwell_marketing_motion.mp4"
TOTAL_FRAMES = 1020  # 34.0 seconds @ 30 fps
FPS = 30
PORT = 8995

# Verify soundtrack exists
if not SOUNDTRACK.exists():
    print("Generating soundtrack first...")
    subprocess.run([sys.executable, str(ROOT / "generate_audio.py")], check=True)

# FFmpeg encoding process
ffmpeg_cmd = [
    "ffmpeg", "-y",
    "-f", "image2pipe",
    "-vcodec", "mjpeg",
    "-r", str(FPS),
    "-i", "-",
    "-i", str(SOUNDTRACK),
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-shortest",
    "-movflags", "+faststart",
    str(OUTPUT_VIDEO)
]

print("Starting FFmpeg encoder...")
proc = subprocess.Popen(
    ffmpeg_cmd,
    stdin=subprocess.PIPE,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.PIPE
)

frames_rendered = 0
start_time = 0

class FrameHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PROJECT_ROOT), **kwargs)

    def do_POST(self):
        global frames_rendered
        if self.path == '/frame':
            length = int(self.headers['Content-Length'])
            data = self.rfile.read(length)
            proc.stdin.write(data)
            frames_rendered += 1

            if frames_rendered % 60 == 0 or frames_rendered == TOTAL_FRAMES:
                pct = (frames_rendered / TOTAL_FRAMES) * 100
                elapsed = time.time() - start_time
                fps_actual = frames_rendered / max(0.1, elapsed)
                remaining = (TOTAL_FRAMES - frames_rendered) / max(0.1, fps_actual)
                print(f"  [Progress] {frames_rendered}/{TOTAL_FRAMES} frames ({pct:.1f}%) | "
                      f"{fps_actual:.1f} fps | {elapsed:.0f}s elapsed | ~{remaining:.0f}s left",
                      flush=True)

            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'ok')
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *args):
        pass

server = http.server.HTTPServer(('127.0.0.1', PORT), FrameHandler)
server_thread = threading.Thread(target=server.serve_forever, daemon=True)
server_thread.start()
print(f"HTTP Frame Receiver active on port {PORT}")

print("Launching Chromium headless browser...")
with sync_playwright() as pw:
    chrome_bin = shutil.which("chromium") or shutil.which("google-chrome-stable") or shutil.which("chrome")
    browser = pw.chromium.launch(
        executable_path=chrome_bin,
        headless=True,
        args=[
            "--allow-file-access-from-files",
            "--force-device-scale-factor=1",
            "--no-sandbox",
            "--disable-gpu",
            "--disable-dev-shm-usage"
        ]
    )
    context = browser.new_context(viewport={"width": 1920, "height": 1080})
    page = context.new_page()

    url = f"http://127.0.0.1:{PORT}/marketing_motion/index.html?render=1"
    print(f"Navigating to {url} ...")
    page.goto(url)
    page.wait_for_selector("#motionCanvas")

    # Give assets 1 second to load completely
    page.wait_for_timeout(1000)

    print(f"Beginning frame render pipeline ({TOTAL_FRAMES} frames @ 1080p)...")
    start_time = time.time()

    page.evaluate(f"""
    async () => {{
      const canvas = document.getElementById('motionCanvas');
      const total = {TOTAL_FRAMES};
      const fps = {FPS};
      for (let f = 0; f < total; f++) {{
        const t = f / fps;
        window.renderFrame(t, f);
        const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.90));
        await fetch('/frame', {{ method: 'POST', body: blob }});
      }}
      return true;
    }}
    """)

    total_time = time.time() - start_time
    print(f"Frame rendering complete! Rendered {frames_rendered} frames in {total_time:.1f}s ({frames_rendered/total_time:.1f} fps)")
    browser.close()

# Close ffmpeg input and finalize video
print("Finalizing video encoding with audio muxing...")
proc.stdin.close()
_, stderr = proc.communicate()

server.shutdown()

if proc.returncode != 0:
    print("FFmpeg encoding error:", stderr.decode('utf-8', errors='ignore'))
    sys.exit(proc.returncode)

size_mb = os.path.getsize(OUTPUT_VIDEO) / (1024 * 1024)
print(f"\n========================================================")
print(f"SUCCESS! Motion design video created: {OUTPUT_VIDEO}")
print(f"Duration: 34.0s | Resolution: 1920x1080 @ 30fps | Size: {size_mb:.2f} MB")
print(f"========================================================\n")
