/* ============================================================================
 * MIRROR of the pure helper functions defined inside the IIFE in ../app.js
 *
 * app.js is one 7,900-line IIFE with no exports, so these small side-effect-free
 * helpers cannot be imported directly. They are copied here VERBATIM (bodies
 * only de-indented) so `tests/helpers.test.mjs` can exercise them.
 *
 *   >>> Keep this file byte-for-byte in sync with ../app.js. <<<
 *
 * `tests/sync-check.test.mjs` re-extracts each function from ../app.js by name
 * and fails if the logic here has drifted. When app.js is split into ES modules
 * (see the refactor plan), delete this file and import from the real module.
 * ==========================================================================*/

const JP_TZ = "Asia/Tokyo";

/* ---- date/time helpers (JST-anchored) ---- */

export function keyParts(key){
  var p = key.split("-").map(Number);
  return { y: p[0], m: p[1], d: p[2] };
}
export function mdLabel(key){ var p = keyParts(key); return p.m + "/" + p.d; }
export function addDaysKey(key, n){
  var p = keyParts(key);
  var d = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
}
export function keyWeekday(key){
  var p = keyParts(key);
  return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
}
export function startOfWeekKey(key){ return addDaysKey(key, -keyWeekday(key)); }
export function startOfMonthKey(key){ var p = keyParts(key); return p.y + "-" + String(p.m).padStart(2, "0") + "-01"; }
export function daysInMonth(y, m){ return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
export function jstKeyTimeToUTCISO(key, hh, mm){
  var p = keyParts(key);
  return new Date(Date.UTC(p.y, p.m - 1, p.d, hh - 9, mm || 0, 0)).toISOString();
}
export function jstRangeForKeys(startKey, endKeyExclusive){
  return { start: jstKeyTimeToUTCISO(startKey, 0, 0), end: jstKeyTimeToUTCISO(endKeyExclusive, 0, 0) };
}
export function minutesToHHMM(m){
  var h = Math.floor(m / 60), mm = m % 60;
  return String(h).padStart(2, "0") + ":" + String(mm).padStart(2, "0");
}
export function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, function(ch){
    return { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch];
  });
}

/* ---- サブスク管理: 周期・金額 ---- */

export function subYen(n){ return "¥" + (Math.round(Number(n) || 0)).toLocaleString("ja-JP"); }
export function subUnit(s){ return s.unit === "year" ? "year" : "month"; }
export function subEvery(s){ return Math.min(120, Math.max(1, Math.round(Number(s.every) || 1))); }
export function subNeedsMonth(s){ return subUnit(s) === "year" || subEvery(s) > 1; }
export function subMonthlyAmount(s){
  var a = Number(s.amount) || 0;
  var months = subEvery(s) * (subUnit(s) === "year" ? 12 : 1);
  return a / months;
}
export function subCadenceWord(s){
  var n = subEvery(s);
  if (subUnit(s) === "year") return n === 1 ? "毎年" : n + "年ごと";
  if (n === 1) return "毎月";
  if (n === 2) return "隔月";
  if (n === 6) return "半年ごと";
  return n + "ヶ月ごと";
}

export function subTodayParts(){
  return new Intl.DateTimeFormat("en-CA", { timeZone: JP_TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date()).split("-").map(Number);
}
export function subYm(y, m){ return y + "-" + String(m).padStart(2, "0"); }
export function subChargesInRange(s, fromYm, count){
  var step = subEvery(s) * (subUnit(s) === "year" ? 12 : 1);
  var day = Math.min(31, Math.max(1, Math.round(Number(s.day) || 1)));
  var p = subTodayParts();
  var fp = String(fromYm).split("-").map(Number);
  var fromIdx = fp[0] * 12 + (fp[1] - 1);
  var toIdx = fromIdx + count - 1;
  var anchorM = step === 1 ? p[1] : Math.min(12, Math.max(1, Math.round(Number(s.month) || p[1])));
  var anchorIdx = (p[0] - 2) * 12 + (anchorM - 1);
  var skip = Math.max(0, Math.ceil((fromIdx - anchorIdx) / step));
  var out = [];
  for (var idx = anchorIdx + skip * step; idx <= toIdx && out.length < 200; idx += step){
    var y = Math.floor(idx / 12), m = (idx % 12) + 1;
    out.push({ ym: subYm(y, m), y: y, m: m, d: Math.min(day, new Date(y, m, 0).getDate()) });
  }
  return out;
}
export function subDaysLabel(days){
  if (days <= 0) return "今日";
  if (days === 1) return "明日";
  return "あと" + days + "日";
}

/* ---- 今月の収支: 金額表示 / 月の計算 ---- */

export function finYen(n){
  return "¥" + (Math.round(Number(n) || 0)).toLocaleString("ja-JP");
}
export function finSignedYen(n){
  var v = Math.round(Number(n) || 0);
  return (v < 0 ? "−" : "") + "¥" + Math.abs(v).toLocaleString("ja-JP");
}
export function finShiftMonth(ym, n){
  var p = String(ym).split("-").map(Number);
  var t = (p[0] * 12 + (p[1] - 1)) + n;
  return String(Math.floor(t / 12)) + "-" + String((t % 12) + 1).padStart(2, "0");
}
export function finMonthLabel(ym){
  var p = String(ym).split("-");
  return p[0] + "年" + Number(p[1]) + "月";
}

export { JP_TZ };
