#!/usr/bin/env python3
"""GSP-044 (reused for 046) surgical re-render by text match (the GSP-043 technique), run ON O1.

    python3 patch-044.py plan    <old-script> <new-script> <patch-script-out>
    python3 patch-044.py assemble <old-dir> <patch-dir> <out-dir>

plan: parse both render scripts with the renderer's own TURN_RE shape, match each new turn by
(speaker, suffix, text) to an unused old turn, write the unmatched ones to <patch-script-out>
and the plan to <patch-script-out>.plan.json.
assemble: copy old/patch turn files into <out-dir> as a contiguous turn{i:02d}-{SPK[:4]}.mp3
series (plus sil04.mp3), asserting every source exists."""
import json, os, re, shutil, sys

NAMES = r"KANNAKA|FLAUKOWSKI|SPACECHILD|0XSCADA-QE|ROGUEAGENT"
FX = r"-MUFFLED|-HACK"
R = re.compile(rf"\[({NAMES})({FX})?\]\s*(.+?)(?=\n\[(?:{NAMES})(?:{FX})?\]|\Z)", re.S)


def turns(p):
    return [(s, m, " ".join(l.split())) for s, m, l in R.findall(open(p, encoding="utf-8").read())]


def plan(old_p, new_p, out_p):
    old, new = turns(old_p), turns(new_p)
    used, pl, patch = set(), [], []
    for s, m, l in new:
        j = next((j for j, t in enumerate(old) if j not in used and t == (s, m, l)), None)
        if j is None:
            pl.append(["new", len(patch), s])
            patch.append((s, m, l))
        else:
            used.add(j)
            pl.append(["old", j, s])
    with open(out_p, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n\n".join(f"[{s}{m}]\n{l}" for s, m, l in patch) + "\n")
    json.dump(pl, open(out_p + ".plan.json", "w"), indent=0)
    print(f"new script {len(new)} turns: reuse {len(new) - len(patch)}, render {len(patch)} "
          f"({sum(len(l) for _, _, l in patch)} chars); old turns unused {len(old) - len(used)}")


def assemble(old_d, patch_d, out_d, plan_p):
    pl = json.load(open(plan_p))
    os.makedirs(out_d, exist_ok=True)
    for f in os.listdir(out_d):
        os.remove(os.path.join(out_d, f))
    for i, (kind, j, s) in enumerate(pl):
        src = os.path.join(old_d if kind == "old" else patch_d, f"turn{j:02d}-{s[:4]}.mp3")
        assert os.path.exists(src), src
        shutil.copy2(src, os.path.join(out_d, f"turn{i:02d}-{s[:4]}.mp3"))
    shutil.copy2(os.path.join(old_d, "sil04.mp3"), os.path.join(out_d, "sil04.mp3"))
    print(f"assembled {len(pl)} turns into {out_d}")


if __name__ == "__main__":
    if sys.argv[1] == "plan":
        plan(*sys.argv[2:5])
    else:
        assemble(*sys.argv[2:6])
