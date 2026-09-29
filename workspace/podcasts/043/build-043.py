#!/usr/bin/env python3
"""GSP-043 build: splice the music video's song into the dialogue, bookend it, and
render a slideshow that SHOWS the music video while the song plays.

    python build-043.py audio   <render_dir> <after_turn_index>
    python build-043.py video

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
EP_MP3 = os.path.join(HERE, "GSP-043-What-the-Boundary-Knows.mp3")
TIMING = os.path.join(BUILD, "timing.json")
CLIP_MP3 = os.path.join(BUILD, "clip01.mp3")
CLIP_MP4 = os.path.join(BUILD, "show_me_the_receipt.mp4")
RENDERS = os.path.join(PODCASTS, "renders")
FINAL = os.path.join(RENDERS, "GSP-043-slideshow.mp4")


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
    work = os.path.join(RENDERS, "GSP-043-work")
    os.makedirs(work, exist_ok=True)

    F_pre = round(t["T_pre"] * FPS)
    F_clip = round(t["T_clip"] * FPS)
    F_post = round(t["T_post"] * FPS)
    F_cover = round(ps.COVER_SECONDS * FPS)
    n_pre = max(1, round((F_pre - F_cover) / FPS / ps.SLIDE_SECONDS))
    n_post = max(1, round(F_post / FPS / ps.SLIDE_SECONDS))
    assert n_pre + n_post <= len(imgs), f"need {n_pre + n_post} images, have {len(imgs)}"
    pre_frames = still_plan(F_pre - F_cover, n_pre)
    post_frames = still_plan(F_post, n_post)
    post_frames[-1] += round(1.5 * FPS)   # the usual tail pad; -shortest trims it
    print(f"PLAN F_pre {F_pre} = cover {F_cover} + {n_pre} slides {pre_frames}")
    print(f"     F_clip {F_clip} (T_clip {t['T_clip']:.3f})")
    print(f"     F_post {F_post} (+{round(1.5 * FPS)} pad) = {n_post} slides {post_frames}")

    cover = os.path.join(RENDERS, "GSP-043-cover.png")
    ep = {"num": 43, "title": "What the Boundary Knows"}
    if not os.path.exists(cover):
        ps.make_cover(ep, imgs[0], cover)

    jobs = [(cover, F_cover, os.path.join(work, "seg-000.mp4"), False, True, True)]
    k = 0
    for i, fr in enumerate(pre_frames):
        jobs.append((imgs[k], fr, os.path.join(work, f"pre-{i:03d}.mp4"), True, True, False)); k += 1
    for i, fr in enumerate(post_frames):
        jobs.append((imgs[k], fr, os.path.join(work, f"post-{i:03d}.mp4"), True, i < len(post_frames) - 1, False)); k += 1

    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=ps.SEG_WORKERS) as pool:
        futs = [pool.submit(ps.render_segment, img, fr / FPS, out, fi, fo, cov)
                for img, fr, out, fi, fo, cov in jobs]
        for f in futs:
            f.result()
    bad = []
    for img, fr, out, *_ in jobs:
        got = frames(out)
        if got != fr:
            bad.append((os.path.basename(out), fr, got))
    print(f"SEGMENT FRAME CHECK: {len(jobs)} segments, mismatches {bad}")

    # the music video, scaled to the slideshow frame and padded to exactly F_clip frames
    clipv = os.path.join(work, "clip-1080.mp4")
    if not os.path.exists(clipv):
        src_frames = frames(CLIP_MP4)
        pad = max(0, F_clip - src_frames)
        run(["ffmpeg", "-y", "-loglevel", "error", "-i", CLIP_MP4, "-an", "-vf",
             f"scale=1920:1080:flags=lanczos,setsar=1,fps={FPS},format=yuv420p,"
             f"tpad=stop_mode=clone:stop={pad},trim=end_frame={F_clip}",
             "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-r", str(FPS), clipv])
    print(f"CLIP frames {frames(clipv)} (want {F_clip})")

    # join: re-encode through the concat FILTER, trimming each part to its exact frame
    # count, so a segment that came out a frame long or short can't shift the sync.
    pre_list = [j[2] for j in jobs if "seg-000" in j[2] or "pre-" in j[2]]
    post_list = [j[2] for j in jobs if "post-" in j[2]]
    parts = []
    for name, lst in (("pre", pre_list), ("post", post_list)):
        cl = os.path.join(work, f"{name}.txt")
        with open(cl, "w", encoding="utf-8") as f:
            for p in lst:
                f.write(f"file '{os.path.basename(p)}'\n")
        outp = os.path.join(work, f"{name}-video.mp4")
        run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", cl, "-c", "copy", outp])
        parts.append(outp)
    pre_v, post_v = parts
    fp, fq = frames(pre_v), frames(post_v)
    print(f"PARTS pre {fp} (want {F_pre})  clip {frames(clipv)} (want {F_clip})  post {fq} (want >= {F_post})")
    if fp != F_pre:
        sys.exit("** GATE FAIL: pre part is not frame-exact; the song would drift against the video **")

    video = os.path.join(work, "video.mp4")
    cl = os.path.join(work, "all.txt")
    with open(cl, "w", encoding="utf-8") as f:
        for p in (pre_v, clipv, post_v):
            f.write(f"file '{os.path.basename(p)}'\n")
    run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", cl, "-c", "copy", video])
    errs = subprocess.run(["ffmpeg", "-v", "error", "-i", video, "-f", "null", "-"],
                          capture_output=True, text=True).stderr.strip()
    print(f"DECODE CHECK: {'clean' if not errs else errs[:800]}")
    run(["ffmpeg", "-y", "-loglevel", "error", "-i", video, "-i", EP_MP3, "-map", "0:v", "-map", "1:a",
         "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart",
         "-shortest", FINAL])
    vd, ad = dur(FINAL), dur(EP_MP3)
    print(f"FINAL {vd:.3f}s vs episode {ad:.3f}s  delta {vd - ad:+.3f}  "
          f"{'OK' if abs(vd - ad) <= 2.0 else '** DRIFT **'}  sync err |F_pre/24 - T_pre| = "
          f"{abs(F_pre / FPS - t['T_pre']) * 1000:.1f} ms")
    json.dump({"F_pre": F_pre, "F_clip": F_clip, "F_post": F_post, "images": imgs[:k]},
              open(os.path.join(BUILD, "video-plan.json"), "w"), indent=1)


if __name__ == "__main__":
    if sys.argv[1] == "audio":
        cmd_audio(sys.argv[2], sys.argv[3])
    elif sys.argv[1] == "video":
        cmd_video()
