/* 請求書管理の 金額・日付の読み取り と 検索（app.payables.js の p2ParseAmount / p2StmtNum / p2StmtDate / p2Match）を
 * 実物から切り出して試す。切り出し方は payables-terms.test.mjs と同じ（2字下げの function 〜 次の 2字下げの }）。 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL(".", import.meta.url));
const src = readFileSync(dir + "../app.payables.js", "utf8").replace(/\r\n/g, "\n");

function cut(name){
  const start = src.indexOf("\n  function " + name + "(");
  assert.ok(start !== -1, name + " が app.payables.js に見つからない");
  const end = src.indexOf("\n  }\n", start);
  return src.slice(start, end + 4);
}
const { p2ParseAmount, p2StmtNum, p2StmtDate, p2Match } = new Function(
  cut("p2ParseAmount") + cut("p2StmtNum") + cut("p2StmtDate") + cut("p2Fold") + cut("p2Match") +
  "\nreturn { p2ParseAmount, p2StmtNum, p2StmtDate, p2Match };"
)();

test("金額: 記号・カンマ・全角を外して読む", () => {
  assert.equal(p2ParseAmount("12345"), 12345);
  assert.equal(p2ParseAmount("¥12,345"), 12345);
  assert.equal(p2ParseAmount("￥12,345"), 12345);
  assert.equal(p2ParseAmount("¥12,345.00"), 12345);   // 以前は 1,234,500 になっていた
  assert.equal(p2ParseAmount("１２，３４５円"), 12345);
  assert.equal(p2ParseAmount(" 1 234 "), 1234);
  assert.equal(p2ParseAmount("$3.50"), 3.5);
  assert.equal(p2ParseAmount("0"), 0);
  assert.equal(p2ParseAmount(1200), 1200);
});

test("金額: △ ▲ − - (…) はマイナス", () => {
  assert.equal(p2ParseAmount("-500"), -500);
  assert.equal(p2ParseAmount("−500"), -500);
  assert.equal(p2ParseAmount("－500"), -500);
  assert.equal(p2ParseAmount("△1,000"), -1000);
  assert.equal(p2ParseAmount("▲1,000"), -1000);
  assert.equal(p2ParseAmount("(1,000)"), -1000);
  assert.equal(p2ParseAmount("（1,000）"), -1000);
  assert.equal(p2ParseAmount("¥-1,000"), -1000);
  assert.equal(p2ParseAmount("-¥1,000"), -1000);
});

test("金額: 読めなければ null", () => {
  assert.equal(p2ParseAmount(""), null);
  assert.equal(p2ParseAmount(null), null);
  assert.equal(p2ParseAmount(undefined), null);
  assert.equal(p2ParseAmount("abc"), null);
  assert.equal(p2ParseAmount("1.2.3"), null);
  assert.equal(p2ParseAmount("12a"), null);
  assert.equal(p2ParseAmount("-"), null);
  assert.equal(p2ParseAmount("税込12,000"), null);
  assert.equal(p2ParseAmount(NaN), null);
});

test("明細の金額: 既定は丸める・frac なら小数のまま", () => {
  assert.equal(p2StmtNum("1,234.6"), 1235);
  assert.equal(p2StmtNum("1,234.6", true), 1234.6);
  assert.equal(p2StmtNum("▲300"), -300);
  assert.equal(p2StmtNum(""), null);
  assert.equal(p2StmtNum("—"), null);
});

test("明細の日付: 西暦のいろいろな書き方", () => {
  assert.equal(p2StmtDate("2026/09/01"), "2026-09-01");
  assert.equal(p2StmtDate("2026-9-1"), "2026-09-01");
  assert.equal(p2StmtDate("2026年9月1日"), "2026-09-01");
  assert.equal(p2StmtDate("２０２６／０９／０１"), "2026-09-01");
  assert.equal(p2StmtDate("2026.09.01 10:30"), "2026-09-01");
  assert.equal(p2StmtDate("20260901"), "2026-09-01");
  assert.equal(p2StmtDate(20260901), "2026-09-01");
  assert.equal(p2StmtDate(46266), "2026-09-01");   // Excel のシリアル値
  assert.equal(p2StmtDate("46266"), "2026-09-01");
});

test("明細の日付: 令和（R1＝2019）", () => {
  assert.equal(p2StmtDate("R8.9.1"), "2026-09-01");
  assert.equal(p2StmtDate("r8/09/01"), "2026-09-01");
  assert.equal(p2StmtDate("令和8年9月1日"), "2026-09-01");
  assert.equal(p2StmtDate("令和元年5月1日"), "2019-05-01");
  assert.equal(p2StmtDate("Ｒ８．９．１"), "2026-09-01");
  assert.equal(p2StmtDate("㋿8年9月1日"), "2026-09-01");
});

test("明細の日付: 読めなければ空", () => {
  assert.equal(p2StmtDate(""), "");
  assert.equal(p2StmtDate(null), "");
  assert.equal(p2StmtDate("9月1日"), "");
  assert.equal(p2StmtDate("2026/13/01"), "");
  assert.equal(p2StmtDate("2026/09/00"), "");
  assert.equal(p2StmtDate("ABCR8.9.1"), "");
});

test("検索: NFKC・大文字小文字・ひらがな/カタカナを区別せず、空白区切りは AND", () => {
  const f = ["株式会社ラット", "info@rat.example", "月末締め翌月末"];
  assert.equal(p2Match("", f), true);
  assert.equal(p2Match("  ", f), true);
  assert.equal(p2Match("らっと", f), true);
  assert.equal(p2Match("ﾗｯﾄ", f), true);
  assert.equal(p2Match("ＲＡＴ", f), true);
  assert.equal(p2Match("ラット 翌月", f), true);
  assert.equal(p2Match("ラット　翌々月", f), false);
  assert.equal(p2Match("ねずみ", f), false);
  assert.equal(p2Match("らっと", [null, undefined, "ラット"]), true);
});
