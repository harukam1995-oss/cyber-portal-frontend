/* 請求書管理のベンダー判定（app.payables.js の p2VendorByName / p2VendorByEmail）を実物から切り出して試す。
 * 2026/09/15: 永山さんの請求書が misoca（請求書サービスの共用送信元）経由で、そのアドレスを登録していた
 * 早河さんと判定され、早河さんの口座が入っていた。名前優先・共用送信元は使わない、を確かめる。 */
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
  const oneLine = src.indexOf("\n", start + 1);
  // 1行で閉じる関数（function f(){ ... }）はその行だけ
  return /\}\s*$/.test(src.slice(start, oneLine)) && src.slice(start, oneLine).split("{").length === src.slice(start, oneLine).split("}").length
    ? src.slice(start, oneLine + 1) : src.slice(start, end + 4);
}
const varLine = src.match(/\n  var P2_SHARED_SENDER_DOMAINS = [^\n]+/);
assert.ok(varLine, "P2_SHARED_SENDER_DOMAINS が見つからない");

const make = (vendors) => new Function(
  "var p2 = { vendors: " + JSON.stringify(vendors) + " };" + varLine[0] +
  cut("p2EmailKey") + cut("p2VendorEmails") + cut("p2IsSharedSender") + cut("p2VendorByEmail") + cut("p2NameKey") + cut("p2VendorByName") +
  "\nreturn { p2VendorByEmail, p2VendorByName, p2IsSharedSender };"
)();

const V = [
  { id: "haya", name: "早河 優", emails: "noreply@misoca.jp, yu@hayakawa.example" },
  { id: "naga", name: "永山 真理子", emails: "mariko@example.com", aliases: "ながやま, Nagayama" },
  { id: "we", name: "ウィ・コネクト合同会社", emails: "" },
];

test("共用送信元（misoca など）はベンダー判定に使わない", () => {
  const f = make(V);
  assert.equal(f.p2VendorByEmail("Misoca <noreply@misoca.jp>"), null);
  assert.equal(f.p2IsSharedSender("no-reply@bill-one.com"), true);
  assert.equal(f.p2IsSharedSender("x@mail.moneyforward.com"), true);
  assert.equal(f.p2IsSharedSender("yu@hayakawa.example"), false);
  assert.equal(f.p2VendorByEmail("YU@hayakawa.example").id, "haya");
});

test("名前は空白・全角半角の違いを無視し、別名にも当たる", () => {
  const f = make(V);
  assert.equal(f.p2VendorByName("永山真理子").id, "naga");
  assert.equal(f.p2VendorByName(" 永山　真理子 ").id, "naga");
  assert.equal(f.p2VendorByName("nagayama").id, "naga");
  assert.equal(f.p2VendorByName("ウィ・コネクト合同会社").id, "we");
  assert.equal(f.p2VendorByName(""), null);
  assert.equal(f.p2VendorByName("存在しない"), null);
});
