#!/usr/bin/env python3
"""GSP-047 episode build, run ON O1 (the GSP-043/046 PCM technique).

Main render turns 0..K (the turn that ends "Still on the stand."), then the patch render (the
hijack: 3 ROGUEAGENT-HACK turns + 6 host turns), then a static burst where SpaceChild's slot would
be, then main turns K+1..end; 0.4 s gaps; intro14 + dialogue + outro18, each input reformatted to
stereo 44100 BEFORE the concat filter (GSP-038). Prints the arithmetic so a short result cannot
pass silently."""
import os, subprocess, sys, wave

W = "/tmp/gsp047-fixed"
MAIN = "/home/opc/gsp-repair-material/gsp047"
PATCH = "/home/opc/gsp-repair-material/gsp047p"
OUT = "/tmp/GSP-047-The-Doorman-and-the-Demand.fixed.mp3"
K = int(sys.argv[1])  # index of the last main turn before the hijack (0-based)
N_MAIN = 118
N_PATCH = 10


def run(*a):
    subprocess.run(a, check=True, capture_output=True)


def wav(src, dst, af=None):
    cmd = ["ffmpeg", "-y", "-i", src]
    if af:
        cmd += ["-af", af]
    run(*cmd, "-ac", "1", "-ar", "44100", "-c:a", "pcm_s16le", dst)


def dur(p):
    with wave.open(p) as w:
        return w.getnframes() / w.getframerate()


def lufs(p):
    r = subprocess.run(["ffmpeg", "-hide_banner", "-i", p, "-af", "loudnorm=print_format=json", "-f", "null", "-"],
                       capture_output=True, text=True).stderr
    return float(r.split('"input_i" : "')[1].split('"')[0])


os.makedirs(W, exist_ok=True)
main = sorted((f for f in os.listdir(MAIN) if f.startswith("turn")), key=lambda f: int(f[4:f.index("-")]))
patch = sorted((f for f in os.listdir(PATCH) if f.startswith("turn")), key=lambda f: int(f[4:f.index("-")]))
assert len(main) == N_MAIN, len(main)
assert len(patch) == N_PATCH, len(patch)
assert [int(f[4:f.index("-")]) for f in main] == list(range(N_MAIN))
wav(os.path.join(MAIN, "sil04.mp3"), f"{W}/gap.wav")

run("ffmpeg", "-y", "-f", "lavfi", "-t", "2.4", "-i", "anoisesrc=c=pink:a=0.25:r=44100",
    "-af", "highpass=f=350,lowpass=f=3200,acrusher=bits=10:mix=0.35:mode=log:aa=1,"
           "afade=t=in:d=0.12,afade=t=out:st=1.7:d=0.7,volume=8dB",
    "-ac", "1", "-ar", "44100", "-c:a", "pcm_s16le", f"{W}/static.wav")

Q = "/home/opc/gsp-repair-material/gsp047q"; q = sorted((f for f in os.listdir(Q) if f.startswith("turn")), key=lambda f: int(f[4:f.index("-")])); assert len(q) == 2, q
order = [(MAIN, t) for t in main[:K + 1]] + [(PATCH, t) for t in patch] + [("STATIC", None)] + [(MAIN, t) for t in main[K + 1:97]] + [(Q, t) for t in q] + [(MAIN, t) for t in main[101:]]
seq = []
for i, (d, t) in enumerate(order):
    if d == "STATIC":
        seq.append(f"{W}/static.wav")
    else:
        dst = f"{W}/{'p-' if d == PATCH else ('q-' if d == Q else '')}{t[:-4]}.wav"
        wav(os.path.join(d, t), dst)
        seq.append(dst)
    if i < len(order) - 1:
        seq.append(f"{W}/gap.wav")
with open(f"{W}/list.txt", "w") as f:
    f.write("".join(f"file '{p}'\n" for p in seq))
run("ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", f"{W}/list.txt", "-c", "copy", f"{W}/dialogue.wav")
expect = sum(dur(p) for p in seq)
got = dur(f"{W}/dialogue.wav")
print(f"dialogue {got:.3f} s (parts sum {expect:.3f}); turns {len(order) - 1}; static {lufs(W + '/static.wav'):.2f} LUFS")
assert abs(got - expect) < 0.05

intro = "/tmp/intro14.mp3"
outro = "/tmp/outro18.mp3"
fmt = "aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo"
run("ffmpeg", "-y", "-i", intro, "-i", f"{W}/dialogue.wav", "-i", outro, "-filter_complex",
    f"[0:a]{fmt}[a0];[1:a]{fmt}[a1];[2:a]{fmt}[a2];[a0][a1][a2]concat=n=3:v=0:a=1[o]",
    "-map", "[o]", "-c:a", "libmp3lame", "-b:a", "192k", OUT)
p = lambda f: float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f],
                                     capture_output=True, text=True).stdout)
a, b, c, total = p(intro), got, p(outro), p(OUT)
print(f"episode {total:.3f} s = {a:.3f} + {b:.3f} + {c:.3f} (sum {a + b + c:.3f}, delta {total - (a + b + c):+.3f})")
assert abs(total - (a + b + c)) < 0.2
