#!/bin/bash
# debain2 driver for the generation-only pod: provision (22-min hard cutoff), push adapter + scripts, run, pull, terminate.
set -u
cd ~/ace-resonance
PY=~/qbraid-venv2/bin/python
$PY - <<'EOF' > gen_provision.log 2>&1
import time
from qbraid_core.services.compute import ComputeClient
c = ComputeClient()
print("CREDITS_BEFORE", c.get_credits_balance()["qbraidCredits"], flush=True)
inst = c.provision_bma_instance("gpu-rtx-4090")
iid = getattr(inst, "instance_id", None) or inst["instance_id"]
print("INSTANCE", iid, flush=True)
open("gen_instance.txt", "w").write(iid)
try: c.update_bma_cutoff(iid, 10, 40)
except Exception as e: print("cutoff note:", type(e).__name__, flush=True)
i = c.get_bma_instance(iid); print("cutoff:", i.auto_stop_idle_minutes, i.max_session_minutes, flush=True)
c.wait_for_bma_instance(iid, timeout=900)
c.configure_ssh_for_instance(iid)
print("ALIAS", c.bma_ssh_alias(iid), flush=True)
EOF
cat gen_provision.log
IID=$(cat gen_instance.txt); A=$(grep ^ALIAS gen_provision.log | awk '{print $2}')
echo "$IID resonance-protocol $(date -u +%FT%TZ) gen-only" >> pods-created.txt
if [ -z "$A" ]; then echo "no alias; terminating"; $PY -c "from qbraid_core.services.compute import ComputeClient as C;C().terminate_bma_instance('$IID')"; exit 1; fi
T0=$(date +%s)
ssh -o BatchMode=yes -o ConnectTimeout=30 "$A" 'mkdir -p /home/jovyan/ace/lora' && \
scp -q ckpt/kannaka_lora/final/adapter_config.json ckpt/kannaka_lora/final/adapter_model.safetensors "$A":/home/jovyan/ace/lora/ && \
scp -q pod_gen.sh pod_generate.py prompts.json "$A":/home/jovyan/ace/ && \
ssh "$A" 'cd /home/jovyan/ace && chmod +x pod_gen.sh && nohup bash pod_gen.sh >/dev/null 2>&1 &' && echo "=== launched at $(date -u +%H:%MZ)"
for i in $(seq 1 38); do
  sleep 60
  L=$(ssh -o BatchMode=yes -o ConnectTimeout=15 "$A" 'tail -2 /home/jovyan/ace/gen.log 2>/dev/null' 2>/dev/null | tr '\n' ' ' | cut -c1-160)
  echo "$(date -u +%H:%MZ) $L"
  echo "$L" | grep -q "POD_GEN_DONE" && break
  if (( i % 3 == 0 )); then mkdir -p gen && scp -q "$A":'/home/jovyan/ace/gen/*' gen/ 2>/dev/null; fi
done
mkdir -p gen && scp -q "$A":'/home/jovyan/ace/gen/*' gen/ 2>/dev/null; scp -q "$A":/home/jovyan/ace/gen.log gen/pod_gen.log 2>/dev/null; find gen -name "*.wav" -size -100k -print -delete
ls -la gen | awk '{print $5, $9}'
echo "=== elapsed $(( ($(date +%s)-T0)/60 )) min; terminating $IID"
$PY - <<EOF
import time
from qbraid_core.services.compute import ComputeClient
c = ComputeClient()
try: c.terminate_bma_instance("$IID")
except Exception as e: print("terminate err", e)
time.sleep(25)
live = [x.instance_id for x in c.list_bma_instances() if str(x.status).split(".")[-1].lower() != "terminated"]
print("MINE_GONE", "$IID" not in live, "| other live:", live)
print("CREDITS_AFTER", c.get_credits_balance()["qbraidCredits"])
EOF
echo "=== GEN_RUN_DONE"
