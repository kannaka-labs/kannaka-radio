#!/bin/bash
# TSOF E12 render launcher (runs on O1). Clears ONLY its own output dir, launches
# the renderer detached, and prints the pid so the caller can wait with kill -0.
set -u
source ~/.kannaka-elevenlabs.env
OUT=/tmp/tsof12
rm -rf "$OUT"
mkdir -p "$OUT"
nohup python3 -u /tmp/tsof12-render.py /tmp/tsof12-script.txt "$OUT" /tmp/tsof12-voices.json > /tmp/tsof12-render.log 2>&1 &
echo "PID=$!"
