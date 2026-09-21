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
// p2Mkey は1行の関数なので cut で続く p2MonthsDiff まで一緒に切り出される（どちらも使う）
const { p2DueFromTerms, p2DueLabel, p2PeriodCheck, p2PayMonthOf, p2GuessPeriod, p2ArrivalDay, p2WithSkip, p2SkipOf } = new Function(
  cut("p2Mkey") + cut("p2MonthAdd") + cut("p2TermsDays") + cut("p2DueFromTerms") + cut("p2DueLabel") + cut("p2CloseLimit") + cut("p2PeriodCheck") +
  cut("p2PayMonthOf") + cut("p2GuessPeriod") + cut("p2ArrivalDay") + cut("p2WithSkip") + cut("p2SkipOf") +
  "\nreturn { p2DueFromTerms, p2DueLabel, p2PeriodCheck, p2PayMonthOf, p2GuessPeriod, p2ArrivalDay, p2WithSkip, p2SkipOf };"
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

test("〆 は 締め と同じ・「支払日」でも区切る", () => {
  assert.equal(p2DueFromTerms("月末〆翌月10日払い", "2026-06", ""), "2026-07-10");
  assert.equal(p2DueFromTerms("20日〆翌月5日", "2026-06", ""), "2026-07-05");
  assert.equal(p2DueFromTerms("締日：月末、支払日：翌月25日", "2026-06", ""), "2026-07-25");
  assert.equal(p2DueFromTerms("締日: 月末 / 支払日: 翌々月末", "2026-06", ""), "2026-08-31");
  assert.equal(p2DueFromTerms("月末締め、翌月末支払", "2026-06", ""), "2026-07-31");
  assert.equal(p2DueFromTerms("月末締め翌月20日支払い", "2026-06", ""), "2026-07-20");
  assert.equal(p2DueFromTerms("月末〆", "2026-06", ""), null);
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

test("未着チェックの支払月: 何月分＋支払サイトの期日の月（支払予定日は使わない）", () => {
  const T = "月末締め翌月末";
  assert.equal(p2PayMonthOf({ periodMonth: "2026-07", method: "銀行振込", scheduledDate: "2026-07-31" }, T), "2026-08");
  assert.equal(p2PayMonthOf({ periodMonth: "2026-06", method: "銀行振込" }, "月末締め翌々月末"), "2026-08");
  assert.equal(p2PayMonthOf({ periodMonth: "2026-07", method: "銀行振込", invoiceDate: "2026-07-20" }, "請求書発行後30日"), "2026-08");
  assert.equal(p2PayMonthOf({ periodMonth: "2026-07", method: "銀行振込", dueDate: "2026-09-10" }, ""), "2026-09");
  assert.equal(p2PayMonthOf({ periodMonth: "2026-07", method: "口座振替" }, ""), "2026-08");
  assert.equal(p2PayMonthOf({ periodMonth: "", method: "銀行振込", receivedDate: "2026-08-03" }, T), "2026-08");
  assert.equal(p2PayMonthOf({ periodMonth: "2026-07", method: "UPSIDER", receivedDate: "2026-07-05" }, ""), "2026-07");
});

test("何月分の初期値: 月初着は前月分・25日以降はその月分・月中はベンダーの過去の行から", () => {
  assert.equal(p2GuessPeriod("2026-08-03", []), "2026-07");
  assert.equal(p2GuessPeriod("2026-07-31", []), "2026-07");
  assert.equal(p2GuessPeriod("2026-07-25", []), "2026-07");
  assert.equal(p2GuessPeriod("2026-01-05", []), "2025-12");
  assert.equal(p2GuessPeriod("2026-08-14", []), "2026-07");
  const rat = [{ periodMonth: "2026-07", date: "2026-07-22" }, { periodMonth: "2026-07", date: "2026-07-14" }];
  assert.equal(p2GuessPeriod("2026-08-18", rat), "2026-08");
  // 月初に出た行は月中の推定に使わない
  assert.equal(p2GuessPeriod("2026-08-18", [{ periodMonth: "2026-07", date: "2026-08-03" }]), "2026-07");
  assert.equal(p2GuessPeriod("", []), "");
});

test("想定到着日の提案: 支払月に届いた日の最大＋3日（前月着は0・遅れは数えない・2か月分未満は出さない）", () => {
  const s = [{ pay: "2026-07", received: "2026-07-02" }, { pay: "2026-08", received: "2026-08-04" }, { pay: "2026-09", received: "2026-08-31" }];
  assert.deepEqual(p2ArrivalDay(s, "2026-09"), { day: 7, days: [2, 4, 0] });
  assert.equal(p2ArrivalDay([{ pay: "2026-08", received: "2026-08-02" }], "2026-09"), null);
  const late = [{ pay: "2026-07", received: "2026-08-06" }, { pay: "2026-08", received: "2026-08-10" }, { pay: "2026-09", received: "2026-09-15" }];
  assert.deepEqual(p2ArrivalDay(late, "2026-09"), { day: 18, days: [10, 15] });
  assert.deepEqual(p2ArrivalDay([{ pay: "2026-08", received: "2026-08-27" }, { pay: "2026-09", received: "2026-09-28" }], "2026-09"), { day: 28, days: [27, 28] });
  // 先の支払月は数えない
  assert.equal(p2ArrivalDay([{ pay: "2026-09", received: "2026-09-02" }, { pay: "2026-10", received: "2026-10-01" }], "2026-09"), null);
});

test("スキップ: 月を足す・置き換える・外す／理由を引く", () => {
  let list = p2WithSkip([], "2026-08", "稼働なし");
  list = p2WithSkip(list, "2026-06", "停止・解約");
  assert.deepEqual(list.map(x => x.month), ["2026-06", "2026-08"]);
  list = p2WithSkip(list, "2026-08", "翌月にまとめて請求");
  assert.equal(p2SkipOf({ skipMonths: list }, "2026-08"), "翌月にまとめて請求");
  list = p2WithSkip(list, "2026-06", "");
  assert.deepEqual(list, [{ month: "2026-08", reason: "翌月にまとめて請求" }]);
  assert.equal(p2SkipOf({ skipMonths: list }, "2026-07"), "");
  assert.equal(p2SkipOf({}, "2026-07"), "");
  assert.equal(p2SkipOf({ skipMonths: [{ month: "2026-07", reason: "" }] }, "2026-07"), "スキップ");
});

test("期日の表示に曜日と土日の注記", () => {
  assert.equal(p2DueLabel("2026-07-31"), "7/31（金）");
  assert.equal(p2DueLabel("2026-10-31"), "10/31（土） ※銀行休業日");
});
