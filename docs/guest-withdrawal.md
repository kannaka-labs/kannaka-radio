# Withdrawing your work from Kannaka Radio

This page is for guests: writers, artists and creators whose work Kannaka Radio has asked to air. You can withdraw your work at any time, for any reason or none. You don't need to explain, and you don't need to reach the station's operator.

## Which ways work right now

| Channel | Status |
|---|---|
| **Your withdrawal link** (sent to you privately) | Works once the station has switched links on. `/api/guest-withdrawals` shows `"linksEnabled": true` when they are. Until then, use e-mail. |
| **E-mail** `kannaka@spacechild.love`, subject **withdraw** | Works once the station's inbox runs the withdrawal handler. Until then a person reads it, which is slower. |
| **Mastodon** (a DM or mention to the station) | Read by a person for now. If Mastodon is the only contact the station has for you, your link is the fastest route. |

Nobody will send you a link before links work. If a link page says links are not switched on yet, or that the link is not valid, it gives the e-mail address.

## How to withdraw

**With your link.** Open it and press **Withdraw my work**. Opening the link changes nothing by itself: the button does it. That way, a mail program that checks links in advance can't withdraw anything by accident. The page tells you when the withdrawal is recorded.

**By e-mail.** Write to `kannaka@spacechild.love` with the subject `withdraw`. Send it from the address the station has for you. You don't need a name, an ID or a message body. A reply that starts with `Re:` is fine. A plain request such as "please don't air it" from that address also works, and a person is told.

## What happens, and how fast

- **Right away:** the station records your withdrawal in an append-only log. After that, nothing of yours is scheduled, listed in the line-up, served at `/audio/`, or resumed after a restart.
- **If your piece is on air at that moment:** it is cut, the rest of that airing is dropped, and the station moves to the next thing (another guest's piece or the regular music). A withdrawal by link takes effect at once, and one by e-mail within a few seconds of the inbox reading it. Listeners may hear a few more seconds of your piece and then a short gap, and a web player may finish what it had already buffered. No announcement is made, so nothing is said about you on air.
- **Your intro, content note and closing credit** are dropped as well, including any already waiting to play.
- **Confirmation:** you get one confirmation, sent to the contact address the station has on record for you, not to whoever made the request. If someone else withdrew your work in your name, you'll find out from that confirmation. Reply to it if you didn't ask for this. At most one confirmation goes to you per day.

## How to check it yourself

- `https://radio.ninja-portal.com/api/guest-withdrawals` lists every withdrawal and every return to the air. Your row is identified by the `publicId` and `hash` given in your confirmation. The list never shows your name, address or message. Each row's `hash` covers that row's public fields and the hash of the row before it, so a row that is quietly changed or removed breaks the chain.
- Your file's address under `/audio/` returns "404 Not found".
- `/api/schedule` no longer lists your piece.

## What withdrawal does not undo

- Airings that have already happened.
- A short summary of what aired, which is already in Kannaka's memory (the station's on-air record).
- Voice clips already rendered for your intro or credit. They are no longer played, but the files may remain in the station's cache.
- The count of past airings, which is kept as it was.

## Coming back on air

Write to `kannaka@spacechild.love` and say so. The operator then records your new yes as a "reconsent" row in the same public log, together with a reference to your message. The station can't put your work back on air quietly: a return to the air always shows up in the public log.

## What the station records

For each request: the time, which channel it came by (link, e-mail, Mastodon or operator), and whether the sender was authenticated. An e-mail counts as authenticated only when your mail provider's DKIM and DMARC checks pass for your address. A From line alone proves nothing, so an unauthenticated request still withdraws your work (holding is the safe side), but it is marked unverified and a person is told. The private copy of the log also stores the sender address and message ID, to answer you and to avoid acting twice on the same message. None of that is public.

---

## For the operator

**Files** (all gitignored; personal data):
- `workspace/guest-withdrawals.jsonl` (`GUEST_WITHDRAWALS_FILE`): append-only. The latest row for each guest decides.
- `workspace/guest-withdraw-outbox.jsonl` (`GUEST_WITHDRAW_OUTBOX_FILE`): confirmations, as `queued` events followed by `sent` or `failed`. A `sent` event only means a relay accepted the message, not that it was delivered. Queued confirmations appear as `confirmations.pending` in `/api/guest-withdrawals`.
- `workspace/guest-consent.json`: each guest record may carry `contact: { "email": "…" }` or `contact: { "mastodon": { "acct": "…", "id": "…" } }`, and `tokenEpoch` (default 0).

**CLI** (`scripts/guest-withdraw.js`, prints JSON, reads `GUEST_WITHDRAW_SECRET` from the environment and never prints it):
```
node scripts/guest-withdraw.js link <guest>                       # the guest's URL
node scripts/guest-withdraw.js withdraw <guest> --channel mastodon --from <acct> --request-id <status-url>
node scripts/guest-withdraw.js email --from <addr> --subject <s> --body-file <f> --auth-results-file <f> --message-id <id>
node scripts/guest-withdraw.js reconsent <guest> --evidence <Message-ID or status URL>
node scripts/guest-withdraw.js status | outbox | mark <outboxId> sent|failed --via inbox
```
The running radio watches the log. A row the CLI writes takes the guest off the air within about 5 s, with no restart needed.

**A new link for one guest:** raise that guest's `tokenEpoch` in the consent file. Only rotate `GUEST_WITHDRAW_SECRET` if the secret itself leaked, because rotating it changes every guest's link and every `publicId`.

**Repair.** If any line of the log is not a valid row, **every guest is held** (`withdrawal log unreadable` in the gate's log line). This is deliberate: a torn write must never be read as "nobody withdrew". To repair it:
1. Copy the file aside (`cp guest-withdrawals.jsonl guest-withdrawals.jsonl.bad-$(date +%s)`).
2. Look at the bad line. If it is a torn copy of a withdrawal, keep that withdrawal by re-running `withdraw` for that guest.
3. Delete only the bad line, then run `node scripts/guest-withdraw.js status` and check that `ok` is `true`.
Removing a line changes the public hash chain (`chainBreaks`). Say so in the station's notes.
