import test from "node:test";
import assert from "node:assert/strict";
import * as H from "./helpers.mjs";

test("keyParts splits YYYY-MM-DD", () => {
  assert.deepEqual(H.keyParts("2026-09-07"), { y: 2026, m: 9, d: 7 });
});

test("mdLabel drops leading zeros", () => {
  assert.equal(H.mdLabel("2026-09-07"), "9/7");
  assert.equal(H.mdLabel("2026-12-25"), "12/25");
});

test("addDaysKey handles month and year rollover", () => {
  assert.equal(H.addDaysKey("2026-09-07", 1), "2026-09-08");
  assert.equal(H.addDaysKey("2026-09-30", 1), "2026-10-01");
  assert.equal(H.addDaysKey("2026-12-31", 1), "2027-01-01");
  assert.equal(H.addDaysKey("2026-01-01", -1), "2025-12-31");
  assert.equal(H.addDaysKey("2026-03-01", -1), "2026-02-28");
  assert.equal(H.addDaysKey("2024-03-01", -1), "2024-02-29"); // leap year
});

test("keyWeekday: 2026-09-07 is a Monday (1), Sunday is 0", () => {
  assert.equal(H.keyWeekday("2026-09-07"), 1);
  assert.equal(H.keyWeekday("2026-09-06"), 0);
});

test("startOfWeekKey snaps back to Sunday", () => {
  assert.equal(H.startOfWeekKey("2026-09-07"), "2026-09-06"); // Mon -> Sun
  assert.equal(H.startOfWeekKey("2026-09-06"), "2026-09-06"); // Sun -> same
  assert.equal(H.startOfWeekKey("2026-09-12"), "2026-09-06"); // Sat -> Sun
});

test("startOfMonthKey", () => {
  assert.equal(H.startOfMonthKey("2026-09-07"), "2026-09-01");
  assert.equal(H.startOfMonthKey("2026-01-31"), "2026-01-01");
});

test("daysInMonth (m is 1-based)", () => {
  assert.equal(H.daysInMonth(2026, 9), 30);
  assert.equal(H.daysInMonth(2026, 2), 28);
  assert.equal(H.daysInMonth(2024, 2), 29);
  assert.equal(H.daysInMonth(2026, 12), 31);
});

test("jstKeyTimeToUTCISO: JST midnight is previous day 15:00Z", () => {
  assert.equal(H.jstKeyTimeToUTCISO("2026-09-07", 0, 0), "2026-09-06T15:00:00.000Z");
  assert.equal(H.jstKeyTimeToUTCISO("2026-09-07", 9, 30), "2026-09-07T00:30:00.000Z");
});

test("jstRangeForKeys wraps two midnights", () => {
  assert.deepEqual(H.jstRangeForKeys("2026-09-07", "2026-09-08"), {
    start: "2026-09-06T15:00:00.000Z",
    end: "2026-09-07T15:00:00.000Z",
  });
});

test("minutesToHHMM zero-pads", () => {
  assert.equal(H.minutesToHHMM(0), "00:00");
  assert.equal(H.minutesToHHMM(9 * 60 + 5), "09:05");
  assert.equal(H.minutesToHHMM(23 * 60 + 59), "23:59");
});

test("escapeHtml neutralises all five metacharacters", () => {
  assert.equal(H.escapeHtml(`<img src=x onerror="alert('x')">`),
    "&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;");
  assert.equal(H.escapeHtml("a & b"), "a &amp; b");
  assert.equal(H.escapeHtml(123), "123");
});

/* ---- サブスク ---- */

test("subYen rounds and groups", () => {
  assert.equal(H.subYen(1234.6), "¥1,235");
  assert.equal(H.subYen(0), "¥0");
  assert.equal(H.subYen("abc"), "¥0");
});

test("subEvery clamps to 1..120", () => {
  assert.equal(H.subEvery({ every: 0 }), 1);
  assert.equal(H.subEvery({ every: 3 }), 3);
  assert.equal(H.subEvery({ every: 999 }), 120);
  assert.equal(H.subEvery({}), 1);
});

test("subNeedsMonth: yearly or multi-step needs an anchor month", () => {
  assert.equal(H.subNeedsMonth({ unit: "month", every: 1 }), false);
  assert.equal(H.subNeedsMonth({ unit: "month", every: 2 }), true);
  assert.equal(H.subNeedsMonth({ unit: "year", every: 1 }), true);
});

test("subMonthlyAmount amortises over the period", () => {
  assert.equal(H.subMonthlyAmount({ amount: 1200, unit: "month", every: 1 }), 1200);
  assert.equal(H.subMonthlyAmount({ amount: 1200, unit: "month", every: 6 }), 200); // 半年払い
  assert.equal(H.subMonthlyAmount({ amount: 1200, unit: "year", every: 1 }), 100);  // 年払い
  assert.equal(H.subMonthlyAmount({ amount: 2400, unit: "year", every: 2 }), 100);  // 2年払い
});

test("subCadenceWord", () => {
  assert.equal(H.subCadenceWord({ unit: "month", every: 1 }), "毎月");
  assert.equal(H.subCadenceWord({ unit: "month", every: 2 }), "隔月");
  assert.equal(H.subCadenceWord({ unit: "month", every: 3 }), "3ヶ月ごと");
  assert.equal(H.subCadenceWord({ unit: "month", every: 6 }), "半年ごと");
  assert.equal(H.subCadenceWord({ unit: "year", every: 1 }), "毎年");
  assert.equal(H.subCadenceWord({ unit: "year", every: 2 }), "2年ごと");
});

/* ---- 収支 ---- */

test("subChargesInRange: 毎月は窓のすべての月に1回ずつ当たる", () => {
  const p = H.subTodayParts();
  const from = H.subYm(p[0], p[1]);
  const got = H.subChargesInRange({ unit: "month", every: 1, day: 25 }, from, 12);
  assert.equal(got.length, 12);
  assert.equal(got[0].ym, from);
  assert.ok(got.every((c) => c.d === 25));
});

test("subChargesInRange: 毎年は基準月に年1回だけ", () => {
  const p = H.subTodayParts();
  const from = H.subYm(p[0], p[1]);
  const got = H.subChargesInRange({ unit: "year", every: 1, month: 6, day: 25 }, from, 12);
  assert.equal(got.length, 1);
  assert.equal(got[0].m, 6);
  assert.equal(got[0].d, 25);
});

test("subChargesInRange: 半年ごとは12ヶ月窓に2回", () => {
  const p = H.subTodayParts();
  const from = H.subYm(p[0], p[1]);
  const got = H.subChargesInRange({ unit: "month", every: 6, month: 3, day: 10 }, from, 12);
  assert.equal(got.length, 2);
  assert.equal(Math.abs(got[1].m - got[0].m) % 12, 6 % 12);
});

test("subChargesInRange: 支払日は月の実日数へ丸める（31日 → 2月は28/29日）", () => {
  const got = H.subChargesInRange({ unit: "month", every: 1, day: 31 }, "2026-02", 1);
  assert.equal(got.length, 1);
  assert.equal(got[0].d, 28); // 2026年2月
});

test("subDaysLabel", () => {
  assert.equal(H.subDaysLabel(0), "今日");
  assert.equal(H.subDaysLabel(-2), "今日");
  assert.equal(H.subDaysLabel(1), "明日");
  assert.equal(H.subDaysLabel(15), "あと15日");
});

test("finShiftMonth crosses year boundaries", () => {
  assert.equal(H.finShiftMonth("2026-09", -1), "2026-08");
  assert.equal(H.finShiftMonth("2026-01", -1), "2025-12");
  assert.equal(H.finShiftMonth("2026-12", 1), "2027-01");
  assert.equal(H.finShiftMonth("2026-03", -14), "2025-01");
});

test("finMonthLabel drops the leading zero", () => {
  assert.equal(H.finMonthLabel("2026-09"), "2026年9月");
  assert.equal(H.finMonthLabel("2026-12"), "2026年12月");
});

test("finYen / finSignedYen", () => {
  assert.equal(H.finYen(-500.4), "¥-500");           // finYen keeps the raw minus from toLocaleString
  assert.equal(H.finSignedYen(-1200), "−¥1,200");    // finSignedYen uses U+2212 and abs value
  assert.equal(H.finSignedYen(1200), "¥1,200");
  assert.equal(H.finSignedYen(0), "¥0");
});
