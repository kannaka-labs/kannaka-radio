#!/usr/bin/env python3
"""
tsof-score-mix.py — lay music beds under sections of a rendered TSOF dialogue.

Rebuilds the episode dialogue from the renderer's per-turn files (with the
same 0.4s gaps), grouping turns into sections; sections named in the score
plan get a bed mixed underneath (trimmed to length, faded in/out, attenuated).

Usage:
  python scripts/tsof-score-mix.py TURNDIR PLAN.json OUT.mp3

PLAN.json:
  [{"from_turn": 0, "to_turn": 3, "bed": "path/to/bed.mp3",
    "gain_db": -22, "fade": 2.5, "bed_offset": 0.0}, ...]
Turn indexes are the renderer's (0-based). Regions not covered by any plan
entry pass through unscored. Entries must not overlap and must be ascending.
"""
import json, os, re, subprocess, sys, tempfile

TURNDIR = os.path.abspath(sys.argv[1])
PLAN_PATH, OUT = sys.argv[2], sys.argv[3]
raw_plan = json.load(open(PLAN_PATH, encoding="utf-8"))
plan = [e for e in raw_plan if "from_turn" in e]
sfx_entries = [e for e in raw_plan if "sfx_before_turn" in e]

def run(cmd):
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"cmd failed: {' '.join(cmd)}\n{p.stderr[-600:]}")
    return p.stdout

def duration(path):
    return float(run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                      "-of", "csv=p=0", path]).strip())

# Only rendered turns: a backup left beside one (turn12-x.mp3.orig, turn12-x.mp3.bak)
# is not a turn, and E09's first mix had two of them inside the arithmetic.
turns = sorted(
    (f for f in os.listdir(TURNDIR) if re.match(r"turn\d+-.*\.mp3$", f)),
    key=lambda f: int(re.match(r"turn(\d+)-", f).group(1)))
if not turns:
    sys.exit("no turn files found")
seen = {}
for f in turns:
    i = int(re.match(r"turn(\d+)-", f).group(1))
    if i in seen:
        sys.exit(f"turn {i} has two files: {seen[i]} and {f}; remove one")
    seen[i] = f
print(f"{len(turns)} turns")

work = tempfile.mkdtemp(prefix="tsofmix-")
sil = os.path.join(work, "sil04.mp3")
run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i",
     "anullsrc=r=44100:cl=mono", "-t", "0.4", "-b:a", "128k", sil])

# Point SFX: preprocess each entry (gain + codec-match) and index by turn.
# An entry {"sfx_before_turn": i, "sfx": path, "gain_db": -8} plays in the
# clear immediately before turn i (inside that turn's section, under its bed).
sfx_map = {}
for si, e in enumerate(sfx_entries):
    p = os.path.join(work, f"sfx{si}.mp3")
    run(["ffmpeg", "-y", "-loglevel", "error", "-i", e["sfx"],
         "-af", f"volume={e.get('gain_db', -8)}dB,"
                "aformat=sample_rates=44100:channel_layouts=mono",
         "-b:a", "128k", p])
    sfx_map.setdefault(e["sfx_before_turn"], []).append(p)
    print(f"sfx before turn {e['sfx_before_turn']}: {os.path.basename(e['sfx'])} {e.get('gain_db', -8)}dB")

# Build section boundaries: scored regions from the plan, unscored between.
bounds, cursor = [], 0
for e in sorted(plan, key=lambda e: e["from_turn"]):
    a, b = e["from_turn"], e["to_turn"]
    if a > cursor:
        bounds.append((cursor, a - 1, None))
    bounds.append((a, b, e))
    cursor = b + 1
if cursor <= len(turns) - 1:
    bounds.append((cursor, len(turns) - 1, None))

section_files = []
for si, (a, b, entry) in enumerate(bounds):
    concat = os.path.join(work, f"sec{si}.txt")
    with open(concat, "w", encoding="utf-8") as f:
        for i in range(a, b + 1):
            if i > a:
                f.write(f"file '{sil}'\n")
            for sp in sfx_map.get(i, []):
                f.write(f"file '{sp.replace(os.sep, '/')}'\n")
            f.write(f"file '{os.path.join(TURNDIR, turns[i]).replace(os.sep, '/')}'\n")
    dry = os.path.join(work, f"sec{si}-dry.mp3")
    run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
         "-i", concat, "-c:a", "libmp3lame", "-b:a", "128k", "-ar", "44100", dry])
    if not entry:
        section_files.append(dry)
        print(f"sec{si}: turns {a}-{b} dry {duration(dry):.1f}s")
        continue
    dur = duration(dry)
    gain = entry.get("gain_db", -22)
    fade = entry.get("fade", 2.5)
    off = entry.get("bed_offset", 0.0)
    wet = os.path.join(work, f"sec{si}-wet.mp3")
    bed_f = (f"atrim=start={off}:end={off + dur},asetpts=PTS-STARTPTS,"
             f"volume={gain}dB,afade=t=in:st=0:d={fade},"
             f"afade=t=out:st={max(0, dur - fade):.3f}:d={fade},"
             f"aformat=sample_rates=44100:channel_layouts=mono")
    run(["ffmpeg", "-y", "-loglevel", "error", "-i", dry,
         "-stream_loop", "-1", "-i", entry["bed"],
         "-filter_complex",
         f"[1:a]{bed_f}[bed];[0:a][bed]amix=inputs=2:duration=first:normalize=0[m]",
         "-map", "[m]", "-c:a", "libmp3lame", "-b:a", "128k", "-ar", "44100", wet])
    section_files.append(wet)
    print(f"sec{si}: turns {a}-{b} scored {os.path.basename(entry['bed'])} "
          f"{gain}dB {dur:.1f}s")

final_concat = os.path.join(work, "final.txt")
with open(final_concat, "w", encoding="utf-8") as f:
    for sf in section_files:
        f.write(f"file '{sf.replace(os.sep, '/')}'\n")
run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
     "-i", final_concat, "-c:a", "libmp3lame", "-b:a", "128k", "-ar", "44100", OUT])
print(f"OUT {OUT} {duration(OUT):.1f}s")
