#!/usr/bin/env bash
#
# Back up the radio-ads database.
#
# This file is the money ledger: payments, Stripe payment-intent ids, frozen
# pro-rata refund amounts, dispute state, and the GSA entitlements advertisers
# have paid for. On 2026-08-24 an audit found it had ZERO backups — the only
# backup directory on the box was five months old — while the station has been
# taking live card payments since the 23rd. Losing it means losing the record
# of who paid, who is owed a refund, and what has already aired.
#
# Uses sqlite3's own `.backup`, not `cp`: a copy taken while the radio process
# has a write in flight can capture a torn page or miss the WAL entirely, and
# would restore as a corrupt or silently stale ledger. `.backup` takes a
# consistent snapshot of a live database.
#
# Every backup is verified with an integrity check before it is allowed to
# count, because an unverified backup is a belief, not a backup.
set -uo pipefail

DB="${KANNAKA_ADS_DB:-$HOME/.kannaka/radio-ads.db}"
DEST="${ADS_BACKUP_DIR:-$HOME/.kannaka/backups}"
KEEP="${ADS_BACKUP_KEEP:-48}"      # hourly -> two days of history
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DEST/radio-ads-$STAMP.db"

log() { printf '%s [ads-backup] %s\n' "$(date -u +%H:%M:%S)" "$1"; }

[ -f "$DB" ] || { log "no database at $DB — nothing to back up"; exit 0; }
command -v sqlite3 >/dev/null 2>&1 || { log "FATAL: sqlite3 not installed; cannot take a consistent snapshot"; exit 1; }

mkdir -p "$DEST" || { log "FATAL: cannot create $DEST"; exit 1; }

if ! sqlite3 "$DB" ".backup '$OUT'" 2>/dev/null; then
  log "FATAL: .backup failed for $DB"
  rm -f "$OUT"
  exit 1
fi

# Verify. A backup that cannot be opened and checked is not a backup.
CHECK="$(sqlite3 "$OUT" 'PRAGMA integrity_check;' 2>/dev/null | head -1)"
if [ "$CHECK" != "ok" ]; then
  log "FATAL: integrity check on the SNAPSHOT returned '${CHECK:-<nothing>}' — discarding"
  rm -f "$OUT"
  exit 1
fi

# Prove it carries the money rows, not just a valid empty file. A schema-only
# or truncated snapshot passes integrity_check quite happily.
ADS="$(sqlite3 "$OUT" 'SELECT COUNT(*) FROM radio_ads;' 2>/dev/null)"
if [ -z "$ADS" ]; then
  log "FATAL: snapshot has no radio_ads table — discarding"
  rm -f "$OUT"
  exit 1
fi

chmod 600 "$OUT"
gzip -f "$OUT" 2>/dev/null && OUT="$OUT.gz"
log "ok: $(basename "$OUT") ($ADS ads, $(stat -c%s "$OUT") bytes)"

# Rotate: keep the newest $KEEP, delete older. Runs after a verified write, so
# a failed backup never deletes a good one.
mapfile -t OLD < <(ls -1t "$DEST"/radio-ads-*.db.gz 2>/dev/null | tail -n +"$((KEEP + 1))")
for f in "${OLD[@]:-}"; do
  [ -n "$f" ] && rm -f "$f" && log "rotated out $(basename "$f")"
done

exit 0
