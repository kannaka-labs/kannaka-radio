#!/usr/bin/env python3
"""fx.py — TSOF E10 per-turn treatments, run after the render and before the mix.

  log   : the watch-log recorder band (TEODORA-LOG), same chain as E09/logfx.py
  phone : a landline band (LUND-PHONE), 300 Hz..3.4 kHz with firmer compression

Each treated turn is RE-NORMALISED to the target through the limiter, because an
effect chain moves loudness after the renderer's own normalisation.

Backups go to a SIBLING directory (TURNDIR/../turns-orig), never inside TURNDIR:
in E09 the `.orig` files inside turns/ were counted as turns and shifted the mix.

Usage: python fx.py TURNDIR MODE idx [idx ...] [--target -16.0]
"""
import json, os, re, shutil, subprocess, sys

CHAINS = {
    "log": "highpass=f=200,lowpass=f=5200,acompressor=threshold=-20dB:ratio=2.5:attack=6:release=90:makeup=2",
    "phone": "highpass=f=300,lowpass=f=3400,acompressor=threshold=-22dB:ratio=4:attack=4:release=80:makeup=3",
}


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
    turndir, mode, idxs = args[0], args[1], [int(x) for x in args[2:]]
    chain = CHAINS[mode]
    bakdir = os.path.join(os.path.dirname(os.path.abspath(turndir)), "turns-orig")
    os.makedirs(bakdir, exist_ok=True)
    files = {int(re.match(r"turn(\d+)-", f).group(1)): f
             for f in os.listdir(turndir) if re.match(r"turn\d+-.*\.mp3$", f)}
    for i in idxs:
        src = os.path.join(turndir, files[i])
        bak = os.path.join(bakdir, files[i])
        if not os.path.exists(bak):
            shutil.copy2(src, bak)
        before, _ = measure(bak)
        tmp = os.path.join(bakdir, files[i] + ".fx.mp3")
        run(["ffmpeg", "-y", "-i", bak, "-af", chain + ",aformat=sample_rates=44100:channel_layouts=mono",
             "-b:a", "128k", tmp])
        mid, _ = measure(tmp)
        gain = target - mid
        out = os.path.join(bakdir, files[i] + ".fx2.mp3")
        run(["ffmpeg", "-y", "-i", tmp, "-af",
             f"volume={gain:.2f}dB,aresample=176400,alimiter=limit=0.891:level=false:attack=5:release=50,aresample=44100",
             "-ar", "44100", "-ac", "1", "-b:a", "128k", out])
        os.remove(tmp)
        shutil.move(out, src)
        final, tp = measure(src)
        print(f"turn{i:02d} {mode}: {before:6.2f} -> fx {mid:6.2f} -> {gain:+.2f}dB -> {final:6.2f} LUFS (TP {tp:.2f})")


if __name__ == "__main__":
    main()
