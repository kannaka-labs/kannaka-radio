#!/usr/bin/env bash
# deploy-oracle.sh — the whole kannaka-radio deploy process, repeatable.
#
# Run from the dev box AFTER `git push origin master`. It SSHes to Oracle,
# fast-forwards the checkout, ensures the launcher has the voice-engine env
# (ADR-0012), restarts the systemd service, smoke-verifies, and ROLLS BACK to
# the previous commit if the smoke check fails.
#
#   bash scripts/deploy-oracle.sh                  # pull + restart + verify (+rollback on fail)
#   bash scripts/deploy-oracle.sh --with-piper     # also (re)run install-piper.sh
#   bash scripts/deploy-oracle.sh --restart-kannaka# also cycle the full kannaka-* fleet
#   bash scripts/deploy-oracle.sh --force          # deploy even if a show is ON AIR
#
# ON-AIR GUARD: the deploy refuses (exit 3) when a scheduled show or a locked
# album showcase is playing, because `systemctl restart` ends it and the slot
# does NOT resume — show triggers fire only at minute :00. Slots to know about:
# 09:00 + 21:00 TSOF, 10:00 + 22:00 Ghost Signals, 11:00 showcase, 19:00 Open
# Mic (all America/Chicago). Use --force only when interrupting is the point.
#
# --restart-kannaka (alias --fleet): after the radio deploy verifies, restart
# every active kannaka-*.service so no process keeps running an old, replaced
# binary inode. REQUIRED whenever this deploy accompanies a kannaka-memory
# binary rebuild — `cargo build --release` swaps the file in place but leaves
# long-running PIDs (kannaka-swarm-serve / -attention / -staff / -substrate /
# -ui-bridge, etc.) on the deleted inode running the OLD code. See memory
# oracle-kannaka-zombie-binaries. The step verifies no /proc/PID/exe still
# points at a "(deleted)" kannaka binary.
#
# Rollback: the pre-deploy commit is recorded before the fast-forward. If the
# service fails to come active, port 8888 never listens, or the voice smoke
# render fails, the remote checkout is `git reset --hard`-ed back to that
# commit and the service restarted, so a bad push never stays live. (Untracked
# machine-specific wrappers like run-radio.sh are left untouched — see memory
# oracle-deploy-git-stash-u.)
#
# Env overrides:
#   RADIO_SSH   ssh target           (default opc@170.9.238.136)
#   RADIO_KEY   identity file        (default ~/.ssh/ninja-portal-ed25519)
#   RADIO_DIR   remote checkout      (default /home/opc/kannaka-radio)
#   RADIO_UNIT  systemd unit         (default kannaka-radio)
set -euo pipefail

RADIO_SSH="${RADIO_SSH:-opc@170.9.238.136}"
RADIO_KEY="${RADIO_KEY:-$HOME/.ssh/ninja-portal-ed25519}"
RADIO_DIR="${RADIO_DIR:-/home/opc/kannaka-radio}"
RADIO_UNIT="${RADIO_UNIT:-kannaka-radio}"

WITH_PIPER=0
RESTART_KANNAKA=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --with-piper) WITH_PIPER=1 ;;
    --restart-kannaka|--fleet) RESTART_KANNAKA=1 ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,45p' "$0"; exit 0 ;;
    *) echo "unknown arg: $arg (see --help)" >&2; exit 2 ;;
  esac
done

SSH=(ssh -i "$RADIO_KEY" -o BatchMode=yes -o ConnectTimeout=15 "$RADIO_SSH")

echo "▶ deploying $RADIO_UNIT to $RADIO_SSH:$RADIO_DIR"

"${SSH[@]}" "RADIO_DIR='$RADIO_DIR' RADIO_UNIT='$RADIO_UNIT' WITH_PIPER='$WITH_PIPER' RESTART_KANNAKA='$RESTART_KANNAKA' FORCE='$FORCE' bash -s" <<'REMOTE'
set -euo pipefail
cd "$RADIO_DIR"

# ── Don't cut a listener off mid-programme ──────────────────────────────────
# A scheduled show (Ghost Signals, The Story of Flaukowski) or a locked album
# showcase is an appointment a listener planned around, and NEITHER resumes
# after a restart: the show triggers only fire at minute :00, and the showcase
# slot window is 15 minutes wide. On 2026-08-24 a deploy at 09:01 ended the
# 9 AM drama 70 seconds into the episode.
#
# This runs BEFORE the fast-forward so a refused deploy leaves the checkout
# exactly where it was, rather than parking it ahead of the running service.
#
# An unreachable endpoint is treated as "nothing on air" DELIBERATELY: if the
# service can't answer, there is no programme to protect and the restart is
# the remedy, not the hazard. What we must never do is guess "clear" while the
# service is healthy and mid-episode — hence the [PODCAST] fallback below for
# builds that predate /api/on-air.
if [ "$FORCE" = "1" ]; then
  echo "→ --force: skipping the on-air check"
else
  echo "→ on-air check"
  on_air=$(curl -s --max-time 5 http://127.0.0.1:8888/api/on-air 2>/dev/null || true)
  if printf '%s' "$on_air" | grep -q '"onAir":true'; then
    echo "  ✗ ON AIR: $on_air"
    echo "    deploy refused — wait for it to finish, or re-run with --force"
    exit 3
  elif printf '%s' "$on_air" | grep -q '"onAir":false'; then
    echo "  clear"
  else
    # /api/on-air absent (build predates this guard) or service not answering.
    # Fall back to the [PODCAST] marker the scheduler stamps on the track it
    # loads — the same signal, one layer coarser.
    np=$(curl -s --max-time 5 http://127.0.0.1:8888/api/now-playing 2>/dev/null || true)
    if printf '%s' "$np" | grep -q 'PODCAST'; then
      echo "  ✗ ON AIR (via now-playing): $np"
      echo "    deploy refused — wait for it to finish, or re-run with --force"
      exit 3
    fi
    if [ -z "$np" ]; then
      echo "  service not answering — nothing to interrupt, proceeding"
    else
      echo "  clear (no /api/on-air on the running build; [PODCAST] marker absent)"
    fi
  fi
fi

# ── Record the rollback point BEFORE we move HEAD ───────────────────────────
before=$(git rev-parse HEAD)
before_short=$(git rev-parse --short HEAD)

echo "→ git fetch + fast-forward"
git fetch --quiet origin
git merge --ff-only origin/master >/dev/null
after_short=$(git rev-parse --short HEAD)
echo "  $before_short → $after_short"

echo "→ ensure launcher voice-engine env (idempotent)"
LAUNCHER=/home/opc/run-radio.sh
if [ -f "$LAUNCHER" ] && ! grep -q "EDGE_TTS_BIN" "$LAUNCHER"; then
  cp -n "$LAUNCHER" "$LAUNCHER.bak-$(date +%Y%m%d)" || true
  python3 - "$LAUNCHER" <<'PY'
import sys
p=sys.argv[1]; s=open(p).read()
block="""
# -- Voice engine (ADR-0012): local-first persona TTS --
export EDGE_TTS_BIN=/home/opc/.local/bin/edge-tts
export PIPER_BIN=/home/opc/.kannaka/piper/piper
export PIPER_VOICES_DIR=/home/opc/.kannaka/piper/voices

"""
a="export KANNAKA_ICECAST_SOURCE=1"
if "EDGE_TTS_BIN" not in s and a in s:
    s=s.replace(a, block+a, 1); open(p,"w").write(s); print("  launcher patched")
PY
else
  echo "  launcher already configured"
fi

if [ "$WITH_PIPER" = "1" ]; then
  echo "→ install-piper.sh"
  bash "$RADIO_DIR/scripts/install-piper.sh"
fi

# ── Verify: service active + port listening + one live voice render ─────────
verify_radio() {
  systemctl is-active --quiet "$RADIO_UNIT" || {
    echo "  SERVICE NOT ACTIVE"; journalctl -u "$RADIO_UNIT" -n 20 --no-pager || true; return 1;
  }
  ss -ltn 2>/dev/null | grep -q ':8888' || { echo "  PORT 8888 NOT LISTENING"; return 1; }
  ( cd "$RADIO_DIR"
    export EDGE_TTS_BIN=/home/opc/.local/bin/edge-tts PIPER_BIN=/home/opc/.kannaka/piper/piper PIPER_VOICES_DIR=/home/opc/.kannaka/piper/voices
    node -e '
      const ve=require("./server/voice-engine");
      ve.synthesize({text:"Deploy smoke test for Kannaka Radio.",persona:"news",outPath:"/tmp/deploy_smoke.mp3"},(e,f,eng)=>{
        if(e){console.error("  SMOKE FAILED:",e.message);process.exit(1);}
        const sz=require("fs").statSync(f).size;
        console.log("  smoke OK: engine="+eng+" "+sz+"b");
      });' ) || return 1
  # The confab gate fails closed: a rules file that does not hash to the
  # frozen value silently stops orations, showcase intros and replies. Fail
  # the deploy (and roll back) instead. Skipped on a commit without the gate.
  if [ -f "$RADIO_DIR/server/lib/confab-rules-v2.js" ]; then
    ( cd "$RADIO_DIR" && node -e '
      const st=require("./server/lib/confab-rules-v2").rulesStatus();
      if(!st.ok){console.error("  CONFAB RULES v2 UNAVAILABLE:",st.reason);process.exit(1);}
      console.log("  confab rules v2 OK: "+st.sha256.slice(0,12)+"…");' ) || return 1
  fi
  return 0
}

echo "→ restart $RADIO_UNIT"
sudo systemctl restart "$RADIO_UNIT"
sleep 4

echo "→ verify"
if verify_radio; then
  echo "✓ radio deploy verified at $after_short"
else
  echo "✗ verify failed — rolling back $after_short → $before_short"
  git reset --hard "$before" >/dev/null
  sudo systemctl restart "$RADIO_UNIT"
  sleep 4
  if verify_radio; then
    echo "✓ rolled back to $before_short and service healthy"
  else
    echo "✗ ROLLBACK ALSO UNHEALTHY — manual intervention required"
    journalctl -u "$RADIO_UNIT" -n 30 --no-pager || true
  fi
  exit 1
fi

# ── Optional: cycle the full kannaka-* fleet (zombie-binary rule) ───────────
if [ "$RESTART_KANNAKA" = "1" ]; then
  echo "→ restart kannaka-* fleet (zombie-binary rule)"
  mapfile -t KUNITS < <(systemctl list-units --type=service --state=active --no-legend 'kannaka-*.service' 2>/dev/null | awk '{print $1}')
  if [ "${#KUNITS[@]}" -eq 0 ]; then
    echo "  no active kannaka-* services found"
  else
    # Restart the single-writer (kannaka-memory) first, then the rest.
    ordered=()
    for u in "${KUNITS[@]}"; do [ "$u" = "kannaka-memory.service" ] && ordered+=("$u"); done
    for u in "${KUNITS[@]}"; do [ "$u" != "kannaka-memory.service" ] && ordered+=("$u"); done

    fleet_ok=1
    for u in "${ordered[@]}"; do
      printf '  restart %-28s ' "$u"
      if sudo systemctl restart "$u"; then echo "ok"; else echo "FAILED"; fleet_ok=0; fi
    done
    sleep 3

    for u in "${ordered[@]}"; do
      systemctl is-active --quiet "$u" || {
        echo "  ✗ $u not active after restart"; journalctl -u "$u" -n 15 --no-pager || true; fleet_ok=0;
      }
    done

    # Zombie check: any kannaka process still executing a replaced (deleted)
    # binary inode? /proc/PID/exe resolves to "…/kannaka (deleted)" if so.
    for pid in $(pgrep -f 'target/release/kannaka' 2>/dev/null || true); do
      target=$(sudo readlink "/proc/$pid/exe" 2>/dev/null || true)
      case "$target" in
        *"(deleted)"*) echo "  ⚠ pid $pid still on a deleted kannaka inode: $target"; fleet_ok=0 ;;
      esac
    done

    if [ "$fleet_ok" = "1" ]; then
      echo "  ✓ kannaka-* fleet restarted cleanly (no deleted-inode zombies)"
    else
      echo "  ✗ kannaka-* fleet restart had failures — investigate above"
      exit 1
    fi
  fi
fi

echo "✓ deploy complete"
REMOTE
