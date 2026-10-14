// A human guest's track must never be tagged as AI-made (2026-10-13: the now-playing
// post for Solace Road carried #aiart, and the artist had to correct us in public).
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { tagsFor } = require("../server/broadcasters/discovery");

const AI = /(^|#)ai|aimusic|aiart/i;

const featured = tagsFor("featured", 5);
assert.ok(featured.length >= 2, "featured topic has its own tags");
for (const t of featured) assert.ok(!AI.test(t), `featured tag ${t} must not say AI`);
assert.ok(tagsFor(undefined, 5).some((t) => AI.test(t)), "the default topic still carries AI tags (so the topic must be set)");

const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "post-now-playing.js"), "utf8");
const pool = src.match(/const FEATURED_TAGS = \[([^\]]*)\]/);
assert.ok(pool, "post-now-playing defines FEATURED_TAGS");
assert.ok(!AI.test(pool[1].replace(/["\s]/g, "")), "FEATURED_TAGS must not say AI");
assert.ok(/broadcastPost\(\{ text, link, topic \}/.test(src), "now-playing passes a topic to the broadcaster");
assert.ok(/isFeatured\(title, album\) \? "featured"/.test(src), "featured tracks get the featured topic");

console.log("featured-no-ai-tags: ok");
