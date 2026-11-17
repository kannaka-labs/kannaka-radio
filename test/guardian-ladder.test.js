// Guardian: the ban ladder and the probe patterns added after the 2026-11-16 scan.
const assert=require("assert");process.env.GUARDIAN_STRIKES_FILE=require("os").tmpdir()+"/g-strikes-test.json";
const g=require("../scripts/constellation-guardian.js");const m={};const t=1e12;
assert.equal(g.nextRung(m,"a",t).rung.set,"kannaka_threats");
assert.equal(g.nextRung(m,"a",t+7200e3).rung.set,"kannaka_threats_day");
assert.equal(g.nextRung(m,"a",t+2*864e5).rung.set,"kannaka_threats_week");
assert.equal(g.nextRung(m,"a",t+9*864e5).rung.ttlS,7*86400);
assert.equal(g.nextRung(m,"b",t).n,1);
assert.equal(g.nextRung(m,"a",t+9*864e5+g.STRIKE_MEMORY_MS).n,1,"forgiven after 30 quiet days");
assert.equal(g.pruneStrikes({x:{n:2,last:0}},g.STRIKE_MEMORY_MS),1);
const hit=p=>g.SCANNER_PATTERNS.some(r=>r.test(p));
for(const p of ["/%2e%2e/%2e%2e/etc/passwd","/album/x/file/..%2f..%2fapp.js","/album/x/file/..%5capp.js","/%3Cimg%20src=x%20onerror=alert(1)%3E","/album/%3Cscript%3Ealert(1)%3C%2Fscript%3E","/agent/audit-history?limit=1;SELECT","/api/x?name=../../../../etc/passwd","/a?t=%7B%7B7*7%7D%7D"]) assert.ok(hit(p),"should flag "+p);
for(const p of ["/","/api/state","/api/hrm/remote?path=status&url=http://170.9.238.136","/album/anHlHrI4ymdVqY6rTMD6iA/file/01%20-%20Song.mp3","/api/markets?status=open&limit=20","/stream","/api/library?select=1","/api/similar?track=union%20station"]) assert.ok(!hit(p),"should not flag "+p);
console.log("guardian tests ok");
