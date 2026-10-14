'use strict';
// 2026-10-14: the edge personas (oration, gossip, news) aired at -21 to -24 LUFS
// while the DJ and the music sat at -18, so narration sounded buried. postProcess
// now lands every spoken persona at one integrated target with a two-pass
// loudnorm (measure, then linear gain), and renders unnormalized rather than
// failing when the measurement cannot be made.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ve = require('../server/voice-engine');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-loud-'));
const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

function measure(file) {
  const r = spawnSync('ffmpeg', ['-v', 'info', '-nostats', '-i', file, '-af', 'loudnorm=I=-18:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = ve.parseLoudnorm(r.stderr);
  assert.ok(m, `measure ${file}: ${r.stderr.slice(-200)}`);
  const d = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).stdout.trim();
  return { lufs: m.input_i, tp: m.input_tp, sec: parseFloat(d) };
}
/** A 3 s speech-like fixture (band-limited noise with pauses) at roughly `gainDb` below its natural level. */
function fixture(name, gainDb) {
  const p = path.join(TMP, name);
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', 'anoisesrc=color=pink:seed=7:duration=3:sample_rate=24000',
    '-af', `lowpass=f=4000,highpass=f=120,volume=${gainDb}dB,tremolo=f=2:d=0.9`, '-ac', '1', p]);
  assert.equal(r.status, 0, String(r.stderr));
  return p;
}
function post(src, dsp, out, cb) { ve.postProcess(src, dsp, out, cb, 60000); }

test('target and switches: default -18 / -1.5, per-persona override, opt-out, env', () => {
  assert.deepEqual(ve.loudnessTarget({}), { i: -18, tp: -1.5, lra: 11 });
  assert.deepEqual(ve.loudnessTarget({ lufs: -16, tp: -2 }), { i: -16, tp: -2, lra: 11 });
  assert.equal(ve.loudnormEnabled({}), true);
  assert.equal(ve.loudnormEnabled({ loudnorm: false }), false);
  process.env.VOICE_LOUDNORM = '0';
  assert.equal(ve.loudnormEnabled({}), false);
  delete process.env.VOICE_LOUDNORM;
  process.env.VOICE_TARGET_LUFS = '-20';
  assert.equal(ve.loudnessTarget({}).i, -20);
  assert.equal(ve.loudnessTarget({ lufs: -17 }).i, -17, 'persona beats env');
  delete process.env.VOICE_TARGET_LUFS;
});

test('parseLoudnorm reads ffmpeg\'s report and refuses silence', () => {
  const rep = 'x\n{\n\t"input_i" : "-23.40",\n\t"input_tp" : "-6.10",\n\t"input_lra" : "5.20",\n\t"input_thresh" : "-33.70",\n\t"output_i" : "-18.0",\n\t"target_offset" : "0.30"\n}\n';
  assert.deepEqual(ve.parseLoudnorm(rep), { input_i: -23.4, input_tp: -6.1, input_lra: 5.2, input_thresh: -33.7, target_offset: 0.3 });
  assert.equal(ve.parseLoudnorm(rep.replace('"-23.40"', '"-inf"')), null);
  assert.equal(ve.parseLoudnorm('no report here'), null);
  const f = ve.loudnormFilter({ i: -18, tp: -1.5, lra: 11 }, ve.parseLoudnorm(rep));
  assert.match(f, /^loudnorm=I=-18:TP=-1.5:LRA=11:measured_I=-23.4:measured_TP=-6.1:measured_LRA=5.2:measured_thresh=-33.7:offset=0.3:linear=true/);
});

test('encode args keep the icecast envelope and carry the filter only when there is one', () => {
  const a = ve.encodeArgs('in.wav', '', 'out.mp3');
  assert.ok(!a.includes('-af'));
  assert.deepEqual(a.slice(-13), ['-ar', '44100', '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '128k', '-id3v2_version', '0', '-write_xing', '0', 'out.mp3']);
  assert.ok(ve.encodeArgs('in.wav', 'atempo=1.05,loudnorm=I=-18', 'out.mp3').includes('-af'));
});

test('a quiet render (about -24 LUFS) comes out at the target, peak-limited, same length', { skip: !haveFfmpeg && 'ffmpeg missing' }, async () => {
  const src = fixture('quiet.wav', -16);
  const before = measure(src);
  assert.ok(before.lufs < -21, `fixture should be quiet, got ${before.lufs}`);
  const out = path.join(TMP, 'quiet.mp3');
  await new Promise((res, rej) => post(src, { rate: 1.0 }, out, (e) => (e ? rej(e) : res())));
  const after = measure(out);
  assert.ok(Math.abs(after.lufs - (-18)) <= 1.0, `expected -18 ±1, got ${after.lufs}`);
  assert.ok(after.tp <= -1.5 + 0.3, `true peak ${after.tp} above the ceiling`);
  assert.ok(Math.abs(after.sec - before.sec) < 0.25, `duration ${before.sec} -> ${after.sec}`);
});

test('a render already at the target is left alone (within 0.5 LU), and the DJ DSP still applies', { skip: !haveFfmpeg && 'ffmpeg missing' }, async () => {
  // First land a fixture at -18 through the engine, then feed that result back in.
  const src = fixture('mid.wav', -10);
  const first = path.join(TMP, 'mid-1.mp3');
  await new Promise((res, rej) => post(src, {}, first, (e) => (e ? rej(e) : res())));
  const a = measure(first);
  assert.ok(Math.abs(a.lufs - (-18)) <= 1.0, `first pass ${a.lufs}`);
  const second = path.join(TMP, 'mid-2.mp3');
  await new Promise((res, rej) => post(first, {}, second, (e) => (e ? rej(e) : res())));
  const b = measure(second);
  assert.ok(Math.abs(b.lufs - a.lufs) <= 0.5, `second pass moved the level ${a.lufs} -> ${b.lufs}`);
  // The DJ recipe (rate 1.05) shortens the clip; the level still lands.
  const dj = path.join(TMP, 'dj.mp3');
  await new Promise((res, rej) => post(src, { rate: 1.05, pitch: -0.5, treble: 1.0, reverb: 0.08 }, dj, (e) => (e ? rej(e) : res())));
  const d = measure(dj);
  assert.ok(Math.abs(d.lufs - (-18)) <= 1.0, `dj ${d.lufs}`);
  assert.ok(d.sec < measure(src).sec, 'rate 1.05 shortens the clip');
});

test('opting out renders the old way: no level change', { skip: !haveFfmpeg && 'ffmpeg missing' }, async () => {
  const src = fixture('raw.wav', -16);
  const before = measure(src);
  const out = path.join(TMP, 'raw.mp3');
  await new Promise((res, rej) => post(src, { loudnorm: false }, out, (e) => (e ? rej(e) : res())));
  const after = measure(out);
  assert.ok(Math.abs(after.lufs - before.lufs) <= 0.7, `opt-out moved the level ${before.lufs} -> ${after.lufs}`);
});

test('an unmeasurable (silent) render still renders, unnormalized', { skip: !haveFfmpeg && 'ffmpeg missing' }, async () => {
  const p = path.join(TMP, 'silence.wav');
  assert.equal(spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', '2', p]).status, 0);
  const out = path.join(TMP, 'silence.mp3');
  await new Promise((res, rej) => post(p, {}, out, (e) => (e ? rej(e) : res())));
  assert.ok(fs.statSync(out).size > 500);
});
