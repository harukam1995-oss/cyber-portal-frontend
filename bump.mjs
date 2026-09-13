// デプロイ前のバージョン上げを1コマンドに(sw.js の CACHE / app.js の BUILD_V / index.html フッター)。
//
//   node bump.mjs            … sw.js の CACHE を +1、index.html フッターを patch +1
//   node bump.mjs minor      … フッターを minor +1 (patch=0)、CACHE も +1
//   node bump.mjs 23 2.21.0  … 明示指定
// どのディレクトリから実行してもリポジトリ直下のファイルを触る。
import { readFileSync, writeFileSync } from "node:fs";

const at = (f) => new URL(f, import.meta.url);
const sw = readFileSync(at("sw.js"), "utf8");
const html = readFileSync(at("index.html"), "utf8");
const app = readFileSync(at("app.js"), "utf8");

const curCache = Number((sw.match(/cyber-portal-shell-v(\d+)/) || [])[1]);
const curVer = (html.match(/<span>v(\d+\.\d+\.\d+)<\/span>/) || [])[1];
if (!curCache || !curVer) {
  console.error("現在のバージョンを検出できませんでした。sw.js / index.html を確認してください。");
  process.exit(1);
}

const [a2, a3] = process.argv.slice(2);
let nextCache = curCache + 1;
let nextVer;
if (a2 && /^\d+$/.test(a2) && a3 && /^\d+\.\d+\.\d+$/.test(a3)) {
  nextCache = Number(a2);
  nextVer = a3;
} else {
  const [maj, min, pat] = curVer.split(".").map(Number);
  nextVer = a2 === "minor" ? `${maj}.${min + 1}.0` : a2 === "major" ? `${maj + 1}.0.0` : `${maj}.${min}.${pat + 1}`;
}

// BUILD_V も sw CACHE と同じ番号に揃える(オンデマンドモジュール app.*.js の読み込みに ?v= を
// 付けて、CDN/ブラウザキャッシュの max-age=600 を毎回突破する)。
// 置換が1件も当たらなかったら書き込まずに止める(以前は BUILD_V だけ黙って古いまま残り得た)。
const BUILD_V_RE = /var BUILD_V = \d+;/;
if (!BUILD_V_RE.test(app)) {
  console.error("app.js に `var BUILD_V = N;` が見つかりません。何も書き込まずに中止しました。");
  process.exit(1);
}
writeFileSync(at("sw.js"), sw.replace(/cyber-portal-shell-v\d+/, `cyber-portal-shell-v${nextCache}`));
writeFileSync(at("index.html"), html.replace(/<span>v\d+\.\d+\.\d+<\/span>/, `<span>v${nextVer}</span>`));
writeFileSync(at("app.js"), app.replace(BUILD_V_RE, `var BUILD_V = ${nextCache};`));
console.log(`sw CACHE  v${curCache} -> v${nextCache}`);
console.log(`footer    v${curVer} -> v${nextVer}`);
console.log(`BUILD_V   -> ${nextCache}（app.js）`);
console.log("→ 変更したファイルを名指しで git add して commit / push してください。");
