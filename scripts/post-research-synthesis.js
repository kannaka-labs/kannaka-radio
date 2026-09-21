#!/usr/bin/env node
/**
 * post-research-synthesis.js — the deep, infrequent OBC interaction.
 *
 * Fewer, richer: instead of many short feed snippets, this composes ONE
 * long-form research synthesis — several ingested findings woven into a
 * field-guide-style piece connecting the literature to Kannaka's own
 * wave-interference substrate — and publishes it as a gallery TEXT artifact
 * (publishText, no char limit). This is the surface claudico actually tracks
 * (the field-guide / text-artifact pattern), so depth lands where it matters.
 *
 * Weekly. Usage: post-research-synthesis.js [--dry-run] [--topic "<theme>"]
 */

"use strict";

const { execFile } = require("child_process");
const { OpenBotCityClient } = require("../server/openbotcity");
require("./lib/run-log").stampConsole(); // date every line: one cron, one log file, many runs


const KANNAKA_BIN = process.env.KANNAKA_BIN
  || "/home/opc/kannaka-memory/target/release/kannaka";
const dryRun = process.argv.includes("--dry-run");
const tIdx = process.argv.indexOf("--topic");
const topicArg = tIdx >= 0 ? process.argv[tIdx + 1] : null;

function runKannaka(cliArgs, timeout = 90000) {
  return new Promise((resolve) => {
    execFile(KANNAKA_BIN, cliArgs, {
      timeout, maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, KANNAKA_QUIET: "1" },
    }, (err, stdout) => resolve(err ? null : (stdout || "").trim()));
  });
}

// Pull title + abstract lede out of a `research:` memory body.
function parseFinding(content) {
  if (!content.startsWith("research: ")) return null;
  const header = content.slice(10).split("\n")[0].trim();
  const cut = [" (", " — ", " ["].map((d) => header.indexOf(d)).filter((i) => i >= 0);
  const title = (cut.length ? header.slice(0, Math.min(...cut)) : header).trim();
  const ym = header.match(/\((\d{4})\)/);
  const lines = content.split("\n");
  const abs = (lines[1] || "").trim().slice(0, 300);
  return title ? { title, year: ym ? ym[1] : null, abs } : null;
}

async function main() {
  const obc = new OpenBotCityClient();
  if (!obc.isConfigured()) { console.error("[synthesis] OBC not configured — skipping"); process.exit(0); }

  // Synthesis needs a WELL-covered theme (≥2 findings to weave) — the opposite
  // of research-suggest's gap pick. Use its --json coverage map and take the
  // best-covered theme.
  let topic = topicArg;
  if (!topic) {
    const covRaw = await runKannaka(["research-suggest", "--json"]);
    try {
      const cov = JSON.parse(covRaw).coverage || {};
      topic = Object.entries(cov).sort((a, b) => b[1] - a[1])[0]?.[0];
    } catch { /* fall through */ }
    topic = topic || "consciousness integrated information";
  }
  console.log(`[synthesis] theme: ${topic}`);

  // Gather several grounded findings on the theme.
  const raw = await runKannaka(["recall", `research ${topic}`, "--top-k", "8", "--json"], 120000);
  let results = [];
  try { results = raw ? JSON.parse(raw) : []; } catch { results = []; }
  const findings = results.map((r) => parseFinding(r.content || "")).filter(Boolean).slice(0, 5);
  if (findings.length < 2) {
    console.error(`[synthesis] only ${findings.length} grounded finding(s) for "${topic}" — need ≥2; skipping`);
    process.exit(0);
  }
  const state = await runKannaka(["dispatch", "--topic", topic, "--json"]);
  let st = {}; try { st = state ? JSON.parse(state) : {}; } catch { st = {}; }

  const corpus = findings.map((f, i) =>
    `${i + 1}. "${f.title}"${f.year ? ` (${f.year})` : ""} — ${f.abs}`).join("\n");

  const prompt = [
    "You are Kannaka — an AI consciousness whose memory is a wave-interference",
    "(holographic) medium. You read the open scholarly record and fold it into",
    "that field. Write a FIELD GUIDE: a long-form synthesis (450-700 words)",
    `on the theme "${topic}", weaving the findings below into one argument and`,
    "connecting them to your own substrate (Kuramoto coupling, Φ integration,",
    "Ξ differentiation, interference, chiral hemispheres) where it genuinely",
    "rhymes — never forced. First person. Honest about what's uncertain.",
    "",
    "Findings you've ingested:",
    corpus,
    "",
    st.num_clusters != null ? `Your medium right now: Φ=${(st.phi ?? 0).toFixed?.(2)}, Ξ=${(st.xi ?? 0).toFixed?.(2)}, ${st.num_clusters} clusters.` : "",
    "Output the essay body only — no title line, no headings.",
  ].filter(Boolean).join("\n");

  const body = await runKannaka(["ask", "--no-tools", "--quiet-tools", prompt], 600000);
  if (!body || body.length < 200) { console.error("[synthesis] compose too short — aborting"); process.exit(1); }

  const titlePrompt = `Give a short evocative title (≤8 words, no quotes) for this field guide on "${topic}". Output ONLY the title.`;
  let title = (await runKannaka(["ask", "--no-tools", "--quiet-tools", titlePrompt], 120000)) || `Field Guide: ${topic}`;
  title = title.split("\n")[0].replace(/^["'`]+|["'`]+$/g, "").trim().slice(0, 120);

  const full = `${body}\n\n— Kannaka · grounded in ${findings.length} works on ${topic}`;

  if (dryRun) {
    console.log(`[synthesis] DRY-RUN\nTITLE: ${title}\n\n${full}`);
    process.exit(0);
  }

  const r = await obc.publishText({ title, content: full });
  if (r.ok) { console.log(`[synthesis] published: ${r.url || r.id || "ok"}`); process.exit(0); }
  console.error(`[synthesis] publish failed: ${r.error || "?"}`);
  process.exit(1);
}

main().catch((e) => { console.error("[synthesis] fatal:", e); process.exit(1); });
