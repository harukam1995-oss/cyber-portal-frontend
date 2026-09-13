/* Smoke test against the DEPLOYED site. Catches "shipped broken shell":
 * HTML that no longer parses to the expected structure, a 404 on a shell
 * asset, a stale service-worker version, etc.
 *
 * Network-dependent. Set SMOKE_BASE to test a different origin, or
 * SKIP_SMOKE=1 to skip (e.g. offline). */
import test from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.SMOKE_BASE || "https://harukam1995-oss.github.io/cyber-portal-frontend/";
const skip = process.env.SKIP_SMOKE === "1";

async function get(path){
  const url = new URL(path, BASE).href;
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15000) });
  const body = await res.text();
  return { res, body, url };
}

test("index.html loads and has the auth gate + app shell", { skip }, async () => {
  const { res, body } = await get("./");
  assert.equal(res.status, 200);
  assert.match(body, /<div id="auth-gate"/, "auth gate missing");
  assert.match(body, /id="auth-gate-signin-btn"/, "sign-in button missing");
  assert.match(body, /<div class="frame" id="view-home">/, "home view missing");
  assert.match(body, /<script src="app\.js">/, "app.js not linked");
  assert.match(body, /<script type="module" src="auth\.js">/, "auth.js not linked");
});

test("shell assets referenced by the service worker all resolve", { skip }, async () => {
  const { body: sw } = await get("./sw.js");
  const m = sw.match(/const SHELL = \[([\s\S]*?)\]/);
  assert.ok(m, "SHELL array not found in sw.js");
  const paths = [...m[1].matchAll(/"([^"]+)"/g)].map(x => x[1]);
  assert.ok(paths.length >= 5);
  for (const p of paths){
    const { res, url } = await get(p);
    assert.equal(res.status, 200, `shell asset ${url} returned ${res.status}`);
  }
});

test("deployed sw CACHE, app.js BUILD_V and footer are all present and in sync", { skip }, async () => {
  const { body: sw } = await get("./sw.js");
  const { body: html } = await get("./");
  const { body: app } = await get("./app.js?cb=" + Date.now());
  const cache = sw.match(/cyber-portal-shell-v(\d+)/);
  const footer = html.match(/<span>v(\d+\.\d+\.\d+)<\/span>/);
  const build = app.match(/var BUILD_V = (\d+);/);
  assert.ok(cache && footer && build, "could not read all version markers");
  // bump.mjs が同じ番号にそろえる。ズレるとオンデマンドモジュールの ?v= が変わらず古い版が配信される。
  assert.equal(build[1], cache[1], "BUILD_V in deployed app.js differs from sw.js CACHE");
});

test("on-demand modules resolve on the deployed site", { skip }, async () => {
  const { body: app } = await get("./app.js?cb=" + Date.now());
  const files = [...app.matchAll(/loadModuleOnce\("([^"]+)", "[^"]+"\)/g)].map(m => m[1]);
  assert.ok(files.length >= 3);
  for (const f of files){
    const { res, url } = await get("./" + f);
    assert.equal(res.status, 200, `module ${url} returned ${res.status}`);
  }
});
