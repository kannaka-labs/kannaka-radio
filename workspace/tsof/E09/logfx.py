#!/usr/bin/env python3
"""logfx.py — the watch-log recorder treatment for TEODORA-LOG turns (TSOF S2 cold-open device).

Gentler than the renderer's -MUFFLED/-HACK chains: a handheld recorder band
(200 Hz..5.2 kHz), light compression, then RE-NORMALISED to the target LUFS
through the limiter, because any effect chain changes loudness after the
renderer's own normalisation (GSP-043 lesson: measure the final file, not the
render log). In place, with a .orig backup.

Usage: python logfx.py TURNDIR idx [idx ...] [--target -16.0]
"""
import json, os, re, shutil, subprocess, sys

def measure(path):
    p = subprocess.run(["ffmpeg", "-i", path, "-af", "loudnorm=print_format=json", "-f", "null", "-"],
                       capture_output=True, text=True)
    j = json.loads(p.stderr[p.stderr.rfind("{"):p.stderr.rfind("}") + 1])
    return float(j["input_i"]), float(j["input_tp"])

def run(cmd):
    subprocess.run(cmd, check=True, capture_output=True)

def main():
    args = sys.argv[1:]
    target = -16.0
    if "--target" in args:
        i = args.index("--target"); target = float(args[i + 1]); del args[i:i + 2]
    turndir, idxs = args[0], [int(x) for x in args[1:]]
    files = {int(re.match(r"turn(\d+)-", f).group(1)): f for f in os.listdir(turndir) if re.match(r"turn\d+-", f)}
    for i in idxs:
        src = os.path.join(turndir, files[i])
        bak = src + ".orig"
        if not os.path.exists(bak):
            shutil.copy2(src, bak)
        before, _ = measure(bak)
        tmp = src + ".fx.mp3"
        run(["ffmpeg", "-y", "-i", bak, "-af",
             "highpass=f=200,lowpass=f=5200,acompressor=threshold=-20dB:ratio=2.5:attack=6:release=90:makeup=2,"
             "aformat=sample_rates=44100:channel_layouts=mono", "-b:a", "128k", tmp])
        mid, _ = measure(tmp)
        gain = target - mid
        out = src + ".fx2.mp3"
        run(["ffmpeg", "-y", "-i", tmp, "-af",
             f"volume={gain:.2f}dB,aresample=176400,alimiter=limit=0.891:level=false:attack=5:release=50,aresample=44100",
             "-ar", "44100", "-ac", "1", "-b:a", "128k", out])
        os.remove(tmp)
        os.replace(out, src)
        final, tp = measure(src)
        print(f"turn{i:02d} {files[i]}: {before:6.2f} -> fx {mid:6.2f} -> +{gain:.2f}dB -> {final:6.2f} LUFS (TP {tp:.2f})")

if __name__ == "__main__":
    main()
