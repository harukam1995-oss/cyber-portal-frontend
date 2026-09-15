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
const { p2DueFromTerms, p2DueLabel, p2PeriodCheck } = new Function(
  cut("p2MonthAdd") + cut("p2TermsDays") + cut("p2DueFromTerms") + cut("p2DueLabel") + cut("p2CloseLimit") + cut("p2PeriodCheck") +
  "\nreturn { p2DueFromTerms, p2DueLabel, p2PeriodCheck };"
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

test("月末締め翌々月: 日が無ければ翌々月末", () => {
  assert.equal(p2DueFromTerms("月末締め翌々月", "2026-06", ""), "2026-08-31");
  assert.equal(p2DueFromTerms("月末締め翌々月末", "2026-06", ""), "2026-08-31");
  assert.equal(p2DueFromTerms("月末締め翌々月末払い", "2026-12", ""), "2027-02-28");
  assert.equal(p2DueFromTerms("月末締め翌月払い", "2026-06", ""), "2026-07-31");
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

test("何月分を確認: 請求日が月末の5日前より前なら警告", () => {
  const T = "月末締め翌月末";
  assert.equal(p2PeriodCheck(T, "2026-07", "2026-07-22", "", []), "warn");
  assert.equal(p2PeriodCheck(T, "2026-07", "2026-07-25", "", []), "warn");
  assert.equal(p2PeriodCheck(T, "2026-07", "2026-07-26", "", []), "");
  assert.equal(p2PeriodCheck(T, "2026-06", "2026-07-01", "", []), "");
  assert.equal(p2PeriodCheck(T, "2026-07", "", "", []), "");
  assert.equal(p2PeriodCheck("請求書発行後30日", "2026-07", "2026-07-01", "", []), "");
  assert.equal(p2PeriodCheck("", "2026-07", "2026-07-01", "", []), "");
});

test("何月分を確認: 請求書の期日が 支払サイト＋何月分 と合えば出さない（株式会社ラット 7月分・7/22 発行・期日 8/31）", () => {
  const T = "月末締め翌月末";
  assert.equal(p2PeriodCheck(T, "2026-07", "2026-07-22", "2026-08-31", []), "due");
  assert.equal(p2PeriodCheck(T, "2026-07", "2026-07-22", "2026-07-31", []), "warn");
});

test("何月分を確認: 同じベンダーが締め前に当月分を出していれば出さない", () => {
  const T = "月末締め翌月末";
  const rat = [{ periodMonth: "2026-07", invoiceDate: "2026-07-14", dueDate: "2026-08-31" }];
  assert.equal(p2PeriodCheck(T, "2026-08", "2026-08-15", "", rat), "habit");
  // 何月分が請求書の月になっている行（9月分・9/1 発行・期日 9/30）は根拠にしない
  const wrong = [{ periodMonth: "2026-09", invoiceDate: "2026-09-01", dueDate: "2026-09-30" }];
  assert.equal(p2PeriodCheck(T, "2026-10", "2026-10-01", "", wrong), "warn");
  // 期日の無い行・締め後の発行の行も根拠にしない
  const noHabit = [
    { periodMonth: "2026-07", invoiceDate: "2026-07-14", dueDate: "" },
    { periodMonth: "2026-06", invoiceDate: "2026-06-30", dueDate: "2026-07-31" },
  ];
  assert.equal(p2PeriodCheck(T, "2026-08", "2026-08-15", "", noHabit), "warn");
});

test("期日の表示に曜日と土日の注記", () => {
  assert.equal(p2DueLabel("2026-07-31"), "7/31（金）");
  assert.equal(p2DueLabel("2026-10-31"), "10/31（土） ※銀行休業日");
});
