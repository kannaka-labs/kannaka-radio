# voice-signer — the O2 remote signer for Kannaka's Nostr voice (ADR-0043)

Kannaka's reputation-bearing Nostr key (`npub1j9t89fsgkpascqdezsrlw3p743jmkks084g6d0drzwuxaz3qaq6qx8w8dz`)
lives **only on O2** (170.9.241.14). The radio on O1 never holds it: `server/broadcasters/nostr-adapter.js`
builds the content and tags and asks this daemon, over NATS, to sign and publish.

Until 2026-09-25 this code existed only as deployed files on O2. This directory is now its source.
**The deployed copy must equal these files** (see *Drift check*).

| file | what |
|---|---|
| `voice-signer.js` | the daemon: subscribes `RADIO.voice.sign`, signs, publishes to the relays in the key file, replies `{ok, id, npub, relays}` |
| `protocol.js` | the request gate (no dependencies, tested by `test/voice-signer-protocol.test.js`) |
| `voice-nowplaying.js` | an older now-playing poster that signs locally on O2. **Not scheduled** (no cron, no unit as of 2026-09-25); kept for the record |
| `kannaka-voice-signer.service`, `nats-creds.conf.example` | the unit and its drop-in (the real drop-in holds a password and is never committed) |

## Protocol

A request is JSON on `RADIO.voice.sign`: `{content, tags?, ts, nonce, hmac, kind?}`. Only the O1 `radio`
NATS user can publish that subject, and only a holder of the shared secret can produce a valid HMAC.

- **kind 1** (default, the radio's notes): `hmac = HMAC-SHA256(secret, "<ts>:<nonce>:<sha256(content)>")`.
  Tags are not authenticated in v1, so only well-formed string arrays are kept.
- **kind 30023** (NIP-23 long-form, added 2026-09-25):
  `hmac = HMAC-SHA256(secret, "v2:<ts>:<nonce>:<kind>:<sha256(content)>:<sha256(JSON.stringify(tags))>")`.
  The kind and the exact tags are authenticated, so an article cannot be re-titled or re-addressed on the bus.
  Tags must be well formed and include `d` and `title`; the content is at most 60,000 bytes.
- Any other kind is refused. Every request must be within ±120 s, and a nonce is accepted once.

Secrets (never in this repo): `~/.kannaka-voice-nostr.json` (the key, O2 only, 0600) and
`~/.kannaka-voice-signer.secret` (the HMAC secret, on O1 and O2, 0600).

## Deploy (O2)

```bash
scp ops/voice-signer/{voice-signer.js,protocol.js,package.json,package-lock.json} opc@O2:voice-poster/
ssh opc@O2 'cd voice-poster && npm ci --omit=dev && node --check voice-signer.js \
  && sudo systemctl restart kannaka-voice-signer && sleep 3 \
  && sudo journalctl -u kannaka-voice-signer -n 3 --no-pager'   # expect "connected … subscribing RADIO.voice.sign"
```

⚠ From a Windows checkout, strip CRLF before copying (`sed 's/\r$//'`); a shebang with a CR breaks the file.

## Drift check

```bash
for f in voice-signer.js protocol.js; do
  diff <(sed 's/\r$//' ops/voice-signer/$f) <(ssh opc@O2 cat voice-poster/$f) >/dev/null && echo "$f ok" || echo "$f DRIFTED"
done
```
