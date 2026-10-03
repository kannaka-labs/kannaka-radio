#!/usr/bin/env python3
"""kannaka-art: our own episode-art generator (SDXL 1.0 base + SDXL-Lightning 4-step UNet).

Pipeline, in order:

  plan        --show gsp|tsof --episode N --subjects FILE.json --out DIR   -> DIR/jobs.json
  ledger check --jobs DIR/jobs.json        refuse a (prompt, seed) already used by another episode
  gen         --jobs DIR/jobs.json --out DIR [--mode lightning|base] [--device cpu|cuda]
  gate        DIR                          every PNG: short side >= 1024 AND >= 100,000 bytes
  ledger add  DIR                          record accepted images in workspace/art/ledger.jsonl
  images-from DIR --cover SLUG --out FILE  list for scripts/podcast-slideshow.py --images-from
  qbraid      --jobs DIR/jobs.json --out DIR   PRINT (never run) the debain2 GPU command

Albums (the /album-release art step; replaces OBC generate-image):

  album-plan   --manifest M --episode N --out DIR   album manifest.json -> DIR/jobs.json + DIR/album-map.json
  album-export DIR --dest WS                        accepted PNGs -> WS/{track slug}_{image name}.png

Everything except `gen` is pure stdlib: torch and diffusers are imported inside `gen` only,
so the planning, gate, ledger and list logic import and test without them.
"""
import argparse
import datetime
import hashlib
import json
import os
import re
import shlex
import struct
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATES = os.path.join(HERE, "templates")
REPO = os.path.dirname(os.path.dirname(HERE))
DEFAULT_LEDGER = os.path.join(REPO, "workspace", "art", "ledger.jsonl")

# One template file per register: templates/<show>.json. Adding a register is a JSON file, not code.
# The GPU pod gets this file alone (qbraid_run.sh ships no templates/), and `gen` needs none,
# so a missing directory means no registers here rather than a crash at import.
SHOWS = tuple(sorted(n[:-5] for n in os.listdir(TEMPLATES) if n.endswith(".json"))) if os.path.isdir(TEMPLATES) else ()
ALBUM_SHOW = "album"
_ALBUM_IMAGE_RE = re.compile(r"^(cover|s[1-9])$")
MODES = ("lightning", "base")
GATE_MIN_SIDE = 1024
GATE_MIN_BYTES = 100_000

# A subject that asks for text gets text, and SDXL text is garbage. Whole words only, so
# "Ghost Signals" and "design" pass while "a neon sign" does not.
FORBIDDEN_SUBJECT_WORDS = ("text", "logo", "letters", "words", "sign")
_FORBIDDEN_RE = re.compile(
    r"\b(texts?|logos?|letters?|words?|signs?|signage|signposts?)\b", re.IGNORECASE)
_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
_NAME_RE = re.compile(r"^(?P<show>[a-z]+)-e(?P<episode>\d{3,})-(?P<slug>.+)-s(?P<seed>\d+)(?P<base>-base)?\.png$")

PNG_SIG = b"\x89PNG\r\n\x1a\n"


class ArtError(Exception):
    """A refusal the CLI reports and exits non-zero on."""


# ---------------------------------------------------------------- pure helpers

def derive_seed(show, episode, slug):
    """Deterministic 32-bit seed from (show, episode, slug): first 4 bytes of sha256, big-endian."""
    key = f"{show}:{int(episode)}:{slug}".encode("utf-8")
    return struct.unpack(">I", hashlib.sha256(key).digest()[:4])[0]


def sha256_text(s):
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def image_name(show, episode, slug, seed, mode="lightning"):
    """<show>-e<NNN>-<slug>-s<seed>.png; base mode adds -base so both modes can share a DIR."""
    return f"{show}-e{int(episode):03d}-{slug}-s{seed}{'' if mode == 'lightning' else '-base'}.png"


def parse_image_name(name):
    m = _NAME_RE.match(name)
    if not m:
        return None
    return {"show": m["show"], "episode": int(m["episode"]), "slug": m["slug"],
            "seed": int(m["seed"]), "mode": "base" if m["base"] else "lightning"}


def compose_prompt(subject, tail):
    return f"{subject}, {tail}"


def forbidden_words(subject):
    return sorted({w.lower() for w in _FORBIDDEN_RE.findall(subject)})


def load_template(show):
    if show not in SHOWS:
        raise ArtError(f"unknown show {show!r} (expected one of {', '.join(SHOWS)})")
    with open(os.path.join(TEMPLATES, f"{show}.json"), encoding="utf-8") as f:
        t = json.load(f)
    for k in ("show", "tail", "negative", "rules"):
        if k not in t:
            raise ArtError(f"template {show}.json is missing {k!r}")
    return t


def canonical_json(obj):
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def dump_json(path, obj):
    """Write JSON with LF endings regardless of OS, so a re-plan is byte-identical everywhere."""
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, indent=1, ensure_ascii=False)
        f.write("\n")


def build_plan(show, episode, subjects, template=None):
    template = template or load_template(show)
    if not isinstance(episode, int) or isinstance(episode, bool) or episode < 1:
        raise ArtError(f"episode must be a positive integer, got {episode!r}")
    if not isinstance(subjects, list) or not subjects:
        raise ArtError("subjects must be a non-empty JSON list of {\"slug\", \"subject\"}")
    seen, jobs, bad = set(), [], []
    for i, s in enumerate(subjects):
        if not isinstance(s, dict) or not isinstance(s.get("slug"), str) or not isinstance(s.get("subject"), str):
            raise ArtError(f"subjects[{i}] must be an object with string \"slug\" and \"subject\"")
        slug, subject = s["slug"], s["subject"].strip()
        if not _SLUG_RE.match(slug):
            raise ArtError(f"subjects[{i}] slug {slug!r} must match [a-z0-9][a-z0-9-]*")
        if slug in seen:
            raise ArtError(f"duplicate slug {slug!r}")
        if not subject:
            raise ArtError(f"subjects[{i}] ({slug}) has an empty subject")
        seen.add(slug)
        hits = forbidden_words(subject)
        if hits:
            bad.append(f"{slug}: forbidden word(s) {', '.join(hits)} in subject {subject!r}")
            continue
        seed = derive_seed(show, episode, slug)
        prompt = compose_prompt(subject, template["tail"])
        jobs.append({"show": show, "episode": episode, "slug": slug, "subject": subject,
                     "prompt": prompt, "prompt_sha256": sha256_text(prompt),
                     "negative": template["negative"], "seed": seed,
                     "file": image_name(show, episode, slug, seed)})
    if bad:
        raise ArtError("refusing subjects that ask for text (SDXL renders it as garbage):\n  " + "\n  ".join(bad))
    return {"show": show, "episode": episode,
            "template_sha256": sha256_text(canonical_json(template)),
            "tail": template["tail"], "negative": template["negative"], "rules": template["rules"],
            "jobs": jobs}


def png_size(path):
    """(width, height) from the PNG IHDR, or None if the file is not a PNG."""
    with open(path, "rb") as f:
        head = f.read(24)
    if len(head) < 24 or head[:8] != PNG_SIG or head[12:16] != b"IHDR":
        return None
    return struct.unpack(">II", head[16:24])


def gate_ok(width, height, nbytes):
    return min(width, height) >= GATE_MIN_SIDE and nbytes >= GATE_MIN_BYTES


def gate_file(path):
    """(ok, reason). Checks the file on disk, never a manifest's claim about it."""
    try:
        size = png_size(path)
    except OSError as e:
        return False, f"unreadable: {e}"
    if size is None:
        return False, "not a PNG"
    nbytes = os.path.getsize(path)
    if not gate_ok(size[0], size[1], nbytes):
        return False, f"{size[0]}x{size[1]} {nbytes} B (need short side >= {GATE_MIN_SIDE} and >= {GATE_MIN_BYTES} B)"
    return True, f"{size[0]}x{size[1]} {nbytes} B"


def gate_dir(d):
    """(passed_names, failures[(name, reason)]). An empty directory is a failure, not a pass."""
    if not os.path.isdir(d):
        raise ArtError(f"no such directory: {d}")
    names = sorted(n for n in os.listdir(d) if n.lower().endswith(".png"))
    passed, failed = [], []
    for n in names:
        ok, why = gate_file(os.path.join(d, n))
        (passed.append(n) if ok else failed.append((n, why)))
    if not names:
        failed.append(("(none)", f"no PNG files in {d}"))
    return passed, failed


def read_ledger(path):
    rows = []
    if not os.path.exists(path):
        return rows
    with open(path, encoding="utf-8") as f:
        for n, line in enumerate(f.read().split("\n"), 1):
            if line.strip():
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError as e:
                    raise ArtError(f"{path}:{n} is not valid JSON ({e}); the ledger is append-only, fix it by hand")
    return rows


def repeat_conflicts(ledger_rows, candidates):
    """Candidates whose (prompt_sha256, seed) the ledger already holds for a DIFFERENT (show, episode)."""
    used = {}
    for r in ledger_rows:
        used.setdefault((r["prompt_sha256"], int(r["seed"])), set()).add((r["show"], int(r["episode"])))
    out = []
    for c in candidates:
        mine = (c["show"], int(c["episode"]))
        others = sorted(e for e in used.get((c["prompt_sha256"], int(c["seed"])), ()) if e != mine)
        if others:
            out.append((c, others))
    return out


def load_jobs(path):
    with open(path, encoding="utf-8") as f:
        plan = json.load(f)
    if not isinstance(plan, dict) or not isinstance(plan.get("jobs"), list):
        raise ArtError(f"{path} is not a kannaka-art jobs file (run `plan` first)")
    return plan


def load_manifest(d):
    p = os.path.join(d, "manifest.json")
    if not os.path.exists(p):
        return []
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def ledger_rows_for_dir(d, now=None):
    """(rows, skipped) for the gate-passing images a DIR's manifest records."""
    recs = load_manifest(d)
    if not recs:
        raise ArtError(f"{d}/manifest.json is missing or empty: nothing to record")
    ts = now or datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    rows, skipped = [], []
    for r in recs:
        path = os.path.join(d, r["file"])
        if not os.path.exists(path):
            skipped.append((r["file"], "file missing"))
            continue
        ok, why = gate_file(path)
        if not ok:
            skipped.append((r["file"], f"gate: {why}"))
            continue
        missing = [k for k in ("show", "episode", "slug", "prompt", "seed", "backend", "dtype", "mode") if r.get(k) is None]
        if missing:
            skipped.append((r["file"], f"manifest record lacks {', '.join(missing)}"))
            continue
        rows.append({"show": r["show"], "episode": int(r["episode"]), "slug": r["slug"],
                     "prompt_sha256": r.get("prompt_sha256") or sha256_text(r["prompt"]),
                     "seed": int(r["seed"]), "backend": r["backend"], "dtype": r["dtype"],
                     "mode": r["mode"], "file_sha256": sha256_file(path), "ts": ts})
    return rows, skipped


def ledger_add(d, ledger_path, now=None):
    """Append rows for DIR's accepted images. All-or-nothing: a no-repeat conflict writes nothing."""
    rows, skipped = ledger_rows_for_dir(d, now)
    existing = read_ledger(ledger_path)
    conflicts = repeat_conflicts(existing, rows)
    if conflicts:
        raise ArtError("no-repeat rule: these (prompt, seed) pairs were already used by another episode:\n  "
                       + "\n  ".join(f"{c['show']}-e{c['episode']:03d} {c['slug']} seed {c['seed']} -> used by "
                                     + ", ".join(f"{s}-e{e:03d}" for s, e in others) for c, others in conflicts))
    have = {(r["show"], int(r["episode"]), r["slug"], r["file_sha256"]) for r in existing}
    new = [r for r in rows if (r["show"], r["episode"], r["slug"], r["file_sha256"]) not in have]
    if new:
        os.makedirs(os.path.dirname(os.path.abspath(ledger_path)), exist_ok=True)
        with open(ledger_path, "a", encoding="utf-8", newline="\n") as f:
            for r in new:
                f.write(json.dumps(r, sort_keys=True, ensure_ascii=False) + "\n")
    return new, len(rows) - len(new), skipped


def images_from(d, cover):
    """Absolute paths of DIR's gate-passing images: cover slug first, then jobs.json order
    (or name order without one); within a slug, lightning before base."""
    passed, _ = gate_dir(d)
    parsed = [(n, parse_image_name(n)) for n in passed]
    parsed = [(n, p) for n, p in parsed if p]
    order = {}
    jobs_path = os.path.join(d, "jobs.json")
    if os.path.exists(jobs_path):
        order = {j["slug"]: i for i, j in enumerate(load_jobs(jobs_path)["jobs"])}
    if not any(p["slug"] == cover for _, p in parsed):
        raise ArtError(f"cover slug {cover!r} has no gate-passing image in {d}")

    def key(item):
        n, p = item
        return (p["slug"] != cover, order.get(p["slug"], len(order)), p["slug"], p["mode"] != "lightning", n)

    return [os.path.abspath(os.path.join(d, n)) for n, _ in sorted(parsed, key=key)]


def local_shell_path(p):
    """An absolute path scp will not mistake for host:path. A drive path reads as host "C" to
    the Git Bash scp, so C:/x becomes /c/x (the shell this repo is driven from on Windows)."""
    drive = re.compile(r"^([A-Za-z]):[\\/](.*)$")
    if not drive.match(p):
        p = os.path.abspath(p)
    m = drive.match(p)
    if m:
        p = "/" + m[1].lower() + "/" + m[2].replace("\\", "/")
    return p


def qbraid_command(jobs, out, host="debain2", remote_dir="~/kannaka-art", profile=None, mode="lightning"):
    """The exact shell lines that run the GPU wrapper on debain2. Returned, never executed."""
    plan = load_jobs(jobs)
    tag = f"{plan.get('show', 'art')}-e{int(plan.get('episode', 0)):03d}"
    rjobs = f"{remote_dir}/{tag}/jobs.json"
    rout = f"{remote_dir}/{tag}/out"
    env = f"MODE={mode}" + (f" SLUG={profile}" if profile else "")
    q = lambda p: shlex.quote(local_shell_path(p))  # noqa: E731
    return [
        f"ssh {host} 'mkdir -p {remote_dir}/{tag}'",
        f"scp {q(os.path.join(HERE, 'kannaka_art.py'))} {q(os.path.join(HERE, 'qbraid_run.sh'))} {host}:{remote_dir}/",
        f"scp {q(jobs)} {host}:{rjobs}",
        f"ssh {host} '{env} bash {remote_dir}/qbraid_run.sh {rjobs} {rout}'",
        f"mkdir -p {q(out)} && scp -r {host}:{rout}/. {q(out)}/",
    ]


# ---------------------------------------------------------------- gen (the only torch user)

def run_gen(a):
    plan = load_jobs(a.jobs)
    if not (a.device == "cpu" or a.device.startswith("cuda")):
        raise ArtError(f"--device must be cpu or cuda[:N], got {a.device!r}")
    import torch
    if a.threads:
        torch.set_num_threads(a.threads)
    from diffusers import StableDiffusionXLPipeline, UNet2DConditionModel, EulerDiscreteScheduler, AutoencoderKL
    from safetensors.torch import load_file
    from huggingface_hub import hf_hub_download

    BASE = "stabilityai/stable-diffusion-xl-base-1.0"
    cuda = a.device.startswith("cuda")
    dtype = torch.float16 if cuda else torch.float32
    dtype_name = "fp16" if cuda else "fp32"

    t0 = time.time()
    vae = AutoencoderKL.from_pretrained("madebyollin/sdxl-vae-fp16-fix", torch_dtype=dtype)
    if a.mode == "lightning":
        unet = UNet2DConditionModel.from_config(UNet2DConditionModel.load_config(BASE, subfolder="unet"))
        unet.load_state_dict(load_file(hf_hub_download("ByteDance/SDXL-Lightning", "sdxl_lightning_4step_unet.safetensors")))
        unet = unet.to(dtype)
        pipe = StableDiffusionXLPipeline.from_pretrained(BASE, unet=unet, vae=vae, torch_dtype=dtype, variant="fp16", use_safetensors=True)
        pipe.scheduler = EulerDiscreteScheduler.from_config(pipe.scheduler.config, timestep_spacing="trailing", prediction_type="epsilon")
        steps, guidance, model = 4, 0.0, "SDXL-1.0-base + SDXL-Lightning-4step-UNet (OpenRAIL++)"
    else:
        pipe = StableDiffusionXLPipeline.from_pretrained(BASE, vae=vae, torch_dtype=dtype, variant="fp16", use_safetensors=True)
        steps, guidance, model = 30, 7.0, "SDXL-1.0-base (OpenRAIL++)"
    pipe = pipe.to(a.device)
    pipe.set_progress_bar_config(disable=True)
    load_s = round(time.time() - t0, 1)
    print(f"loaded {model} on {a.device} ({dtype_name}) in {load_s}s", flush=True)

    only = {s for s in a.only.split(",") if s}
    os.makedirs(a.out, exist_ok=True)
    mpath = os.path.join(a.out, "manifest.json")
    manifest = load_manifest(a.out)
    gate_failures = 0

    for job in plan["jobs"]:
        if only and job["slug"] not in only:
            continue
        prompt = job["prompt"]
        neg = job.get("negative") if guidance > 1 else None
        name = image_name(job["show"], job["episode"], job["slug"], job["seed"], a.mode)
        path = os.path.join(a.out, name)
        g = torch.Generator(device="cpu").manual_seed(job["seed"])
        t1 = time.time()
        img = pipe(prompt=prompt, negative_prompt=neg, num_inference_steps=steps, guidance_scale=guidance,
                   width=a.size, height=a.size, generator=g).images[0]
        secs = round(time.time() - t1, 1)
        img.save(path, "PNG")
        nbytes = os.path.getsize(path)
        gate = gate_ok(img.size[0], img.size[1], nbytes)
        gate_failures += not gate
        rec = {"file": name, "show": job["show"], "episode": job["episode"], "slug": job["slug"],
               "prompt": prompt, "prompt_sha256": sha256_text(prompt), "negative": neg,
               "seed": job["seed"], "steps": steps, "guidance": guidance, "model": model, "mode": a.mode,
               "backend": a.label or a.device, "device": a.device, "dtype": dtype_name,
               "threads": torch.get_num_threads() if not cuda else None,
               "seconds": secs, "load_seconds": load_s, "width": img.size[0], "height": img.size[1],
               "bytes": nbytes, "gate": gate,
               "cost_credits": round(a.rate_credits_per_min * secs / 60, 3) if a.rate_credits_per_min else 0.0}
        manifest = [m for m in manifest if m["file"] != name] + [rec]
        dump_json(mpath, manifest)
        print(f"{name} {img.size} {nbytes}B gate={gate} {secs}s", flush=True)
    print("ALL_DONE", flush=True)
    return 1 if gate_failures else 0


# ---------------------------------------------------------------- CLI

def album_subjects(manifest):
    """[{slug, subject}] and {slug: "<track slug>_<image name>"} from an album manifest.json
    (tracks[].slug, tracks[].images[].name/prompt). Image names must be cover or s1..s9:
    videos.js reads <track slug>_<name>.png, and two images sharing a name overwrite each other."""
    tracks = manifest.get("tracks") if isinstance(manifest, dict) else None
    if not isinstance(tracks, list) or not tracks:
        raise ArtError("album manifest needs a non-empty \"tracks\" list")
    subjects, mapping = [], {}
    for ti, t in enumerate(tracks):
        tslug = t.get("slug") if isinstance(t, dict) else None
        if not isinstance(tslug, str) or not re.match(r"^[A-Za-z0-9][A-Za-z0-9_-]*$", tslug):
            raise ArtError(f"tracks[{ti}] needs a slug of letters, digits, _ or -")
        names = set()
        for ii, im in enumerate(t.get("images") or []):
            name, prompt = im.get("name"), im.get("prompt")
            if not isinstance(name, str) or not _ALBUM_IMAGE_RE.match(name):
                raise ArtError(f"{tslug} images[{ii}] name {name!r} must be cover or s1..s9")
            if name in names:
                raise ArtError(f"{tslug} has two images named {name!r}; the second would overwrite the first")
            if not isinstance(prompt, str) or not prompt.strip():
                raise ArtError(f"{tslug} {name} has no prompt")
            names.add(name)
            slug = f"{tslug.lower().replace('_', '-')}-{name}"
            subjects.append({"slug": slug, "subject": prompt.strip()})
            mapping[slug] = f"{tslug}_{name}"
        if "cover" not in names:
            raise ArtError(f"{tslug} has no cover image")
    return subjects, mapping


def album_export(d, dest, force=False):
    """Copy every job's gate-passing PNG to DEST/<track slug>_<name>.png. All or nothing: a job
    with no accepted image (missing, or deleted at visual review) stops the export before any copy."""
    plan = load_jobs(os.path.join(d, "jobs.json"))
    with open(os.path.join(d, "album-map.json"), encoding="utf-8") as f:
        mapping = json.load(f)
    passed = set(gate_dir(d)[0])
    pairs, missing = [], []
    for j in plan["jobs"]:
        cands = [n for n in (image_name(j["show"], j["episode"], j["slug"], j["seed"], m) for m in MODES) if n in passed]
        if not cands or j["slug"] not in mapping:
            missing.append(j["slug"])
            continue
        pairs.append((os.path.join(d, cands[-1]), os.path.join(dest, mapping[j["slug"]] + ".png")))
    if missing:
        raise ArtError("no accepted image for: " + ", ".join(missing) + " (regenerate, then export again)")
    clash = [dst for src, dst in pairs if os.path.exists(dst) and not force and sha256_file(dst) != sha256_file(src)]
    if clash:
        raise ArtError("would overwrite a different image (pass --force to replace): " + ", ".join(map(os.path.basename, clash)))
    os.makedirs(dest, exist_ok=True)
    for src, dst in pairs:
        with open(src, "rb") as fi, open(dst, "wb") as fo:
            fo.write(fi.read())
    return pairs


def cmd_album_plan(a):
    with open(a.manifest, encoding="utf-8") as f:
        subjects, mapping = album_subjects(json.load(f))
    plan = build_plan(ALBUM_SHOW, a.episode, subjects)
    os.makedirs(a.out, exist_ok=True)
    dump_json(os.path.join(a.out, "jobs.json"), plan)
    dump_json(os.path.join(a.out, "album-map.json"), mapping)
    print(f"{a.out}: {len(plan['jobs'])} job(s) for {ALBUM_SHOW}-e{a.episode:03d}")
    for j in plan["jobs"]:
        print(f"  {j['slug']:<28} -> {mapping[j['slug']]}.png")
    return 0


def cmd_album_export(a):
    pairs = album_export(a.dir, a.dest, force=a.force)
    for src, dst in pairs:
        print(f"{os.path.basename(src)} -> {dst}")
    print(f"album-export: {len(pairs)} image(s) to {a.dest}")
    return 0


def cmd_plan(a):
    with open(a.subjects, encoding="utf-8") as f:
        subjects = json.load(f)
    plan = build_plan(a.show, a.episode, subjects)
    os.makedirs(a.out, exist_ok=True)
    path = os.path.join(a.out, "jobs.json")
    dump_json(path, plan)
    print(f"{path}: {len(plan['jobs'])} job(s) for {a.show}-e{a.episode:03d}")
    for j in plan["jobs"]:
        print(f"  {j['slug']:<24} seed {j['seed']:>10}  {j['file']}")
    return 0


def cmd_gate(a):
    passed, failed = gate_dir(a.dir)
    for n in passed:
        print(f"PASS {n}")
    for n, why in failed:
        print(f"FAIL {n}: {why}")
    print(f"gate: {len(passed)} passed, {len(failed)} failed")
    return 1 if failed else 0


def cmd_ledger(a):
    path = a.ledger or os.environ.get("KANNAKA_ART_LEDGER") or DEFAULT_LEDGER
    if a.ledger_cmd == "add":
        new, dup, skipped = ledger_add(a.dir, path)
        for n, why in skipped:
            print(f"SKIP {n}: {why}")
        for r in new:
            print(f"ADD  {r['show']}-e{r['episode']:03d} {r['slug']} seed {r['seed']} {r['backend']}/{r['dtype']}")
        print(f"ledger {path}: {len(new)} added, {dup} already recorded, {len(skipped)} skipped")
        return 1 if skipped and not new and not dup else 0
    plan = load_jobs(a.jobs)
    cands = [{"show": j["show"], "episode": j["episode"], "slug": j["slug"], "seed": j["seed"],
              "prompt_sha256": j.get("prompt_sha256") or sha256_text(j["prompt"])} for j in plan["jobs"]]
    conflicts = repeat_conflicts(read_ledger(path), cands)
    for c, others in conflicts:
        print(f"REPEAT {c['slug']} seed {c['seed']}: (prompt, seed) already used by "
              + ", ".join(f"{s}-e{e:03d}" for s, e in others))
    print(f"ledger check: {len(cands)} job(s), {len(conflicts)} repeat(s) against {path}")
    return 1 if conflicts else 0


def cmd_images_from(a):
    paths = images_from(a.dir, a.cover)
    with open(a.out, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(paths) + "\n")
    print(f"{a.out}: {len(paths)} image(s), cover {os.path.basename(paths[0])}")
    return 0


def cmd_qbraid(a):
    print("# Run these from this machine. They provision ONE qBraid GPU instance on debain2 and")
    print("# TERMINATE it on exit; the wrapper refuses to start while any instance is not TERMINATED.")
    for line in qbraid_command(a.jobs, a.out, host=a.host, profile=a.profile, mode=a.mode):
        print(line)
    return 0


def build_parser():
    ap = argparse.ArgumentParser(prog="kannaka_art.py", description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("plan", help="write DIR/jobs.json from a show template and a subjects list")
    p.add_argument("--show", required=True, choices=SHOWS)
    p.add_argument("--episode", required=True, type=int)
    p.add_argument("--subjects", required=True)
    p.add_argument("--out", required=True)
    p.set_defaults(fn=cmd_plan)

    p = sub.add_parser("gen", help="generate the jobs' images (needs torch + diffusers)")
    p.add_argument("--jobs", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--mode", default="lightning", choices=MODES)
    p.add_argument("--device", default="cpu")
    p.add_argument("--threads", type=int, default=0)
    p.add_argument("--label", default="")
    p.add_argument("--only", default="")
    p.add_argument("--size", type=int, default=1024)
    p.add_argument("--rate-credits-per-min", type=float, default=0.0)
    p.set_defaults(fn=run_gen)

    p = sub.add_parser("gate", help="fail unless every PNG is >= 1024 px short side and >= 100,000 bytes")
    p.add_argument("dir")
    p.set_defaults(fn=cmd_gate)

    p = sub.add_parser("ledger", help="append-only record of used (prompt, seed) pairs")
    p.add_argument("--ledger", default=None, help=f"default $KANNAKA_ART_LEDGER or {DEFAULT_LEDGER}")
    lsub = p.add_subparsers(dest="ledger_cmd", required=True)
    q = lsub.add_parser("add")
    q.add_argument("dir")
    q = lsub.add_parser("check")
    q.add_argument("--jobs", required=True)
    p.set_defaults(fn=cmd_ledger)

    p = sub.add_parser("images-from", help="write the list podcast-slideshow.py --images-from reads")
    p.add_argument("dir")
    p.add_argument("--cover", required=True)
    p.add_argument("--out", required=True)
    p.set_defaults(fn=cmd_images_from)

    p = sub.add_parser("album-plan", help="album manifest.json -> DIR/jobs.json + DIR/album-map.json")
    p.add_argument("--manifest", required=True)
    p.add_argument("--episode", required=True, type=int, help="album number; seeds derive from it")
    p.add_argument("--out", required=True)
    p.set_defaults(fn=cmd_album_plan)

    p = sub.add_parser("album-export", help="copy accepted PNGs to DEST/<track slug>_<name>.png for videos.js")
    p.add_argument("dir")
    p.add_argument("--dest", required=True)
    p.add_argument("--force", action="store_true", help="replace a different image already at the destination")
    p.set_defaults(fn=cmd_album_export)

    p = sub.add_parser("qbraid", help="PRINT the debain2 command for one GPU session (runs nothing)")
    p.add_argument("--jobs", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--host", default="debain2")
    p.add_argument("--profile", default=None, help="qBraid BMA profile, e.g. gpu-rtx-4090 or gpu-l4")
    p.add_argument("--mode", default="lightning", choices=MODES)
    p.set_defaults(fn=cmd_qbraid)
    return ap


def main(argv=None):
    a = build_parser().parse_args(argv)
    try:
        return a.fn(a)
    except ArtError as e:
        print(f"kannaka-art: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
