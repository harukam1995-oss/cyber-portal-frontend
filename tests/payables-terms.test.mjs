/* 請求書管理の「支払サイト → 支払期日」（app.payables.js の p2DueFromTerms）を実物から切り出して試す。
 * app.payables.js は IIFE で export が無いので、関数を「2字下げの function 〜 次の 2字下げの }」で
 * 切り出して new Function で評価する（正規表現の { } を含むので sync-check の括弧対応は使えない）。 */
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
const { p2DueFromTerms, p2DueLabel } = new Function(
  cut("p2MonthAdd") + cut("p2TermsDays") + cut("p2DueFromTerms") + cut("p2DueLabel") + "\nreturn { p2DueFromTerms, p2DueLabel };"
)();

test("月末締め翌月末: 6月分 → 7月末", () => {
  assert.equal(p2DueFromTerms("月末締め翌月末", "2026-06", "2026-07-01"), "2026-07-31");
  assert.equal(p2DueFromTerms("月末締め翌月末払い", "2026-01", ""), "2026-02-28");
  assert.equal(p2DueFromTerms("月末締め 翌月末日", "2026-12", ""), "2027-01-31");
});

test("月末締め20日: 翌月と書いていなくても翌月20日", () => {
  assert.equal(p2DueFromTerms("月末締め20日", "2026-06", ""), "2026-07-20");
  assert.equal(p2DueFromTerms("月末締め翌月２０日払い", "2026-06", ""), "2026-07-20");
});

test("当月・翌々月・月の日数を超える日", () => {
  assert.equal(p2DueFromTerms("月末締め翌々月10日", "2026-06", ""), "2026-08-10");
  assert.equal(p2DueFromTerms("当月末払い", "2026-06", ""), "2026-06-30");
  assert.equal(p2DueFromTerms("月末締め翌月31日", "2026-01", ""), "2026-02-28");
});

test("請求書発行後N日は請求日から数える", () => {
  assert.equal(p2DueFromTerms("請求書発行後30日", "2026-06", "2026-07-15"), "2026-08-14");
  assert.equal(p2DueFromTerms("請求日から14日以内", "", "2026-12-25"), "2027-01-08");
  assert.equal(p2DueFromTerms("請求書発行後30日", "2026-06", ""), null);
});

test("読めないとき・何月分が無いときは null", () => {
  assert.equal(p2DueFromTerms("", "2026-06", ""), null);
  assert.equal(p2DueFromTerms("月末締め", "2026-06", ""), null);
  assert.equal(p2DueFromTerms("都度相談", "2026-06", ""), null);
  assert.equal(p2DueFromTerms("月末締め翌月末", "", "2026-07-01"), null);
});

test("期日の表示に曜日と土日の注記", () => {
  assert.equal(p2DueLabel("2026-07-31"), "7/31（金）");
  assert.equal(p2DueLabel("2026-10-31"), "10/31（土） ※銀行休業日");
});
