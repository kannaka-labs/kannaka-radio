"""Unit tests for the pure parts of kannaka_art.py (no torch, no diffusers, no network).

Run: python -m unittest discover -s scripts/kannaka-art/tests -v
CI runs them through test/kannaka-art.test.js.
"""
import io
import json
import os
import random
import struct
import sys
import tempfile
import unittest
import zlib
from contextlib import redirect_stdout, redirect_stderr

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import kannaka_art as ka  # noqa: E402


def write_png(path, w, h, noise):
    """A real PNG via Pillow when present, else a stdlib encoder. Noise is incompressible
    (big file); flat colour compresses to almost nothing (a thumbnail-sized file)."""
    rng = random.Random(f"{w}x{h}:{noise}")
    try:
        from PIL import Image
        if noise:
            img = Image.frombytes("RGB", (w, h), rng.randbytes(w * h * 3))
        else:
            img = Image.new("RGB", (w, h), (20, 30, 90))
        img.save(path, "PNG")
        return
    except ImportError:
        pass
    row = (lambda: rng.randbytes(w * 3)) if noise else (lambda: bytes((20, 30, 90)) * w)
    raw = b"".join(b"\x00" + row() for _ in range(h))

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    with open(path, "wb") as f:
        f.write(ka.PNG_SIG + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def rb(path):
    with open(path, "rb") as f:
        return f.read()


def wjson(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f)


def quiet(fn, *a, **k):
    with redirect_stdout(io.StringIO()) as out, redirect_stderr(io.StringIO()) as err:
        rc = fn(*a, **k)
    return rc, out.getvalue(), err.getvalue()


SUBJECTS = [
    {"slug": "tower", "subject": "a lattice radio tower on a prairie ridge at dusk"},
    {"slug": "substrate", "subject": "concentric interference rings of light across a dark field"},
    {"slug": "radio-at-night", "subject": "a vintage radio glowing on a windowsill, a faceless silhouette"},
]


class TmpCase(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.tmp = self._td.name

    def tearDown(self):
        self._td.cleanup()

    def p(self, *parts):
        return os.path.join(self.tmp, *parts)


class TestImport(unittest.TestCase):
    def test_import_does_not_pull_in_torch_or_diffusers(self):
        self.assertNotIn("torch", sys.modules)
        self.assertNotIn("diffusers", sys.modules)


class TestSeedAndNaming(unittest.TestCase):
    def test_seed_is_deterministic_and_32_bit(self):
        s = ka.derive_seed("gsp", 43, "tower")
        self.assertEqual(s, ka.derive_seed("gsp", 43, "tower"))
        self.assertTrue(0 <= s < 2 ** 32)

    def test_seed_is_pinned_to_sha256_of_show_episode_slug(self):
        import hashlib
        want = int.from_bytes(hashlib.sha256(b"gsp:43:tower").digest()[:4], "big")
        self.assertEqual(ka.derive_seed("gsp", 43, "tower"), want)

    def test_seed_changes_with_each_input(self):
        base = ka.derive_seed("gsp", 43, "tower")
        self.assertNotEqual(base, ka.derive_seed("tsof", 43, "tower"))
        self.assertNotEqual(base, ka.derive_seed("gsp", 44, "tower"))
        self.assertNotEqual(base, ka.derive_seed("gsp", 43, "towers"))

    def test_image_name(self):
        self.assertEqual(ka.image_name("gsp", 9, "tower", 123), "gsp-e009-tower-s123.png")
        self.assertEqual(ka.image_name("tsof", 12, "a-b", 7, "base"), "tsof-e012-a-b-s7-base.png")

    def test_parse_round_trips_hyphenated_slugs(self):
        for mode in ka.MODES:
            n = ka.image_name("tsof", 9, "wet-mill-s-floor", 42, mode)
            p = ka.parse_image_name(n)
            self.assertEqual((p["show"], p["episode"], p["slug"], p["seed"], p["mode"]),
                             ("tsof", 9, "wet-mill-s-floor", 42, mode))
        self.assertIsNone(ka.parse_image_name("cover.png"))


class TestForbiddenSubjects(unittest.TestCase):
    def test_each_forbidden_word_is_rejected_and_named(self):
        for word in ka.FORBIDDEN_SUBJECT_WORDS:
            with self.assertRaises(ka.ArtError) as cm:
                ka.build_plan("gsp", 1, [{"slug": "x", "subject": f"a wall with {word} on it"}])
            self.assertIn(word, str(cm.exception))
            self.assertIn("x:", str(cm.exception))

    def test_case_and_plural_are_caught(self):
        self.assertEqual(ka.forbidden_words("A neon SIGN and two Logos"), ["logos", "sign"])

    def test_whole_words_only(self):
        self.assertEqual(ka.forbidden_words("Ghost Signals tower, a design of swords, textured snow"), [])

    def test_cli_plan_exits_non_zero_naming_the_word(self):
        d = tempfile.mkdtemp()
        subj = os.path.join(d, "s.json")
        wjson(subj, [{"slug": "bad", "subject": "a shop sign in the rain"}])
        rc, _, err = quiet(ka.main, ["plan", "--show", "tsof", "--episode", "9", "--subjects", subj, "--out", d])
        self.assertEqual(rc, 1)
        self.assertIn("sign", err)
        self.assertFalse(os.path.exists(os.path.join(d, "jobs.json")))


class TestPlan(TmpCase):
    def plan_cli(self, out, show="gsp", ep=43):
        subj = self.p("subjects.json")
        wjson(subj, SUBJECTS)
        rc, _, err = quiet(ka.main, ["plan", "--show", show, "--episode", str(ep), "--subjects", subj, "--out", out])
        self.assertEqual(rc, 0, err)
        return os.path.join(out, "jobs.json")

    def test_replan_is_byte_identical(self):
        a = rb(self.plan_cli(self.p("a")))
        b = rb(self.plan_cli(self.p("b")))
        self.assertEqual(a, b)
        self.assertNotIn(b"\r\n", a)

    def test_prompt_is_subject_plus_show_tail(self):
        plan = ka.load_jobs(self.plan_cli(self.p("a"), show="tsof", ep=9))
        tail = ka.load_template("tsof")["tail"]
        for j, s in zip(plan["jobs"], SUBJECTS):
            self.assertEqual(j["prompt"], f"{s['subject']}, {tail}")
            self.assertEqual(j["seed"], ka.derive_seed("tsof", 9, s["slug"]))
            self.assertEqual(j["file"], ka.image_name("tsof", 9, s["slug"], j["seed"]))
            self.assertEqual(j["prompt_sha256"], ka.sha256_text(j["prompt"]))
        self.assertEqual([j["slug"] for j in plan["jobs"]], [s["slug"] for s in SUBJECTS])

    def test_templates_carry_rules(self):
        self.assertTrue(any("face canon" in r for r in ka.load_template("gsp")["rules"]))
        self.assertTrue(any("No faces" in r for r in ka.load_template("tsof")["rules"]))

    def test_bad_inputs_refused(self):
        for subjects in ([], [{"slug": "Bad Slug", "subject": "x"}],
                         [{"slug": "a", "subject": "x"}, {"slug": "a", "subject": "y"}],
                         [{"slug": "a", "subject": "  "}]):
            with self.assertRaises(ka.ArtError):
                ka.build_plan("gsp", 1, subjects)
        with self.assertRaises(ka.ArtError):
            ka.build_plan("gsp", 0, SUBJECTS)


class TestGate(TmpCase):
    def test_small_fails_large_passes(self):
        write_png(self.p("small.png"), 256, 256, noise=True)
        write_png(self.p("large.png"), 1024, 1024, noise=True)
        self.assertFalse(ka.gate_file(self.p("small.png"))[0])
        self.assertTrue(ka.gate_file(self.p("large.png"))[0])
        rc, out, _ = quiet(ka.main, ["gate", self.tmp])
        self.assertEqual(rc, 1)
        self.assertIn("FAIL small.png", out)
        self.assertIn("PASS large.png", out)

    def test_full_size_but_tiny_file_fails(self):
        write_png(self.p("flat.png"), 1024, 1024, noise=False)
        self.assertLess(os.path.getsize(self.p("flat.png")), ka.GATE_MIN_BYTES)
        self.assertFalse(ka.gate_file(self.p("flat.png"))[0])

    def test_short_side_counts(self):
        write_png(self.p("wide.png"), 1600, 900, noise=True)
        self.assertGreater(os.path.getsize(self.p("wide.png")), ka.GATE_MIN_BYTES)
        self.assertFalse(ka.gate_file(self.p("wide.png"))[0])

    def test_all_passing_dir_exits_zero(self):
        write_png(self.p("large.png"), 1024, 1024, noise=True)
        self.assertEqual(quiet(ka.main, ["gate", self.tmp])[0], 0)

    def test_empty_dir_and_non_png_fail(self):
        self.assertEqual(quiet(ka.main, ["gate", self.tmp])[0], 1)
        with open(self.p("fake.png"), "wb") as f:
            f.write(os.urandom(200_000))
        self.assertEqual(ka.gate_file(self.p("fake.png")), (False, "not a PNG"))


def fake_gen(d, plan, backend="cpu-skywave", dtype="fp32", big=True, mode="lightning"):
    """What `gen` leaves behind (PNGs + manifest.json), without a model."""
    os.makedirs(d, exist_ok=True)
    recs = []
    for j in plan["jobs"]:
        name = ka.image_name(j["show"], j["episode"], j["slug"], j["seed"], mode)
        write_png(os.path.join(d, name), 1024 if big else 256, 1024 if big else 256, noise=True)
        recs.append({"file": name, "show": j["show"], "episode": j["episode"], "slug": j["slug"],
                     "prompt": j["prompt"], "prompt_sha256": j["prompt_sha256"], "seed": j["seed"],
                     "mode": mode, "backend": backend, "dtype": dtype})
    ka.dump_json(os.path.join(d, "manifest.json"), recs)
    ka.dump_json(os.path.join(d, "jobs.json"), plan)


class TestLedger(TmpCase):
    def setUp(self):
        super().setUp()
        self.ledger = self.p("art", "ledger.jsonl")

    def test_add_records_fields_and_is_idempotent(self):
        plan = ka.build_plan("gsp", 9, SUBJECTS)
        fake_gen(self.p("e9"), plan)
        new, dup, skipped = ka.ledger_add(self.p("e9"), self.ledger, now="2026-09-30T00:00:00Z")
        self.assertEqual((len(new), dup, skipped), (3, 0, []))
        rows = ka.read_ledger(self.ledger)
        self.assertEqual(set(rows[0]), {"show", "episode", "slug", "prompt_sha256", "seed", "backend",
                                        "dtype", "mode", "file_sha256", "ts"})
        self.assertEqual(rows[0]["dtype"], "fp32")
        new, dup, _ = ka.ledger_add(self.p("e9"), self.ledger)
        self.assertEqual((len(new), dup), (0, 3))
        self.assertEqual(len(ka.read_ledger(self.ledger)), 3)

    def test_gate_failures_are_not_recorded(self):
        fake_gen(self.p("e9"), ka.build_plan("gsp", 9, SUBJECTS), big=False)
        new, _, skipped = ka.ledger_add(self.p("e9"), self.ledger)
        self.assertEqual((len(new), len(skipped)), (0, 3))
        self.assertFalse(os.path.exists(self.ledger))

    def test_check_refuses_reuse_by_a_different_episode(self):
        e9 = ka.build_plan("gsp", 9, SUBJECTS)
        fake_gen(self.p("e9"), e9)
        ka.ledger_add(self.p("e9"), self.ledger)
        # A plan for episode 10 that copied episode 9's tower job verbatim (same prompt AND seed).
        e10 = ka.build_plan("gsp", 10, SUBJECTS)
        e10["jobs"][0] = dict(e9["jobs"][0], episode=10)
        ka.dump_json(self.p("e10.json"), e10)
        rc, out, _ = quiet(ka.main, ["ledger", "--ledger", self.ledger, "check", "--jobs", self.p("e10.json")])
        self.assertEqual(rc, 1)
        self.assertIn("REPEAT tower", out)
        self.assertIn("gsp-e009", out)
        self.assertEqual(out.count("REPEAT"), 1)

    def test_check_passes_same_episode_and_fresh_plan(self):
        e9 = ka.build_plan("gsp", 9, SUBJECTS)
        fake_gen(self.p("e9"), e9)
        ka.ledger_add(self.p("e9"), self.ledger)
        ka.dump_json(self.p("e9.json"), e9)
        ka.dump_json(self.p("e10.json"), ka.build_plan("gsp", 10, SUBJECTS))
        for jobs in ("e9.json", "e10.json"):
            rc, out, _ = quiet(ka.main, ["ledger", "--ledger", self.ledger, "check", "--jobs", self.p(jobs)])
            self.assertEqual(rc, 0, out)

    def test_same_prompt_and_seed_on_another_show_episode_counts_as_different(self):
        rows = [{"show": "gsp", "episode": 9, "prompt_sha256": "p", "seed": 1}]
        self.assertEqual(len(ka.repeat_conflicts(rows, [{"show": "tsof", "episode": 9, "prompt_sha256": "p", "seed": 1}])), 1)
        self.assertEqual(ka.repeat_conflicts(rows, [{"show": "gsp", "episode": 10, "prompt_sha256": "p", "seed": 2}]), [])
        self.assertEqual(ka.repeat_conflicts(rows, [{"show": "gsp", "episode": 10, "prompt_sha256": "q", "seed": 1}]), [])

    def test_add_refuses_a_repeat_and_writes_nothing(self):
        e9 = ka.build_plan("gsp", 9, SUBJECTS)
        fake_gen(self.p("e9"), e9)
        ka.ledger_add(self.p("e9"), self.ledger)
        before = rb(self.ledger)
        e10 = ka.build_plan("gsp", 10, SUBJECTS)
        e10["jobs"][1] = dict(e9["jobs"][1], episode=10)
        fake_gen(self.p("e10"), e10, backend="qbraid-gpu-rtx-4090", dtype="fp16")
        with self.assertRaises(ka.ArtError) as cm:
            ka.ledger_add(self.p("e10"), self.ledger)
        self.assertIn("substrate", str(cm.exception))
        self.assertEqual(rb(self.ledger), before)


class TestImagesFrom(TmpCase):
    def test_cover_first_then_job_order_gate_passing_only(self):
        plan = ka.build_plan("tsof", 9, SUBJECTS)
        d = self.p("e9")
        fake_gen(d, plan)
        fake_gen(d, plan, mode="base")
        os.remove(os.path.join(d, plan["jobs"][2]["file"]))  # radio-at-night lightning: gone
        write_png(os.path.join(d, plan["jobs"][2]["file"]), 300, 300, noise=True)  # ...replaced by a thumbnail
        out = self.p("list.txt")
        rc, _, err = quiet(ka.main, ["images-from", d, "--cover", "substrate", "--out", out])
        self.assertEqual(rc, 0, err)
        lines = rb(out).decode("utf-8").splitlines()
        names = [os.path.basename(x) for x in lines]
        j = {x["slug"]: x for x in plan["jobs"]}
        self.assertEqual(names, [
            j["substrate"]["file"], ka.image_name("tsof", 9, "substrate", j["substrate"]["seed"], "base"),
            j["tower"]["file"], ka.image_name("tsof", 9, "tower", j["tower"]["seed"], "base"),
            ka.image_name("tsof", 9, "radio-at-night", j["radio-at-night"]["seed"], "base"),
        ])
        self.assertTrue(all(os.path.isabs(x) for x in lines))
        again = self.p("list2.txt")
        quiet(ka.main, ["images-from", d, "--cover", "substrate", "--out", again])
        self.assertEqual(rb(out), rb(again))

    def test_missing_cover_refused(self):
        plan = ka.build_plan("gsp", 9, SUBJECTS)
        fake_gen(self.p("e9"), plan)
        rc, _, err = quiet(ka.main, ["images-from", self.p("e9"), "--cover", "nope", "--out", self.p("l.txt")])
        self.assertEqual(rc, 1)
        self.assertIn("nope", err)

    def test_cover_that_failed_the_gate_is_refused(self):
        plan = ka.build_plan("gsp", 9, SUBJECTS)
        fake_gen(self.p("e9"), plan, big=False)
        rc, _, _ = quiet(ka.main, ["images-from", self.p("e9"), "--cover", "tower", "--out", self.p("l.txt")])
        self.assertEqual(rc, 1)


ALBUM = {"album": "T", "tracks": [
    {"slug": "01_first", "title": "First", "images": [
        {"name": "cover", "prompt": "a lantern on a pier at night, oil painting"},
        {"name": "s1", "prompt": "a rowing boat in fog, watercolour"}]},
    {"slug": "02_second", "title": "Second", "images": [
        {"name": "cover", "prompt": "a radio tower over snow, linocut"}]},
]}


class TestAlbum(TmpCase):
    def plan(self):
        m = self.p("manifest.json")
        wjson(m, ALBUM)
        rc, out, err = quiet(ka.main, ["album-plan", "--manifest", m, "--episode", "1", "--out", self.p("art")])
        self.assertEqual(rc, 0, err)
        return ka.load_jobs(self.p("art", "jobs.json"))

    def test_album_is_a_template_register(self):
        self.assertIn("album", ka.SHOWS)
        self.assertIn("signature", ka.load_template("album")["negative"])

    def test_plan_maps_each_image_to_the_videos_js_name(self):
        plan = self.plan()
        self.assertEqual([j["slug"] for j in plan["jobs"]], ["01-first-cover", "01-first-s1", "02-second-cover"])
        self.assertTrue(all(j["show"] == "album" and j["prompt"].startswith(j["subject"]) for j in plan["jobs"]))
        with open(self.p("art", "album-map.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f), {"01-first-cover": "01_first_cover", "01-first-s1": "01_first_s1",
                                            "02-second-cover": "02_second_cover"})

    def test_duplicate_or_bad_image_names_refused(self):
        dup = json.loads(json.dumps(ALBUM))
        dup["tracks"][0]["images"][1]["name"] = "cover"
        with self.assertRaises(ka.ArtError):
            ka.album_subjects(dup)
        bad = json.loads(json.dumps(ALBUM))
        bad["tracks"][0]["images"][1]["name"] = "support"
        with self.assertRaises(ka.ArtError):
            ka.album_subjects(bad)
        nocover = json.loads(json.dumps(ALBUM))
        nocover["tracks"][1]["images"][0]["name"] = "s1"
        with self.assertRaises(ka.ArtError):
            ka.album_subjects(nocover)

    def test_export_copies_base_or_lightning_to_track_names(self):
        plan = self.plan()
        fake_gen(self.p("art"), plan, mode="base")
        rc, _, err = quiet(ka.main, ["album-export", self.p("art"), "--dest", self.p("ws")])
        self.assertEqual(rc, 0, err)
        self.assertEqual(sorted(os.listdir(self.p("ws"))), ["01_first_cover.png", "01_first_s1.png", "02_second_cover.png"])
        j = plan["jobs"][1]
        src = ka.image_name("album", 1, j["slug"], j["seed"], "base")
        self.assertEqual(rb(self.p("ws", "01_first_s1.png")), rb(self.p("art", src)))

    def test_export_is_all_or_nothing_when_an_image_was_rejected(self):
        plan = self.plan()
        fake_gen(self.p("art"), plan)
        os.remove(self.p("art", plan["jobs"][1]["file"]))  # deleted at visual review
        rc, _, err = quiet(ka.main, ["album-export", self.p("art"), "--dest", self.p("ws")])
        self.assertEqual(rc, 1)
        self.assertIn("01-first-s1", err)
        self.assertFalse(os.path.exists(self.p("ws")))

    def test_export_refuses_to_overwrite_a_different_image(self):
        plan = self.plan()
        fake_gen(self.p("art"), plan)
        os.makedirs(self.p("ws"))
        write_png(self.p("ws", "02_second_cover.png"), 1024, 1024, noise=False)
        rc, _, err = quiet(ka.main, ["album-export", self.p("art"), "--dest", self.p("ws")])
        self.assertEqual(rc, 1)
        self.assertIn("02_second_cover.png", err)
        rc, _, err = quiet(ka.main, ["album-export", self.p("art"), "--dest", self.p("ws"), "--force"])
        self.assertEqual(rc, 0, err)


class TestStandalone(TmpCase):
    def test_runs_without_templates_beside_it(self):
        """qbraid_run.sh copies kannaka_art.py alone to the pod. Importing it there must not need templates/."""
        import shutil, subprocess
        shutil.copy(ka.__file__, self.p("kannaka_art.py"))
        os.makedirs(self.p("out"))
        write_png(self.p("out", "x.png"), 1024, 1024, noise=True)
        r = subprocess.run([sys.executable, self.p("kannaka_art.py"), "gate", self.p("out")],
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("1 passed", r.stdout)


class TestQbraid(TmpCase):
    def test_prints_the_wrapper_command_and_runs_nothing(self):
        jobs = self.p("jobs.json")
        ka.dump_json(jobs, ka.build_plan("gsp", 43, SUBJECTS))
        rc, out, _ = quiet(ka.main, ["qbraid", "--jobs", jobs, "--out", self.p("out")])
        self.assertEqual(rc, 0)
        self.assertIn("qbraid_run.sh ~/kannaka-art/gsp-e043/jobs.json ~/kannaka-art/gsp-e043/out", out)
        self.assertIn("ssh debain2", out)
        self.assertFalse(os.path.exists(self.p("out")))
        self.assertNotRegex(out, r"(?m)^(scp|mkdir)[^\n]*\b[A-Za-z]:[\\/]")

    def test_drive_paths_become_git_bash_paths(self):
        self.assertEqual(ka.local_shell_path("C:\\Users\\n\\x.json"), "/c/Users/n/x.json")
        self.assertEqual(ka.local_shell_path("D:/art/out"), "/d/art/out")
        if os.name != "nt":
            self.assertEqual(ka.local_shell_path("/srv/art"), "/srv/art")


if __name__ == "__main__":
    unittest.main()
