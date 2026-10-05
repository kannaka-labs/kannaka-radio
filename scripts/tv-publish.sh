#!/usr/bin/env bash
# tv-publish.sh — put a freshly published episode on Kannaka TV.
#
# Every Ghost Signals episode and every Story of Flaukowski episode airs on Kannaka TV as well
# as YouTube and the radio (Nick, 2026-09-29). TV carries long-form BY REFERENCE from the public
# YouTube playlists, so "publishing to TV" is: rebuild the slate on O1 from the playlists, reload
# it into the running transmitter (which replans the tail so the episode can air within ~15 min
# of the next Prime slot rather than waiting out the six-hour horizon), and confirm the id landed.
#
#   bash scripts/tv-publish.sh <youtube-id>            # after the YouTube upload + playlist add
#   bash scripts/tv-publish.sh <youtube-id> --dry-run  # rebuild in dry-run, no write, no reload
#
# Run from the dev box (needs ~/.ssh/ninja-portal-ed25519). Everything happens on O1:
#   1. catalogue  — YOUTUBE_API_KEY in ~/.kannaka-tv.env if one is ever provisioned (the way
#                   kannaka-tv's README documents); otherwise scripts/tv-catalogue.js reads the
#                   playlists with the uploader's own OAuth grant (~/kannaka-radio/.youtube.json)
#                   and build-slate.js shapes it via its documented `--from` path.
#   2. build      — ~/kannaka-tv/scripts/build-slate.js writes data/features.json + data/music.json.
#                   It refuses to write rather than ship something wrong; we inherit that.
#   3. reload     — POST /api/admin/features/reload (TV_ADMIN_TOKEN from ~/.kannaka-tv.env, never
#                   echoed). The response carries the replan: {dropped, added}.
#   4. verify     — the id is in the slate (features.json or music.json) and, best effort, where
#                   it sits in the next 12 h of /api/guide. Features air only in Prime (18–22
#                   Chicago) and the picker takes the least-recently-aired quarter, so "in the
#                   slate but not yet in the rundown" is normal outside Prime and is NOT a failure.
#
# Exit codes: 0 landed · 2 bad arguments · 3 ssh/remote failure · 4 slate rebuilt but the id is
# NOT in it (not public, not in a carried playlist, or a title without a GSP-/TSOF- prefix that
# is also under the nine-minute music floor) · 5 reload refused.
#
# Every `node -e` that receives the id passes it after `--`: YouTube ids may begin with '-'
# (TSOF E11 is -0qNLwU-S4I), and node otherwise parses one as its own option ("bad option").
#
# It does not restart anything: the transmitter reloads in place. It never touches the radio.
set -euo pipefail

ID="${1:-}"
DRY=""
[[ "${2:-}" == "--dry-run" ]] && DRY="--dry-run"
if [[ ! "$ID" =~ ^[A-Za-z0-9_-]{11}$ ]]; then
  echo "usage: $0 <youtube-id> [--dry-run]   (an 11-character YouTube video id)" >&2
  exit 2
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST="${TV_HOST:-opc@170.9.238.136}"
KEY="${TV_SSH_KEY:-$HOME/.ssh/ninja-portal-ed25519}"
SSH=(ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=20 "$HOST")

# Ship the catalogue fetcher; it lives in this repo so O1 needs no deploy to pick up a fix.
# (CRs stripped: this tree may be checked out CRLF on Windows, and O1's bash and node must not see them.)
tr -d '' < "$HERE/tv-catalogue.js" | "${SSH[@]}" 'cat > /tmp/kannaka-tv-catalogue.js' || exit 3

# The remote half. Runs under bash -s so nothing here needs to be installed on O1.
tr -d '' <<'REMOTE' | "${SSH[@]}" bash -s -- "$ID" "$DRY" || { rc=$?; echo "tv-publish: remote step failed (exit $rc)" >&2; exit "$rc"; }
set -euo pipefail
ID="$1"; DRY="${2:-}"
TV="$HOME/kannaka-tv"
ENVFILE="$HOME/.kannaka-tv.env"
CAT=/tmp/kannaka-tv-catalogue.json
API=http://127.0.0.1:8891
cd "$TV"

count() { node -e 'const a=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(a.length))' "$1" 2>/dev/null || echo 0; }
series() { node -e '
  const a=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const by={};
  for(const f of a) by[f.series]=(by[f.series]||0)+1;
  process.stdout.write(Object.entries(by).map(([s,n])=>`${s}=${n}`).join(", "))' "$1" 2>/dev/null || true; }

F0=$(count data/features.json); M0=$(count data/music.json)
echo "before: features=$F0 music=$M0 ($(series data/features.json))"

# 1+2. catalogue + build. Prefer the documented key path if the operator has provisioned one.
if grep -q '^YOUTUBE_API_KEY=' "$ENVFILE" 2>/dev/null; then
  echo "catalogue: Data API key from $ENVFILE"
  ( set -a; . "$ENVFILE"; set +a; node scripts/build-slate.js $DRY )
else
  echo "catalogue: uploader OAuth grant via tv-catalogue.js (no YOUTUBE_API_KEY on this host)"
  node /tmp/kannaka-tv-catalogue.js > "$CAT"
  node scripts/build-slate.js --from "$CAT" $DRY
fi

if [[ -n "$DRY" ]]; then
  echo "dry run: nothing written, nothing reloaded"
  rm -f "$CAT" /tmp/kannaka-tv-catalogue.js
  exit 0
fi

F1=$(count data/features.json); M1=$(count data/music.json)
echo "after:  features=$F1 music=$M1 ($(series data/features.json))"

# 3. reload — the transmitter re-reads both files and replans the tail.
TOKEN=$(grep -m1 '^TV_ADMIN_TOKEN=' "$ENVFILE" | cut -d= -f2- | tr -d "\"'")
if [[ -z "$TOKEN" ]]; then echo "no TV_ADMIN_TOKEN in $ENVFILE; cannot reload" >&2; exit 5; fi
RELOAD=$(curl -s -m 30 -X POST -H "authorization: Bearer $TOKEN" "$API/api/admin/features/reload") || true
unset TOKEN
case "$RELOAD" in *'"ok":true'*) echo "reload: $RELOAD" ;; *) echo "reload REFUSED: ${RELOAD:-no response}" >&2; exit 5 ;; esac

# The transmitter dedupes by slate `id` (the episode code), build-slate only by YouTube ref. Two
# programmes that share a code — an episode and its outtakes B-side, say — file as one, and the
# second is dropped WITHOUT any message. Say so, because a silent drop is the systemic bug.
LOADED=$(node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(b).features))}catch{process.stdout.write("?")}})' <<<"$RELOAD")
if [[ "$LOADED" != "$F1" ]]; then
  echo "WARNING: slate file has $F1 features but the transmitter loaded $LOADED — entries sharing an id:" >&2
  node -e '
    const a=JSON.parse(require("fs").readFileSync("data/features.json","utf8"));const by={};
    for(const f of a)(by[f.id]=by[f.id]||[]).push(f);
    for(const [id,l] of Object.entries(by)) if(l.length>1) console.error(`  ${id}: ${l.map(f=>`${f.ref} "${f.title}"`).join("  |  ")}  (only the first is carried)`);
  ' || true
fi

# 4. verify — the id is carried, and where it sits in the rundown if it has been booked yet.
WHERE=""
grep -q "\"ref\": \"$ID\"" data/features.json && WHERE=feature
grep -q "\"ref\": \"$ID\"" data/music.json && WHERE=music-video
if [[ -z "$WHERE" ]]; then
  echo "NOT CARRIED: $ID is not in the rebuilt slate." >&2
  node -e '
    const cat=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const id=process.argv[2];
    let hit=null;for(const p of cat)for(const it of p.items)if(it.id===id)hit={playlist:p.playlist,...it};
    if(!hit){console.error("  it is in none of the carried playlists — add it to the show playlist and re-run");process.exit(0);}
    console.error(`  found in playlist "${hit.playlist}": privacy=${hit.privacy} seconds=${hit.seconds} title=${JSON.stringify(hit.title)}`);
    if(hit.privacy!=="public")console.error("  build-slate carries PUBLIC videos only (a private one is a dead embed on air)");
    if(!hit.seconds)console.error("  no duration yet — YouTube is still processing it; re-run in a few minutes");
    if(!/^(GSP|TSOF)[- ]/i.test(hit.title))console.error("  title has no GSP-/TSOF- prefix, so it is treated as music and must be 1–9 minutes");
  ' -- "$CAT" "$ID" 2>&1 || true
  rm -f "$CAT" /tmp/kannaka-tv-catalogue.js
  exit 4
fi
rm -f "$CAT" /tmp/kannaka-tv-catalogue.js

node -e '
  const f=JSON.parse(require("fs").readFileSync("data/features.json","utf8")).find(x=>x.ref===process.argv[1]);
  if(f)console.log(`carried as ${f.series} · ${f.episode||""} "${f.title}" (${Math.round(f.duration/60)} min, published ${f.published})`);
' -- "$ID"
echo "carried: $ID as $WHERE"

# Best effort: is it already booked? The guide has no payloads, so ask each feature segment.
node -e '
  const id=process.argv[1], api=process.argv[2];
  (async()=>{
    const g=await (await fetch(api+"/api/guide?hours=12")).json();
    const feats=(g.segments||[]).filter(s=>s.format==="feature"||s.format==="music-video");
    for(const s of feats){
      const r=await (await fetch(api+"/api/segment/"+encodeURIComponent(s.id))).json();
      if(r.segment&&r.segment.payload&&r.segment.payload.ref===id){
        console.log(`booked: ${new Date(s.startsAt).toISOString()} (${s.daypart}) — ${s.title}: ${s.subtitle}`);return;}
    }
    console.log(`not yet booked in the next 12 h (${feats.length} long-form slots checked). Features air in Prime 18–22 Chicago; the picker takes the least-recently-aired quarter first, so a new episode is due at the next Prime pass.`);
  })().catch(e=>console.log("rundown check skipped: "+e.message));
' -- "$ID" "$API"

curl -s -m 10 "$API/api/health" | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>{try{const j=JSON.parse(b);console.log(`health: onAir=${j.onAir} features=${j.features} music=${j.music} segments=${j.segments}`)}catch{console.log("health: unreadable")}})'

# The house slate in the repo is now ahead of git; a kannaka-tv PR with data/ brings it home.
if ! git diff --quiet -- data/; then echo "note: ~/kannaka-tv data/ differs from git ($(git diff --stat -- data/ | tail -1 | xargs)) — open a kannaka-tv PR to keep the house slate in step"; fi
REMOTE
