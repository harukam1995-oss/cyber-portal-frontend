/* 安価な静的ガード（ネットワーク不要）。
 *
 * - JS が getElementById("固定の id") で参照する要素が index.html（または JS 自身が
 *   組み立てる HTML）に実在する。id の改名・削除で null を掴んで初期化が止まる事故を防ぐ。
 * - bump.mjs の儀式がそろっている（app.js の BUILD_V = sw.js の CACHE 番号）。
 * - sw.js の SHELL / CORE に書いたファイルがリポジトリにある。
 * - デザイン方針（B/アンバー: 発光・グラデ・ぼかし・大きい角丸を使わない）に反する CSS の
 *   件数が増えていない（ラチェット。減らしたら上限もその数まで下げる）。 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("..", import.meta.url));
const read = (f) => readFileSync(dir + f, "utf8");

const html = read("index.html");
const JS_FILES = ["app.js", "app.business.js", "app.payables.js", "app.jimuhack.js", "app.smallbiz.js", "auth.js"];
const jsSrc = JS_FILES.filter((f) => existsSync(dir + f)).map(read).join("\n");
const sw = read("sw.js");
const app = read("app.js");

test("getElementById literals point at ids that exist", () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  // JS が文字列で組み立てる HTML（'<div id="x">'）と el.id = "x" も実在扱い
  for (const m of jsSrc.matchAll(/\bid=\\?["']([\w-]+)\\?["']/g)) ids.add(m[1]);
  for (const m of jsSrc.matchAll(/\.id\s*=\s*["']([\w-]+)["']/g)) ids.add(m[1]);
  const refs = new Set([...jsSrc.matchAll(/getElementById\(\s*["']([\w-]+)["']\s*\)/g)].map((m) => m[1]));
  assert.ok(refs.size > 300, `expected many getElementById literals, found ${refs.size}`);
  const missing = [...refs].filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], `getElementById refers to ids that exist nowhere: ${missing.join(", ")}`);
});

test("app.js BUILD_V matches sw.js CACHE (bump.mjs ritual)", () => {
  const cache = (sw.match(/cyber-portal-shell-v(\d+)/) || [])[1];
  const build = (app.match(/var BUILD_V = (\d+);/) || [])[1];
  assert.ok(cache && build, "could not find CACHE / BUILD_V");
  assert.equal(build, cache, "run `node bump.mjs` — BUILD_V and CACHE drifted");
});

test("sw.js SHELL and CORE files exist, and CORE is inside SHELL", () => {
  const list = (name) => {
    const m = sw.match(new RegExp("const " + name + " = \\[([\\s\\S]*?)\\]"));
    assert.ok(m, `${name} not found in sw.js`);
    return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  };
  const shell = list("SHELL");
  const core = list("CORE");
  for (const p of shell) {
    if (p === "./") continue;
    assert.ok(existsSync(dir + p.replace(/^\.\//, "")), `SHELL entry ${p} is missing from the repo`);
  }
  for (const p of core) assert.ok(shell.includes(p), `CORE entry ${p} is not in SHELL`);
});

/* ---- デザイン方針のラチェット ----
   現状の件数を上限にしている。CSS 整理で減らしたら、ここの数字も下げてコミットする
   （増やす変更はテストが落ちる＝方針に戻す）。コメント内の記述は数えない。 */
const CSS_LIMITS = {
  "!important": 79,
  "gradient(": 11,
  "backdrop-filter (not none)": 2,
  "text-shadow (not none)": 2,
  "box-shadow 0 0 Npx (glow)": 9,
  "drop-shadow(": 1,
  "Orbitron / Rajdhani": 0,
  "border-radius > 3px": 101,
};

test("design-policy CSS counts do not grow (ratchet)", () => {
  const css = read("style.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const count = (re) => (css.match(re) || []).length;
  const actual = {
    "!important": count(/!important/g),
    "gradient(": count(/gradient\(/g),
    "backdrop-filter (not none)": count(/backdrop-filter\s*:\s*(?!none)/g),
    "text-shadow (not none)": count(/text-shadow\s*:\s*(?!none)/g),
    "box-shadow 0 0 Npx (glow)": count(/box-shadow\s*:\s*0\s+0\s+\d+px/g),
    "drop-shadow(": count(/drop-shadow\(/g),
    "Orbitron / Rajdhani": count(/Orbitron|Rajdhani/g),
    "border-radius > 3px": [...css.matchAll(/border-radius\s*:\s*([^;}]+)/g)]
      .filter((m) => (m[1].match(/\d+(?:\.\d+)?px/g) || []).some((v) => parseFloat(v) > 3)).length,
  };
  for (const [k, limit] of Object.entries(CSS_LIMITS)) {
    assert.ok(actual[k] <= limit, `style.css: ${k} = ${actual[k]} (limit ${limit}). デザイン方針に反する指定が増えています。`);
  }
});
