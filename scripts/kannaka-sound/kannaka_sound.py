#!/usr/bin/env python3
"""kannaka-sound: beds, stings and sound effects for the production, from open audio models.

Same shape as kannaka-art: a jobs.json in, ONE short qBraid GPU session, files back, pod terminated.

    plan    --jobs JOBS.json --out DIR          check a jobs file, write DIR/jobs.json
    gen     --jobs JOBS --out DIR --engine ...  runs ON THE POD (needs torch + the engine's package)
    qbraid  --jobs JOBS --out DIR               print the exact debain2 commands (never executes)
    post    DIR --out DIR2                      normalize to -18 LUFS 44.1 kHz mp3 on this box (ffmpeg)

Engines and what they may be used for:
    musicgen      facebook/musicgen-{small,medium,large}: music beds and stings. Weights are CC-BY-NC 4.0:
                  NON-COMMERCIAL. Comparison and research only; nothing from it airs in a paid slot.
    audiogen      facebook/audiogen-medium: sound effects. Also CC-BY-NC 4.0, same rule.
    stable-audio  stabilityai/stable-audio-open-1.0 (or -small): beds, stings and SFX up to 47 s.
                  Stability AI Community License: commercial use allowed under $1M revenue after
                  registering. The repo is GATED: the HF account must accept its terms in a browser
                  before `gen` can download it.

A job: {"id": "bed-suspense", "kind": "bed|sting|sfx", "prompt": "...", "seconds": 40,
        "engines": ["musicgen", "stable-audio"]}  (engines optional: defaults by kind).
Output: DIR/<id>--<engine>.wav plus DIR/manifest.json (prompt, engine, seconds, seed, wall time, license).
"""
import argparse
import json
import os
import re
import shlex
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
KINDS = ("bed", "sting", "sfx")
ENGINES = ("musicgen", "audiogen", "stable-audio")
DEFAULT_ENGINES = {"bed": ["musicgen", "stable-audio"], "sting": ["musicgen", "stable-audio"], "sfx": ["audiogen", "stable-audio"]}
LICENSE = {
    "musicgen": "CC-BY-NC-4.0 (non-commercial; comparison only)",
    "audiogen": "CC-BY-NC-4.0 (non-commercial; comparison only)",
    "stable-audio": "Stability AI Community License (commercial under $1M revenue, registration required)",
}
MAX_SECONDS = {"musicgen": 30, "audiogen": 10, "stable-audio": 47}


class SoundError(Exception):
    pass


def load_jobs(path):
    with open(path, encoding="utf-8") as f:
        plan = json.load(f)
    jobs = plan.get("jobs") if isinstance(plan, dict) else plan
    if not isinstance(jobs, list) or not jobs:
        raise SoundError("jobs file holds no jobs")
    seen = set()
    for j in jobs:
        for k in ("id", "kind", "prompt", "seconds"):
            if k not in j:
                raise SoundError(f"job missing {k!r}: {j}")
        if j["kind"] not in KINDS:
            raise SoundError(f"job {j['id']}: kind must be one of {KINDS}")
        if j["id"] in seen:
            raise SoundError(f"duplicate job id {j['id']}")
        seen.add(j["id"])
        if not (1 <= float(j["seconds"]) <= 47):
            raise SoundError(f"job {j['id']}: seconds must be 1..47")
        j.setdefault("engines", list(DEFAULT_ENGINES[j["kind"]]))
        for e in j["engines"]:
            if e not in ENGINES:
                raise SoundError(f"job {j['id']}: unknown engine {e}")
    return plan if isinstance(plan, dict) else {"jobs": jobs}


def cmd_plan(a):
    plan = load_jobs(a.jobs)
    os.makedirs(a.out, exist_ok=True)
    with open(os.path.join(a.out, "jobs.json"), "w", encoding="utf-8") as f:
        json.dump(plan, f, indent=1)
    n = sum(len(j["engines"]) for j in plan["jobs"])
    print(f"{len(plan['jobs'])} jobs, {n} renders -> {os.path.join(a.out, 'jobs.json')}")
    return 0


# ---------------------------------------------------------------- gen (the only torch user)

def _write_wav(path, wav, sr):
    import torch
    import torchaudio
    if wav.dim() == 3:
        wav = wav[0]
    wav = wav.detach().cpu().float().clamp(-1, 1)
    torchaudio.save(path, wav, sr)


def _gen_musicgen(size, jobs, out, device):
    """MusicGen through transformers: no audiocraft, no torch pin, no xformers."""
    import torch
    from transformers import AutoProcessor, MusicgenForConditionalGeneration
    name = f"facebook/musicgen-{size}"
    t0 = time.time()
    proc = AutoProcessor.from_pretrained(name)
    model = MusicgenForConditionalGeneration.from_pretrained(name, torch_dtype=torch.float16 if device.startswith("cuda") else torch.float32).to(device)
    sr = model.config.audio_encoder.sampling_rate
    frame_rate = model.config.audio_encoder.frame_rate
    print(f"[musicgen] loaded {name} in {time.time() - t0:.0f}s (sr {sr})")
    results = []
    for j in jobs:
        secs = min(float(j["seconds"]), MAX_SECONDS["musicgen"])
        inputs = proc(text=[j["prompt"]], padding=True, return_tensors="pt").to(device)
        t = time.time()
        with torch.no_grad():
            wav = model.generate(**inputs, do_sample=True, guidance_scale=3.0, max_new_tokens=int(secs * frame_rate))
        path = os.path.join(out, f"{j['id']}--musicgen.wav")
        _write_wav(path, wav, sr)
        dt = time.time() - t
        print(f"[musicgen] {j['id']}: {secs:.0f}s audio in {dt:.1f}s")
        results.append({"id": j["id"], "engine": "musicgen", "model": name, "file": os.path.basename(path), "seconds": secs,
                        "prompt": j["prompt"], "wall_seconds": round(dt, 1), "license": LICENSE["musicgen"]})
    return results


def _gen_audiogen(size, jobs, out, device):
    """AudioGen is only in audiocraft (which pins torch 2.1 and wants xformers): best effort."""
    from audiocraft.models import AudioGen
    name = f"facebook/audiogen-{size}"
    t0 = time.time()
    model = AudioGen.get_pretrained(name, device=device)
    print(f"[audiogen] loaded {name} in {time.time() - t0:.0f}s")
    results = []
    for j in jobs:
        secs = min(float(j["seconds"]), MAX_SECONDS["audiogen"])
        model.set_generation_params(duration=secs)
        t = time.time()
        wav = model.generate([j["prompt"]])
        path = os.path.join(out, f"{j['id']}--audiogen.wav")
        _write_wav(path, wav, model.sample_rate)
        dt = time.time() - t
        print(f"[audiogen] {j['id']}: {secs:.0f}s audio in {dt:.1f}s")
        results.append({"id": j["id"], "engine": "audiogen", "model": name, "file": os.path.basename(path), "seconds": secs,
                        "prompt": j["prompt"], "wall_seconds": round(dt, 1), "license": LICENSE["audiogen"]})
    return results


def _gen_stable_audio(size, jobs, out, device):
    import torch
    from stable_audio_tools import get_pretrained_model
    from stable_audio_tools.inference.generation import generate_diffusion_cond
    name = "stabilityai/stable-audio-open-1.0" if size != "small" else "stabilityai/stable-audio-open-small"
    t0 = time.time()
    model, cfg = get_pretrained_model(name)
    model = model.to(device)
    sr, sample_size = cfg["sample_rate"], cfg["sample_size"]
    print(f"[stable-audio] loaded {name} in {time.time() - t0:.0f}s (sr {sr})")
    results = []
    for j in jobs:
        secs = min(float(j["seconds"]), MAX_SECONDS["stable-audio"])
        cond = [{"prompt": j["prompt"], "seconds_start": 0, "seconds_total": secs}]
        t = time.time()
        wav = generate_diffusion_cond(model, steps=100, cfg_scale=7, conditioning=cond, sample_size=sample_size,
                                      sigma_min=0.3, sigma_max=500, sampler_type="dpmpp-3m-sde", device=device)
        wav = wav[:, :, : int(secs * sr)]
        path = os.path.join(out, f"{j['id']}--stable-audio.wav")
        _write_wav(path, wav, sr)
        dt = time.time() - t
        print(f"[stable-audio] {j['id']}: {secs:.0f}s audio in {dt:.1f}s")
        results.append({"id": j["id"], "engine": "stable-audio", "model": name, "file": os.path.basename(path), "seconds": secs,
                        "prompt": j["prompt"], "wall_seconds": round(dt, 1), "license": LICENSE["stable-audio"]})
    return results


def run_gen(a):
    plan = load_jobs(a.jobs)
    os.makedirs(a.out, exist_ok=True)
    engines = a.engine.split(",") if a.engine else list(ENGINES)
    manifest = {"started": time.strftime("%FT%TZ", time.gmtime()), "label": a.label, "renders": [], "failures": []}
    for engine in engines:
        jobs = [j for j in plan["jobs"] if engine in j["engines"]]
        if not jobs:
            continue
        try:
            if engine == "musicgen":
                manifest["renders"] += _gen_musicgen(a.size, jobs, a.out, a.device)
            elif engine == "audiogen":
                manifest["renders"] += _gen_audiogen(a.size, jobs, a.out, a.device)
            elif engine == "stable-audio":
                manifest["renders"] += _gen_stable_audio(a.size, jobs, a.out, a.device)
        except Exception as e:  # one engine failing must not lose the others' renders
            msg = f"{engine}: {type(e).__name__}: {str(e)[:300]}"
            print("[gen] ENGINE FAILED", msg, file=sys.stderr)
            manifest["failures"].append(msg)
        with open(os.path.join(a.out, "manifest.json"), "w", encoding="utf-8") as f:
            json.dump(manifest, f, indent=1)
    manifest["finished"] = time.strftime("%FT%TZ", time.gmtime())
    with open(os.path.join(a.out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=1)
    print(f"[gen] {len(manifest['renders'])} renders, {len(manifest['failures'])} engine failures -> {a.out}")
    return 0 if manifest["renders"] else 1


# ---------------------------------------------------------------- qbraid (prints only)

def local_shell_path(p):
    p = os.path.abspath(p)
    if os.name == "nt" and len(p) > 2 and p[1] == ":":
        return "/" + p[0].lower() + p[2:].replace("\\", "/")
    return p


def qbraid_command(jobs, out, host="debain2", remote_dir="~/kannaka-sound", profile=None, engines=None, size="medium"):
    tag = time.strftime("run-%Y%m%dT%H%MZ", time.gmtime())
    rjobs = f"{remote_dir}/{tag}/jobs.json"
    rout = f"{remote_dir}/{tag}/out"
    env = f"SIZE={size}" + (f" SLUG={profile}" if profile else "") + (f" ENGINES={engines}" if engines else "")
    q = lambda p: shlex.quote(local_shell_path(p))  # noqa: E731
    return [
        f"ssh {host} 'mkdir -p {remote_dir}/{tag}'",
        f"scp {q(os.path.join(HERE, 'kannaka_sound.py'))} {q(os.path.join(HERE, 'qbraid_sound_run.sh'))} {host}:{remote_dir}/",
        f"scp {q(jobs)} {host}:{rjobs}",
        f"ssh {host} '{env} bash {remote_dir}/qbraid_sound_run.sh {rjobs} {rout}'",
        f"mkdir -p {q(out)} && scp -r {host}:{rout}/. {q(out)}/",
    ]


def cmd_qbraid(a):
    print("# Run these from this machine. They provision ONE qBraid GPU instance on debain2 and TERMINATE it on exit.")
    for line in qbraid_command(a.jobs, a.out, host=a.host, profile=a.profile, engines=a.engine, size=a.size):
        print(line)
    return 0


# ---------------------------------------------------------------- post (this box, ffmpeg)

KIND_DIR = {"bed": "beds", "sting": "stings", "sfx": "sfx"}


def _loudnorm_stats(ff, path, lufs=-18.0):
    """First loudnorm pass: the measured stats the second pass needs."""
    r = subprocess.run([ff, "-v", "info", "-i", path, "-af", f"loudnorm=I={lufs}:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"],
                       capture_output=True, text=True)
    m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", r.stderr, re.S)
    return json.loads(m.group(0)) if m else None


def cmd_post(a):
    """wav -> Kannaka Sound Library mp3s: -18 LUFS, 44.1 kHz, beds/ stings/ sfx/, plus a library manifest."""
    ff = a.ffmpeg or "ffmpeg"
    renders = {}
    mpath = os.path.join(a.dir, "manifest.json")
    if os.path.exists(mpath):
        with open(mpath, encoding="utf-8") as f:
            for r in json.load(f).get("renders", []):
                renders[r["file"]] = r
    per_id = {}
    for r in renders.values():
        per_id.setdefault(r["id"], []).append(r["engine"])
    library = []
    for name in sorted(os.listdir(a.dir)):
        if not name.endswith(".wav"):
            continue
        r = renders.get(name, {"id": name[:-4], "engine": "", "prompt": "", "model": "", "seconds": None, "license": ""})
        kind = r["id"].split("-", 1)[0]
        stem = a.prefix + r["id"] + ("" if len(per_id.get(r["id"], [])) <= 1 else "-" + r["engine"])
        sub = os.path.join(a.out, KIND_DIR.get(kind, "sfx"))
        os.makedirs(sub, exist_ok=True)
        dst = os.path.join(sub, stem + ".mp3")
        src = os.path.join(a.dir, name)
        # Measure integrated loudness, apply the exact gain, then a -1.5 dBTP limiter: loudnorm itself refuses to
        # reach the target on peaky clips (crackle, rings, teletype have 30 dB crest factors) and lands 5 LU low.
        # areverse/afade/areverse fades the LAST 0.5 s whatever the clip's length.
        st = _loudnorm_stats(ff, src, a.lufs)
        if not st:
            print(f"[post] FAIL {name}: loudnorm measurement", file=sys.stderr)
            continue
        gain = a.lufs - float(st["input_i"])
        af = f"volume={gain:.2f}dB,alimiter=limit=0.84:level=false:attack=3:release=50,afade=t=in:d=0.02,areverse,afade=t=in:d=0.5,areverse"
        cmd = [ff, "-v", "error", "-y", "-i", src, "-af", af, "-ar", "44100", "-ac", "2", "-b:a", "160k", dst]
        res = subprocess.run(cmd, capture_output=True, text=True)
        if res.returncode:
            print(f"[post] FAIL {name}: {res.stderr.strip()[-200:]}", file=sys.stderr)
            continue
        out_st = _loudnorm_stats(ff, dst, a.lufs)
        library.append({"file": f"{KIND_DIR.get(kind, 'sfx')}/{stem}.mp3", "kind": kind, "id": r["id"], "prompt": r["prompt"],
                        "model": r["model"], "engine": r["engine"], "seconds": r["seconds"],
                        "lufs": float(out_st["input_i"]) if out_st else None, "license": r["license"]})
    with open(os.path.join(a.out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump({"name": a.name, "clips": library}, f, indent=1)
    print(f"[post] {len(library)} mp3 -> {a.out}")
    return 0 if library else 1


def build_parser():
    ap = argparse.ArgumentParser(prog="kannaka_sound.py", description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("plan"); p.add_argument("--jobs", required=True); p.add_argument("--out", required=True); p.set_defaults(fn=cmd_plan)
    p = sub.add_parser("gen"); p.add_argument("--jobs", required=True); p.add_argument("--out", required=True)
    p.add_argument("--engine", default="", help="comma list of engines; default all the jobs name")
    p.add_argument("--size", default="medium", help="musicgen/audiogen size or stable-audio 'small'")
    p.add_argument("--device", default="cuda"); p.add_argument("--label", default=""); p.set_defaults(fn=run_gen)
    p = sub.add_parser("qbraid"); p.add_argument("--jobs", required=True); p.add_argument("--out", required=True)
    p.add_argument("--host", default="debain2"); p.add_argument("--profile", default=None); p.add_argument("--engine", default=None)
    p.add_argument("--size", default="medium"); p.set_defaults(fn=cmd_qbraid)
    p = sub.add_parser("post"); p.add_argument("dir"); p.add_argument("--out", required=True); p.add_argument("--lufs", type=float, default=-18.0)
    p.add_argument("--prefix", default="kannaka-sound-"); p.add_argument("--name", default="Kannaka Sound Library v0")
    p.add_argument("--ffmpeg", default=None); p.set_defaults(fn=cmd_post)
    return ap


def main(argv=None):
    a = build_parser().parse_args(argv)
    try:
        return a.fn(a)
    except SoundError as e:
        print(f"kannaka_sound: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
