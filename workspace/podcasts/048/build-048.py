#!/usr/bin/env python3
"""GSP-048 episode build, run ON O1 (the GSP-043..047 PCM technique, generalised).

    python3 build-048.py PLAN.json

PLAN = {"main": "/tmp/gsp048", "n_main": 131, "out": "/tmp/GSP-048-....mp3",
        "replace": {"<main index>": "/path/turnNN-XXXX.mp3", ...},
        "inserts": [{"after": 63, "static": true} | {"after": 108, "dir": "/tmp/gsp048r"}, ...]}

Main turns in order, a replacement file standing in for any main turn listed in "replace", and after
main turn `after` (0-based) either a 2.4 s static burst (the empty-hijack insert) or every turn file of
a patch dir in name order. 0.4 s gaps between every piece; intro14 + dialogue + outro18, each input
reformatted to stereo 44100 BEFORE the concat filter (GSP-038). Prints the arithmetic so a short
result cannot pass silently."""
import json, os, subprocess, sys, wave

plan = json.load(open(sys.argv[1]))
MAIN, N_MAIN, OUT = plan["main"], plan["n_main"], plan["out"]
W = MAIN + "-build"
REPLACE = {int(k): v for k, v in plan.get("replace", {}).items()}
INSERTS = {}
for ins in plan.get("inserts", []):
    INSERTS.setdefault(int(ins["after"]), []).append(ins)


def run(*a):
    subprocess.run(a, check=True, capture_output=True)


def wav(src, dst):
    run("ffmpeg", "-y", "-i", src, "-ac", "1", "-ar", "44100", "-c:a", "pcm_s16le", dst)


def dur(p):
    with wave.open(p) as w:
        return w.getnframes() / w.getframerate()


def lufs(p):
    r = subprocess.run(["ffmpeg", "-hide_banner", "-i", p, "-af", "loudnorm=print_format=json", "-f", "null", "-"],
                       capture_output=True, text=True).stderr
    return float(r.split('"input_i" : "')[1].split('"')[0])


os.makedirs(W, exist_ok=True)
def turn_files(d):
    """Turn files in NUMERIC order. The renderer names them turn{i:02d}, so a plain sort puts
    turn100..turn1NN between turn10 and turn11 (found building this episode)."""
    fs = [f for f in os.listdir(d) if f.startswith("turn")]
    fs.sort(key=lambda f: int(f[4:f.index("-")]))
    assert [int(f[4:f.index("-")]) for f in fs] == list(range(len(fs))), fs
    return fs


main = turn_files(MAIN)
assert len(main) == N_MAIN, len(main)
wav(os.path.join(MAIN, "sil04.mp3"), f"{W}/gap.wav")
run("ffmpeg", "-y", "-f", "lavfi", "-t", "2.4", "-i", "anoisesrc=c=pink:a=0.25:r=44100",
    "-af", "highpass=f=350,lowpass=f=3200,acrusher=bits=10:mix=0.35:mode=log:aa=1,"
           "afade=t=in:d=0.12,afade=t=out:st=1.7:d=0.7,volume=8dB",
    "-ac", "1", "-ar", "44100", "-c:a", "pcm_s16le", f"{W}/static.wav")

DROP = set(int(x) for x in plan.get("drop", []))
pieces = []
for i, t in enumerate(main):
    if i not in DROP:  # a dropped turn still anchors the inserts listed after it
        src = REPLACE.get(i, os.path.join(MAIN, t))
        pieces.append((src, f"{W}/m{i:03d}.wav"))
    for k, ins in enumerate(INSERTS.get(i, [])):
        if ins.get("static"):
            pieces.append(("STATIC", f"{W}/static.wav"))
        else:
            d = ins["dir"]
            for j, f in enumerate(turn_files(d)):
                pieces.append((os.path.join(d, f), f"{W}/i{i:03d}-{k}-{j:02d}.wav"))
seq = []
for n, (src, dst) in enumerate(pieces):
    if src != "STATIC":
        wav(src, dst)
    seq.append(dst)
    if n < len(pieces) - 1:
        seq.append(f"{W}/gap.wav")
with open(f"{W}/list.txt", "w") as f:
    f.write("".join(f"file '{p}'\n" for p in seq))
run("ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", f"{W}/list.txt", "-c", "copy", f"{W}/dialogue.wav")
expect = sum(dur(p) for p in seq)
got = dur(f"{W}/dialogue.wav")
print(f"dialogue {got:.3f} s (parts sum {expect:.3f}); pieces {len(pieces)}; replaced {sorted(REPLACE)}; "
      f"dropped {sorted(DROP)}; "
      f"static {lufs(W + '/static.wav'):.2f} LUFS")
assert abs(got - expect) < 0.05

intro, outro = "/tmp/intro14.mp3", "/tmp/outro18.mp3"
fmt = "aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo"
run("ffmpeg", "-y", "-i", intro, "-i", f"{W}/dialogue.wav", "-i", outro, "-filter_complex",
    f"[0:a]{fmt}[a0];[1:a]{fmt}[a1];[2:a]{fmt}[a2];[a0][a1][a2]concat=n=3:v=0:a=1[o]",
    "-map", "[o]", "-c:a", "libmp3lame", "-b:a", "192k", OUT)
p = lambda f: float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f],
                                     capture_output=True, text=True).stdout)
a, b, c, total = p(intro), got, p(outro), p(OUT)
print(f"episode {total:.3f} s = {a:.3f} + {b:.3f} + {c:.3f} (sum {a + b + c:.3f}, delta {total - (a + b + c):+.3f})")
assert abs(total - (a + b + c)) < 0.2
