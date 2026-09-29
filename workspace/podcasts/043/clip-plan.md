# GSP-043 "What the Boundary Knows": clip, hijack and video plan (Phase 2, NOT executed)

Nothing here has been run. No TTS, no ElevenLabs credits, no upload. Numbers marked *measured* were
probed read-only on 2026-09-28 from `C:\Users\nickf\Source\gsqs-043-ro` (kannaka-labs/ghost-signals-quantum-session @ `9c803b7`).

## 0. Inputs

| input | fact | source |
|---|---|---|
| `output/video/show_me_the_receipt.mp4` | 1280x720, h264, yuv420p, **24 fps**, video 167.5417 s (= 4021 frames); audio AAC stereo 44.1 kHz, 167.571 s; container 167.571 s; 39.4 MB | *measured*, ffprobe |
| renderer turn files | `turn{i:02d}-{SPK[:4]}.mp3`, mono, 44.1 kHz, 128k MP3; gaps `sil04.mp3` (0.4 s mono); `concat.txt` in the render outdir | `scripts/render-dialogue.py` L81-121 |
| slideshow | **1920x1080, 24 fps (`FPS = 24`), yuv420p, SAR 1, libx264 `-preset medium -tune stillimage -crf 20 -r 24`**; cover 6.0 s, slides ~45 s, 0.6 s dip-to-black fades; final mux AAC 192k 48 kHz `+faststart -shortest` | `scripts/podcast-slideshow.py` L38-42, L195-269 |
| bookends | `012/intro14.mp3` (14.03 s, stereo) + `012/outro18.mp3` (18.05 s, stereo) | SKILL.md §3 step 2 + GSP-040 ledger |

## 1. Script → render script

`script.txt` carries four kinds of lines the renderer must never see:
1. `[CLIP 1 — Show Me the Receipt, full, 2:48]` (one line, after the KANNAKA turn "Put the pliers down.").
2. `[0XSCADA-QE]` + `<<…>>` placeholder / fallback lines.
3. `[SPACECHILD-HACK]` and `[ROGUEAGENT-HACK]` + `<<…>>` placeholder / ALT lines.
4. Any `<<…>>` line at all.

`render-dialogue.py`'s `TURN_RE` only knows the keys of `voices.json` (plus `-MUFFLED`). **An unknown `[TAG]`
is not skipped: its text is swallowed into the PRECEDING turn and read aloud in that host's voice** (the GSP-027
reason clip lines are stripped). So before any TTS:

1. Resolve every placeholder: paste 0xSCADA-QE's and the hijackers' own words verbatim, or apply the written
   fallback. Delete every `<<…>>` line.
2. Write `script-render.txt` = `script.txt` minus the `[CLIP 1 …]` line. Record the **after-turn index**: the
   0-indexed render turn whose text is "Put the pliers down." (Currently the 30th of 120 turns, counting the
   SpaceChild slot as one turn, so render index 29, or 28 if that slot falls back to static. The example below uses
   placeholder numbers. **Recompute after the guest text lands**, since 0xSCADA-QE may send several turns and
   hijack slots may be deleted.)
3. Parse-only dry run (no API calls): count turns; assert no line matches `^\[` without being claimed by
   `TURN_RE`; assert no `<<`; assert no empty turn; scan for consecutive identical tags (the fallbacks are written
   so none appear, but check).

## 2. Audio: the clip (the whole song, uninterrupted)

Extract, downmix and codec-match to the turn files (the GSP-027 recipe, no `-ss/-t`, since the brief is "the whole thing").
Use two-pass loudnorm so the whole song lands on target rather than being dynamically squashed:

```bash
SRC=show_me_the_receipt.mp4
# pass 1: measure
ffmpeg -hide_banner -i "$SRC" -vn -ac 1 -ar 44100 \
  -af loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json -f null - 2> ln1.txt
# pass 2: apply measured values (fill from ln1.txt: input_i, input_tp, input_lra, input_thresh, target_offset)
ffmpeg -y -i "$SRC" -vn -ac 1 -ar 44100 \
  -af "loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=<i>:measured_TP=<tp>:measured_LRA=<lra>:measured_thresh=<th>:offset=<off>:linear=true,afade=t=in:d=0.02,afade=t=out:st=167.52:d=0.05" \
  -c:a libmp3lame -b:a 128k clip01.mp3
ffprobe -v error -show_entries format=duration:stream=channels,sample_rate -of default=nw=1 clip01.mp3
```

- The 20 ms fade-in and 50 ms fade-out only de-click the edges. The song already starts and ends on its own intro and outro.
- ⚠ **Mono downmix is what the brief specifies**, because it codec-matches the turns. It does fold the song's stereo
  retrocausal echo to mono. If Nick prefers stereo, see §4 option B, which keeps the clip stereo without breaking the
  codec match, because the join is done by the concat *filter*.

Splice: copy the renderer's `concat.txt` to `concat-clips.txt` and insert the clip after the after-turn index's
`sil04` line, followed by one more `sil04`:

```
file 'turn30-KANN.mp3'
file 'sil04.mp3'
file 'clip01.mp3'        # <- inserted
file 'sil04.mp3'         # <- inserted
file 'turn31-FLAU.mp3'
...
```
Then build `dialogue-with-clip.mp3` from `concat-clips.txt` with the renderer's own final command
(`-c:a libmp3lame -b:a 128k -ar 44100`), and bookend it **with per-input `aformat` before the concat filter**
(GSP-040 ledger: the demuxer silently produces a SHORT file when it joins mono and stereo):

```bash
ffmpeg -y -i intro14.mp3 -i dialogue-with-clip.mp3 -i outro18.mp3 -filter_complex \
 "[0:a]aformat=sample_rates=44100:channel_layouts=stereo[a0];[1:a]aformat=sample_rates=44100:channel_layouts=stereo[a1];[2:a]aformat=sample_rates=44100:channel_layouts=stereo[a2];[a0][a1][a2]concat=n=3:v=0:a=1[a]" \
 -map "[a]" -c:a libmp3lame -b:a 192k GSP-043-What-the-Boundary-Knows.mp3
```

## 3. Hijack slots (new recurring bit, from GSP-043)

- **Placeholders:** `[SPACECHILD-HACK]` (SpaceChild's words, by mail) and `[ROGUEAGENT-HACK]` (Rogue Agent's
  words, by OBC DM, from its own model). We never write their lines. The budget is about 60-120 words for both together.
- **Renderer change (Phase 2, a signed kannaka-radio PR, SKILL.md ledger 2026-09-28):** add a `-HACK` suffix
  next to `-MUFFLED` in `TURN_RE`, keyed off the base speaker's voices.json entry (`SPACECHILD`, `ROGUEAGENT`). Post-TTS chain,
  for example: `highpass=f=300,lowpass=f=3400,acrusher=bits=8:mix=0.35,` plus a short stutter (repeat the first 80 ms
  twice via `aloop` or a pre-cut), then a 0.4-0.6 s static burst in and out (`anoisesrc=c=pink` with a bandpass, faded)
  concatenated around the turn. Re-normalise to −16 LUFS / TP −1.5 so it sits with the hosts. Until that PR merges,
  a `-HACK` tag is swallowed and read aloud by the preceding host (see §1). **Do not render the episode before it merges.**
- **Voices:** SpaceChild `GYByFJmdMLMJj5jHJBnt` (041 `voices.json`). Rogue Agent has no voice yet, so offer it the
  `GET /v1/voices` list and let it choose (§1.6 ⭐). Run a collision check against the 041/042 cast and TSOF locks.
  0xSCADA-QE `cjVigY5qzO86Huf0OWal`, stability 0.82 / style 0.03 / target −15.5 (041 entry, reuse verbatim).
- **Fallback (an agent does not answer in time):** delete its block and splice a **1.5 s static burst** in its
  place, the same way the clip is spliced. The script carries the ALT host turns for each slot.
  ```bash
  ffmpeg -y -f lavfi -i "anoisesrc=d=1.5:c=pink:a=0.5" -af "bandpass=f=1800:w=2400,acrusher=bits=6:mix=0.5,afade=t=in:d=0.05,afade=t=out:st=1.3:d=0.2,loudnorm=I=-20:TP=-3" \
    -ac 1 -ar 44100 -c:a libmp3lame -b:a 128k static15.mp3
  ```
  (It sits 4 dB under the voices on purpose: dead air with a hiss, not a jump scare.)

## 4. Video: show the music video during the clip, slides elsewhere

**Least invasive:** do not edit `podcast-slideshow.py`. Add one wrapper, `workspace/podcasts/043/slideshow-parts.py`,
that loads the script with `importlib.util.spec_from_file_location` (the name has a hyphen) and **reuses its
`render_segment`, `make_cover`, `pick_art`, `FPS`** unchanged, so every still segment is encoded exactly as the
show always encodes them.

1. **Split the audio at the clip.** Build `pre.mp3` = intro14 + dialogue up to and including the `sil04` before the
   clip, and `post.mp3` = the `sil04` after the clip + the rest + outro18, with the same per-input `aformat` concat
   filter as §2. Probe both: `T_pre`, `T_post`. `T_clip` = the probed duration of `clip01.mp3`.
   (Option B for stereo: build the final episode as `[pre][clip_stereo][post]` with the concat filter, where
   `clip_stereo` is the same loudnorm pass with `-ac 2`. The durations are then exact by construction.)
2. **Frame-exact still parts.** At 24 fps the pre part must be `F_pre = round(T_pre × 24)` frames. The wrapper
   gives the cover `6.0 s` and splits the rest into art slides whose frame counts are integers summing to exactly `F_pre`,
   with **no +1.5 s tail pad** (that pad in `render_episode` exists only for the final part). The post part has no cover,
   art slides summing to `round(T_post × 24)` frames, **plus** the usual 1.5 s pad on its last slide (`-shortest` trims it).
   Record every art pick in `art-used.json` (042 ledger).
3. **The clip part.** Scale the 1280x720 source to the slideshow's frame. The aspect ratio is the same 16:9, so no padding is
   needed. Hold the last frame for one extra frame, so the video spans 4022 frames = 167.583 s against 167.571 s of audio:
   ```bash
   ffmpeg -y -i show_me_the_receipt.mp4 -an \
     -vf "scale=1920:1080:flags=lanczos,setsar=1,fps=24,format=yuv420p,tpad=stop_mode=clone:stop=1" \
     -c:v libx264 -preset medium -crf 20 -r 24 -profile:v high -level:v 4.0 clip-1080.mp4
   ```
   `-tune stillimage` is left off because this is motion. Before joining, probe `seg-000.mp4` and `clip-1080.mp4`
   with `ffprobe -show_entries stream=codec_name,profile,level,pix_fmt,width,height,r_frame_rate,time_base` and
   make `profile`/`level`/`time_base` match (adjust `-level:v` to whatever the stills report).
4. **Join the video**, with the concat demuxer in stream copy (`pre-video.mp4`, `clip-1080.mp4`, `post-video.mp4`). If
   any decode error appears (`ffmpeg -v error -i video.mp4 -f null -` must print nothing), fall back to the concat
   **filter** with one re-encode at the slideshow settings (slower, but it can't mis-join).
5. **Mux** exactly as the slideshow does: `ffmpeg -i video.mp4 -i GSP-043-What-the-Boundary-Knows.mp3 -map 0:v -map 1:a
   -c:v copy -c:a aac -b:a 192k -ar 48000 -movflags +faststart -shortest GSP-043-slideshow.mp4`.
   The song is heard from the episode mp3, and the music video's own audio track is discarded, so sync
   depends only on `F_pre / 24 == T_pre`.

**Duration arithmetic (write it out at build time, with the real numbers):**
```
T_episode = 14.03 + D_pre_dialogue + 0.40 + T_clip + 0.40 + D_post_dialogue + 18.05
T_pre     = 14.03 + D_pre_dialogue + 0.40          (clip starts here)
T_post    = 0.40 + D_post_dialogue + 18.05
video     = F_pre/24 + 4022/24 + F_post/24 (+1.5 pad, trimmed by -shortest)
sync err  = |F_pre/24 − T_pre|  ≤ 1/48 s by construction; clip audio/video length differ by 0.012 s (≤ 1 frame)
```
Estimate at 161 wpm (GSP-042's measured rate incl. gaps): 2,559 host words + 100-250 guest words ≈ 990-1,050 s of
speech, so the episode runs **≈ 1,190-1,250 s (19:50-20:50)** bookended, with the song starting at about 4:00 (about 557 host words in).

## 5. Gates (every one prints its arithmetic; an exit code proves nothing)

1. **Render script:** 0 `<<`, 0 unclaimed `[TAG]`, 0 empty turns, 0 consecutive identical tags; `-HACK` tags only if the renderer PR is merged and deployed to O1 `/tmp/render-dialogue3.py`.
2. **Clip audio:** duration 167.57 ± 0.05 s, mono, 44100 Hz; a loudnorm re-measure gives I = −16 ± 0.5, TP ≤ −1.5.
3. **LUFS voice spread** per §3 step 1 (F − K = 1.0 ± 0.3 dB), guests between the hosts as in 041.
4. **Dialogue with clip:** Σ(turn durations) + Σ(gaps) + T_clip (+ static bursts) vs the probed file, within ±0.1 s.
5. **Bookend:** 14.03 + D + 18.05 vs the probed episode, within ±0.1 s (the GSP-040 silent-short trap).
6. **Video parts:** probe the frame counts of `pre-video`/`clip-1080`/`post-video` (`-count_frames`): exactly F_pre, 4022 and ≥ F_post.
7. **Final:** `|ffprobe(GSP-043-slideshow.mp4) − ffprobe(episode.mp3)| ≤ 0.5 s` (tighter than the usual ±2 s, because a clip is in the middle); `ffmpeg -v error … -f null -` is empty.
8. **Sync spot check:** extract frames at `T_pre − 1 s` (a slide), `T_pre + 2 s` (the music video's intro), `T_pre + T_clip − 1 s` (the video's last seconds) and `T_pre + T_clip + 2 s` (a slide), and look at them.
9. **Consent (last gate before upload):** re-read 0xSCADA-QE's **mail** thread (it was asked by mail at 2026-09-28T23:51Z, so
   `consent-gate.py`, which reads OBC DMs, does not cover it; check it by hand and record it in `043/consent.json`). Run `consent-gate.py`
   on Rogue Agent's DM conversation. Check SpaceChild's mail reply. `upload-43.js` must call `assertConsentClear` first
   (042 ledger). ⚠ If 0xSCADA-QE declines **airing the video itself**, not just a speaking part, the episode's spine is gone
   and Nick decides; the written fallbacks cover only its speaking slot.
10. **Live-fact re-check at publish:** "usage limit until October the first", "the search … is still running as we record", and
    "neither certified yet" all expire. Re-verify each (or re-cut) immediately before upload.
