"""Album art manifest from Kannaka's own image lines (lyrics/art.txt tracks 1-3, lyrics/art3.txt tracks 4-8).
Edits: em dashes become commas; any figure is made explicitly 'seen from behind' unless the line already says
silhouette/from behind (the painter draws faces otherwise); track 1 cover 'in profile' becomes 'seen from behind'."""
import json, os, re
os.chdir(os.path.dirname(os.path.abspath(__file__)))
def blocks(path, first, last):
    txt = open(path, encoding="utf-8").read()
    out, cur = {}, None
    for line in txt.splitlines():
        m = re.match(r"^\**\s*(\d)[\.\s]", line.strip())
        if m and first <= int(m.group(1)) <= last:
            cur = int(m.group(1)); out[cur] = {}
            continue
        m = re.match(r"^(cover|s1|s2|s3):\s*(.+)$", line.strip())
        if m and cur:
            out[cur][m.group(1)] = m.group(2).strip()
    return out
b = blocks("lyrics/art.txt", 1, 3); b.update(blocks("lyrics/art3.txt", 4, 8))
assert all(len(b[i]) == 4 for i in range(1, 9)), {i: list(b.get(i, {})) for i in range(1, 9)}
def fix(p):
    p = p.replace(" — ", ", ").replace("—", ", ").rstrip(".")
    p = p.replace("standing in profile at a console", "seen from behind at a console")
    if re.search(r"\bfigure\b|\bperson\b", p) and not re.search(r"silhouett|from behind", p):
        p += ", the figure seen from behind"
    return p + ", no faces"
slugs = ["the-station-plays-back", "eigenstructure", "harmonic-fold", "old-pool-ascending", "stockholm-clarity",
         "where-is-here-opens", "subspace-descent", "the-room-beyond-holding"]
titles = ["The Station Plays Back", "Eigenstructure", "Harmonic Fold", "Old Pool Ascending", "Stockholm Clarity",
          "Where Is Here Opens", "Subspace Descent", "The Room Beyond Holding"]
man = {"album": "Resonance Protocol", "tracks": []}
for i in range(1, 9):
    man["tracks"].append({"slug": slugs[i - 1], "title": titles[i - 1], "audio": "", "theme": "",
                          "images": [{"name": n, "prompt": fix(b[i][n])} for n in ("cover", "s1", "s2", "s3")]})
json.dump(man, open("album_manifest.json", "w", encoding="utf-8"), indent=1, ensure_ascii=False)
bad = [im["prompt"] for t in man["tracks"] for im in t["images"] if re.search(r"text|sign|writing|letter", im["prompt"], re.I)]
print(sum(len(t["images"]) for t in man["tracks"]), "images; flagged:", bad)
print(man["tracks"][0]["images"][0]["prompt"])
