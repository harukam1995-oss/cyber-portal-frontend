// デプロイ前のバージョン上げを1コマンドに。GitHub Web UI アップロード運用でも、
// 手元でこれを実行してから該当ファイルを上げれば sw.js と index.html のズレが無くなる。
//
//   node bump.mjs            … sw.js の CACHE を +1、index.html フッターを patch +1
//   node bump.mjs minor      … フッターを minor +1 (patch=0)、CACHE も +1
//   node bump.mjs 23 2.21.0  … 明示指定
import { readFileSync, writeFileSync } from "node:fs";

const sw = readFileSync("sw.js", "utf8");
const html = readFileSync("index.html", "utf8");

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

writeFileSync("sw.js", sw.replace(/cyber-portal-shell-v\d+/, `cyber-portal-shell-v${nextCache}`));
writeFileSync("index.html", html.replace(/<span>v\d+\.\d+\.\d+<\/span>/, `<span>v${nextVer}</span>`));
console.log(`sw CACHE  v${curCache} -> v${nextCache}`);
console.log(`footer    v${curVer} -> v${nextVer}`);
console.log("→ 変更した index.html / sw.js（と app.js/style.css 等）をアップロードしてください。");
