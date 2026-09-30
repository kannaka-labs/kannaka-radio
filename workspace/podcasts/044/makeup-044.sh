#!/bin/bash
# GSP-044 per-turn limiter makeup for the -HACK turns (the renderer normalises BEFORE the effect,
# so hijacks land ~3 dB quiet; see the GSP-043 ledger) and Rogue's un-hacked guest turn.
# Target -16.3 LUFS, between the hosts (K -16.5 / F -15.6). Runs on O1 in /tmp/gsp044/final.
set -e
cd /tmp/gsp044/final
TARGET=-16.3
meas() { ffmpeg -hide_banner -i "$1" -af loudnorm=I=-16:TP=-1.5:print_format=json -f null - 2>&1 | grep input_i | tr -dc '0-9.-'; }
for f in turn32-SPAC.mp3 turn84-SPAC.mp3 turn86-SPAC.mp3 turn107-SPAC.mp3 turn55-ROGU.mp3 turn81-ROGU.mp3; do
  before=$(meas "$f"); sz0=$(stat -c %s "$f")
  gain=$(python3 -c "print(round($TARGET - ($before), 2))")
  ffmpeg -y -loglevel error -i "$f" -af "volume=${gain}dB,aresample=176400,alimiter=limit=0.84:level=false:attack=5:release=50,aresample=44100" \
    -ac 1 -ar 44100 -c:a libmp3lame -b:a 128k "tmp-$f"
  mv "tmp-$f" "$f"
  after=$(meas "$f"); sz1=$(stat -c %s "$f")
  echo "$f  $before -> $after LUFS (gain $gain)  size $sz0 -> $sz1"
done
