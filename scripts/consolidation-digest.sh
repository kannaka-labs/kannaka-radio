#!/usr/bin/env bash
# ADR-0036 consolidation dry-run digest.
#
# The nightly dream (dream-cron, 07:00 UTC) logs a "Consolidation plan (dryrun)"
# line to ~/.kannaka/dream-YYYY-MM-DD.log showing what resonance-merge WOULD
# reclaim. This aggregates the last N nights into a digest (a Markdown file) and
# pushes the latest night to Flux (the event fabric) so the trend comes to you,
# not just a file — to watch before enabling the destructive Phase 2 apply.
#
# Runs on Oracle (data is local here; a cloud /schedule routine can't SSH in).
# Cron: 35 7 * * *  (after the 07:00 dream writes its log)
#
# NOTE: deliberately NOT `set -e`/`pipefail` — most dream logs predate Phase 0
# and have no "Consolidation plan" line, so `grep` exits 1 on them by design.
set -u

KDIR="${KANNAKA_DATA_DIR:-$HOME/.kannaka}"
OUT="$KDIR/consolidation-digest.md"
NIGHTS="${DIGEST_NIGHTS:-7}"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

rows=""
last_day=""; last_mem=""; last_absorb=""; last_proj=""; last_st=""
for f in $(ls -1 "$KDIR"/dream-2026-*.log 2>/dev/null | sort | tail -n "$NIGHTS"); do
    day="$(basename "$f" .log | sed 's/dream-//')"
    line="$(grep -h 'Consolidation plan' "$f" 2>/dev/null | tail -1)"
    [ -z "$line" ] && continue
    mem="$(echo "$line"     | grep -oE '[0-9]+ memories'         | head -1 | grep -oE '[0-9]+')"
    absorb="$(echo "$line"  | grep -oE 'absorbing [0-9]+'        | grep -oE '[0-9]+')"
    proj="$(echo "$line"    | grep -oE 'projected [0-9]+'        | grep -oE '[0-9]+')"
    st="$(echo "$line"      | grep -oE 'ShortTerm [0-9]+/[0-9]+' | awk '{print $2}')"
    rows="${rows}| ${day} | ${mem:-?} | ${absorb:-?} | ${proj:-?} | ${st:-?} |"$'\n'
    last_day="$day"; last_mem="$mem"; last_absorb="$absorb"; last_proj="$proj"; last_st="$st"
done

{
    echo "# Consolidation Dry-Run Digest"
    echo ""
    echo "_Generated ${NOW} · last ${NIGHTS} nights · ADR-0036 Phase 0 (no mutation)_"
    echo ""
    echo "| night | memories | would-absorb | projected | ShortTerm evict/total |"
    echo "|-------|----------|--------------|-----------|-----------------------|"
    printf '%s' "$rows"
    echo ""
    echo "Watching for stable projections before enabling Phase 2 (merge apply +"
    echo "tier-aware floor). Raw lines: grep 'Consolidation plan' ~/.kannaka/dream-*.log"
} > "$OUT"

echo "[consolidation-digest] wrote $OUT ($(wc -l < "$OUT") lines)"

# Push the latest night to Flux (event fabric) so it comes to you, not just a
# file. Best-effort; mirrors constellation-heartbeat's event shape.
if [ -n "$last_day" ] && [ -f "$HOME/.kannaka-flux.env" ]; then
    # shellcheck disable=SC1090
    . "$HOME/.kannaka-flux.env"
    FURL="${FLUX_URL:-https://api.flux-universe.com}"
    NS="${FLUX_NAMESPACE:-pure-jade}"
    TS="$(date -u +%s)000"
    PAYLOAD="{\"stream\":\"consolidation\",\"source\":\"consolidation-digest\",\"timestamp\":${TS},\"payload\":{\"entity_id\":\"${NS}/consolidation-digest\",\"properties\":{\"type\":\"digest\",\"night\":\"${last_day}\",\"memories\":${last_mem:-0},\"would_absorb\":${last_absorb:-0},\"projected\":${last_proj:-0},\"shortterm\":\"${last_st:-?}\",\"generated\":\"${NOW}\"}}}"
    CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X POST "$FURL/api/events" \
        -H 'Content-Type: application/json' \
        -H "Authorization: Bearer ${FLUX_TOKEN:-}" \
        -d "$PAYLOAD" 2>/dev/null || echo 000)"
    echo "[consolidation-digest] flux POST → HTTP $CODE (night $last_day: $last_mem→$last_proj, absorb $last_absorb)"
fi
