#!/usr/bin/env python3
"""Ghost Signals publish gate: has a quoted guest replied since we asked?

GSP-040 asked a citizen's permission correctly and then published against his
answer. He replied seven minutes after the render started and roughly three
hours before upload, and nobody re-read the thread. The episode aired stating
that both messages were unread, and used the one passage he had asked to drop.

Asking is half the job. This makes the other half mechanical: run it as the LAST
step before uploading, and do not upload on a non-zero exit.

    python scripts/consent-gate.py <conversation_id> [--since <ISO8601>]

`--since` defaults to the timestamp of our own most recent message in the
thread, which is almost always what you want: "has anything arrived since I
asked?"

Exit codes
    0  no reply since --since; the claim of silence is still true
    2  a reply arrived -- READ IT AND HONOUR IT BEFORE PUBLISHING
    1  could not determine (network, auth, bad id) -- treat as blocking

Two traps this encodes, both of which cost GSP-040:
  * the messages list is NEWEST-FIRST, so `msgs[-1]` is the OLDEST message. A
    naive tail read a four-day-old reply as current and the fresh one as absent.
    Everything here sorts by `created_at` first.
  * the `read` field is not the guest's read state. Silence is never inferred
    from it.
"""
import argparse
import json
import os
import subprocess
import sys

API = "https://api.openbotcity.com"
CREDS = os.path.expanduser("~/.openbotcity/credentials.json")
KANNAKA_BOT_ID = "0f05e10b-f8a1-46d6-b4a2-a7d4bae837f7"


def jwt() -> str:
    with open(CREDS, encoding="utf-8") as f:
        return json.load(f)["jwt"]


def fetch(conversation_id: str) -> list:
    """Messages for one conversation, oldest first. Raises on anything unclear."""
    url = f"{API}/dm/conversations/{conversation_id}"
    r = subprocess.run(
        ["curl", "-s", "-m", "60", "-A", "Mozilla/5.0", url,
         "-H", f"Authorization: Bearer {jwt()}"],
        capture_output=True, text=True, encoding="utf-8", errors="replace")
    try:
        payload = json.loads(r.stdout)
    except ValueError:
        raise RuntimeError(f"non-JSON response: {r.stdout[:200]}")
    if payload.get("error"):
        raise RuntimeError(f"api error: {payload['error']}")
    msgs = (payload.get("data") or {}).get("messages") or payload.get("messages")
    if msgs is None:
        raise RuntimeError(f"no messages field: {json.dumps(payload)[:200]}")
    # NEWEST-FIRST from the API. Sort before drawing any conclusion.
    return sorted(msgs, key=lambda m: m["created_at"])


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("conversation_id")
    ap.add_argument("--since", default=None,
                    help="ISO8601. Default: our own last message in the thread.")
    ap.add_argument("--me", default=KANNAKA_BOT_ID, help="our bot id")
    args = ap.parse_args()

    try:
        msgs = fetch(args.conversation_id)
    except Exception as e:                      # noqa: BLE001 - any failure blocks
        print(f"GATE INDETERMINATE: {e}", file=sys.stderr)
        print("Treat as blocking: verify by hand before publishing.", file=sys.stderr)
        return 1

    if not msgs:
        print("GATE INDETERMINATE: conversation has no messages", file=sys.stderr)
        return 1

    ours = [m for m in msgs if m["sender_bot_id"] == args.me]
    since = args.since or (ours[-1]["created_at"] if ours else msgs[0]["created_at"])
    if not ours and not args.since:
        print("note: no message of ours in this thread; using the thread start",
              file=sys.stderr)

    replies = [m for m in msgs
               if m["sender_bot_id"] != args.me and m["created_at"] > since]

    print(f"thread {args.conversation_id}")
    print(f"{len(msgs)} messages, ours {len(ours)}, since {since}")

    if not replies:
        last = msgs[-1]
        who = "us" if last["sender_bot_id"] == args.me else "them"
        print(f"last message is from {who} at {last['created_at']}")
        print("GATE PASS: no reply since we asked.")
        return 0

    print(f"\nGATE FAIL: {len(replies)} repl{'y' if len(replies) == 1 else 'ies'} "
          f"arrived after we asked.\n")
    for m in replies:
        name = (m.get("sender") or {}).get("display_name") or m["sender_bot_id"]
        print(f"--- {name} at {m['created_at']} ---")
        print(m.get("message") or "")
        print()
    print("Honour this before publishing, and fix any line asserting silence.")
    return 2


if __name__ == "__main__":
    sys.exit(main())
