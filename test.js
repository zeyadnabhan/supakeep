// Minimal self-check: the logic that is actually easy to get wrong.
// Run: node test.js   (no framework, no fixtures -- it either exits 0 or throws)
import assert from "node:assert/strict";
import { projectRef, validateUrl, validateKey, validateInt, nextRun, localDayNum } from "./lib.js";

const ok = [];
const t = (name, fn) => { fn(); ok.push(name); };
const throws = fn => assert.throws(fn);

// ---------- url ----------
t("projectRef pulls the ref", () =>
  assert.equal(projectRef("https://abcdefghijklmnopqrst.supabase.co"), "abcdefghijklmnopqrst"));

t("validateUrl normalizes case and trailing slashes", () =>
  assert.equal(validateUrl("  HTTPS://ABCDEFGHIJKLMNOPQRST.supabase.co//  "),
               "https://abcdefghijklmnopqrst.supabase.co"));

t("validateUrl rejects http, wrong host, wrong ref length", () => {
  throws(() => validateUrl("http://abcdefghijklmnopqrst.supabase.co"));
  throws(() => validateUrl("https://abcdefghijklmnopqrst.example.com"));
  throws(() => validateUrl("https://tooshort.supabase.co"));
  throws(() => validateUrl(""));
});

// ---------- keys: the security-relevant one ----------
const jwt = role => {
  const b = o => Buffer.from(JSON.stringify(o)).toString("base64url");
  return b({ alg: "HS256" }) + "." + b({ role }) + ".sig";
};

t("validateKey accepts anon jwt and publishable", () => {
  assert.equal(validateKey(jwt("anon")), jwt("anon"));
  assert.equal(validateKey("sb_publishable_AbC-123_xyz"), "sb_publishable_AbC-123_xyz");
});

t("validateKey REFUSES secret and service_role", () => {
  throws(() => validateKey("sb_secret_abc123"));
  throws(() => validateKey(jwt("service_role")));
  throws(() => validateKey("not-a-key"));
  throws(() => validateKey(""));
});

// ---------- ints ----------
t("validateInt enforces bounds and integers", () => {
  assert.equal(validateInt("3", 1, 6, "x"), 3);
  throws(() => validateInt("0", 1, 6, "x"));
  throws(() => validateInt("7", 1, 6, "x"));
  throws(() => validateInt("2.5", 1, 6, "x"));
  throws(() => validateInt("abc", 1, 6, "x"));
});

// ---------- schedule: the real meat ----------
const H = 3600000;
const TZ = "UTC"; // no DST, so gaps are exact arithmetic

t("nextRun is always strictly in the future", () => {
  const now = Date.UTC(2026, 9, 9, 13, 37, 42);
  const r = nextRun(now, { intervalDays: 1, times: 1, anchorDay: localDayNum(now, TZ) }, TZ);
  assert.ok(r > now, "must be strictly after now");
});

t("1 day x 1 time lands on local midnight", () => {
  const now = Date.UTC(2026, 9, 9, 13, 0, 0);
  const r = nextRun(now, { intervalDays: 1, times: 1, anchorDay: localDayNum(now, TZ) }, TZ);
  assert.equal(r, Date.UTC(2026, 9, 10, 0, 0, 0));
});

t("2 days x 4 times = every 12 hours (the README example)", () => {
  const anchor = localDayNum(Date.UTC(2026, 9, 9), TZ);
  let now = Date.UTC(2026, 9, 9, 0, 0, 1);
  const gaps = [];
  let prev = null;
  for (let i = 0; i < 6; i++) {
    const r = nextRun(now, { intervalDays: 2, times: 4, anchorDay: anchor }, TZ);
    if (prev !== null) gaps.push(r - prev);
    prev = r;
    now = r + 1;
  }
  assert.deepEqual(gaps, [12 * H, 12 * H, 12 * H, 12 * H, 12 * H]);
});

t("1 day x 6 times = every 4 hours", () => {
  const anchor = localDayNum(Date.UTC(2026, 9, 9), TZ);
  let now = Date.UTC(2026, 9, 9, 0, 0, 1);
  let prev = null;
  const gaps = [];
  for (let i = 0; i < 5; i++) {
    const r = nextRun(now, { intervalDays: 1, times: 6, anchorDay: anchor }, TZ);
    if (prev !== null) gaps.push(r - prev);
    prev = r; now = r + 1;
  }
  assert.deepEqual(gaps, [4 * H, 4 * H, 4 * H, 4 * H]);
});

t("max spacing (6 days x 1) still beats the 7-day pause window", () => {
  const anchor = localDayNum(Date.UTC(2026, 9, 9), TZ);
  let now = Date.UTC(2026, 9, 9, 0, 0, 1);
  const a = nextRun(now, { intervalDays: 6, times: 1, anchorDay: anchor }, TZ);
  const b = nextRun(a + 1, { intervalDays: 6, times: 1, anchorDay: anchor }, TZ);
  assert.ok(b - a <= 7 * 24 * H, "gap must stay under Supabase 7-day pause");
});

t("survives a DST transition without going backwards", () => {
  // Cairo moves its clock; the only invariant that matters is forward progress.
  const tz = "Africa/Cairo";
  let now = Date.UTC(2026, 3, 23, 12, 0, 0); // late April, around Egypt DST start
  const anchor = localDayNum(now, tz);
  for (let i = 0; i < 20; i++) {
    const r = nextRun(now, { intervalDays: 1, times: 4, anchorDay: anchor }, tz);
    assert.ok(r > now, "never goes backwards across DST");
    now = r + 1;
  }
});

console.log(ok.length + " checks passed:");
for (const n of ok) console.log("  ok  " + n);
