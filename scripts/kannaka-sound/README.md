# kannaka-sound

Beds, stings and sound effects for the production (podcast, drama, ads) from open audio models, in one
short qBraid GPU session, the way `scripts/kannaka-art` makes pictures. Nothing here touches the radio's
live config or music library: outputs land in a directory and a person places them.

```
python scripts/kannaka-sound/kannaka_sound.py plan   --jobs jobs/pilot.json --out workspace/sound/pilot
python scripts/kannaka-sound/kannaka_sound.py qbraid --jobs workspace/sound/pilot/jobs.json --out workspace/sound/pilot/out
#   ...prints the debain2 commands; run them (they provision ONE pod and TERMINATE it on exit)
python scripts/kannaka-sound/kannaka_sound.py post   workspace/sound/pilot/out --out workspace/sound/pilot/mp3
```

A job: `{"id", "kind": "bed|sting|sfx", "prompt", "seconds" (1..47), "engines"?}`. Output per render:
`<id>--<engine>.wav` and a `manifest.json` with prompt, model, wall time and the model's license.

## Engines and licenses (read before anything airs)

| engine | model | good for | license |
|---|---|---|---|
| `musicgen` | facebook/musicgen-{small,medium,large} | music beds, stings (≤30 s) | weights **CC-BY-NC 4.0: non-commercial**. Comparison only. |
| `audiogen` | facebook/audiogen-medium | sound effects (≤10 s) | **CC-BY-NC 4.0**, same rule. |
| `stable-audio` | stabilityai/stable-audio-open-1.0 (`--size small` for the small one) | beds, stings, SFX (≤47 s) | Stability AI Community License: commercial use under $1M revenue after registering. **Gated on Hugging Face**: the account must accept the terms once, in a browser, or the download 403s. |

The radio carries paid ads, so only `stable-audio` output is usable on air. MusicGen/AudioGen renders
exist to compare quality and to decide what is worth paying for.

## Pod wrapper (`qbraid_sound_run.sh`)

Runs on debain2 with `~/qbraid-venv2`. Provisions one BMA (`SLUG`, default `gpu-rtx-4090`; `gpu-l4` is
fine for inference), sets a 10-minute idle cutoff and a `MAX_MIN` session cap (default 90), bootstraps
torch + audiocraft + stable-audio-tools, runs `gen`, copies `out/` back, and terminates the instance in an
EXIT trap. It prints `CREDITS_BEFORE`/`CREDITS_AFTER`, lists other instances but never touches them, and
prints `STRAYS_ALL` at the end. Log: `~/kannaka-sound/qbraid.log`.

## Post

`post` normalizes every wav to −18 LUFS (true peak −1.5), 44.1 kHz stereo 160 kbps mp3 with a 20 ms
fade-in and a 0.5 s fade-out: ready to drop under narration or into a bookend. Beds for TSOF go through
`scripts/tsof-score-mix.py` as before.
