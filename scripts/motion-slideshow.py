#!/usr/bin/env python3
"""
motion-slideshow.py — render a Ghost Signals episode as a 1920x1080 MOTION
slideshow: the same house layout as podcast-slideshow.py (art blur-filled to
1920x1080 behind a sharp 1080x1080 centre panel, generated cover card first),
but the stills move.

  * Ken Burns per slide: zoompan on a 4x-oversampled panel (8 % push,
    alternating in/out, seeded pan) with the blurred background drifting the
    opposite way (6 %, parallax).
  * 1 s crossfades (xfade) between every segment, cover card included.
  * A faint waveform of the episode audio (mode=line, screen blend, default
    12 %) confined to a bottom band in the blurred side margins only, never
    across the art panel.
  * Seeded temporal luma grain, a static scanline overlay and a soft vignette.

Usage:
  python scripts/motion-slideshow.py 44
  python scripts/motion-slideshow.py --images-from images.txt 44 [--force]
      [--crf 22] [--grain light|normal] [--workers 2] [--wave-opacity 0.12]
      [--episodes FILE] [--out FILE]

The episode's audio and title come from workspace/podcasts/episodes.json,
exactly as podcast-slideshow.py resolves them. --images-from takes absolute
paths, one per line; the first is the cover art. Output is
workspace/podcasts/renders/GSP-0NN-motion.mp4, so the still slideshow
(GSP-0NN-slideshow.mp4) is never overwritten.

Everything is planned in integer frames at 24 fps. With n segments and a
24-frame crossfade, sum(segment frames) = F_audio + (n-1)*24, so the video is
exactly round(audio * 24) frames. The render is written to a .part file and
only renamed into place after ffprobe confirms the duration (within 0.1 s of
the audio), the frame count and tv colour range; otherwise it exits 1.

Segments are reused across runs only when ffprobe confirms their frame count,
duration, size, pixel format and colour range; anything else is deleted and
re-rendered. A segment's file name carries a hash of its image and filtergraph,
so a changed plan never reuses a stale segment.

This box is a 4-core laptop: keep --workers at 2 and never run two renders at
once. A 20-minute episode takes roughly an hour.
"""
import argparse
import hashlib
import importlib.util
import json
import os
import random
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PODCASTS = os.path.join(ROOT, "workspace", "podcasts")
ART_DIR = os.path.join(PODCASTS, "art")
RENDERS = os.path.join(PODCASTS, "renders")
EPISODES_JSON = os.path.join(PODCASTS, "episodes.json")

# --- shared with podcast-slideshow.py (values copied, behaviour unchanged there)
FPS = 24
COVER_SECONDS = 6.0
SLIDE_SECONDS = 45.0
PRESET = "medium"

# --- motion parameters
GRAPH_VERSION = 1            # bump when a segment graph changes meaning
XFADE_FRAMES = 24            # 1.0 s crossfade at 24 fps
COVER_FRAMES = round(COVER_SECONDS * FPS)
SEG_CRF = "14"               # near-lossless intermediates, re-encoded once
SEG_PRESET = "veryfast"
OVERSAMPLE = 4               # panel oversampling for sub-pixel zoompan steps
ZOOM_AMT = 0.08              # 8 % push over a slide
BG_ZOOM_AMT = 0.06           # background counter-move (parallax)
W, H = 1920, 1080
PANEL = 1080
PANEL_X = (W - PANEL) // 2   # 420: the blurred margins are x < 420 and x >= 1500
WAVE_BAND = 140              # waveform band height, flush with the bottom edge
WAVE_COLOURS = "0xB9A6EE|0x8A6FD0"   # house purple
GRAIN = {"light": 4, "normal": 7}
SCANLINE_ALPHA = 18          # 0-255, every 3rd row
VIGNETTE = "PI/6"
DURATION_TOLERANCE_S = 0.1
MAX_WORKERS = 4

# Every RGB/PNG -> YUV conversion goes through this. ffmpeg 8 otherwise tags
# PNG -> yuv420p (and RGB -> YUV) as full range (yuvj420p / pc) and players
# lift the blacks.
TO_TV = "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p"
FROM_TV = "scale=in_color_matrix=bt709:in_range=tv"
COLOUR_TAGS = ["-color_range", "tv", "-colorspace", "bt709",
               "-color_primaries", "bt709", "-color_trc", "bt709"]


# ---------------------------------------------------------------------------
# Pure functions (tested in test/python/test_motion_slideshow.py)
# ---------------------------------------------------------------------------
def slide_count(audio_frames, cover_frames=COVER_FRAMES, fps=FPS, slide_seconds=SLIDE_SECONDS):
    """Art slides after the cover: the still renderer's rule, max(3, round(body / 45 s))."""
    return max(3, round((audio_frames - cover_frames) / fps / slide_seconds))


def plan_frames(total_frames, n_art, cover_frames=COVER_FRAMES, xfade=XFADE_FRAMES):
    """Integer frame plan for [cover, art_1 .. art_n].

    Each of the n_art crossfades overlaps two segments by `xfade` frames, so
    sum(plan) == total_frames + n_art * xfade and the xfade chain is exactly
    total_frames long. The art frames are split with divmod (earlier slides
    take the remainder). Raises ValueError if any segment is too short to hold
    its own transitions."""
    if n_art < 1:
        raise ValueError("need at least one art slide")
    body = total_frames - cover_frames + n_art * xfade
    base, extra = divmod(body, n_art)
    art = [base + (1 if i < extra else 0) for i in range(n_art)]
    plan = [cover_frames] + art
    for i, f in enumerate(plan):
        sides = (i > 0) + (i < len(plan) - 1)          # transitions this segment takes part in
        if f < sides * xfade + 1:
            raise ValueError(f"segment {i} has {f} frames, needs > {sides * xfade} for its crossfades")
    assert sum(plan) == total_frames + (len(plan) - 1) * xfade
    return plan


def xfade_offsets(plan, xfade=XFADE_FRAMES):
    """Start frame of crossfade k (k = 1..n-1): sum(plan[:k]) - k * xfade."""
    return [sum(plan[:k]) - k * xfade for k in range(1, len(plan))]


def chain_frames(plan, xfade=XFADE_FRAMES):
    """Length of the xfade chain: the last offset plus the last segment."""
    if len(plan) == 1:
        return plan[0]
    return xfade_offsets(plan, xfade)[-1] + plan[-1]


def frames_to_seconds(frames, fps=FPS):
    """Frame count as a seconds string, floored to the microsecond, so ffmpeg's
    rounding can never push a transition one frame late."""
    us = (frames * 1_000_000) // fps
    return f"{us // 1_000_000}.{us % 1_000_000:06d}"


def derive_seeds(episode):
    """Pan and grain seeds from the episode number alone, so a re-render of an
    episode moves and grains identically. Both fit ffmpeg's int seed range."""
    h = hashlib.sha256(f"kannaka-radio/motion-slideshow/ep{int(episode)}".encode()).digest()
    return {"pan": int.from_bytes(h[0:4], "big"),
            "noise": int.from_bytes(h[4:8], "big") & 0x7FFFFFFF}


def motion_plan(seed, n):
    """Per-slide Ken Burns: zoom alternates in/out; pan endpoints in [0.3, 0.7]
    (0.5 = centred) drawn from a seeded RNG."""
    rng = random.Random(seed)
    plans = []
    for i in range(n):
        ax, ay = rng.uniform(0.3, 0.7), rng.uniform(0.3, 0.7)
        bx, by = 1.0 - ax, 1.0 - ay
        if rng.random() < 0.5:                       # sometimes pan mostly along one axis
            by = ay + rng.uniform(-0.08, 0.08)
        plans.append({"zoom_in": i % 2 == 0, "x0": round(ax, 4), "y0": round(ay, 4),
                      "x1": round(bx, 4), "y1": round(by, 4)})
    return plans


def _zoompan_expr(frames, zoom_in, amt, x0, y0, x1, y1):
    p = f"(on/{max(1, frames - 1)})"
    z = f"1+{amt}*{p}" if zoom_in else f"(1+{amt})-{amt}*{p}"
    x = f"(iw-iw/zoom)*({x0}+({x1}-{x0})*{p})"
    y = f"(ih-ih/zoom)*({y0}+({y1}-{y0})*{p})"
    return z, x, y


def motion_segment_graph(frames, plan):
    """One art slide -> `frames` frames of 1920x1080 motion, tv-range yuv420p."""
    fz, fx, fy = _zoompan_expr(frames, plan["zoom_in"], ZOOM_AMT,
                               plan["x0"], plan["y0"], plan["x1"], plan["y1"])
    bz, bx, by = _zoompan_expr(frames, not plan["zoom_in"], BG_ZOOM_AMT,
                               plan["x1"], plan["y1"], plan["x0"], plan["y0"])
    big = PANEL * OVERSAMPLE
    return (
        f"[0:v]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},"
        f"boxblur=28:2,eq=brightness=-0.22,scale={W * 2}:{H * 2}:flags=bicubic,"
        f"zoompan=z='{bz}':x='{bx}':y='{by}':d={frames}:s={W}x{H}:fps={FPS}[bg];"
        f"[0:v]scale={big}:{big}:flags=lanczos,"
        f"zoompan=z='{fz}':x='{fx}':y='{fy}':d={frames}:s={PANEL}x{PANEL}:fps={FPS}[fg];"
        f"[bg][fg]overlay=(W-w)/2:(H-h)/2:format=auto,setsar=1,{TO_TV}[v]"
    )


def cover_segment_graph():
    """The cover card (already 1920x1080) held still, tv-range yuv420p."""
    return f"[0:v]scale={W}:{H},setsar=1,{TO_TV}[v]"


def assemble_graph(plan, audio_idx, scan_idx, wave_opacity, grain_strength, noise_seed,
                   xfade=XFADE_FRAMES):
    """xfade chain -> margin waveform band -> scanlines -> grain -> vignette."""
    n = len(plan)
    total = chain_frames(plan, xfade)
    fade_s = frames_to_seconds(xfade)
    parts = []
    prev = "[0:v]"
    for k, off in enumerate(xfade_offsets(plan, xfade), start=1):
        lab = f"[x{k}]"
        parts.append(f"{prev}[{k}:v]xfade=transition=fade:duration={fade_s}:"
                     f"offset={frames_to_seconds(off)}{lab}")
        prev = lab
    if n == 1:
        parts.append("[0:v]null[x0]")
        prev = "[x0]"
    if wave_opacity > 0:
        band_y = H - WAVE_BAND
        parts += [
            f"{prev}split[b0][b1]",
            f"[b1]crop={W}:{WAVE_BAND}:0:{band_y},{FROM_TV},format=gbrp[band]",
            # the waveform, blacked out over the art panel: screen-blending
            # black changes nothing, so it only shows in the blurred margins
            f"[{audio_idx}:a]aformat=channel_layouts=mono,"
            f"showwaves=s={W}x{WAVE_BAND}:mode=line:rate={FPS}:scale=sqrt:draw=full:"
            f"colors={WAVE_COLOURS},format=gbrp,"
            f"drawbox=x={PANEL_X}:y=0:w={PANEL}:h={WAVE_BAND}:color=black:t=fill,"
            f"gblur=sigma=2[wave]",
            f"[band][wave]blend=all_mode=screen:all_opacity={wave_opacity}:shortest=1,{TO_TV}[lit]",
            f"[b0][lit]overlay=0:{band_y}[comp]",
        ]
        prev = "[comp]"
    parts.append(
        f"{prev}[{scan_idx}:v]overlay=0:0:shortest=1,"
        f"noise=c0s={grain_strength}:c0f=t+u:all_seed={noise_seed},"
        f"vignette=angle={VIGNETTE},{TO_TV},trim=end_frame={total},setpts=PTS-STARTPTS[v]"
    )
    return ";".join(parts)


def segment_acceptable(probe, planned_frames, fps=FPS):
    """A reused segment is accepted only if ffprobe proves it is the planned
    one: exact frame count, a duration matching that frame count to within
    half a frame, 1920x1080, yuv420p, tv range. File size is never evidence:
    a truncated or half-written file can be large."""
    if not probe:
        return False
    try:
        frames = int(probe.get("nb_frames"))
        dur = float(probe.get("duration"))
    except (TypeError, ValueError):
        return False
    return (frames == planned_frames
            and abs(dur - planned_frames / fps) <= 0.5 / fps
            and int(probe.get("width", 0)) == W and int(probe.get("height", 0)) == H
            and probe.get("pix_fmt") == "yuv420p"
            and probe.get("color_range") == "tv")


def segment_name(index, image, graph):
    """seg-NNN-<hash>.mp4; the hash covers everything that shapes the pixels."""
    key = json.dumps({"v": GRAPH_VERSION, "img": os.path.abspath(image), "graph": graph,
                      "crf": SEG_CRF, "preset": SEG_PRESET})
    return f"seg-{index:03d}-{hashlib.sha256(key.encode()).hexdigest()[:12]}.mp4"


# ---------------------------------------------------------------------------
# ffmpeg / ffprobe
# ---------------------------------------------------------------------------
def run(cmd):
    p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if p.returncode != 0:
        raise RuntimeError(f"cmd failed ({p.returncode}): {' '.join(cmd)}\n{p.stderr[-1500:]}")
    return p


def probe_video(path):
    """ffprobe the first video stream; None if the file is missing or unreadable."""
    if not os.path.exists(path):
        return None
    p = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                        "stream=nb_frames,duration,width,height,pix_fmt,color_range",
                        "-of", "json", path], capture_output=True, text=True)
    if p.returncode != 0:
        return None
    try:
        streams = json.loads(p.stdout).get("streams") or []
    except ValueError:
        return None
    return streams[0] if streams else None


def probe_format_duration(path):
    out = run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
               "-of", "default=nw=1:nk=1", path]).stdout
    return float(out.strip().splitlines()[0])


def render_segment(index, image, frames, graph, is_cover, out, force=False):
    """Render one segment unless an ffprobe-verified copy already exists.
    Returns 'reused' or 'rendered'; raises if the fresh render fails the check."""
    if not force and segment_acceptable(probe_video(out), frames):
        return "reused"
    if os.path.exists(out):
        os.remove(out)
    part = out[:-4] + ".part.mp4"
    src = ["-loop", "1", "-framerate", str(FPS), "-i", image] if is_cover else ["-i", image]
    run(["ffmpeg", "-y", "-loglevel", "error", *src, "-filter_complex", graph, "-map", "[v]",
         "-frames:v", str(frames), "-c:v", "libx264", "-preset", SEG_PRESET, "-crf", SEG_CRF,
         "-pix_fmt", "yuv420p", *COLOUR_TAGS, "-r", str(FPS), part])
    probe = probe_video(part)
    if not segment_acceptable(probe, frames):
        raise RuntimeError(f"segment {index} failed its check after render: planned {frames} frames, got {probe}")
    os.replace(part, out)
    return "rendered"


def make_scanlines(path):
    if probe_video(path):
        return path
    run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i",
         f"color=c=black@0.0:s={W}x{H},format=rgba,"
         f"geq=r=0:g=0:b=0:a='if(eq(mod(Y\\,3)\\,0)\\,{SCANLINE_ALPHA}\\,0)'",
         "-frames:v", "1", path])
    return path


def render_motion(images, cover_png, audio, out, episode, crf=22, grain="light", workers=2,
                  wave_opacity=0.12, force=False, cover_frames=COVER_FRAMES,
                  xfade=XFADE_FRAMES, n_art=None, log=print):
    """Render `out` from a cover PNG + art images over `audio`. `images` is
    cycled to the slide count. Returns the report dict; raises SystemExit(1)
    when the final checks fail (the unverified file stays at <out>.part.mp4)."""
    t0 = time.perf_counter()
    audio_s = probe_format_duration(audio)
    total = round(audio_s * FPS)
    n_art = n_art or slide_count(total, cover_frames)
    reps = -(-n_art // len(images))
    arts = (list(images) * reps)[:n_art]
    plan = plan_frames(total, n_art, cover_frames, xfade)
    seeds = derive_seeds(episode)
    motion = motion_plan(seeds["pan"], n_art)
    log(f"PLAN {total} frames ({audio_s:.3f} s audio) = cover {plan[0]} + {n_art} slides "
        f"{plan[1:]} - {n_art} x {xfade}-frame crossfades; seeds {seeds}")

    work = out[:-4] + "-work"
    os.makedirs(work, exist_ok=True)
    jobs = [(0, cover_png, plan[0], cover_segment_graph(), True)]
    for i, (img, fr, mp) in enumerate(zip(arts, plan[1:], motion), start=1):
        jobs.append((i, img, fr, motion_segment_graph(fr, mp), False))
    seg_paths = [os.path.join(work, segment_name(i, img, g)) for i, img, _, g, _ in jobs]
    keep = {os.path.basename(p) for p in seg_paths}
    for f in os.listdir(work):                       # segments of an older plan
        if re.fullmatch(r"seg-\d{3}-[0-9a-f]{12}(\.part)?\.mp4", f) and f not in keep:
            os.remove(os.path.join(work, f))

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futs = [pool.submit(render_segment, i, img, fr, g, cov, path, force)
                for (i, img, fr, g, cov), path in zip(jobs, seg_paths)]
        states = [f.result() for f in futs]
    t_seg = time.perf_counter() - t0
    log(f"SEGMENTS {len(jobs)}: {states.count('rendered')} rendered, {states.count('reused')} reused "
        f"(each verified by ffprobe), {t_seg:.1f} s wall, {workers} workers")

    scan = make_scanlines(os.path.join(work, "scanlines.png"))
    audio_idx, scan_idx = len(jobs), len(jobs) + 1
    graph = assemble_graph(plan, audio_idx, scan_idx, wave_opacity, GRAIN[grain],
                           seeds["noise"], xfade)
    part = out[:-4] + ".part.mp4"
    # -benchmark reports at info level; -nostats keeps that level quiet otherwise
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "info", "-nostats", "-benchmark"]
    for s in seg_paths:
        cmd += ["-threads", "1", "-i", s]           # all decoders open at once; keep them small
    cmd += ["-i", audio, "-loop", "1", "-framerate", str(FPS), "-i", scan,
            "-filter_complex", graph, "-map", "[v]", "-map", f"{audio_idx}:a",
            "-frames:v", str(total), "-c:v", "libx264", "-preset", PRESET, "-crf", str(crf),
            "-pix_fmt", "yuv420p", *COLOUR_TAGS, "-r", str(FPS),
            "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", part]
    t1 = time.perf_counter()
    res = run(cmd)
    t_asm = time.perf_counter() - t1
    bench = dict(re.findall(r"(\w+)=([\d.]+\w*)", " ".join(
        ln for ln in (res.stdout + res.stderr).splitlines() if ln.startswith("bench:"))))

    probe = probe_video(part) or {}
    video_s = probe_format_duration(part)
    delta = video_s - audio_s
    checks = {
        "duration": abs(delta) <= DURATION_TOLERANCE_S,
        "frames": str(probe.get("nb_frames")) == str(total),
        "color_range": probe.get("color_range") == "tv",
        "pix_fmt": probe.get("pix_fmt") == "yuv420p",
    }
    size = os.path.getsize(part)
    report = {
        "out": out, "episode": episode, "audio": audio, "audio_s": audio_s, "video_s": video_s,
        "delta_s": round(delta, 4), "frames_planned": total, "frames_out": probe.get("nb_frames"),
        "color_range": probe.get("color_range"), "pix_fmt": probe.get("pix_fmt"), "bytes": size,
        "plan": plan, "xfade_frames": xfade, "seeds": seeds, "motion": motion,
        "images": [cover_png] + arts, "crf": crf, "grain": grain, "wave_opacity": wave_opacity,
        "workers": workers, "segments": states, "wall_segments_s": round(t_seg, 1),
        "wall_assemble_s": round(t_asm, 1), "wall_total_s": round(time.perf_counter() - t0, 1),
        "ffmpeg_bench": bench, "checks": checks, "filter_graph": graph,
    }
    with open(os.path.join(work, "report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, indent=1)
    log(f"FINAL {probe.get('nb_frames')} frames (planned {total}), video {video_s:.3f} s, "
        f"audio {audio_s:.3f} s, delta {delta:+.3f} s, color_range {probe.get('color_range')}, "
        f"{size / 1e6:.1f} MB, assemble {t_asm:.1f} s, total {report['wall_total_s']} s")
    failed = [k for k, ok in checks.items() if not ok]
    if failed:
        log(f"CHECK FAILED: {failed}; unverified render left at {part}")
        raise SystemExit(1)
    os.replace(part, out)
    log(f"OK -> {out}")
    return report


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _load_still_renderer():
    spec = importlib.util.spec_from_file_location("podcast_slideshow", os.path.join(HERE, "podcast-slideshow.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _workers(v):
    n = int(v)
    if not 1 <= n <= MAX_WORKERS:
        raise argparse.ArgumentTypeError(f"--workers must be 1..{MAX_WORKERS}")
    return n


def _opacity(v):
    x = float(v)
    if not 0.0 <= x <= 1.0:
        raise argparse.ArgumentTypeError("--wave-opacity must be 0..1")
    return x


def parse_args(argv):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("episode", type=int, help="episode number in episodes.json")
    ap.add_argument("--images-from", metavar="FILE",
                    help="ordered image list, absolute paths, first = cover art")
    ap.add_argument("--force", action="store_true", help="re-render segments and the final")
    ap.add_argument("--crf", type=int, default=22, help="final x264 crf (default 22)")
    ap.add_argument("--grain", choices=sorted(GRAIN), default="light")
    ap.add_argument("--workers", type=_workers, default=2, help=f"parallel segments, 1..{MAX_WORKERS} (default 2)")
    ap.add_argument("--wave-opacity", type=_opacity, default=0.12, help="0 disables the waveform")
    ap.add_argument("--episodes", default=EPISODES_JSON, help="episodes.json to resolve the episode from")
    ap.add_argument("--out", help="output mp4 (default renders/GSP-0NN-motion.mp4)")
    return ap.parse_args(argv)


def main(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    with open(args.episodes, encoding="utf-8") as f:
        episodes = json.load(f)
    ep = next((e for e in episodes if e["num"] == args.episode), None)
    if ep is None:
        sys.exit(f"episode {args.episode} is not in {args.episodes}")
    tag = f"GSP-{args.episode:03d}"
    out = os.path.abspath(args.out or os.path.join(RENDERS, f"{tag}-motion.mp4"))
    if not out.endswith(".mp4"):
        sys.exit("--out must end in .mp4")
    if os.path.exists(out) and not args.force:
        print(f"[{tag}] {out} exists, skipping (--force to re-render)")
        return
    os.makedirs(os.path.dirname(out), exist_ok=True)

    ps = _load_still_renderer()
    if args.images_from:
        with open(args.images_from, encoding="utf-8") as f:
            images = [ln.strip() for ln in f if ln.strip() and not ln.startswith("#")]
        if not images:
            sys.exit(f"{args.images_from} lists no images")
    else:
        total = round(ps.audio_duration(ep["audio"]) * FPS)
        picks = ps.pick_art(ps.load_pool(), args.episode, slide_count(total))
        images = [os.path.join(ART_DIR, a["file"]) for a in picks]
    missing = [p for p in images + [ep["audio"]] if not os.path.exists(p)]
    if missing:
        sys.exit(f"missing inputs: {missing}")

    work = out[:-4] + "-work"
    os.makedirs(work, exist_ok=True)
    cover = os.path.join(work, "cover.png")
    if not os.path.exists(cover) or args.force:
        ps.make_cover(ep, images[0], cover)
    render_motion(images, cover, ep["audio"], out, args.episode, crf=args.crf, grain=args.grain,
                  workers=args.workers, wave_opacity=args.wave_opacity, force=args.force,
                  log=lambda s: print(f"[{tag}] {s}", flush=True))


if __name__ == "__main__":
    main()
