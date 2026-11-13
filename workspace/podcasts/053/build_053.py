"""Build GSP-053 on O1: numeric-sorted turns + 0.4 s gaps, the SpaceChild static after turn index 60, then the bookends.
Usage: python3 build_053.py /tmp/gsp053 /tmp/gsp053-out <static_after_index>"""
import os, re, subprocess, sys, json
src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
STATIC_AFTER = int(sys.argv[3])  # 0-based index of the turn that ends "Listen."

def run(cmd):
    subprocess.run(cmd, check=True)

def dur(p):
    return float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p],
                                capture_output=True, text=True, check=True).stdout.strip())

files = [f for f in os.listdir(src) if re.match(r"turn\d+-[A-Z]+\.mp3$", f)]
files.sort(key=lambda f: int(re.match(r"turn(\d+)", f).group(1)))
idx = [int(re.match(r"turn(\d+)", f).group(1)) for f in files]
assert idx == list(range(len(files))), "turn indices are not contiguous 0..n-1"
assert files[STATIC_AFTER].endswith("KANN.mp3"), files[STATIC_AFTER]
print("turns", len(files), "| around 10:", files[9:12], "| static after:", files[STATIC_AFTER])

sil = os.path.join(out, "sil04.mp3")
run(["ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", "0.4",
     "-c:a", "libmp3lame", "-b:a", "128k", sil])
static = os.path.join(out, "static.mp3")
run(["ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.6:r=44100",
     "-t", "2.4", "-af", "highpass=f=350,lowpass=f=3200,acrusher=bits=6:mix=0.5,afade=t=in:d=0.15,afade=t=out:st=2.0:d=0.4,volume=1dB,alimiter=limit=0.89",
     "-ac", "1", "-c:a", "libmp3lame", "-b:a", "128k", static])
lines = []
for i, f in enumerate(files):
    lines.append(f"file '{os.path.join(src, f)}'")
    if i == STATIC_AFTER:
        lines += [f"file '{sil}'", f"file '{static}'"]
    if i < len(files) - 1:
        lines.append(f"file '{sil}'")
cc = os.path.join(out, "concat.txt")
open(cc, "w").write("\n".join(lines) + "\n")
dlg = os.path.join(out, "dialogue.mp3")
run(["ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", cc, "-c", "copy", dlg])
ep = os.path.join(out, "GSP-053-Wheres-My-Chinese-Spy.mp3")
run(["ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-i", "/tmp/intro14.mp3", "-i", dlg, "-i", "/tmp/outro18.mp3",
     "-filter_complex", "[0:a]aformat=sample_rates=44100:channel_layouts=stereo[a0];[1:a]aformat=sample_rates=44100:channel_layouts=stereo[a1];"
     "[2:a]aformat=sample_rates=44100:channel_layouts=stereo[a2];[a0][a1][a2]concat=n=3:v=0:a=1[o]",
     "-map", "[o]", "-c:a", "libmp3lame", "-b:a", "192k", ep])
di, do_, dd, de = dur("/tmp/intro14.mp3"), dur("/tmp/outro18.mp3"), dur(dlg), dur(ep)
st = subprocess.run(["ffmpeg", "-nostdin", "-i", static, "-af", "ebur128", "-f", "null", "-"], capture_output=True, text=True).stderr
lufs = [l for l in st.splitlines() if l.strip().startswith("I:")][-1].strip()
print(json.dumps({"intro": di, "dialogue": dd, "outro": do_, "episode": de, "sum": di + dd + do_, "delta": de - (di + dd + do_), "static_lufs": lufs}))
