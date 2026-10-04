#!/bin/bash
# TSOF E11 render launcher (runs on O1). Clears ONLY its own output dir, launches
# the renderer detached, and prints the pid so the caller can wait with kill -0.
set -u
source ~/.kannaka-elevenlabs.env
OUT=/tmp/tsof11
rm -rf "$OUT"
mkdir -p "$OUT"
nohup python3 -u /tmp/tsof11-render.py /tmp/tsof11-script.txt "$OUT" /tmp/tsof11-voices.json > /tmp/tsof11-render.log 2>&1 &
echo "PID=$!"
