# tests

No build step; these run on Node's built-in test runner (Node 18+).

```
npm test                  # node --test "tests/**/*.test.mjs"（Node 24 ではディレクトリ指定不可なので glob）
SKIP_SMOKE=1 npm test     # skip the network-dependent smoke test
```

CI: `.github/workflows/test.yml` runs `SKIP_SMOKE=1 npm test` on every push to `main`
(run it manually from the Actions tab with `smoke` checked to also hit the deployed site).

## What's here

| file | what it checks | needs network |
|---|---|---|
| `helpers.test.mjs` | behaviour of the pure date / 収支 / サブスク helpers | no |
| `helpers.mjs` | **mirror** of those helpers copied from `../app.js` (see below) | — |
| `sync-check.test.mjs` | that `helpers.mjs` has not drifted from `../app.js`; no decorative dead DOM; manifest colors/shortcuts; routes ↔ `#view-*`; on-demand modules exist | no |
| `guards.test.mjs` | `getElementById("…")` literals exist; `BUILD_V` = sw `CACHE`; SW `SHELL`/`CORE` files exist; design-policy CSS counts only go down (ratchet) | no |
| `smoke.test.mjs` | the deployed site serves a well-formed shell, all SW shell assets and on-demand modules resolve, deployed `BUILD_V` = `CACHE` | **yes** (hits `harukam1995-oss.github.io`) |

## The mirror, and why

`app.js` is a single ~8,000-line IIFE with no `export`s, so its helpers can't be
imported. `helpers.mjs` holds verbatim copies of the small side-effect-free ones.
`sync-check.test.mjs` re-extracts each function from `app.js` by name and fails
if the logic diverges — so a change in `app.js` that isn't mirrored breaks CI.

When `app.js` is split into ES modules (see
`02_プライベート/ポータルサイト/ポータルサイト_app.js分割計画.md` in the vault),
delete `helpers.mjs` + `sync-check.test.mjs` and point `helpers.test.mjs` at the
real module.

## Not covered

Anything behind Google sign-in. The portal only does Google OAuth (Firebase
anonymous auth is disabled), so there is no way to mint a session token from a
test. Authenticated flows still need manual verification in a browser.
