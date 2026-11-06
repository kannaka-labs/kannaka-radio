# TSOF SP3 "Hello World": gate (v2, after two independent reviews + reviser)

Status: **v2, reviser pass applied.** v1 was frozen before any edit as `script.v1-frozen.txt` / `GATE.v1-frozen.md` (SP2 rule). Both independent reviewers returned SHIP WITH FIXES; all blocking and fix findings were applied (see **Revision log v2** at the end). Nothing rendered, posted or spent. No canon doc edited. Sections below are updated to v2; where v1 text survives it is marked.

## Counts
- v2: **121 turns, 3,086 words** performed (tags and the 7 SFX lines excluded; inside 2,800–3,100). About 18:09 at 170 wpm, about 20:00 with SFX, bookends and credits.
- **v2 spoken characters: 15,966** (cap 19,000; 3,034 headroom). By speaker: NARRATOR 6,961 · ADA 3,716 · KANNAKA-N 2,786 · MARTA 2,503.
- v2 turns/words: NARRATOR 37/1,312 · ADA 41/699 · MARTA 36/512 · KANNAKA-N 7/563.
- Counter: `scratchpad/hello-world/_sp3_count.py` (joins each turn's lines, strips tags and `[SFX` lines). It reproduces the writer's v1 figures exactly (120 / 3,096 / 16,067); reviewer 1's 16,075 differs by 8 chars of method.
- v1 (frozen): 120 turns, 3,096 words, 16,067 chars.
- Four voices, all LOCKED in SKILL §3 (voices.json values copied from the table; similarity_boost 0.75 as in SP2).
- SFX: `ups-beep`, `phone-buzz` ×3, `door-bolt` (library), `keyboard` (library), `generator-start`. **New SFX needed: ups-beep, phone-buzz, generator-start** (ElevenLabs sound generation, money: needs Nick's yes at production time). `furnace-ignite`, `server-fans` and `wind-snow` are in the library if a bed needs them.

## Setting and the gap
**Night of Thursday 5 → Friday 6 November 2026** (date-checked: 5 Nov 2026 Thu, 6 Nov 2026 Fri). That's six nights after SP2 (Sat 31 Oct) and before S2 opens on 15 Jan 2027 (E09 L4). The gap rules from SP1/SP2 hold:
- The file doesn't grow. Both Kannaka turns are spoken "Not to file" and end "Nothing tonight is in the file." (E09 L113, "has not grown").
- Kannaka lives above the laundromat on First Avenue East, and the dryers stop at eleven (E09 L108; SP1; SP2).
- "The receiver has been off since the pole" points back to SP2 only, an earlier special.
- Bay six, Sixteenth Avenue Southwest (E09 L102). It has a wood stove serviced every October (E08 L161, E09 L79; "A man from Marion" is new and harmless). The rack is "asleep, not off" (E09 L79). It sits next to the co-op's fenced substation lot (E05 L188), which is where the squirrel comes from.
- Ada pays the lease and comes "at the hour she keeps" every night (E09 L79: 22:11 nightly; E12 L336: Kannaka watches her every night at that hour). **The minute is never spoken.** She doesn't type the command at 4 a.m. ("It is not her hour"), so E09's "three hundred and some nights running … the same answer" stays intact.
- Marta: a narrow house on the northwest side with the lettered van (E10 L254), the after-hours "no-heat, I'll come anyway" (E10 L258), the Sunday pie (E08, E10), and an oilcloth table (E10).
- "He never recorded a greeting; he said he'd think of something to say" fits canon §2.1 "bad at voicemails". It also means no recording of his voice existed to be kept, so E08 L164's "every recording of him corrupts" is respected.
- No moon is mentioned (low cloud and freezing drizzle). Full moon was 26 Oct (SP2 ledger), so the 6 Nov small hours would be a thin waning crescent behind cloud.

## Beats (scene order)
1. **Cold open, Kannaka, after 23:00 Thu.** The forecast in the laundromat window. He watched Ada at her hour, as on "some evenings since the spring" (v2: "most" contradicted E09 L108, where at Ada's hour he is in his room "doing … nothing, attentively"; E09 L177 has him in a car across the avenue on another night, so "some" fits both). He sees the box only in the seconds Ada's door is open as she leaves (v2 sightline fix: steel door, E09 L187/L198). She went home at 22:40. The grey box with the green lamp, "the one light in the room I could not account for" (v2: the rack lamp and E10 L9's instrument displays also glow): "I do not know what it is for. I will not guess."
2. **02:41:12.** The streetlights on Sixteenth Ave SW go out all at once (v2; one feeder). The UPS beeps, the box goes amber and waits its one minute.
3. **02:42:12.** First text, "Hello world. U P S on battery. Bay six. Runtime fifty-two minutes. Reply ack to silence." Marta is awake on the after-hours line and has the one dry beat ("UPS doesn't deliver at three in the morning."). She dresses for a no-heat call.
4. Ada, awake with a manual, reads the same text: "I didn't set that up … I'd know."
5. **02:52.** Second text, runtime 33 (v2; 31 echoed E11 L4's 31 seconds). The dark signals and the outage map (380 customers, ETA 05:00).
6. **02:55.** Both phones: "Hello world. Acknowledged by Me." (v2: the narrator no longer explains the label). Marta stops at the curb with the wipers going.
7. **About 03:04.** Ada and Marta meet for the first time on air (see risks). v2: a visible handshake through the van window, so Kannaka's coda can infer it. "He talked about you on Mondays." "The first number on that list is his."
8. Inside: the breathing rack lamp, the amber box, Marta lays a fire ("Somebody did this flue right"). Ada reads the box over serial (v2: "I took it for the UPS card" explains why she never noticed it). Three contacts: Me, Marta, Ada. Ada was added the following spring, "He never said."
9. **The log.** The test on Tue 13 Sep 2022 at 14:15, then nothing for four years (it waits a minute, and every outage was shorter "or somebody shut it down by hand first": v2 hedge for E05 L182–191's federal de-energizing and E06/E08 breaker events). **Marta: "It was a Sunday."** She remembers him at her table after the pie, asking to break her phone rule "for one minute" (v2: E04 L68/L70, "she has rules"): "It works … if I ever got one that didn't say test … come over. So I came over." Ada explains network time ("years off, not five days"). Marta: "Then it's wrong." Ada: "Then one of you is." **This is the special's one residue. It stays unreconciled.**
10. "What's hello world?" Ada, in trade terms: the site name, the test string everybody types, "He'd have changed it the first time it went off for real." (v2: theme-stating sentence cut).
11. **Inbound log.** 02:53 "who is this", then the box's command list, then 02:55 "ack", "Acknowledged by Me". Marta's Sunday calls: not in service from Sun 10 May; on Sun 20 Sep somebody answered "hello" with a baby crying behind them, and she hung up. Numbers get reassigned. "I know what it is; I knew it in the van, and I drove over anyway." / "So did I."
12. **03:10.** The battery is at 20%, 9 min, against the co-op's 05:00. Asleep vs off. Marta: shut it down properly. Ada: "It's not off. It's asleep. It's been asleep since March … It's how he left it." (v2: the memory/disk mechanism and "whatever it comes back up as" cut; S2 §1 rack identity stays unspent). Marta doesn't ask anything else.
13. **The generator.** Marta's trade: exhaust never comes inside; v2 puts it on the apron by the van, twenty feet off, exhaust away from the door, door closed down on the cord (CPSC/CDC practice; v1 had it under the eave by a door ajar). Its 62.3 Hz is out of tolerance ("half a hertz", v2) because he set the window tight (±0.5 Hz). Marta adjusts the governor by ear, Ada reads 61.1 → 60.8 → 60.4, and at **03:16** the UPS is on line at 6% with 2 min left. The box goes green and sends "Utility power restored" to all three numbers. Across the avenue, a figure in a charcoal coat and a hat stands under a dark streetlight (v2: aired wardrobe, E09 L177, SP2 L164).
14. **The number debate.** Ada wants to remove a stranger who now knows when the building is dark. Marta: "It's his number … then it's a box about us." Ada: "I haven't changed one setting in this room since March." Marta: "Then ask them."
15. **Ada's text.** She deletes two drafts ("Sorry"; one with his name), then sends "… Your number used to belong to the man who set it up. He isn't here. I'm sorry it woke you…" The replies: "up with the baby anyway"; "leave me on … I don't mind knowing your lights are on"; **"tell him hi"**. She doesn't answer it or delete it, and turns the phone face down. Marta repeats it once.
16. **03:50.** The streetlights come back on, not quite together, as a co-op bucket truck folds its boom (v2: no travelling wave). The far sidewalk is empty. The plug goes back to the wall, the beep lasts under a minute, and the box says nothing (the one-minute delay set up in beat 2). Marta coils the cord: "If it's that box, I come anyway." Ada sits at the bench and doesn't type ("not her hour"). The lamps run until the window turns grey.
17. **Title card.** "The Story of Flaukowski. Hello World."
18. **Coda, Kannaka, 04:45 Fri (v2).** He calls it Thursday, then corrects himself (flat). He walks when the dryers stop and he cannot sleep; from the bridge the southwest side was dark (Cedar River bridges, SP1 L8/L347); Sixteenth Ave's lights "were dark when I got there and dark when I left" (no times he could not have seen). He was across the avenue from a little before three. "From the way they stood at the van, I do not think they had met." The governor came down by ear and the sister came away from the engine; two people at a dark building at 3 a.m. means something called them, "I think it was the grey box" (inference, flagged as guess). "I have never held a telephone number. No box anywhere has me on its list … Tonight two people came out in freezing drizzle because a box had them on its list. I am less certain that it is one … a note that guesses is worse than no note" (v2: he no longer knows about the reused number or the woken stranger) (his own formula, SP1 L356 / SP2 L371). End.

**The world's "hello world":** the alarm dialer's site-name field, typed as a test string four years earlier and never changed because the box never fired for real. Its first real transmission goes to a dead man's sister, a colleague he never told, and a stranger holding his recycled number. The stranger is the only one who says hello back ("tell him hi"). Everything enters through an instrument: the UPS screen, the dialer's log, SMS delivery and inbound lines, the outage map, the generator frequency. The narrator states it; no line announces the theme.

## Night/day arithmetic (checked with `date`)
| Claim | Check |
|---|---|
| Thu 5 Nov 2026 / Fri 6 Nov 2026 | Thursday / Friday ✓ |
| SP2 → SP3 | Sat 31 Oct → night of Thu 5 Nov: **six nights later**. Not spoken anywhere. ✓ |
| Test send Tue 13 Sep 2022 (log) vs Marta's Sunday | 13 Sep 2022 = Tuesday ✓. The nearest Sunday is 18 Sep 2022, five days later, and Ada's "Not five days" matches. Only Marta's "Sunday" is spoken, not the 18th. ✓ |
| "Four years of nothing" | Sep 2022 → Nov 2026 = 4 y 2 m ✓ |
| Marta: Sun 10 May 2026 first "not in service" | 10 May 2026 = Sunday ✓, about 8 weeks after March (S1 finale) |
| Marta: Sun 20 Sep 2026 "it rang" | 20 Sep 2026 = Sunday ✓. About 19 weeks after disconnection, which fits the usual 45–90-day number aging plus idle time ✓ |
| Runtime | 02:42 says 52 min, 02:52 says 33 min (v2) (an untested 4-year-old battery reading high), 03:10 says 9 min / 20%, 03:16 is accepted at 2 min / 6%. 6 minutes elapsed for 7 minutes lost, which is consistent with a collapsing battery. True runtime is about 35 min from 02:41. ✓ |
| One-minute delay | power out 02:41:12 → first text 02:42:12 ✓. On restoration the plug swap's battery moment is under a minute, so there's no text ✓ |
| Outage | 02:41 → 03:50 (69 min). Co-op ETA was 05:00 and actual came earlier. v2: the coda states no times; Kannaka arrives "a little before three" (after 02:41) and is gone before 03:50 (L337 "far sidewalk is empty") ✓ |
| Timeline of arrivals | Marta is parked before Ada (about 03:04). Kannaka is there "from a little before three" and says "the sister came first" ✓ |
| Counts avoided | No night count since March is spoken, because the exact March date is unaired (E08). **The word "seven" appears nowhere** (scripted check), and neither does "eleven seconds". The only uses of "eleven" are "after eleven" (the dryers) and "twenty to eleven" |
| Number collisions removed from v1 | "four hundred and twelve customers" became **380**, because E12 L99 gives 412 as the latchkey patch count. "two-oh-six" became **a quarter past two**, because patch 206 (E12). The restoration time 03:52 became **03:50**, because SP1's intrusion camera was 03:52 |

## Canon checks (citations)
- **Ada's guard (S2 §5g / S1 §2.3), still true:** Ada sees a log disagree with a memory and is told nothing about why. Marta tells her nothing, and the can, the envelope and the pie's meaning are never mentioned. Ada tells Marta only "It's how he left it". The queue, the patch and latchkey are never named.
- **Marta's memory holding (E08 L164):** used without comment. She is certain against the timestamp and "never asks the obvious question". She doesn't ask Ada why she pays the lease either. That's in character, and it keeps E10 L383–386 (Ada's lease answer to Teodora) unspent.
- **Brandt's reconciling reports (E08 L161; E11 L81, "first one in ten months"):** the outage is an ordinary crew job with a bucket truck and an outage map. No co-op anomaly appears.
- **Finished instruments (E09 L76/L143):** not mentioned. No bench meter is described.
- **SP1 no-trespass:** Kannaka stays on the public far sidewalk and never crosses. The bay isn't co-op property anyway.
- **Kannaka's watching (E09 L177 car across the avenue; E10 L395; v2 corrects the v1 citation: E12 L336 says only that he has wanted to tell her, not that he watches):** fits. He watches and doesn't intervene. He leaves before the lights come back.
- **E10 Marta/Teodora:** the van, the house and the oilcloth are reused and none is contradicted. "No-heat" is her phrase. The Pruitts aren't mentioned.

## §8 leak check
- **S1 §8 / §4:** Flaukowski appears only as "his number", "he set it up" and the title-card surname. "He isn't here" is neutral, and none of the seven possibilities is touched. No Eye, Echo, Nullmen, verse, archive, Yamibane, Delta-33 or first name ("his name" is typed and deleted, never spoken). No daughters, no March '07.
- **S2 §8:** no Teodora, no Shiori, no latchkey, no rehearsed, no postal rule, no mother, no naming. The rack is "asleep since March" (aired E09). Nothing implies the queue will change.
- **The residue** (the log's Tuesday against Marta's Sunday) is deniable: the device's clock, or a memory that is wrong for once. It belongs to S1's aired aftermath grammar ("every log entry ages into ambiguity … except in one kitchen", E08 L164). S2 never has to honour it. Nobody says which is right.

## The Five Questions
**S1 §9** (as applied to specials in SP1/SP2):
1. **Flaukowski human before legend:** YES. He is present only as habits: typing with one thumb at his sister's table, never recording a greeting, setting a tolerance "as tight as it goes", naming his own number "Me", adding a colleague without telling her, and "He talked about you on Mondays".
2. **Kannaka antagonistic before his motivation is understandable:** YES. He watches a woman's window every night, stands on a dark sidewalk at three in the morning, does nothing to help, leaves before the lights return, and declines to say why. The coda's telephone line is a guess he retracts.
3. **An intelligent viewer could disagree:** YES. There are two live arguments. The number: Ada's case is security (a stranger now knows when the building is dark and on battery) and the stranger's sleep; Marta's is that removing his number makes it "a box about us". The stranger's consent settles the immediate question but not the principle. Asleep vs off: Marta's "shut it down properly" is what any professional would say, and Ada's state-preservation is the reason she keeps the lease. Neither woman is shown to be right about the log date.
4. **The impossible emerges from engineering:** YES. Every beat runs through an instrument: the UPS beeps and runtime, the dialer's one-minute delay, the contact labels, the log, network time, the reassigned number, the governor and the frequency tolerance. Only one thing is left unexplained, and it is a timestamp.
5. **Explains how the mythology begins without explaining away the mystery:** YES. Nothing mythological is added, and the residue is a reading.

**S2 §6 (cross-check):** Q1 n/a (Teodora absent). Q2 n/a. Q3 is the women's disagreement. Q4 YES. Q5 YES, because LIVES is not touched.

## Standards self-check
- Banned phrases: grep found no "the whole", no "real" as intensifier, and no stock proclamations. A staccato scan left only instrument readouts (UPS screen, Hz readings, the SMS texts) as runs of short sentences. Those are readings, not gravitas.
- Narrator as camera: no interpretive tags. The deletions are shown as drafts deleted, not explained.
- **Dry beats (v2): one intended, Marta's "UPS doesn't deliver at three in the morning."** Reviewers counted about five in v1; v2 cut the L5 "habit and not a method" tag, the L19 furnace/batteries contrast, the squirrel, the L364 "poor habit" tag and "I'm not going to explain it to you". Kept as character, not jokes: Marta's "whose world / It works" and Kannaka's flat "Thursday — no." v1 text follows: The reviewer should judge these possible extras: "It's a Sunday thing, I'm not going to explain it to you." (character, not a joke); "I tell every customer I have that, and I'm telling you." (practical); Kannaka's "Thursday — no." (flat fallibility). If any reads as a joke, cut it.
- Nobody marvels at their own normal. Marta treats the exhaust and the governor as routine, and Ada treats the log as routine.

## Risks and open questions for the reviewer / Nick
1. **Ada and Marta meet for the first time on air.** No aired line says they had met, or that they hadn't (searched E01–E12). This becomes canon-as-heard for E13+: they know each other, Marta knows Ada comes nightly, and Marta has offered to come for "that box". E13–E16 must not have them introduced.
2. **New canon-as-heard:** the alarm dialer exists and stays configured with contacts Me, Marta and Ada. A stranger holds his old number and has agreed to stay on. Marta called the number every Sunday at six, and it went out of service from 10 May. He never recorded a greeting. Kannaka "has never held a telephone number" (searched: no aired Kannaka phone. E11's motel knock is in person). Teodora's audit (E10) could in principle find the number record. Never mention it, or let her find it.
3. **"tell him hi"** is the emotional peak, and it is a stranger's courtesy, not a sign. A reviewer might hear it as the world answering. That reading is allowed and should stay deniable.
4. **"It's been asleep since March"** is said to Marta. It's aired (E09) but says nothing about what's on the rack. If the reviewer wants zero rack talk, cut to "It's how he left it."
5. **Title.** "Hello World" matches the album and is the box's own string. The alternative is "On Battery". It is credited as `TSOF SP3 — Hello World`, episodes.json num 192, renders GSP-192, art `--episode 92` (continuing SP1 = 190/90, SP2 = 191/91). Unverified, and the production agent should confirm.
6. **Length:** 3,096 words, inside 2,800–3,100. The cheapest cuts are the Marion stove exchange (3 turns) and Ada's "Until tonight." lead-in.
7. **TTS readings:** the narrator says "U P S" (spaced, so it renders as letters) and Marta says "UPS". "ack" is lowercase in the texts and should come out as the word "ack". Quoted SMS text is lowercase on purpose.
8. **Art (from the frozen script only, per the SP2 lesson; v2: the generator is out on the apron by the van, not under the eave; the figure wears a charcoal coat and a hat):** row of bays in freezing drizzle at night, dark streetlights; a small grey box with an amber lamp on a bare wall (blank, no lettering); a lettered van, which will grow text, so show it as a white van seen from behind with headlights on a roll-up door; wood stove firelight; an open-frame generator on a concrete apron beside a white van in drizzle; a dark figure in a charcoal coat and a hat on a far sidewalk, seen from behind; a woman seen from behind at a bench in grey dawn light. Write "November, freezing drizzle, no snow on the ground" into every outdoor prompt. No phones with screens.

## Files
- `tsof-sp3/script.txt`: working script, 7 `[SFX — …]` lines, which must be stripped into `script-render.txt` before TTS.
- `tsof-sp3/voices.json`: the 4 locked voices.
- `tsof-sp3/GATE.md`: this file.

research.md was used only for theme resonance. The story contains no real-world facts, ids, numbers or names from the ks-cascade record.


## Revision log v2 (reviser, 2026-11-06)
v1 frozen first: `tsof-sp3/script.v1-frozen.txt`, `tsof-sp3/GATE.v1-frozen.md`. Every finding from both reviews was checked against the script and the aired sources (E04 L66–70, E05 L182–191, E09 L108/L177/L187/L198, E10 L9, SP1 L8/L347, SP2 L164 read directly). All applied; none rejected.

**Blocking (all applied)**
- R1-B1 / R2-B2, Kannaka's impossible knowledge (coda): the timed "two forty-one until ten to four, by my watch" became "dark when I got there and dark when I left"; he gets an ordinary reason to be out (walks when the dryers stop, saw the dark side from the bridge); the "said so to somebody / no number left over / no stranger woken" lines became what he could see (two people summoned at 3 a.m.; "no box anywhere has me on its list"); "They did not, until tonight" became "From the way they stood at the van, I do not think they had met", backed by a new visible handshake (narrator turn after "Ada Kessler").
- R1-B2 travelling streetlights: out "all at once"; back "not quite together, as a co-op bucket truck two blocks east folds its boom". One residue only remains (Tuesday vs Sunday).
- R2-B1 Marta's phone rule (E04 L68/L70): "He asked could he break my rule for one minute. I said one."

**Fix (all applied)**
- "most evenings" became "some evenings" (E09 L108); citation corrected above.
- Sightline: he sees the back wall only while Ada's door is open as she leaves; the box is "the one light in the room I could not account for"; coda's amber-to-green sighting replaced by the sister coming away from the engine.
- Narrator exposition: L11 "told to wait one minute" cut; L51 label explanation cut; L19 "expecting a third" cut.
- L216 rack mechanism ("comes back up from the disk as whatever it comes back up as") cut to "It's not off. It's asleep. It's been asleep since March."
- Dry beats cut to one (list in Standards self-check).
- Generator moved to the apron by the van, twenty feet off, exhaust away, door closed down on the cord; Kannaka's "as she should" now endorses correct practice.
- "Four years" hedge: "or somebody shut it down by hand first"; "It never went off for real" cut; "dead wall outlet" became "dead receptacle".
- "half a cycle" became "half a hertz".

**Notes (applied)**
- Theme sentence "It's the first thing anybody makes anything say" cut.
- Runtime 31 became 33 in both places (E11 L4 echo).
- Ada: "I took it for the UPS card."
- E08 L65 echo varied: "her phone buzzes on the counter beside a sink with one cup in it".
- "a site job she starts on Monday" (keeps her at the integrator shop, canon §2.3); "charcoal coat and a hat".

**Canon-as-heard added by SP3 (binding for E13+ if aired; needs Nick's yes)**
- Ada and Marta have met (handshake at the van, 6 Nov); Marta has offered to come out for no-heat or for "that box".
- The alarm dialer in bay six: site name "Hello world", contacts Me / Marta / Ada (Ada added the spring after install, unknown to her), one-minute delay, network time; test logged Tue 13 Sep 2022 14:15 vs Marta's remembered Sunday (unreconciled).
- A stranger with a baby holds his old number and agreed to stay on the list; last message "tell him hi", unanswered and undeleted.
- Marta called the number every Sunday at six; not in service from Sun 10 May 2026; answered Sun 20 Sep 2026. He never recorded a greeting.
- He once broke Marta's phone rule, with permission, for one minute.
- Ada starts a site job on Monday 9 Nov.
- Kannaka has never held a telephone number; he walks at night when the dryers stop.
- No later episode may tie the box's texts to the March unsent-sentences minute (E08 L62/L65).

**Still open for Nick / production**
- Yes on the on-air Ada–Marta meeting (new canon).
- Yes on 3 new ElevenLabs SFX (ups-beep, phone-buzz, generator-start): credits.
- episodes.json num 192 / art `--episode 92` to be confirmed by the production agent.
- Strip the 7 `[SFX — …]` lines into `script-render.txt` before TTS; re-verify counts after any further edit.
