#!/bin/bash
# kannaka-sound: ONE short qBraid GPU session for beds, stings and SFX. Runs on debain2 with
# ~/qbraid-venv2 (the only host whose ssh bridge to a BMA works). It spends credits.
#
#   usage: [SLUG=gpu-rtx-4090] [SIZE=medium] [ENGINES=musicgen,audiogen,stable-audio] qbraid_sound_run.sh JOBS OUT
#
# Order: provision -> cutoffs -> ssh -> bootstrap (torch + audiocraft + stable-audio-tools) -> gen ->
# scp back -> TERMINATE (EXIT trap, also on failure) -> list strays -> credits after.
# Unlike kannaka-art's wrapper it does NOT refuse while other instances exist (other jobs may be
# running); it only ever terminates the instance it provisioned, and lists the rest.
set -u
JOBS=${1:?usage: qbraid_sound_run.sh JOBS OUT}
OUT=${2:?usage: qbraid_sound_run.sh JOBS OUT}
HERE=$(cd "$(dirname "$0")" && pwd)
PY=${PY:-~/qbraid-venv2/bin/python}
SLUG=${SLUG:-gpu-rtx-4090}
SIZE=${SIZE:-medium}
ENGINES=${ENGINES:-}
MAX_MIN=${MAX_MIN:-90}
LOG=${LOG:-$HOME/kannaka-sound/qbraid.log}
IID_FILE=$(mktemp)
mkdir -p "$(dirname "$LOG")" "$OUT"
exec > >(tee -a "$LOG") 2>&1
echo "=== $(date -u +%FT%TZ) START slug=$SLUG size=$SIZE engines=${ENGINES:-all} jobs=$JOBS out=$OUT"
[ -f "$JOBS" ] || { echo "REFUSED: no jobs file $JOBS"; exit 2; }
[ -f "$HERE/kannaka_sound.py" ] || { echo "REFUSED: $HERE/kannaka_sound.py missing"; exit 2; }

$PY - <<'EOF'
from qbraid_core.services.compute import ComputeClient
c = ComputeClient()
print("CREDITS_BEFORE", c.get_credits_balance()["qbraidCredits"])
print("OTHER_INSTANCES", [(i.instance_id, str(i.status)) for i in c.list_bma_instances() if "TERMINATED" not in str(i.status).upper()])
EOF

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
    print("MINE_AFTER", [(i.instance_id, str(i.status)) for i in c.list_bma_instances() if i.instance_id == iid])
print("STRAYS_ALL", [(i.instance_id, str(i.status)) for i in c.list_bma_instances() if "TERMINATED" not in str(i.status).upper()])
print("CREDITS_AFTER", c.get_credits_balance()["qbraidCredits"], time.strftime("%FT%TZ", time.gmtime()))
EOF
  rm -f "$IID_FILE"
}
trap terminate EXIT

SLUG="$SLUG" IID_FILE="$IID_FILE" MAX_MIN="$MAX_MIN" $PY - <<'EOF'
from qbraid_core.services.compute import ComputeClient
import os, time
c = ComputeClient()
inst = c.provision_bma_instance(os.environ["SLUG"])
iid = inst.instance_id
open(os.environ["IID_FILE"], "w").write(iid)
print("PROVISIONED", iid, time.strftime("%FT%TZ", time.gmtime()))
try:
    c.update_bma_cutoff(iid, auto_stop_idle_minutes=10, max_session_minutes=int(os.environ["MAX_MIN"]))
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
c.wait_for_bma_instance(iid, timeout=1500)
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
$SSH 'nvidia-smi --query-gpu=name,memory.total --format=csv; df -h ~ | tail -1; nproc'
scp -o StrictHostKeyChecking=no "$HERE/kannaka_sound.py" "$ALIAS":~/kannaka_sound.py
scp -o StrictHostKeyChecking=no "$JOBS" "$ALIAS":~/jobs.json
HFTOK=$(cat ~/.cache/huggingface/token 2>/dev/null)
$SSH "set -e; cd ~; T=\$(date +%s)
export HF_TOKEN='$HFTOK' HF_HUB_DISABLE_PROGRESS_BARS=1
python3 -c 'import torch; assert torch.cuda.is_available()' 2>/dev/null || pip install -q --index-url https://download.pytorch.org/whl/cu124 torch torchaudio
pip install -q audiocraft huggingface_hub 2>&1 | tail -3 || true
case "'${ENGINES:-stable-audio}'" in *stable-audio*) pip install -q stable-audio-tools 2>&1 | tail -3 || true;; esac
python3 -c 'import torch; print(\"torch\", torch.__version__, \"cuda\", torch.cuda.is_available())'
echo BOOTSTRAP_SECONDS \$(( \$(date +%s) - T ))
python3 kannaka_sound.py gen --jobs jobs.json --out out --size '$SIZE' --device cuda --label qbraid-$SLUG ${ENGINES:+--engine $ENGINES}
ls -la out | tail -40"
GEN_RC=$?
scp -o StrictHostKeyChecking=no -r "$ALIAS":~/out/. "$OUT"/
FETCH_RC=$?
echo "BILLING_END $(date -u +%FT%TZ) billed_wall_seconds $(( $(date -u +%s) - T_BILL_START ))"
echo "=== $(date -u +%FT%TZ) GEN_DONE gen_rc=$GEN_RC fetch_rc=$FETCH_RC"
[ $GEN_RC -eq 0 ] && [ $FETCH_RC -eq 0 ] || exit 1
