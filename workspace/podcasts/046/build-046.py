#!/usr/bin/env python3
"""GSP-046 episode build, run ON O1 (the GSP-043 PCM technique).

Turns -> wav, 0.4 s gaps, two inserts after given turns (a static burst where SpaceChild's hijack
would be, and the "AI for the People" clip), then intro14 + dialogue + outro18, each input
reformatted to stereo 44100 BEFORE the concat filter (GSP-038: the demuxer joins mono+stereo short).
Prints the arithmetic so a short result cannot pass silently."""
import json, os, subprocess, sys, wave

W = "/tmp/gsp046-build"
TURNS = "/tmp/gsp046b"
SONG = "/var/oled/kannaka/music/A Field Guide to Kannaka/07 - AI for the People.mp3"
CLIPS = json.load(open("/tmp/gsp046-clips.json"))
OUT = "/tmp/GSP-046-AI-for-the-People.mp3"


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
turns = sorted(f for f in os.listdir(TURNS) if f.startswith("turn"))
assert len(turns) == 109, len(turns)
wav(os.path.join(TURNS, "sil04.mp3"), f"{W}/gap.wav")

# insert 0: a static burst on an empty frequency (the renderer's -HACK noise, nobody speaking)
run("ffmpeg", "-y", "-f", "lavfi", "-t", "2.4", "-i", "anoisesrc=c=pink:a=0.25:r=44100",
    "-af", "highpass=f=350,lowpass=f=3200,acrusher=bits=10:mix=0.35:mode=log:aa=1,"
           "afade=t=in:d=0.12,afade=t=out:st=1.7:d=0.7,volume=8dB",
    "-ac", "1", "-ar", "44100", "-c:a", "pcm_s16le", f"{W}/static.wav")
# insert 1: the song, 73.80-132.05 s ("The radio's free" ... "For all."), mono first, then gain + oversampled limiter
raw = f"{W}/song-raw.wav"
wav(SONG, raw, "atrim=start=73.8:end=132.05,asetpts=PTS-STARTPTS,aformat=channel_layouts=mono,"
               "afade=t=in:d=0.8,afade=t=out:st=57.75:d=0.5")
g = round(-16.3 - lufs(raw), 2)
wav(raw, f"{W}/song.wav", f"volume={g}dB,aresample=176400,alimiter=limit=0.84:level=false:attack=5:release=50,aresample=44100")

after = {c["after_turn"]: ("static.wav" if c["label"].startswith("[CLIP 0") else "song.wav") for c in CLIPS}
assert set(after) == {67, 96}, after
seq = []
for i, t in enumerate(turns):
    dst = f"{W}/{t[:-4]}.wav"
    wav(os.path.join(TURNS, t), dst)
    seq.append(dst)
    if i in after:
        seq += [f"{W}/gap.wav", f"{W}/{after[i]}"]
    if i < len(turns) - 1:
        seq.append(f"{W}/gap.wav")
with open(f"{W}/list.txt", "w") as f:
    f.write("".join(f"file '{p}'\n" for p in seq))
run("ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", f"{W}/list.txt", "-c", "copy", f"{W}/dialogue.wav")
expect = sum(dur(p) for p in seq)
got = dur(f"{W}/dialogue.wav")
print(f"dialogue {got:.3f} s (parts sum {expect:.3f}); song gain {g} dB -> {lufs(W + '/song.wav'):.2f} LUFS; "
      f"static {lufs(W + '/static.wav'):.2f} LUFS")
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
