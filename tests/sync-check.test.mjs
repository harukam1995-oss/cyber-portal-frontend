/* Guards tests/helpers.mjs against drift from ../app.js.
 *
 * For every `export function NAME` in helpers.mjs, find `function NAME(` in
 * app.js, take the balanced-brace body, strip comments + whitespace on both
 * sides, and assert they match. If this test fails, app.js changed a helper
 * and the mirror in helpers.mjs was not updated (or vice versa). */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL(".", import.meta.url));
const appSrc = readFileSync(dir + "../app.js", "utf8");
const mirrorSrc = readFileSync(dir + "helpers.mjs", "utf8");
const htmlSrc = readFileSync(dir + "../index.html", "utf8");
const cssSrc = readFileSync(dir + "../style.css", "utf8");

// Brace-matching below is naive; functions containing regex literals confuse it.
// Excluded from the byte-compare — still covered behaviourally in helpers.test.mjs.
const UNCHECKED = new Set(["escapeHtml"]);

function extractFn(src, name){
  const decl = new RegExp("function\\s+" + name + "\\s*\\(", "g");
  const m = decl.exec(src);
  if (!m) return null;
  // walk from the first "(" to find the "{" that opens the body, then brace-match
  let i = src.indexOf("(", m.index);
  let depth = 0, bodyStart = -1;
  for (; i < src.length; i++){
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) { bodyStart = src.indexOf("{", i); break; } }
  }
  if (bodyStart === -1) return null;
  depth = 0;
  let inStr = null, prev = "";
  for (i = bodyStart; i < src.length; i++){
    const c = src[i];
    if (inStr){
      if (c === inStr && prev !== "\\") inStr = null;
    } else if (c === '"' || c === "'" || c === "`"){
      inStr = c;
    } else if (c === "{"){
      depth++;
    } else if (c === "}"){
      depth--;
      if (depth === 0) return src.slice(bodyStart, i + 1);
    }
    prev = c;
  }
  return null;
}

function normalize(body){
  return body
    .replace(/\/\*[\s\S]*?\*\//g, "")   // block comments
    .replace(/\/\/[^\n]*/g, "")          // line comments
    .replace(/\s+/g, " ")
    .trim();
}

const names = [...mirrorSrc.matchAll(/export function ([A-Za-z0-9_]+)\s*\(/g)]
  .map(m => m[1])
  .filter(n => !UNCHECKED.has(n));

test("mirror lists a non-trivial set of helpers", () => {
  assert.ok(names.length >= 14, `only found ${names.length} checkable helpers in helpers.mjs`);
});

for (const name of names){
  test(`helpers.mjs:${name} matches app.js`, () => {
    const inApp = extractFn(appSrc, name);
    const inMirror = extractFn(mirrorSrc, name);
    assert.ok(inApp, `function ${name}() not found in ../app.js — was it renamed or removed?`);
    assert.ok(inMirror, `function ${name}() not found in helpers.mjs`);
    assert.equal(
      normalize(inMirror),
      normalize(inApp),
      `function ${name}() has drifted between app.js and tests/helpers.mjs — reconcile them.`
    );
  });
}

/* ---- repo consistency: the B/amber cleanup left no decorative dead markup ---- */

test("index.html has no decorative dead DOM", () => {
  for (const dead of [
    'class="corner', 'class="scanlines"', 'class="vignette"',
    'class="scene-signage"', 'class="pv-hero-vtext"',
    'id="mail-tag"', 'id="home-inbox-tag"',
  ]){
    assert.ok(!htmlSrc.includes(dead), `dead markup still in index.html: ${dead}`);
  }
});

test("theme-color is the warm near-black, not the old purple", () => {
  assert.ok(!htmlSrc.includes('content="#0b0620"'), "stale purple theme-color in index.html");
  assert.match(htmlSrc, /name="theme-color" content="#07090c"/);
});

test("style.css has no rules for the removed decorative classes", () => {
  for (const dead of ['.scene-signage', '.scanlines', '.vignette', '.pv-hero-vtext', '.panel::before', '.placeholder-tag']){
    assert.ok(!cssSrc.includes(dead), `dead rule still in style.css: ${dead}`);
  }
  assert.ok(!/\.corner\b/.test(cssSrc), "dead .corner rule still in style.css");
});
