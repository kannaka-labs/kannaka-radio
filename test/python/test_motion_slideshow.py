"""Unit tests for scripts/motion-slideshow.py (run by test/motion-slideshow.test.js).

Only pure functions are tested, plus one tiny 3-second synthetic render that
runs only when ffmpeg and ffprobe are on PATH (skipped cleanly otherwise)."""
import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
spec = importlib.util.spec_from_file_location(
    "motion_slideshow", os.path.join(ROOT, "scripts", "motion-slideshow.py"))
ms = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ms)


def good_probe(frames, fps=24):
    return {"nb_frames": str(frames), "duration": f"{frames / fps:.6f}", "width": 1920,
            "height": 1080, "pix_fmt": "yuv420p", "color_range": "tv"}


class FrameArithmetic(unittest.TestCase):
    def test_sum_equals_body_plus_crossfades(self):
        for total in (1440, 28797, 28798, 28799, 4321):
            n_art = ms.slide_count(total)
            plan = ms.plan_frames(total, n_art)
            self.assertEqual(sum(plan), total + (len(plan) - 1) * 24, (total, plan))

    def test_chain_is_exactly_the_audio_frame_count(self):
        for total in (1440, 28797, 28798, 28799, 4321, 1441):
            plan = ms.plan_frames(total, ms.slide_count(total))
            self.assertEqual(ms.chain_frames(plan), total)

    def test_gsp044_numbers(self):
        # 1199.86 s of audio -> 28797 frames; 27 art slides after a 144-frame cover
        total = round(1199.86 * 24)
        n_art = ms.slide_count(total)
        self.assertEqual(n_art, 27)
        plan = ms.plan_frames(total, n_art)
        self.assertEqual(plan[0], 144)
        self.assertEqual(set(plan[1:]), {1085, 1086})      # 29301 = 27 x 1085 + 6
        self.assertEqual(sum(plan), 28797 + 27 * 24)

    def test_art_frames_differ_by_at_most_one(self):
        plan = ms.plan_frames(1441, 3)
        self.assertLessEqual(max(plan[1:]) - min(plan[1:]), 1)

    def test_offsets_are_integer_frames(self):
        plan = [144, 456, 456, 456]
        self.assertEqual(ms.xfade_offsets(plan), [120, 552, 984])
        self.assertEqual(ms.chain_frames(plan), 984 + 456)

    def test_offset_seconds_floor_to_the_microsecond(self):
        self.assertEqual(ms.frames_to_seconds(24), "1.000000")
        self.assertEqual(ms.frames_to_seconds(1061), "44.208333")   # 44.2083333.. floored
        self.assertEqual(ms.frames_to_seconds(1), "0.041666")       # not rounded up to ...667

    def test_too_short_segment_is_refused(self):
        with self.assertRaises(ValueError):
            ms.plan_frames(150, 3)


class Seeds(unittest.TestCase):
    def test_same_episode_same_seeds(self):
        self.assertEqual(ms.derive_seeds(44), ms.derive_seeds(44))

    def test_different_episodes_differ(self):
        seeds = {ms.derive_seeds(n)["noise"] for n in range(1, 60)}
        self.assertEqual(len(seeds), 59)
        self.assertNotEqual(ms.derive_seeds(44)["pan"], ms.derive_seeds(45)["pan"])

    def test_noise_seed_fits_ffmpeg_int_range(self):
        for n in range(1, 200):
            self.assertTrue(0 <= ms.derive_seeds(n)["noise"] <= 2**31 - 1)

    def test_motion_plan_is_reproducible_and_seed_dependent(self):
        a = ms.motion_plan(ms.derive_seeds(44)["pan"], 27)
        self.assertEqual(a, ms.motion_plan(ms.derive_seeds(44)["pan"], 27))
        self.assertNotEqual(a, ms.motion_plan(ms.derive_seeds(45)["pan"], 27))
        self.assertEqual([p["zoom_in"] for p in a[:4]], [True, False, True, False])

    def test_noise_seed_reaches_the_graph(self):
        g = ms.assemble_graph([144, 456, 456], 3, 4, 0.12, 4, ms.derive_seeds(44)["noise"])
        self.assertIn(f"all_seed={ms.derive_seeds(44)['noise']}", g)


class SegmentAcceptance(unittest.TestCase):
    def test_exact_segment_is_accepted(self):
        self.assertTrue(ms.segment_acceptable(good_probe(1086), 1086))

    def test_missing_or_unreadable_is_rejected(self):
        self.assertFalse(ms.segment_acceptable(None, 1086))
        self.assertFalse(ms.segment_acceptable({}, 1086))
        self.assertFalse(ms.segment_acceptable({"nb_frames": "N/A", "duration": "N/A"}, 1086))

    def test_truncated_segment_is_rejected_whatever_its_size(self):
        p = good_probe(700)          # a big file that stopped early
        self.assertFalse(ms.segment_acceptable(p, 1086))

    def test_one_frame_off_is_rejected(self):
        self.assertFalse(ms.segment_acceptable(good_probe(1085), 1086))
        self.assertFalse(ms.segment_acceptable(good_probe(1087), 1086))

    def test_duration_disagreeing_with_frame_count_is_rejected(self):
        p = good_probe(1086)
        p["duration"] = "40.000000"
        self.assertFalse(ms.segment_acceptable(p, 1086))

    def test_full_range_or_wrong_format_is_rejected(self):
        for k, v in (("color_range", "pc"), ("pix_fmt", "yuvj420p"), ("width", 1080)):
            p = good_probe(1086)
            p[k] = v
            self.assertFalse(ms.segment_acceptable(p, 1086), k)

    def test_segment_name_changes_with_the_graph(self):
        g1 = ms.motion_segment_graph(456, ms.motion_plan(1, 1)[0])
        g2 = ms.motion_segment_graph(457, ms.motion_plan(1, 1)[0])
        self.assertNotEqual(ms.segment_name(1, "/a.png", g1), ms.segment_name(1, "/a.png", g2))
        self.assertNotEqual(ms.segment_name(1, "/a.png", g1), ms.segment_name(1, "/b.png", g1))
        self.assertEqual(ms.segment_name(1, "/a.png", g1), ms.segment_name(1, "/a.png", g1))


class Filtergraphs(unittest.TestCase):
    def test_every_stage_forces_tv_range(self):
        seg = ms.motion_segment_graph(456, ms.motion_plan(7, 1)[0])
        cover = ms.cover_segment_graph()
        asm = ms.assemble_graph([144, 456, 456], 3, 4, 0.12, 4, 1)
        for g in (seg, cover, asm):
            self.assertIn("out_color_matrix=bt709:out_range=tv", g)
            self.assertTrue(g.endswith("format=yuv420p[v]") or "format=yuv420p,trim" in g, g[-80:])
        # the RGB detour for the waveform band converts back to tv range too
        self.assertIn("all_opacity=0.12:shortest=1,scale=out_color_matrix=bt709:out_range=tv", asm)

    def test_waveform_is_a_faint_line_in_the_bottom_margins(self):
        asm = ms.assemble_graph([144, 456, 456], 3, 4, 0.12, 4, 1)
        self.assertIn("mode=line", asm)
        self.assertNotIn("cline", asm)
        self.assertIn("crop=1920:140:0:940", asm)
        self.assertIn("drawbox=x=420:y=0:w=1080:h=140:color=black:t=fill", asm)

    def test_zero_opacity_drops_the_waveform(self):
        asm = ms.assemble_graph([144, 456, 456], 3, 4, 0.0, 4, 1)
        self.assertNotIn("showwaves", asm)

    def test_xfade_offsets_in_the_graph(self):
        asm = ms.assemble_graph([144, 456, 456], 3, 4, 0.12, 4, 1)
        self.assertIn("offset=5.000000", asm)          # 120 frames
        self.assertIn("offset=23.000000", asm)         # 552 frames
        self.assertIn("trim=end_frame=1008", asm)      # 552 + 456

    def test_cli_defaults_and_limits(self):
        a = ms.parse_args(["44"])
        self.assertEqual((a.crf, a.grain, a.workers, a.wave_opacity), (22, "light", 2, 0.12))
        with self.assertRaises(SystemExit):
            ms.parse_args(["44", "--workers", "5"])
        with self.assertRaises(SystemExit):
            ms.parse_args(["44", "--grain", "heavy"])


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "ffmpeg/ffprobe not on PATH")
class SyntheticRender(unittest.TestCase):
    def test_three_second_render_is_frame_exact_and_tv_range(self):
        def ff(*a):
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *a], check=True)
        with tempfile.TemporaryDirectory() as d:
            imgs = []
            for i, c in enumerate(("0x553366", "0x335577")):
                p = os.path.join(d, f"art{i}.png")
                ff("-f", "lavfi", "-i", f"color=c={c}:s=96x96", "-frames:v", "1", p)
                imgs.append(p)
            cover = os.path.join(d, "cover.png")
            ff("-f", "lavfi", "-i", "color=c=0x222244:s=1920x1080", "-frames:v", "1", cover)
            audio = os.path.join(d, "a.m4a")
            ff("-f", "lavfi", "-i", "sine=f=220:d=3", "-c:a", "aac", audio)
            out = os.path.join(d, "out.mp4")
            rep = ms.render_motion(imgs, cover, audio, out, episode=1, workers=2, cover_frames=30,
                                   xfade=12, n_art=2, log=lambda s: None)
            self.assertTrue(os.path.exists(out))
            self.assertFalse(os.path.exists(out[:-4] + ".part.mp4"))
            self.assertEqual(rep["color_range"], "tv")
            self.assertEqual(int(rep["frames_out"]), rep["frames_planned"])
            self.assertLessEqual(abs(rep["delta_s"]), 0.1)
            # a re-run reuses every segment, after ffprobe confirms each one
            os.remove(out)
            rep2 = ms.render_motion(imgs, cover, audio, out, episode=1, workers=2, cover_frames=30,
                                    xfade=12, n_art=2, log=lambda s: None)
            self.assertEqual(rep2["segments"], ["reused"] * 3)
            # a truncated segment is deleted and re-rendered, not trusted
            work = out[:-4] + "-work"
            seg = sorted(f for f in os.listdir(work) if f.startswith("seg-001-"))[0]
            path = os.path.join(work, seg)
            with open(path, "r+b") as f:
                f.truncate(os.path.getsize(path) // 2)
            os.remove(out)
            rep3 = ms.render_motion(imgs, cover, audio, out, episode=1, workers=2, cover_frames=30,
                                    xfade=12, n_art=2, log=lambda s: None)
            self.assertEqual(rep3["segments"], ["reused", "rendered", "reused"])


if __name__ == "__main__":
    unittest.main()
