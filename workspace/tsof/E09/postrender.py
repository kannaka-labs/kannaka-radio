#!/usr/bin/env python3
"""postrender.py — TSOF E09 local post-render chain.

1. per-voice POST-NORM LUFS from the turn files themselves (never the render log)
2. spread report (all voices within ~1 dB; NARRATOR may sit -0.5 dB by choice)
3. optional limiter-backed makeup for named speakers (--makeup SPK=dB ...)
Usage: python postrender.py TURNDIR [--makeup GARY=1.2 ...]
"""
import json, os, re, subprocess, sys
from collections import defaultdict

def measure(path):
    p = subprocess.run(["ffmpeg", "-i", path, "-af", "loudnorm=print_format=json", "-f", "null", "-"],
                       capture_output=True, text=True)
    j = json.loads(p.stderr[p.stderr.rfind("{"):p.stderr.rfind("}") + 1])
    return float(j["input_i"]), float(j["input_tp"])

def makeup(path, db):
    tmp = path + ".mk.mp3"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", path, "-af",
                    f"volume={db}dB,aresample=176400,alimiter=limit=0.891:level=false:attack=5:release=50,aresample=44100",
                    "-ar", "44100", "-ac", "1", "-b:a", "128k", tmp], check=True)
    os.replace(tmp, path)

turndir = sys.argv[1]
mk = {}
if "--makeup" in sys.argv:
    for a in sys.argv[sys.argv.index("--makeup") + 1:]:
        k, v = a.split("="); mk[k] = float(v)

script = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "script-render.txt"), encoding="utf-8").read()
speakers = re.findall(r"^\[([A-Z\-]+)\]", script, re.M)
files = sorted((f for f in os.listdir(turndir) if re.match(r"turn\d+-.*\.mp3$", f)),
               key=lambda f: int(re.match(r"turn(\d+)-", f).group(1)))
assert len(files) == len(speakers), (len(files), len(speakers))

per = defaultdict(list); total = 0.0
for f, spk in zip(files, speakers):
    p = os.path.join(turndir, f)
    if spk in mk:
        makeup(p, mk[spk])
    L, tp = measure(p)
    per[spk].append(L)
    d = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p],
                             capture_output=True, text=True).stdout.strip())
    total += d
avg = {s: sum(v) / len(v) for s, v in per.items()}
for s in sorted(avg, key=avg.get):
    print(f"{s:<12} n={len(per[s]):>2}  avg {avg[s]:6.2f} LUFS  min {min(per[s]):6.2f} max {max(per[s]):6.2f}")
non_narr = {s: a for s, a in avg.items() if s != "NARRATOR"}
spread = max(non_narr.values()) - min(non_narr.values())
print(f"spread (non-narrator) = {spread:.2f} dB ; narrator vs loudest = {max(non_narr.values()) - avg.get('NARRATOR', 0):.2f} dB")
print(f"raw turn audio total = {total:.1f}s (+ {0.4 * (len(files) - 1):.1f}s gaps = {total + 0.4 * (len(files) - 1):.1f}s before SFX)")
