#!/bin/bash
# TSOF E09 render launcher (runs on O1). Clears ONLY its own output dir, launches
# the renderer detached, and prints the pid so the caller can wait with kill -0.
set -u
source ~/.kannaka-elevenlabs.env
OUT=/tmp/tsof09
rm -rf "$OUT"
mkdir -p "$OUT"
nohup python3 -u /tmp/render-dialogue3.py /tmp/tsof09-script.txt "$OUT" /tmp/tsof09-voices.json > /tmp/tsof09-render.log 2>&1 &
echo "PID=$!"
