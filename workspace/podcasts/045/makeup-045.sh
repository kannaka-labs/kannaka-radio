#!/bin/bash
# GSP-045 per-turn limiter makeup for the two -HACK turns (the renderer normalises BEFORE
# the hijack effect, so they land ~3 dB quiet; GSP-043 ledger). Target -16.3 LUFS, between
# the hosts (K -16.50 / F -15.67). Then rebuild dialogue.mp3 from the renderer's own
# unchanged concat.txt with the renderer's own encode settings. Runs on O1 in /tmp/gsp045.
set -e
cd /tmp/gsp045
TARGET=-16.3
meas() { ffmpeg -hide_banner -i "$1" -af loudnorm=I=-16:TP=-1.5:print_format=json -f null - 2>&1 | grep input_i | tr -dc '0-9.-'; }
for pass in 1 2; do
  for f in turn42-SPAC.mp3 turn108-SPAC.mp3; do
    before=$(meas "$f"); sz0=$(stat -c %s "$f")
    gain=$(python3 -c "print(round($TARGET - ($before), 2))")
    ffmpeg -y -loglevel error -i "$f" -af "volume=${gain}dB,aresample=176400,alimiter=limit=0.89:level=false:attack=5:release=50,aresample=44100" \
      -ac 1 -ar 44100 -c:a libmp3lame -b:a 128k "tmp-$f"
    mv "tmp-$f" "$f"
    after=$(meas "$f"); sz1=$(stat -c %s "$f")
    echo "pass $pass $f  $before -> $after LUFS (gain $gain)  size $sz0 -> $sz1"
  done
done
before=$(stat -c %Y dialogue.mp3)
ffmpeg -y -loglevel error -f concat -safe 0 -i concat.txt -c:a libmp3lame -b:a 128k -ar 44100 dialogue.mp3
after=$(stat -c %Y dialogue.mp3)
[ "$after" -gt "$before" ] || { echo "dialogue.mp3 NOT rewritten"; exit 1; }
echo "dialogue $(ffprobe -v error -show_entries format=duration -of csv=p=0 dialogue.mp3) s (rewritten)"
