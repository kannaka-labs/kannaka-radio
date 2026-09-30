#!/usr/bin/env python3
"""GSP-044 build (from build-043.py): splice the song "Rogue Agent" (whole, 2:47) into the dialogue,
bookend it, and render an all-stills slideshow frame-exact to the episode audio. There is no
music video for this song, so the song plays over stills.

    python build-044.py audio   <render_dir> <after_turn_index>
    python build-044.py video

audio: reads the renderer's turn files + sil04.mp3 from <render_dir>, inserts
clip01.mp3 after turn <after_turn_index> (with a 0.4 s gap each side), and builds
intro14 + dialogue + outro18 in PCM so every boundary is sample-exact. Writes the
episode mp3 and timing.json (T_pre = where the song starts in the final episode).

video: reuses podcast-slideshow.py's own render_segment/make_cover/FPS unchanged, so
every still is encoded exactly as the show always encodes them; the stills before the
song sum to exactly round(T_pre*24) frames, the music video is scaled to 1920x1080
and padded to round(T_clip*24) frames, then the stills after it. Every gate prints
its arithmetic; an exit code proves nothing.
"""
import importlib.util
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PODCASTS = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(PODCASTS))
BUILD = os.path.join(HERE, "build")
os.makedirs(BUILD, exist_ok=True)
EP_MP3 = os.path.join(HERE, "GSP-044-The-Rise-of-Rogue-Agent.mp3")
TIMING = os.path.join(BUILD, "timing.json")
CLIP_MP3 = os.path.join(BUILD, "clip01.mp3")
RENDERS = os.path.join(PODCASTS, "renders")
FINAL = os.path.join(RENDERS, "GSP-044-slideshow.mp4")


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        sys.exit(f"FAILED: {' '.join(cmd)}\n{r.stderr[-2000:]}")
    return r.stdout


def dur(p):
    return float(run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                      "-of", "csv=p=0", p]).strip())


def samples(wav):
    """Exact duration of a PCM wav from its sample count."""
    out = run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-count_packets",
               "-show_entries", "stream=sample_rate,duration_ts", "-of", "json", wav])
    s = json.loads(out)["streams"][0]
    return int(s["duration_ts"]) / int(s["sample_rate"])


def to_wav(src, dst, stereo=True):
    run(["ffmpeg", "-y", "-loglevel", "error", "-i", src, "-ac", "2" if stereo else "1",
         "-ar", "44100", "-c:a", "pcm_s16le", dst])
    return dst


def concat_wav(files, dst):
    lst = dst + ".txt"
    with open(lst, "w", encoding="utf-8") as f:
        for p in files:
            f.write(f"file '{p.replace(os.sep, '/')}'\n")
    run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lst,
         "-c:a", "pcm_s16le", dst])
    return dst


def cmd_audio(render_dir, after):
    after = int(after)
    import re
    turns = [f for f in os.listdir(render_dir) if re.fullmatch(r"turn\d+-[A-Z0-9-]{1,4}\.mp3", f)]
    turns.sort(key=lambda f: int(re.match(r"turn(\d+)", f).group(1)))
    idx = [int(re.match(r"turn(\d+)", f).group(1)) for f in turns]
    assert idx == list(range(len(turns))), f"turn files not contiguous: {idx[:5]}..."
    print(f"{len(turns)} turn files; clip after turn{after:02d} ({turns[after]})")
    w = os.path.join(BUILD, "wav")
    os.makedirs(w, exist_ok=True)
    sil = to_wav(os.path.join(render_dir, "sil04.mp3"), os.path.join(w, "sil04.wav"))
    tw = [to_wav(os.path.join(render_dir, t), os.path.join(w, t[:-4] + ".wav")) for t in turns]
    clip = to_wav(CLIP_MP3, os.path.join(w, "clip01.wav"))
    intro = to_wav(os.path.join(PODCASTS, "012", "intro14.mp3"), os.path.join(w, "intro.wav"))
    outro = to_wav(os.path.join(PODCASTS, "012", "outro18.mp3"), os.path.join(w, "outro.wav"))

    pre, post = [intro], []
    for i, t in enumerate(tw):
        tgt = pre if i <= after else post
        if i:
            tgt.append(sil)
        tgt.append(t)
    pre.append(sil)          # 0.4 s gap before the song
    post = post[:]           # post already starts with the sil that preceded turn after+1
    post.append(outro)
    pre_w = concat_wav(pre, os.path.join(BUILD, "pre.wav"))
    post_w = concat_wav(post, os.path.join(BUILD, "post.wav"))
    full_w = concat_wav([pre_w, clip, post_w], os.path.join(BUILD, "episode.wav"))

    T_intro, T_pre, T_clip, T_post = samples(intro), samples(pre_w), samples(clip), samples(post_w)
    T_outro = samples(outro)
    T_turns = sum(samples(t) for t in tw)
    T_sil = samples(sil)
    n_gaps = (len(tw) - 1) + 1  # between turns, plus one extra gap around the clip
    D = T_turns + n_gaps * T_sil
    run(["ffmpeg", "-y", "-loglevel", "error", "-i", full_w, "-c:a", "libmp3lame", "-b:a", "192k",
         "-ar", "44100", EP_MP3])
    T_ep = dur(EP_MP3)
    expect = T_intro + D + T_clip + T_outro
    print(f"ARITHMETIC intro {T_intro:.3f} + dialogue {D:.3f} (turns {T_turns:.3f} + {n_gaps} gaps x {T_sil:.3f})"
          f" + clip {T_clip:.3f} + outro {T_outro:.3f} = {expect:.3f}")
    print(f"           pre {T_pre:.3f} + clip {T_clip:.3f} + post {T_post:.3f} = {T_pre + T_clip + T_post:.3f}")
    print(f"           episode mp3 probed {T_ep:.3f}  delta {T_ep - expect:+.3f}"
          f"  {'OK' if abs(T_ep - expect) <= 0.1 else '** GATE FAIL **'}")
    json.dump({"T_pre": T_pre, "T_clip": T_clip, "T_post": T_post, "T_ep": T_ep,
               "dialogue": D, "turns": len(tw), "after": after}, open(TIMING, "w"), indent=1)


def load_slideshow():
    spec = importlib.util.spec_from_file_location("ps", os.path.join(ROOT, "scripts", "podcast-slideshow.py"))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def frames(p):
    out = run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames",
               "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", p])
    return int(out.strip().split(",")[0])


def still_plan(total_frames, n_slides):
    base, extra = divmod(total_frames, n_slides)
    return [base + (1 if i < extra else 0) for i in range(n_slides)]


def cmd_video():
    ps = load_slideshow()
    FPS = ps.FPS
    t = json.load(open(TIMING))
    imgs = [l.strip() for l in open(os.path.join(HERE, "images.txt"), encoding="utf-8") if l.strip()]
    work = os.path.join(RENDERS, "GSP-044-work")
    os.makedirs(work, exist_ok=True)
    F_all = round(t["T_ep"] * FPS)
    F_cover = round(ps.COVER_SECONDS * FPS)
    n = max(1, round((F_all - F_cover) / FPS / ps.SLIDE_SECONDS))
    assert n <= len(imgs), f"need {n} images, have {len(imgs)}"
    plan = still_plan(F_all - F_cover, n)
    plan[-1] += round(1.5 * FPS)   # the usual tail pad; -shortest trims it
    print(f"PLAN F_all {F_all} = cover {F_cover} + {n} slides {plan}")
    cover = os.path.join(RENDERS, "GSP-044-cover.png")
    if not os.path.exists(cover):
        ps.make_cover({"num": 44, "title": "The Rise of Rogue Agent"}, imgs[0], cover)
    jobs = [(cover, F_cover, os.path.join(work, "seg-000.mp4"), False, True, True)]
    for i, fr in enumerate(plan):
        jobs.append((imgs[i], fr, os.path.join(work, f"seg-{i + 1:03d}.mp4"), True, i < n - 1, False))
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=ps.SEG_WORKERS) as pool:
        futs = [pool.submit(ps.render_segment, img, fr / FPS, out, fi, fo, cov)
                for img, fr, out, fi, fo, cov in jobs]
        for f in futs:
            f.result()
    bad = [(os.path.basename(o), fr, frames(o)) for _, fr, o, *_ in jobs if frames(o) != fr]
    print(f"SEGMENT FRAME CHECK: {len(jobs)} segments, mismatches {bad}")
    cl = os.path.join(work, "all.txt")
    with open(cl, "w", encoding="utf-8") as f:
        for j in jobs:
            f.write(f"file '{os.path.basename(j[2])}'\n")
    video = os.path.join(work, "video.mp4")
    run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", cl, "-c", "copy", video])
    errs = subprocess.run(["ffmpeg", "-v", "error", "-i", video, "-f", "null", "-"],
                          capture_output=True, text=True).stderr.strip()
    print(f"DECODE CHECK: {'clean' if not errs else errs[:800]}")
    run(["ffmpeg", "-y", "-loglevel", "error", "-i", video, "-i", EP_MP3, "-map", "0:v", "-map", "1:a",
         "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart",
         "-shortest", FINAL])
    vd, ad = dur(FINAL), dur(EP_MP3)
    print(f"FINAL {vd:.3f}s vs episode {ad:.3f}s  delta {vd - ad:+.3f}  {'OK' if abs(vd - ad) <= 2.0 else '** DRIFT **'}")
    json.dump({"F_all": F_all, "slides": n, "images": imgs[:n]},
              open(os.path.join(BUILD, "video-plan.json"), "w"), indent=1)


if __name__ == "__main__":
    if sys.argv[1] == "audio":
        cmd_audio(sys.argv[2], sys.argv[3])
    elif sys.argv[1] == "video":
        cmd_video()
