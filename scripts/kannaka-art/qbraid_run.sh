#!/bin/bash
# kannaka-art: ONE short qBraid GPU session. Runs on debain2 (the only host whose ssh bridge to a
# BMA works), with ~/qbraid-venv2. Never run it by hand without reading it: it spends credits.
#
#   usage: [SLUG=gpu-rtx-4090] [MODE=lightning|base] [RATE=1.45] qbraid_run.sh JOBS OUT
#
#   JOBS  a jobs.json written by `kannaka_art.py plan`
#   OUT   directory on this host that receives the PNGs + manifest.json
#
# Order: refuse if any instance is not TERMINATED -> provision -> cutoffs -> ssh -> bootstrap ->
# gen -> scp back -> TERMINATE (EXIT trap, also on failure) -> STRAYS -> credits after.
# Print `kannaka_art.py qbraid` for the exact invocation. Everything is also logged to $LOG.
set -u
JOBS=${1:?usage: qbraid_run.sh JOBS OUT}
OUT=${2:?usage: qbraid_run.sh JOBS OUT}
HERE=$(cd "$(dirname "$0")" && pwd)
PY=${PY:-~/qbraid-venv2/bin/python}
SLUG=${SLUG:-gpu-rtx-4090}
MODE=${MODE:-lightning}
case "$SLUG" in
  gpu-rtx-4090) DEFAULT_RATE=1.45 ;;
  gpu-l4)       DEFAULT_RATE=0.8167 ;;
  *)            DEFAULT_RATE=0 ;;
esac
RATE=${RATE:-$DEFAULT_RATE}
LOG=${LOG:-$HOME/kannaka-art/qbraid.log}
IID_FILE=$(mktemp)
mkdir -p "$(dirname "$LOG")" "$OUT"
exec > >(tee -a "$LOG") 2>&1
echo "=== $(date -u +%FT%TZ) START slug=$SLUG mode=$MODE jobs=$JOBS out=$OUT"

[ -f "$JOBS" ] || { echo "REFUSED: no jobs file $JOBS"; exit 2; }
[ -f "$HERE/kannaka_art.py" ] || { echo "REFUSED: $HERE/kannaka_art.py missing (scp it next to this script)"; exit 2; }

# A stopped pod still bills for its disk, and a stray we did not start is not ours to kill.
# So: refuse to start while ANY instance is not TERMINATED. This runs before the trap is set.
$PY - <<'EOF'
from qbraid_core.services.compute import ComputeClient
import sys
c = ComputeClient()
print("CREDITS_BEFORE", c.get_credits_balance()["qbraidCredits"])
live = [(i.instance_id, str(i.status)) for i in c.list_bma_instances() if "TERMINATED" not in str(i.status).upper()]
print("PREFLIGHT_INSTANCES", live)
if live:
    print("REFUSED: instance(s) not TERMINATED; resolve them first (a stopped pod still bills)")
    sys.exit(3)
EOF
rc=$?
[ $rc -eq 0 ] || { echo "=== preflight failed rc=$rc; nothing provisioned"; rm -f "$IID_FILE"; exit $rc; }

terminate() {
  local IID
  IID=$(cat "$IID_FILE" 2>/dev/null)
  echo "=== $(date -u +%FT%TZ) TERMINATE ${IID:-<none provisioned>}"
  IID="$IID" $PY - <<'EOF'
from qbraid_core.services.compute import ComputeClient
import os, time
c = ComputeClient()
iid = os.environ.get("IID", "")
if iid:
    try:
        r = c.terminate_bma_instance(iid); print("terminated", getattr(r, "status", r))
    except Exception as e:
        print("TERMINATE_ERROR", repr(e)[:300], "-- CHECK THE qBraid CONSOLE NOW")
    time.sleep(5)
print("STRAYS", [(i.instance_id, str(i.status)) for i in c.list_bma_instances() if "TERMINATED" not in str(i.status).upper()])
print("CREDITS_AFTER", c.get_credits_balance()["qbraidCredits"], time.strftime("%FT%TZ", time.gmtime()))
EOF
  rm -f "$IID_FILE"
}
trap terminate EXIT

# The id is written to IID_FILE the moment provisioning returns, so a crash after that point
# still terminates the instance.
SLUG="$SLUG" IID_FILE="$IID_FILE" $PY - <<'EOF'
from qbraid_core.services.compute import ComputeClient
import os, time
c = ComputeClient()
inst = c.provision_bma_instance(os.environ["SLUG"])
iid = inst.instance_id
open(os.environ["IID_FILE"], "w").write(iid)
print("PROVISIONED", iid, time.strftime("%FT%TZ", time.gmtime()))
try:
    c.update_bma_cutoff(iid, auto_stop_idle_minutes=10, max_session_minutes=60)
except Exception as e:
    print("cutoff-call-raised (re-reading):", repr(e)[:200])
try:
    g = c.get_bma_instance(iid); print("CUTOFF", getattr(g, "auto_stop_idle_minutes", None), getattr(g, "max_session_minutes", None))
except Exception as e:
    print("get err", repr(e)[:200])
EOF
IID=$(cat "$IID_FILE" 2>/dev/null)
echo "IID=$IID"
[ -z "$IID" ] && { echo "NO IID; abort"; exit 1; }

ALIAS=$(IID="$IID" $PY - <<'EOF'
from qbraid_core.services.compute import ComputeClient
import os, sys, time
c = ComputeClient()
iid = os.environ["IID"]
t = time.time()
c.wait_for_bma_instance(iid, timeout=1200)
print("RUNNING after", round(time.time() - t), "s", time.strftime("%FT%TZ", time.gmtime()), file=sys.stderr)
c.configure_ssh_for_instance(iid)
print(c.bma_ssh_alias(iid))
EOF
)
echo "ALIAS=$ALIAS"
[ -z "$ALIAS" ] && { echo "NO ALIAS; abort"; exit 1; }

SSH="ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -o ServerAliveInterval=20 $ALIAS"
for i in 1 2 3 4 5 6; do $SSH 'echo SSH_OK; hostname' && break; echo "ssh retry $i"; sleep 15; done
T_BILL_START=$(date -u +%s)
echo "BILLING_START $(date -u +%FT%TZ)"

$SSH 'nvidia-smi --query-gpu=name,memory.total --format=csv; df -h ~ | tail -1; nproc; free -g | head -2'
scp -o StrictHostKeyChecking=no "$HERE/kannaka_art.py" "$ALIAS":~/kannaka_art.py
scp -o StrictHostKeyChecking=no "$JOBS" "$ALIAS":~/jobs.json
$SSH 'set -e; cd ~; T=$(date +%s)
python3 -c "import torch; assert torch.cuda.is_available()" 2>/dev/null || pip install -q --index-url https://download.pytorch.org/whl/cu124 torch
pip install -q diffusers transformers accelerate safetensors pillow huggingface_hub
python3 -c "import torch,diffusers;print(\"torch\",torch.__version__,\"cuda\",torch.cuda.is_available(),\"diffusers\",diffusers.__version__)"
echo BOOTSTRAP_SECONDS $(( $(date +%s) - T ))
T=$(date +%s)
python3 - <<PY
from huggingface_hub import snapshot_download, hf_hub_download
snapshot_download("stabilityai/stable-diffusion-xl-base-1.0", allow_patterns=["*.json","*.txt","tokenizer*/*","text_encoder/model.fp16.safetensors","text_encoder_2/model.fp16.safetensors","unet/diffusion_pytorch_model.fp16.safetensors","vae/diffusion_pytorch_model.fp16.safetensors","scheduler/*"])
hf_hub_download("ByteDance/SDXL-Lightning","sdxl_lightning_4step_unet.safetensors")
hf_hub_download("madebyollin/sdxl-vae-fp16-fix","diffusion_pytorch_model.safetensors")
PY
echo DOWNLOAD_SECONDS $(( $(date +%s) - T ))
python3 kannaka_art.py gen --jobs jobs.json --out out --mode '"$MODE"' --device cuda --label qbraid-'"$SLUG"' --rate-credits-per-min '"$RATE"'
ls -la out'
GEN_RC=$?
scp -o StrictHostKeyChecking=no -r "$ALIAS":~/out/. "$OUT"/
FETCH_RC=$?
ls -la "$OUT"
echo "BILLING_END $(date -u +%FT%TZ) billed_wall_seconds $(( $(date -u +%s) - T_BILL_START ))"
echo "=== $(date -u +%FT%TZ) GEN_DONE gen_rc=$GEN_RC fetch_rc=$FETCH_RC"
[ $GEN_RC -eq 0 ] && [ $FETCH_RC -eq 0 ] || exit 1
exit 0
