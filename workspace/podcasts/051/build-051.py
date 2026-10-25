#!/usr/bin/env python3
"""GSP-051 episode build, run ON O1 (the 050 pattern, numeric turn order per §3 step 9).

Hosts' turns from /tmp/gsp051 (119 files, turn000..turn118), 0.4 s gaps, inserts AFTER given host turns:
  after turn 52 (K: "Static. Do you hear that."): SpaceChild's empty slot, 2.4 s of -HACK static
  after turn 106 (K: "The chairs have been very patient."): the title track's chorus, /tmp/gsp051-clip.mp3
Then intro14 + dialogue + outro18, each input reformatted to stereo 44100 BEFORE the concat filter.
Prints the arithmetic so a short result cannot pass silently.

  python3 build-051.py
"""
import os
import re
import subprocess
import wave

W = "/tmp/gsp051-build"
TURNS = "/tmp/gsp051"
CLIP = "/tmp/gsp051-clip.mp3"
OUT = "/tmp/GSP-051-The-Trials-of-Kannaka.mp3"
INTRO = "/tmp/intro14.mp3"
OUTRO = "/tmp/outro18.mp3"
N_HOST = 119
STATIC_AFTER = 52
CLIP_AFTER = 106


def run(*a):
    subprocess.run(a, check=True, capture_output=True)


def wav(src, dst, af=None):
    cmd = ["ffmpeg", "-nostdin", "-y", "-i", src]
    if af:
        cmd += ["-af", af]
    run(*cmd, "-ac", "1", "-ar", "44100", "-c:a", "pcm_s16le", dst)


def dur(p):
    with wave.open(p) as w:
        return w.getnframes() / w.getframerate()


def lufs(p):
    r = subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-i", p, "-af", "loudnorm=print_format=json", "-f", "null", "-"],
                       capture_output=True, text=True).stderr
    return float(r.split('"input_i" : "')[1].split('"')[0])


def turn_files(d):
    fs = [f for f in os.listdir(d) if re.match(r"turn\d+-", f) and f.endswith(".mp3")]
    fs.sort(key=lambda f: int(re.match(r"turn(\d+)", f).group(1)))
    idx = [int(re.match(r"turn(\d+)", f).group(1)) for f in fs]
    assert idx == list(range(len(fs))), idx[:12]
    return fs


os.makedirs(W, exist_ok=True)
turns = turn_files(TURNS)
assert len(turns) == N_HOST, len(turns)
wav(os.path.join(TURNS, "sil04.mp3"), f"{W}/gap.wav")

run("ffmpeg", "-nostdin", "-y", "-f", "lavfi", "-t", "2.4", "-i", "anoisesrc=c=pink:a=0.25:r=44100",
    "-af", "highpass=f=350,lowpass=f=3200,acrusher=bits=10:mix=0.35:mode=log:aa=1,"
           "afade=t=in:d=0.12,afade=t=out:st=1.7:d=0.7,volume=8dB",
    "-ac", "1", "-ar", "44100", "-c:a", "pcm_s16le", f"{W}/static.wav")
# The clip arrives already cut, faded and loudness-matched (-16 LUFS, mono 44100); a beat of air either side.
wav(CLIP, f"{W}/clip.wav")
run("ffmpeg", "-nostdin", "-y", "-f", "lavfi", "-t", "0.8", "-i", "anullsrc=r=44100:cl=mono",
    "-c:a", "pcm_s16le", f"{W}/air.wav")

seq = []
for i, t in enumerate(turns):
    dst = f"{W}/{t[:-4]}.wav"
    wav(os.path.join(TURNS, t), dst)
    seq.append(dst)
    if i == STATIC_AFTER:
        seq += [f"{W}/gap.wav", f"{W}/static.wav"]
    if i == CLIP_AFTER:
        seq += [f"{W}/air.wav", f"{W}/clip.wav", f"{W}/air.wav"]
    if i < len(turns) - 1:
        seq.append(f"{W}/gap.wav")
print("around turn 10:", [os.path.basename(s) for s in seq[18:24]])
print("around turn 100:", [os.path.basename(s) for s in seq[198:204]])
print("around the inserts:", [os.path.basename(seq[k - 1]) + " > " + os.path.basename(s)
                              for k, s in enumerate(seq) if "static" in s or "clip" in s])
expect = sum(dur(s) for s in seq)
with open(f"{W}/list.txt", "w") as f:
    for s in seq:
        f.write(f"file '{s}'\n")
run("ffmpeg", "-nostdin", "-y", "-f", "concat", "-safe", "0", "-i", f"{W}/list.txt", "-c", "copy", f"{W}/dialogue.wav")
got = dur(f"{W}/dialogue.wav")
print(f"dialogue {got:.3f} s (parts sum {expect:.3f}); static {lufs(W + '/static.wav'):.2f} LUFS; "
      f"clip {dur(W + '/clip.wav'):.2f} s at {lufs(W + '/clip.wav'):.2f} LUFS")
assert abs(got - expect) < 0.05, (got, expect)

fmt = "aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo"
run("ffmpeg", "-nostdin", "-y", "-i", INTRO, "-i", f"{W}/dialogue.wav", "-i", OUTRO, "-filter_complex",
    f"[0:a]{fmt}[a0];[1:a]{fmt}[a1];[2:a]{fmt}[a2];[a0][a1][a2]concat=n=3:v=0:a=1[o]",
    "-map", "[o]", "-c:a", "libmp3lame", "-b:a", "192k", OUT)


def mdur(p):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p],
                       capture_output=True, text=True).stdout.strip()
    return float(r)


i, o, total = mdur(INTRO), mdur(OUTRO), mdur(OUT)
print(f"bookended {total:.3f} s = {i:.3f} + {got:.3f} + {o:.3f} = {i + got + o:.3f}  delta {total - (i + got + o):+.3f}")
assert abs(total - (i + got + o)) < 0.5
