import json, os, re, subprocess, sys, urllib.request

script_path, outdir = sys.argv[1], sys.argv[2]
os.makedirs(outdir, exist_ok=True)
KEY = os.environ["ELEVENLABS_API_KEY"]
VOICES = {"KANNAKA": "NTqGiNK8P02i66yY2GOH", "FLAUKOWSKI": "XaEUesE01wKIKaa0xI0h"}
SETTINGS = {
    "KANNAKA": {"stability": 0.5, "similarity_boost": 0.75, "style": 0.25},
    "FLAUKOWSKI": {"stability": 0.45, "similarity_boost": 0.75, "style": 0.4},
}
# Per-voice loudness targets (GSP-021 feedback: Flaukowski still read a touch
# quiet after the flat -16 equalization; he now sits 1 dB hotter). Every turn
# is gain-matched here BEFORE any muffle effect.
TARGET_LUFS = {"KANNAKA": -16.0, "FLAUKOWSKI": -15.0}
MAX_TP = -1.0        # true-peak ceiling after gain

# Optional 3rd arg: a voices.json for multi-cast episodes (TSOF drama).
# {"SPEAKER": {"voice_id": "...", "stability": .5, "similarity_boost": .75,
#              "style": .2, "target_lufs": -16.0}, ...}
# Without it the two-voice podcast cast above stays exactly as before.
if len(sys.argv) > 3:
    cast = json.load(open(sys.argv[3], encoding="utf-8"))
    VOICES = {s: c["voice_id"] for s, c in cast.items()}
    SETTINGS = {s: {"stability": c.get("stability", 0.5),
                    "similarity_boost": c.get("similarity_boost", 0.75),
                    "style": c.get("style", 0.2)} for s, c in cast.items()}
    TARGET_LUFS = {s: c.get("target_lufs", -16.0) for s, c in cast.items()}

_names = "|".join(re.escape(s) for s in VOICES)
text = open(script_path, encoding="utf-8").read()
# Tag suffixes: -MUFFLED (hand over the mic) and -HACK (a pirate hijacking the
# broadcast, the recurring bit from GSP-043). An unknown suffix would not match,
# so its line would be swallowed into the previous speaker's turn and read aloud
# in the wrong voice; unclaimed tags are therefore refused below.
_fx = r"-MUFFLED|-HACK"
TURN_RE = re.compile(
    rf"\[({_names})({_fx})?\]\s*(.+?)(?=\n\[(?:{_names})(?:{_fx})?\]|\Z)",
    re.S,
)
turns = TURN_RE.findall(text)
_claimed = {f"[{s}{m}]" for s, m, _ in turns}
_unclaimed = sorted({t for t in re.findall(r"^\[[^\]\n]+\]", text, re.M)} - _claimed)
if _unclaimed:
    sys.exit(f"refusing to render: tags with no cast entry or unknown suffix: {_unclaimed}")
print(f"{len(turns)} turns ({sum(1 for _, m, _ in turns if m == '-MUFFLED')} muffled, "
      f"{sum(1 for _, m, _ in turns if m == '-HACK')} hijacked)")

def tts(speaker, line, dest):
    req = urllib.request.Request(
        f"https://api.elevenlabs.io/v1/text-to-speech/{VOICES[speaker]}?output_format=mp3_44100_128",
        data=json.dumps({
            "text": line.strip(),
            "model_id": "eleven_multilingual_v2",
            "voice_settings": SETTINGS[speaker],
        }).encode(),
        headers={"xi-api-key": KEY, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=300) as r, open(dest, "wb") as f:
        f.write(r.read())
    sz = os.path.getsize(dest)
    words = len(line.split())
    if sz < words * 500:
        raise RuntimeError(f"suspiciously small render {dest}: {sz}B for {words}w")
    return sz

def measure_lufs(path):
    r = subprocess.run(
        ["ffmpeg", "-i", path, "-af",
         "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"],
        capture_output=True, text=True)
    m = re.search(r"\{[^{}]*\}", r.stderr[-2000:], re.S)
    d = json.loads(m.group(0))
    return float(d["input_i"]), float(d["input_tp"])

def normalize(path, speaker):
    # Plain gain only while the true-peak ceiling allows it; peaky turns (most
    # ElevenLabs output) take the full gain through a limiter instead. The old
    # TP-capped plain gain left them 2-3 dB short of target and could invert
    # the K/F balance (GSP-022 shipped F 0.8 dB quieter than K before makeup).
    lufs, tp = measure_lufs(path)
    needed = TARGET_LUFS[speaker] - lufs
    if abs(needed) < 0.3:
        return lufs, 0.0, lufs
    if needed > 0 and needed > MAX_TP - tp:
        af = (f"volume={needed:.2f}dB,alimiter=limit={10 ** (MAX_TP / 20):.3f}"
              ":level=false:attack=5:release=50")
    else:
        af = f"volume={needed:.2f}dB"
    tmp = path.replace(".mp3", "-norm.mp3")
    subprocess.run(["ffmpeg", "-y", "-i", path, "-af", af,
                    "-b:a", "128k", tmp], check=True, capture_output=True)
    os.replace(tmp, path)
    final, _ = measure_lufs(path)
    return lufs, needed, final

files = []
finals = {}
for i, (spk, muf, line) in enumerate(turns):
    dest = os.path.join(outdir, f"turn{i:02d}-{spk[:4]}.mp3")
    sz = tts(spk, line, dest)
    lufs, gain, final = normalize(dest, spk)
    finals.setdefault(spk, []).append(final)
    if muf == "-MUFFLED":
        # hand-over-the-mic: darken and duck, keep it legible as comedy
        muffled = dest.replace(".mp3", "-muf.mp3")
        subprocess.run(
            ["ffmpeg", "-y", "-i", dest, "-af", "lowpass=f=700,volume=0.5",
             "-b:a", "128k", muffled],
            check=True, capture_output=True,
        )
        os.replace(muffled, dest)
    elif muf == "-HACK":
        # pirate hijack: a burst of static, the voice squeezed into a narrow
        # radio band and lightly bit-crushed, then static out. Still legible:
        # the words are the joke, so the effect must never eat them.
        hacked = dest.replace(".mp3", "-hack.mp3")
        subprocess.run(
            ["ffmpeg", "-y",
             "-f", "lavfi", "-t", "0.35", "-i", "anoisesrc=c=pink:a=0.25:r=44100",
             "-i", dest,
             "-f", "lavfi", "-t", "0.25", "-i", "anoisesrc=c=pink:a=0.2:r=44100",
             "-filter_complex",
             "[0:a]aformat=sample_rates=44100:channel_layouts=mono,afade=t=out:st=0.2:d=0.15[n0];"
             "[1:a]aformat=sample_rates=44100:channel_layouts=mono,"
             "highpass=f=350,lowpass=f=3200,acrusher=bits=10:mix=0.35:mode=log:aa=1,volume=0.95[v];"
             "[2:a]aformat=sample_rates=44100:channel_layouts=mono,afade=t=in:d=0.1[n1];"
             "[n0][v][n1]concat=n=3:v=0:a=1[out]",
             "-map", "[out]", "-ar", "44100", "-ac", "1", "-b:a", "128k", hacked],
            check=True, capture_output=True,
        )
        os.replace(hacked, dest)
    tag = {"-MUFFLED": " MUF", "-HACK": " HCK"}.get(muf, "    ")
    print(f"  turn{i:02d} {spk:<10}{tag} {len(line.split()):>4}w {sz//1024:>5}KB {lufs:>6.1f}->{final:>6.1f}LUFS {gain:+.1f}dB")
    files.append(dest)

for spk, vals in sorted(finals.items()):
    avg = sum(vals) / len(vals)
    off = "" if abs(avg - TARGET_LUFS[spk]) <= 0.5 else "  ** OFF TARGET **"
    print(f"POST-NORM {spk}: {avg:.2f} LUFS avg over {len(vals)} turns (target {TARGET_LUFS[spk]}){off}")

sil = os.path.join(outdir, "sil04.mp3")
subprocess.run(["ffmpeg", "-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono",
                "-t", "0.4", "-b:a", "128k", sil], check=True, capture_output=True)
concat = os.path.join(outdir, "concat.txt")
with open(concat, "w") as f:
    for i, fp in enumerate(files):
        if i:
            f.write(f"file '{sil}'\n")
        f.write(f"file '{fp}'\n")
out = os.path.join(outdir, "dialogue.mp3")
subprocess.run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", concat,
                "-c:a", "libmp3lame", "-b:a", "128k", "-ar", "44100", out],
               check=True, capture_output=True)
dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                            "-of", "csv=p=0", out], capture_output=True, text=True).stdout.strip())
total_words = sum(len(l.split()) for _, _, l in turns)
print(f"DIALOGUE {out} {dur:.0f}s ({dur/60:.1f}min) {total_words}w -> {total_words/(dur/60):.0f} wpm")
