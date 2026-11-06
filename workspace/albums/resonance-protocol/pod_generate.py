"""Resonance Protocol: generate TAKES takes of every track with the Kannaka LoRA (no base pass), through ACE-Step's HTTP API on the pod.

Usage (on the pod): uv run --project /home/jovyan/ace/ACE-Step-1.5 python pod_generate.py <lora_dir> <out_dir>
Starts `acestep-api` (port 8001), waits for /health, initialises the turbo DiT via /v1/init (the server lazy-loads
otherwise and /v1/lora/load 500s), loads the LoRA, generates, downloads mp3s, writes gen.json. Outputs are named
kannaka-ace-<mood>-t<k>.wav.
"""
import json, os, subprocess, sys, time, urllib.parse, urllib.request

LORA, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
API = "http://127.0.0.1:8001"
PROMPTS = json.load(open("/home/jovyan/ace/prompts.json"))  # [{mood, caption, lyrics, duration}]


def call(path, body=None, method="POST", raw=False, timeout=900):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method, headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read() if raw else json.loads(r.read().decode())


env = dict(os.environ, ACESTEP_INIT_LLM="false", ACESTEP_CONFIG_PATH="acestep-v15-turbo")
server = subprocess.Popen(["uv", "run", "acestep-api", "--port", "8001"], cwd="/home/jovyan/ace/ACE-Step-1.5", env=env,
                          stdout=open(os.path.join(OUT, "api.log"), "w"), stderr=subprocess.STDOUT)
for _ in range(120):
    try:
        if call("/health", method="GET"): break
    except Exception:
        time.sleep(5)
else:
    print("API never came up"); server.kill(); sys.exit(2)
print("api up", flush=True)
t0 = time.time()
print("init:", json.dumps(call("/v1/init", {"model": "acestep-v15-turbo", "init_llm": False}))[:300], "in", round(time.time() - t0), "s", flush=True)


TAKES = 2


def generate(tag, use_lora):
    results = {}
    for p in [dict(q, mood=f"{q['mood']}-t{k}") for q in PROMPTS for k in range(1, TAKES + 1)]:
        caption = ("kannakasound, " if use_lora else "") + p["caption"]
        t0 = time.time()
        # WAV: the pod image has no ffmpeg, and ACE-Step's MP3 export has no fallback (first gen pod: empty path → /v1/audio 403).
        r = call("/release_task", {"prompt": caption, "lyrics": p["lyrics"], "audio_duration": p.get("duration", 180), "vocal_language": "en", "audio_format": "wav", "thinking": False})
        tid = (r.get("data") or {}).get("task_id") or r.get("task_id")
        print(tag, p["mood"], "task", tid, flush=True)
        for _ in range(300):
            q = call("/query_result", {"task_id_list": [tid]})
            item = (q.get("data") or [{}])[0]
            if item.get("status") == 1:
                res = json.loads(item["result"]) if isinstance(item.get("result"), str) else item.get("result")
                res = res[0] if isinstance(res, list) else res
                path = res.get("file") or ""
                if not path.strip("/v1/audio?path="):
                    results[p["mood"]] = {"error": "empty file path in result (export failed on the pod): " + str(res)[:300]}
                    print(tag, p["mood"], "FAILED export", flush=True); break
                fn = os.path.join(OUT, f"kannaka-ace-{p['mood']}.wav")
                url = path if path.startswith("/v1/audio") else "/v1/audio?path=" + urllib.parse.quote(path, safe="")
                data = call(url, method="GET", raw=True)
                if len(data) < 100_000:
                    results[p["mood"]] = {"error": f"downloaded file too small ({len(data)} bytes)"}; print(tag, p["mood"], "FAILED size", len(data), flush=True); break
                open(fn, "wb").write(data)
                results[p["mood"]] = {"file": fn, "seconds": round(time.time() - t0, 1), "seed": res.get("seed_value"), "caption": caption, "duration": p.get("duration")}
                print(tag, p["mood"], "done in", results[p["mood"]]["seconds"], "s", flush=True)
                break
            if item.get("status") == 2:
                results[p["mood"]] = {"error": str(item)[:500]}; print(tag, p["mood"], "FAILED", str(item)[:300], flush=True); break
            time.sleep(3)
        json.dump(out, open(os.path.join(OUT, "gen.json"), "w"), indent=1)
    return results


out = {"lora": {}}
print("load lora:", call("/v1/lora/load", {"lora_path": LORA}), flush=True)
print("status:", call("/v1/lora/status", method="GET"), flush=True)
out["lora"] = generate("lora", True)
json.dump(out, open(os.path.join(OUT, "gen.json"), "w"), indent=1)
server.terminate()
print("GEN_DONE", flush=True)
