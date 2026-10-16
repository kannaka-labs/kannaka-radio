#!/bin/bash
# disk-monitor.sh — hourly root-disk usage check that publishes a NATS
# alert when usage crosses a threshold. Closes the no-alarm gap from the
# 2026-05-19 100%-full incident (see kannaka-radio#36).
#
# Cron line:
#   33 * * * * /home/opc/kannaka-radio/scripts/disk-monitor.sh >> /tmp/disk-monitor.log 2>&1
#
# Output: one human-readable line on every run (so the log shows liveness)
# plus a `RADIO.alert.disk` publish when usage crosses DISK_ALERT_THRESHOLD
# (default 80). Throttled to one alert per (threshold, hour) so a wedged
# cycle doesn't flood the bus.
#
# Vendored as `.example` is intentional — see the comment in prune-cron.sh
# about `git stash -u` sweeping un-vendored shell scripts.

set -u

THRESHOLD="${DISK_ALERT_THRESHOLD:-80}"
NATS_URL="${NATS_URL:-nats://127.0.0.1:4222}"
NATS_ENV="${NATS_ENV:-/home/opc/.kannaka-nats.env}"
STATE_DIR="${STATE_DIR:-/tmp}"
SUBJECT="${SUBJECT:-RADIO.alert.disk}"
HOSTNAME_TAG="$(hostname -s 2>/dev/null || echo unknown)"

# Load NATS auth if available (Oracle box has authz). `set -a` exports
# NATS_USER / NATS_PASSWORD, and the nats CLI reads them from its environment.
# They are never passed as --user/--password: argv is readable by every user on
# the box through `ps` and /proc/<pid>/cmdline, the environment is not.
if [ -f "$NATS_ENV" ]; then
  set -a; . "$NATS_ENV"; set +a
fi

# Resolve nats binary; bail quietly if not installed (don't break the cron).
NATS_BIN="$(command -v nats 2>/dev/null || true)"

# df values for root filesystem.
read -r FS SIZE USED AVAIL PCT MOUNT < <(df -P / | tail -1)
USE_NUM="${PCT%\%}"

TS="$(date -Iseconds)"
echo "[$TS] root=${PCT} used=${USED} avail=${AVAIL} threshold=${THRESHOLD}%"

# Second line of defense — health-check the prune cron itself (#36 gap 2).
# If /tmp/prune-cron.log hasn't been touched in PRUNE_STALE_HOURS, raise
# an alert even when disk usage is still under the threshold. A wedged
# prune cron is the failure mode that filled the disk on 2026-05-19 —
# catching that BEFORE it manifests as 100%-full is the whole point.
PRUNE_LOG="${PRUNE_LOG:-/tmp/prune-cron.log}"
PRUNE_STALE_HOURS="${PRUNE_STALE_HOURS:-2}"
if [ -f "$PRUNE_LOG" ]; then
  PRUNE_AGE_S=$(( $(date +%s) - $(stat -c %Y "$PRUNE_LOG" 2>/dev/null || date +%s) ))
  PRUNE_AGE_H=$(( PRUNE_AGE_S / 3600 ))
  if [ "$PRUNE_AGE_H" -ge "$PRUNE_STALE_HOURS" ]; then
    HOUR_TAG="$(date -u +%Y%m%d%H)"
    PRUNE_STATE="${STATE_DIR}/disk-monitor.prune-stale.${HOUR_TAG}"
    if [ ! -f "$PRUNE_STATE" ]; then
      echo "[WARN] prune-cron log ${PRUNE_LOG} hasn't been touched in ${PRUNE_AGE_H}h" >&2
      logger -t kannaka-disk-monitor -p user.warn "prune-cron stale (age=${PRUNE_AGE_H}h)" 2>/dev/null || true
      if [ -n "$NATS_BIN" ]; then
        STALE_PAYLOAD="{\"schema_version\":\"1.0\",\"ts\":$(date +%s%3N),\"agent_id\":\"${HOSTNAME_TAG}\",\"subject\":\"RADIO.alert.prune\",\"prune_log\":\"${PRUNE_LOG}\",\"age_hours\":${PRUNE_AGE_H}}"
        if "$NATS_BIN" --server "$NATS_URL" pub "RADIO.alert.prune" "$STALE_PAYLOAD" >/dev/null 2>&1; then
          touch "$PRUNE_STATE"
        fi
      else
        touch "$PRUNE_STATE"
      fi
    fi
  fi
else
  # Missing log = cron never ran since last log rotation. Treat as stale.
  echo "[WARN] prune-cron log ${PRUNE_LOG} does not exist" >&2
  logger -t kannaka-disk-monitor -p user.warn "prune-cron log missing: ${PRUNE_LOG}" 2>/dev/null || true
fi

if [ "$USE_NUM" -lt "$THRESHOLD" ]; then
  exit 0
fi

# Fallback alarm: always echo a WARN-prefixed line to stderr so the
# message appears in journalctl regardless of whether NATS is reachable.
# Without this, a NATS outage during a real disk-pressure event would
# silently swallow the alert — which is exactly what happened on
# 2026-05-22→23 when the disk-monitor cron itself was permission-denied
# and nobody noticed for 24+ hours.
echo "[WARN] disk-pressure root=${PCT} avail=${AVAIL} band-trigger" >&2
logger -t kannaka-disk-monitor -p user.warn "root=${PCT} avail=${AVAIL}" 2>/dev/null || true

# Throttle: only publish once per hour per threshold band. Bands are
# {threshold..89, 90..94, 95..99, 100} so a worsening trend produces a new
# alert even within the same hour.
if [ "$USE_NUM" -ge 100 ]; then BAND="100";
elif [ "$USE_NUM" -ge 95 ]; then BAND="95-99";
elif [ "$USE_NUM" -ge 90 ]; then BAND="90-94";
else BAND="${THRESHOLD}-89"; fi
HOUR="$(date -u +%Y%m%d%H)"
STATE_FILE="${STATE_DIR}/disk-monitor.last-alert.${BAND}.${HOUR}"
if [ -f "$STATE_FILE" ]; then
  echo "  (suppressing duplicate alert for band ${BAND} within ${HOUR})"
  exit 0
fi

# Build top-5 offender list — operators see WHY in the alert payload.
# du runs un-sudo (own home only); sudo would require NOPASSWD and we'd
# rather a usable payload than a script that silently 1's-out.
TOP_OFFENDERS="$(du -sh /home/opc/* 2>/dev/null | sort -hr | head -5 | tr '\n' ',' | sed 's/,$//' | tr -d '"')"

PAYLOAD=$(cat <<EOF
{"schema_version":"1.0","ts":$(date +%s%3N),"agent_id":"${HOSTNAME_TAG}","subject":"${SUBJECT}","pct_used":${USE_NUM},"avail":"${AVAIL}","mount":"${MOUNT}","band":"${BAND}","top_offenders":"${TOP_OFFENDERS}"}
EOF
)

echo "  ALERT: ${PAYLOAD}"

if [ -n "$NATS_BIN" ]; then
  if "$NATS_BIN" --server "$NATS_URL" pub "$SUBJECT" "$PAYLOAD" >/dev/null 2>&1; then
    touch "$STATE_FILE"
    echo "  published to ${SUBJECT}"
  else
    echo "  WARN: nats pub failed; will retry next cycle"
  fi
else
  # Mark anyway — without nats CLI we can still suppress duplicate stdout noise.
  touch "$STATE_FILE"
  echo "  WARN: nats CLI not installed; alert only logged"
fi
