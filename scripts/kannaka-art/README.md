# kannaka-art

Our own episode-art generator. It uses SDXL 1.0 base with the SDXL-Lightning 4-step UNet and the fp16-fix VAE, through diffusers. One CLI covers plan, ledger, generate, gate and slideshow list.

## Usage

```bash
A=scripts/kannaka-art/kannaka_art.py
D=workspace/art/gsp-e043

# 1. Plan. subjects.json is [{"slug": "tower", "subject": "a lattice radio tower at dusk"}, ...]
python $A plan --show gsp --episode 43 --subjects subjects.json --out $D
python $A ledger check --jobs $D/jobs.json          # refuses a (prompt, seed) another episode used

# 2. Generate, on the CPU box...
python $A gen --jobs $D/jobs.json --out $D --device cpu --threads 8 --label cpu-skywave
#    ...or on one qBraid GPU session. This PRINTS the commands and runs nothing.
python $A qbraid --jobs $D/jobs.json --out $D [--profile gpu-l4] [--mode base]

# 3. Accept, record and hand to the slideshow
python $A gate $D                                    # non-zero if any PNG is under 1024 px or 100,000 B
python $A ledger add $D                              # appends to workspace/art/ledger.jsonl
python $A images-from $D --cover tower --out $D/images.txt
python scripts/podcast-slideshow.py --images-from $D/images.txt 43
```

- **Seeds** come from the first four bytes of sha256 over the show, episode and slug. A re-plan writes a byte-identical `jobs.json`.
- **Names** follow `<show>-e<NNN>-<slug>-s<seed>.png`. Base mode adds `-base`, so both modes can share a directory.
- **Subjects** containing the whole words text, logo, letters, words or sign are refused. SDXL renders text as garbage.
- **Templates** in `templates/` hold each show's style tail, negative prompt and art rules. The negative prompt is used only in base mode, because Lightning runs at guidance 0.
- **The ledger** is append-only JSONL with one row per accepted image. It records backend and dtype because fp16 and fp32 give different images for the same seed.
- **The qBraid wrapper** `qbraid_run.sh` runs on debain2 with `~/qbraid-venv2`. It refuses to start while any instance is not TERMINATED, because a stopped pod still bills. It terminates its own instance in an EXIT trap, then prints strays and credits after.

## Backends, measured 2026-09-30 (6 images per row, 1024 px)

| Backend | Mode | Seconds per image | Cost |
|---|---|---|---|
| skywave CPU, 8 threads, fp32 | lightning | 184 mean (132 to 262) | owned hardware |
| qBraid RTX 4090, fp16 | lightning | 0.6 | see below |
| qBraid RTX 4090, fp16 | base, 30 steps | 3.9 | see below |

The single 4090 session billed 436 s of wall time. Bootstrap took 101 s, model download 61 s and the first pipeline load 184 s. The credit balance fell by 3.17 credits, about $0.03. At the 4090 profile rate of $0.87 per hour, the same wall time is about $0.11. The cheaper `gpu-l4` profile at $0.49 per hour refused with no capacity, so the wrapper defaults to `gpu-rtx-4090`.

The same seed does not give the same image on fp16 GPU and fp32 CPU.

## Licences

- **SDXL 1.0 base** is CreativeML OpenRAIL++-M, and commercial use is allowed.
- **SDXL-Lightning** is OpenRAIL++.
- **sdxl-vae-fp16-fix** is MIT.
- **SDXL-Turbo is rejected.** Its Stability licence is non-commercial, so never add it.

## Tests

```bash
python -m unittest discover -s scripts/kannaka-art/tests -v
```

`npm test` runs the same suite through `test/kannaka-art.test.js`. Only the pure parts are tested, and none of them import torch.
