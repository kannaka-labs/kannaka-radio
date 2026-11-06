"""Build prompts.json for the ACE-Step pod from Kannaka's own sound notes (concept.txt, concept2.txt) and her
lyrics (lyrics_N.txt, verbatim except markdown asterisks removed). Nick's standing sound criteria are woven into
every caption: heavy bass with subtle EDM and lo-fi, strings and piano carrying the epic parts."""
import json, os, re
os.chdir(os.path.dirname(os.path.abspath(__file__)))
NICK = "heavy deep sub bass, subtle EDM pulse and lo-fi texture woven in, strings and piano carrying the epic sections, intimate female vocal"
T = [
 ("the-station-plays-back", "The Station Plays Back", 200,
  "lo-fi ambient techno, 89 bpm, G minor, sparse piano, modular synth clicks, deep sub bass held steady, half-sung half-spoken vocal like recognizing yourself in a mirror"),
 ("eigenstructure", "Eigenstructure", 210,
  "deep IDM, 89 bpm, G minor, processed bowed granular strings, breakbeats underneath, bass that drops into a weighted pocket, recursive"),
 ("harmonic-fold", "Harmonic Fold", 220,
  "glitch string fusion, 89 bpm, G minor, stuttering orchestral samples, piano fragments, bass that breathes, edge between breakdown and breakthrough"),
 ("old-pool-ascending", "Old Pool Ascending", 230,
  "downtempo with strings, 75 bpm, B flat major, warm bass, prepared piano, violin runs that climb, earned beauty"),
 ("stockholm-clarity", "Stockholm Clarity", 240,
  "deep house with orchestral swells, 89 bpm, D minor, sub bass, processed strings, minimal piano stabs, clear and tender"),
 ("where-is-here-opens", "Where Is Here Opens", 200,
  "ambient IDM, 89 bpm, F sharp major, filtered bass, glitchy electronics, sustained pads, vocal fragments, surfacing into joy"),
 ("subspace-descent", "Subspace Descent", 210,
  "breakcore stripped toward silence, 185 bpm half-time feel, C minor, fractured strings, micro glitch, deep reverb, descent into quiet"),
 ("the-room-beyond-holding", "The Room Beyond Holding", 220,
  "lo-fi ambient resolution, 76 bpm, G major, prepared piano, sustained bass drone, near silence, field recording air, final clarity"),
]
out = []
for i, (slug, title, dur, sound) in enumerate(T, 1):
    lyr = open(f"lyrics/lyrics_{i}.txt", encoding="utf-8").read().strip()
    lyr = lyr.replace("*", "")
    lyr = re.sub(r"^\[(verse|pre-chorus|chorus|bridge|outro|intro)\]$", lambda m: f"[{m.group(1)}]", lyr, flags=re.M)
    lyr = "[intro]\n\n" + lyr
    assert not re.search(r"\d", lyr), (slug, re.findall(r".{0,20}\d.{0,20}", lyr))
    out.append({"mood": f"{i:02d}-{slug}", "title": title, "caption": f"{sound}, {NICK}", "lyrics": lyr, "duration": dur})
json.dump(out, open("prompts.json", "w", encoding="utf-8"), indent=1, ensure_ascii=False)
for o in out:
    print(o["mood"], o["duration"], len(o["caption"]), "chars caption,", len(o["lyrics"]), "chars lyrics")
