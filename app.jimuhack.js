/* ================= 事務ハック（ブログ）ダッシュボード — app.jimuhack.js =================
   旧ローカル HTML（jimhack-dashboard_26）をポータルへ移したもの。#view-jimuhack を初回に開いたとき
   app.js の loadModuleOnce() が <script> で注入する（index.html にも sw.js の SHELL にも入れない）。

   データの置き場所
   ・GA4 CSV（ページ別 / 検索クエリ）と、目標・収益・ネタ帳・記事メモ等の state … /api/jimuhack（Firestore）
   ・記事一覧 … WordPress の公開 REST API をブラウザから直接読む（CORS 可。10分 localStorage キャッシュ）
   ・計画 … ポータルのタスク（自由タグ「事務ハック」）。__CP 経由で本体の tasksState を読み書きする
     （PUT /api/tasks/bulk は全置換なので、ここで別に POST すると本体の保存で消える。必ず本体経由）

   旧版からの主な変更
   ・保存が window.storage（claude.ai の Artifact 専用 API）で、ローカルで開くと何も残っていなかった → Firestore
   ・記事数「55」や「April 2026」などの固定値 → WordPress と取り込んだ CSV から毎回計算
   ・8色の折れ線 → 表＋推移スパークライン（B/アンバー方針＝アクセント1色＋意味色）
   ・数字を眺めるだけ → 「やること」を自動で出し、クエリ・記事からそのままタスク化できる */
(function(){
  "use strict";

  var CP = window.__CP;
  var escapeHtml = CP.escapeHtml;
  var apiFetch = CP.apiFetch;
  var apiErrorMessage = CP.apiErrorMessage;
  var jstDateKey = CP.jstDateKey;
  var askConfirm = CP.askConfirm;
  var fmtSavedAt = CP.fmtSavedAt;
  var uid = CP.uid;

  var SITE = "https://jim-hack.raindrop.jp";
  var WP_API = SITE + "/wp-json/wp/v2";
  var POSTS_CACHE_KEY = "cp_jh_posts_v1";
  var POSTS_TTL = 10 * 60 * 1000;
  var SERVICE_PATH = "/online-support";
  var PLAN_TAG = "事務ハック";
  var TASK_TYPES = ["新規記事", "リライト", "改善", "収益化"];
  var REVENUE_TYPES = ["AdSense", "Amazonアソシエイト", "オンライン事務", "その他"];
  var STATUS_DEFS = [
    { key: "adsense", label: "AdSense", options: ["未申請", "審査中", "要対策", "合格"] },
    { key: "amazon", label: "Amazonアソシエイト", options: ["未申請", "仮登録中", "本審査中", "要対策", "合格"] }
  ];
  // クエリのテーマ分類（旧版のグループ化をそのまま。上から順に最初に当たったテーマへ入れる）
  var THEMES = [
    { label: "署名", keys: ["署名", "区切り線"] },
    { label: "社内メール", keys: ["社内メール", "社内 メール", "他部署"] },
    { label: "謝罪・お詫び", keys: ["謝罪", "お詫び", "遅刻", "申し訳"] },
    { label: "返信・催促", keys: ["返信", "催促", "督促"] },
    { label: "添付ファイル", keys: ["添付", "開けない"] },
    { label: "メール全般", keys: ["メール", "件名", "cc", "bcc"] },
    { label: "Excel", keys: ["エクセル", "excel", "ショートカット", "vlookup", "関数"] },
    { label: "単語登録・定型文", keys: ["定型文", "単語登録", "辞書登録"] },
    { label: "フォルダ整理", keys: ["フォルダ", "階層", "ファイル名"] },
    { label: "電話応対", keys: ["電話"] },
    { label: "メモ・会議", keys: ["メモ", "5w1h", "会議", "議事録"] },
    { label: "マニュアル", keys: ["マニュアル", "引き継ぎ", "引継ぎ"] }
  ];

  function defaultState(){
    return {
      goals: { pv: 4000, clicks: 0, posts: 4, revenue: 0 },
      // 実績ノート（2026/03 末時点）の事実から。以後は画面で更新する。
      status: {
        adsense: { status: "要対策", date: "2026-04-03", note: "3回目の却下" },
        amazon: { status: "未申請", date: "", note: "" }
      },
      revenue: [],
      ideas: [],
      articleMeta: {},
      changes: [],
      // CSV が無い月だけ使う手入力 PV（旧版の PV 推移タブの値）
      manualPV: { "2026-02": 2200 }
    };
  }

  var S = {
    loaded: false,
    loadErr: null,
    state: defaultState(),
    pages: {},
    queries: {},
    landing: {},   // GA4「Google オーガニック検索レポート: ランディング ページ」CSV（ページ別の検索クリック・表示・順位）
    ranges: { pages: {}, queries: {}, landing: {} },
    dataVer: 0,
    posts: null,
    postsAt: 0,
    postsErr: null,
    postsLoading: false,
    importLog: null,
    tab: "overview",
    goalEdit: false,
    q: { month: "all", filter: "all", search: "", sort: "i", dir: -1, open: null, limit: 200 },
    p: { month: "", articlesOnly: true, sort: "pv", dir: -1, limit: 200, open: null },
    a: { filter: "all", search: "", sort: "date", dir: -1, open: null },
    planShowDone: false
  };

  /* ---------------- 小物 ---------------- */
  function $(id){ return document.getElementById(id); }
  function esc(s){ return escapeHtml(s == null ? "" : String(s)); }
  function fmtN(n){ return (n == null || isNaN(n)) ? "—" : Math.round(n).toLocaleString("ja-JP"); }
  function fmtK(n){
    if (n == null || isNaN(n)) return "";
    return n >= 10000 ? Math.round(n / 1000) + "k" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(Math.round(n));
  }
  function fmtYen(n){ return "¥" + fmtN(n || 0); }
  function fmtPct(n, d){ return (n == null || isNaN(n)) ? "—" : n.toFixed(d == null ? 1 : d) + "%"; }
  function monthLabel(m){ return m ? m.slice(0, 4) + "/" + m.slice(5, 7) : "—"; }
  function shortMonth(m){ return m.slice(2, 4) + "/" + m.slice(5, 7); }
  function todayKey(){ return jstDateKey(new Date()); }
  function curMonth(){ return todayKey().slice(0, 7); }
  function addMonths(m, d){
    var y = +m.slice(0, 4), mo = +m.slice(5, 7) - 1 + d;
    y += Math.floor(mo / 12);
    mo = ((mo % 12) + 12) % 12;
    return y + "-" + String(mo + 1).padStart(2, "0");
  }
  function daysBetween(a, b){
    if (!a || !b) return null;
    return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
  }
  function mdShort(key){ return key ? (+key.slice(5, 7)) + "/" + (+key.slice(8, 10)) : ""; }
  function latest(obj){ var ms = Object.keys(obj || {}).sort(); return ms.length ? ms[ms.length - 1] : null; }
  function sum(arr, f){ var s = 0; for (var i = 0; i < arr.length; i++) s += f(arr[i]) || 0; return s; }
  function setStatus(msg, cls){
    var el = $("jh-status");
    if (!el) return;
    el.textContent = msg || "";
    el.className = "cal-status-chip" + (cls ? " " + cls : "");
  }

  /* ---------------- 集計 ---------------- */
  function pagesTotal(m){ var rows = S.pages[m]; return rows ? sum(rows, function(r){ return r.pv; }) : null; }
  function monthPV(m){
    var t = pagesTotal(m);
    if (t != null) return { v: t, manual: false };
    var mv = (S.state.manualPV || {})[m];
    return mv != null && mv !== "" ? { v: +mv, manual: true } : null;
  }
  function qStats(m){
    var rows = S.queries[m];
    if (!rows) return null;
    var c = 0, i = 0, pw = 0;
    rows.forEach(function(r){ c += r.c; i += r.i; pw += r.p * r.i; });
    return { c: c, i: i, ctr: i ? c / i * 100 : 0, pos: i ? pw / i : 0, n: rows.length };
  }
  // ランディングページ CSV の月合計。クエリの匿名化で消える分も入るので、検索クリックの総数はこちらが正確
  // （例: 2026/06 はクエリ CSV の合計 313 に対しランディングページ合計 1,064）。
  function landingStats(m){
    var rows = S.landing[m];
    if (!rows) return null;
    var c = 0, i = 0, pw = 0;
    rows.forEach(function(r){ c += r.c; i += r.i; pw += r.p * r.i; });
    return { c: c, i: i, ctr: i ? c / i * 100 : 0, pos: i ? pw / i : 0, n: rows.length, src: "landing" };
  }
  function searchStats(m){ return landingStats(m) || qStats(m); }
  function latestSearchMonth(){ return [latest(S.landing), latest(S.queries)].filter(Boolean).sort().pop() || null; }
  function searchPartialEnd(m){ return S.landing[m] ? partialEnd("landing", m) : partialEnd("queries", m); }

  function allMonths(){
    var set = {};
    [S.pages, S.queries, S.landing, S.state.manualPV || {}].forEach(function(o){ Object.keys(o).forEach(function(m){ set[m] = 1; }); });
    return Object.keys(set).sort();
  }
  // CSV の終了日が月末より前（例: 4/29 にエクスポート）なら途中までのデータ
  function partialEnd(kind, m){
    var r = S.ranges[kind] && S.ranges[kind][m];
    if (!r || !r.end) return null;
    var last = new Date(+m.slice(0, 4), +m.slice(5, 7), 0).getDate();
    return +r.end.slice(8, 10) < last ? +r.end.slice(8, 10) : null;
  }
  function isChance(r){ return r.p > 0 && r.p <= 10 && r.c === 0 && r.i >= 20; }
  function isLowCtr(r){ return r.i >= 100 && r.t < 1; }
  function articles(){ return (S.posts || []).filter(function(p){ return !p.notice; }); }
  function postByPath(path){
    var list = S.posts || [];
    for (var i = 0; i < list.length; i++) if (list[i].path === path) return list[i];
    return null;
  }
  function revenueIn(prefix){
    return sum(S.state.revenue.filter(function(r){ return String(r.date || "").indexOf(prefix) === 0; }), function(r){ return +r.amount; });
  }

  /* ---------------- 読み込み・保存（/api/jimuhack） ---------------- */
  function mergeState(saved){
    var d = defaultState();
    if (!saved) return d;
    Object.keys(d).forEach(function(k){ if (saved[k] != null) d[k] = saved[k]; });
    d.goals = Object.assign(defaultState().goals, saved.goals || {});
    d.status = Object.assign(defaultState().status, saved.status || {});
    return d;
  }

  async function loadData(){
    setStatus("読み込み中…");
    try {
      var res = await apiFetch("/api/jimuhack");
      S.pages = res.pages || {};
      S.queries = res.queries || {};
      S.landing = res.landing || {};
      S.ranges = Object.assign({ pages: {}, queries: {}, landing: {} }, res.ranges || {});
      S.state = mergeState(res.state);
      S.loaded = true;
      S.loadErr = null;
      S.dataVer++;
      setStatus(res.state && res.state.updatedAt ? "保存済み ・ " + fmtSavedAt(res.state.updatedAt) : "ポータルに保存");
    } catch (err){
      S.loadErr = apiErrorMessage(err, "事務ハック");
      setStatus(S.loadErr, "err");
    }
    if (S.loaded) await repairMisfiledLanding();
    render();
  }

  var saveTimer = null;
  // 読み込みに失敗したまま保存すると既定値で上書きしてしまうので、成功するまでは保存しない。
  function saveState(){
    if (!S.loaded){ setStatus("読み込みに失敗しているため保存しません。開き直してください。", "err"); return; }
    setStatus("保存中…");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async function(){
      try {
        var r = await apiFetch("/api/jimuhack/state", { method: "PUT", body: JSON.stringify({ state: S.state }) });
        setStatus("保存済み ・ " + fmtSavedAt((r && r.updatedAt) || Date.now()));
      } catch (err){
        setStatus(apiErrorMessage(err, "保存"), "err");
      }
    }, 500);
  }

  /* ---------------- WordPress の記事一覧 ---------------- */
  function decodeEntities(s){
    var t = document.createElement("textarea");
    t.innerHTML = s || "";
    return t.value;
  }
  function summarizePost(p, cats){
    var doc = new DOMParser().parseFromString((p.content && p.content.rendered) || "", "text/html");
    var text = (doc.body.textContent || "").replace(/\s+/g, "");
    var hrefs = Array.prototype.map.call(doc.querySelectorAll("a[href]"), function(a){ return a.getAttribute("href") || ""; });
    var catNames = (p.categories || []).map(function(id){ return cats[id]; }).filter(Boolean);
    var path = "/";
    try { path = decodeURIComponent(new URL(p.link).pathname); } catch (e){}
    return {
      id: p.id,
      slug: decodeURIComponent(p.slug || ""),
      path: path,
      link: String(p.link || "").indexOf(SITE) === 0 ? p.link : SITE + path,
      title: decodeEntities(p.title && p.title.rendered),
      date: String(p.date || "").slice(0, 10),
      modified: String(p.modified || "").slice(0, 10),
      cat: catNames.join(" / "),
      notice: catNames.indexOf("お知らせ") !== -1,
      chars: text.length,
      imgs: doc.querySelectorAll("img").length,
      h2: doc.querySelectorAll("h2").length,
      internal: hrefs.filter(function(h){ return h.indexOf(SITE) === 0 || h.charAt(0) === "/"; }).length,
      cta: hrefs.some(function(h){ return h.indexOf(SERVICE_PATH) !== -1; })
    };
  }

  async function loadPosts(force){
    if (S.postsLoading) return;
    if (!force && S.posts && Date.now() - S.postsAt < POSTS_TTL) return;
    if (!force && !S.posts){
      try {
        var cached = JSON.parse(localStorage.getItem(POSTS_CACHE_KEY) || "null");
        if (cached && cached.posts){
          S.posts = cached.posts;
          S.postsAt = cached.at;
          if (Date.now() - cached.at < POSTS_TTL){ render(); return; }
        }
      } catch (e){}
    }
    S.postsLoading = true;
    try {
      var catRes = await fetch(WP_API + "/categories?per_page=100&_fields=id,name");
      if (!catRes.ok) throw new Error("カテゴリ " + catRes.status);
      var cats = {};
      (await catRes.json()).forEach(function(c){ cats[c.id] = decodeEntities(c.name); });
      var all = [], page = 1, totalPages = 1;
      do {
        var r = await fetch(WP_API + "/posts?per_page=100&page=" + page + "&_fields=id,slug,date,modified,title,link,categories,content");
        if (!r.ok) throw new Error("記事 " + r.status);
        totalPages = Number(r.headers.get("X-WP-TotalPages")) || 1;
        all = all.concat(await r.json());
        page++;
      } while (page <= totalPages && page <= 10);
      S.posts = all.map(function(p){ return summarizePost(p, cats); });
      S.postsAt = Date.now();
      S.postsErr = null;
      try { localStorage.setItem(POSTS_CACHE_KEY, JSON.stringify({ at: S.postsAt, posts: S.posts })); } catch (e){}
    } catch (err){
      S.postsErr = "WordPress から記事一覧を取得できませんでした（" + (err && err.message) + "）";
    }
    S.postsLoading = false;
    render();
  }

  /* ---------------- GA4 CSV の取り込み ---------------- */
  function splitCsvLine(line){
    var cells = [], cell = "", inQ = false;
    for (var i = 0; i < line.length; i++){
      var ch = line[i];
      if (inQ){
        if (ch === '"' && line[i + 1] === '"'){ cell += '"'; i++; }
        else if (ch === '"') inQ = false;
        else cell += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ","){ cells.push(cell); cell = ""; }
      else cell += ch;
    }
    cells.push(cell);
    return cells.map(function(c){ return c.trim(); });
  }
  function decodeCsvBuffer(buf){
    var b = new Uint8Array(buf);
    if (b[0] === 0xFF && b[1] === 0xFE) return new TextDecoder("utf-16le").decode(buf);
    if (b[0] === 0xFE && b[1] === 0xFF) return new TextDecoder("utf-16be").decode(buf);
    return new TextDecoder("utf-8").decode(buf).replace(/^FEFF/, "");
  }
  function ctrPct(v){
    var s = String(v == null ? "" : v);
    var n = parseFloat(s.replace("%", ""));
    if (!isFinite(n)) return 0;
    return Math.round((s.indexOf("%") !== -1 || n > 1 ? n : n * 100) * 100) / 100;
  }
  // GA4 の「ページとスクリーン」「Google のオーガニック検索クエリ」エクスポート（先頭の # 行に開始日/終了日）。
  // 年月はコメントの開始日 → 無ければファイル名の YYYYMM / YYYY-MM から取る。
  function parseGa4Csv(text, filename){
    var lines = text.replace(/\r/g, "").split("\n");
    var comments = lines.filter(function(l){ return l.trim().charAt(0) === "#"; }).join("\n");
    var data = lines.filter(function(l){ return l.trim() && l.trim().charAt(0) !== "#"; });
    // 見出し行だけ（GA4 はデータの無い月もこの形で出す）は失敗ではなくスキップ扱い
    if (data.length < 2) return { empty: true };
    var hdr = splitCsvLine(data[0]);
    var sm = comments.match(/開始日:\s*(\d{4})(\d{2})(\d{2})/);
    var em = comments.match(/終了日:\s*(\d{4})(\d{2})(\d{2})/);
    var month = sm ? sm[1] + "-" + sm[2] : null;
    if (!month){
      var fm = String(filename || "").match(/(20\d{2})[-_]?(0[1-9]|1[0-2])(?!\d)/);
      if (fm) month = fm[1] + "-" + fm[2];
    }
    if (!month) return { error: "年月が分かりません（CSV の開始日かファイル名に YYYYMM が必要）" };
    var range = { start: sm ? sm[1] + "-" + sm[2] + "-" + sm[3] : "", end: em ? em[1] + "-" + em[2] + "-" + em[3] : "" };
    var col = function(re, fallback){
      for (var i = 1; i < hdr.length; i++) if (re.test(hdr[i])) return i;
      return fallback;
    };
    var rows = data.slice(1).map(splitCsvLine);
    // 「ランディング ページ + クエリ文字列」は見出しに「クエリ」も「ページ」も含むので、必ず先に判定する
    // （v2.33.52 まではここが無く、検索クエリとして保存してしまっていた）。
    // ?nstoken= などクエリ文字列付きの URL は同じページに合算し、(not set) や空の行は捨てる。
    if (/ランディング|landing/i.test(hdr[0])){
      var lc = col(/クリック数|clicks/i, 1), li = col(/表示回数|impressions/i, 2), lp = col(/掲載順位|position/i, 4);
      var lu = col(/^(アクティブ ユーザー|active users)$/i, 5), ls = col(/平均エンゲージメント時間|engagement time/i, 8);
      var agg = {};
      rows.forEach(function(r){
        var page = String(r[0] || "").split("?")[0].split("#")[0];
        if (page.charAt(0) !== "/") return;
        var a = agg[page] || (agg[page] = { page: page, c: 0, i: 0, pw: 0, users: 0, sw: 0 });
        var c = +r[lc] || 0, im = +r[li] || 0, u = +r[lu] || 0;
        a.c += c;
        a.i += im;
        a.pw += (+r[lp] || 0) * im;
        a.users += u;
        a.sw += (+r[ls] || 0) * u;
      });
      return {
        kind: "landing", month: month, range: range,
        rows: Object.keys(agg).map(function(k){
          var a = agg[k];
          return {
            page: a.page, c: a.c, i: a.i,
            t: a.i ? Math.round(a.c / a.i * 10000) / 100 : 0,
            p: a.i ? Math.round(a.pw / a.i * 100) / 100 : 0,
            users: a.users, sec: a.users ? Math.round(a.sw / a.users * 10) / 10 : 0
          };
        }).filter(function(r){ return r.c > 0 || r.i > 0; }).sort(function(x, y){ return y.c - x.c || y.i - x.i; })
      };
    }
    if (/クエリ|query/i.test(hdr[0])){
      var ci = col(/クリック数|clicks/i, 1), ii = col(/表示回数|impressions/i, 2), ti = col(/クリック率|ctr/i, 3), pi = col(/掲載順位|position/i, 4);
      return {
        kind: "queries", month: month, range: range,
        rows: rows.map(function(r){
          return { q: r[0] || "", c: +r[ci] || 0, i: +r[ii] || 0, t: ctrPct(r[ti]), p: Math.round((+r[pi] || 0) * 100) / 100 };
        }).filter(function(r){ return r.q; })
      };
    }
    if (/ページ|page/i.test(hdr[0]) || (rows[0] && String(rows[0][0]).charAt(0) === "/")){
      var vi = col(/^(表示回数|views)$/i, 1), ui = col(/^(アクティブ ユーザー|active users)$/i, 2), si = col(/平均エンゲージメント時間|engagement time/i, 4);
      return {
        kind: "pages", month: month, range: range,
        rows: rows.map(function(r){
          return { page: r[0] || "", pv: +r[vi] || 0, users: +r[ui] || 0, sec: Math.round((+r[si] || 0) * 10) / 10 };
        }).filter(function(r){ return r.page.charAt(0) === "/" && r.pv > 0; })
      };
    }
    return { error: "対応していない CSV です（ページとスクリーン / オーガニック検索クエリのみ）" };
  }

  // v2.33.52 までは「ランディング ページ + クエリ文字列」CSV を見出しの「クエリ」で検索クエリと誤判定して保存していた。
  // 行がすべて "/" で始まる検索クエリの月はそれとみなし、ランディングページの月へ移す（同じ月が既にあれば消すだけ）。
  // 1回のロードで1度だけ。移した後は本物の検索クエリ CSV を取り込み直してもらう。
  var repairDone = false;
  async function repairMisfiledLanding(){
    if (repairDone) return;
    repairDone = true;
    var bad = Object.keys(S.queries).filter(function(m){
      var rows = S.queries[m] || [];
      return rows.length && rows.every(function(r){ return String(r.q).charAt(0) === "/"; });
    }).sort();
    if (!bad.length) return;
    var moved = [], ng = [];
    for (var i = 0; i < bad.length; i++){
      var m = bad[i];
      setStatus("取り込み違いを修正中… " + (i + 1) + "/" + bad.length);
      try {
        if (!S.landing[m]){
          var rows = S.queries[m].map(function(r){ return { page: r.q, c: r.c, i: r.i, t: r.t, p: r.p, users: 0, sec: 0 }; });
          await apiFetch("/api/jimuhack/months/landing/" + m, {
            method: "PUT",
            body: JSON.stringify({ rows: rows, range: S.ranges.queries[m] || null })
          });
          S.landing[m] = rows;
          S.ranges.landing[m] = S.ranges.queries[m] || null;
        }
        await apiFetch("/api/jimuhack/months/queries/" + m, { method: "DELETE" });
        delete S.queries[m];
        delete S.ranges.queries[m];
        moved.push(monthLabel(m));
      } catch (err){
        ng.push(monthLabel(m) + "：" + apiErrorMessage(err, "修正"));
      }
    }
    S.dataVer++;
    S.importLog = {
      title: "取り込み違いの自動修正",
      ok: moved.length ? ["検索クエリとして入っていたランディングページ CSV を「ランディングページ」に移しました：" + moved.join("・")] : [],
      ng: ng, skip: [],
      note: "検索クエリの CSV（CSVバックアップ/クエリ）をもう一度取り込んでください。ランディングページ CSV も取り込み直すと、ページ別のユーザー数・滞在時間まで入ります。"
    };
    setStatus(ng.length ? "修正 " + moved.length + "件 ・ 失敗 " + ng.length + "件" : "取り込み違いを修正しました", ng.length ? "err" : "");
  }

  async function importFiles(fileList){
    var files = Array.prototype.filter.call(fileList || [], function(f){ return /\.csv$/i.test(f.name); });
    if (!files.length){ setStatus("CSV ファイルが見つかりません", "err"); return; }
    if (!S.loaded){ setStatus("読み込みに失敗しているため取り込めません。開き直してください。", "err"); return; }
    var ok = [], ng = [], skip = [];
    for (var i = 0; i < files.length; i++){
      var f = files[i];
      setStatus("取り込み中… " + (i + 1) + "/" + files.length);
      try {
        var parsed = parseGa4Csv(decodeCsvBuffer(await f.arrayBuffer()), f.name);
        if (parsed.empty){ skip.push(f.name); continue; }
        if (parsed.error){ ng.push(f.name + "：" + parsed.error); continue; }
        if (!parsed.rows.length){ skip.push(f.name + "（" + monthLabel(parsed.month) + "）"); continue; }
        await apiFetch("/api/jimuhack/months/" + parsed.kind + "/" + parsed.month, {
          method: "PUT",
          body: JSON.stringify({ rows: parsed.rows, range: parsed.range })
        });
        S[parsed.kind][parsed.month] = parsed.rows;
        S.ranges[parsed.kind][parsed.month] = parsed.range;
        ok.push(({ pages: "ページ ", queries: "検索クエリ ", landing: "ランディングページ " })[parsed.kind] + monthLabel(parsed.month) + "（" + parsed.rows.length + "行）");
      } catch (err){
        ng.push(f.name + "：" + apiErrorMessage(err, "保存"));
      }
    }
    S.dataVer++;
    S.importLog = { ok: ok, ng: ng, skip: skip };
    setStatus((ng.length ? "取り込み " + ok.length + "件 ・ 失敗 " + ng.length + "件" : "取り込み完了 " + ok.length + "件") +
      (skip.length ? " ・ データなし " + skip.length + "件" : ""), ng.length ? "err" : "");
    render();
  }

  /* ---------------- 描画の土台 ---------------- */
  var RENDERERS = {
    overview: renderOverview, articles: renderArticles, queries: renderQueries,
    pages: renderPages, plan: renderPlan, revenue: renderRevenue
  };
  var ACTIONS = {};   // data-act="名前"（クリック / Enter）
  var CHANGES = {};   // data-change="名前"（select・checkbox 等の change）
  var INPUTS = {};    // data-input="名前"（検索窓。220ms デバウンス）

  function card(title, bodyHtml, opts){
    opts = opts || {};
    return '<section class="panel jh-card' + (opts.cls ? " " + opts.cls : "") + '">' +
      '<div class="card-head"><h2>' + esc(title) + '</h2>' + (opts.head || "") + '</div>' +
      '<div class="card-body">' + bodyHtml + '</div></section>';
  }
  function kpi(label, value, sub, subCls, lead){
    return '<div class="kpi' + (lead ? " is-lead" : "") + '"><span class="kpi-label">' + esc(label) + '</span>' +
      '<span class="kpi-value">' + esc(value) + '</span>' +
      '<span class="kpi-sub' + (subCls ? " " + subCls : "") + '">' + esc(sub || "") + '</span></div>';
  }
  function btn(label, act, arg, cls){
    return '<button type="button" class="jh-btn' + (cls ? " " + cls : "") + '" data-act="' + act + '"' +
      (arg != null ? ' data-arg="' + esc(arg) + '"' : "") + '>' + esc(label) + '</button>';
  }
  function chip(label, act, arg, on, n){
    return '<button type="button" class="jh-chip' + (on ? " is-on" : "") + '" data-act="' + act + '" data-arg="' + esc(arg) + '">' +
      esc(label) + (n != null ? '<span class="n">' + esc(n) + '</span>' : "") + '</button>';
  }
  function rankBadge(p){
    var cls = p > 0 && p <= 3 ? " is-top" : p > 0 && p <= 10 ? " is-mid" : "";
    return '<span class="jh-rank' + cls + '">' + (p ? p.toFixed(1) : "—") + '</span>';
  }
  function th(label, scope, col, num){
    var st = S[scope], on = st.sort === col;
    return '<th class="' + (num ? "num" : "") + (on ? " is-sorted" : "") + '" data-act="sort" data-arg="' + scope + ":" + col + '">' +
      esc(label) + (on ? (st.dir < 0 ? " ↓" : " ↑") : "") + '</th>';
  }
  function sortRows(rows, st, getters){
    var g = getters[st.sort];
    if (!g) return rows;
    return rows.slice().sort(function(a, b){
      var x = g(a), y = g(b);
      if (typeof x === "string" || typeof y === "string") return String(x || "").localeCompare(String(y || ""), "ja") * st.dir;
      return ((x || 0) - (y || 0)) * st.dir;
    });
  }
  // 推移のスパークライン。invert=true は順位用（小さいほど上）。
  function spark(vals, invert){
    var pts = [];
    vals.forEach(function(v, i){ if (v != null && !isNaN(v)) pts.push([i, v]); });
    if (pts.length < 2) return '<span class="jh-spark-none">—</span>';
    var w = 64, h = 18, n = Math.max(1, vals.length - 1), min = Infinity, max = -Infinity;
    pts.forEach(function(p){ if (p[1] < min) min = p[1]; if (p[1] > max) max = p[1]; });
    var rng = max - min || 1;
    var d = pts.map(function(p){
      var x = p[0] / n * w, t = (p[1] - min) / rng;
      var y = invert ? 1 + t * (h - 2) : h - 1 - t * (h - 2);
      return x.toFixed(1) + "," + y.toFixed(1);
    }).join(" ");
    return '<svg class="jh-spark" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" aria-hidden="true">' +
      '<polyline points="' + d + '" fill="none" stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>';
  }
  // 月次の棒。値は棒の上に mono で出す（グラフライブラリは使わない）。
  function bars(ms, vals, fmt, marks, short){
    var max = 0;
    vals.forEach(function(v){ if (v > max) max = v; });
    return '<div class="jh-bars' + (short ? " is-short" : "") + '">' + ms.map(function(m, i){
      var v = vals[i], h = v && max ? Math.max(2, Math.round(v / max * 100)) : 0;
      return '<div class="jh-bar-col" title="' + esc(monthLabel(m) + "：" + (v == null ? "データなし" : fmtN(v))) + '">' +
        '<span class="jh-bar-val">' + (v == null ? "" : esc(fmt(v))) + '</span>' +
        '<div class="jh-bar-track"><div class="jh-bar' + (marks && marks[i] ? " " + marks[i] : "") + '" style="height:' + h + '%"></div></div>' +
        '<span class="jh-bar-lbl">' + shortMonth(m) + '</span></div>';
    }).join("") + '</div>';
  }

  // 再描画で入力中の文字とフォーカスを失わないようにする。
  // data-keep … 値とフォーカスを戻す（自由入力のフォーム） / data-fkey … フォーカスだけ戻す（値は state が正の検索窓）
  function snapshotInputs(root){
    var snap = {}, active = document.activeElement, focusKey = null, sel = null;
    Array.prototype.forEach.call(root.querySelectorAll("[data-keep]"), function(el){ snap[el.getAttribute("data-keep")] = el.value; });
    if (active && root.contains(active)){
      focusKey = active.getAttribute("data-keep") || active.getAttribute("data-fkey");
      try { sel = active.selectionStart; } catch (e){}
    }
    return { snap: snap, focusKey: focusKey, sel: sel };
  }
  function restoreInputs(root, s){
    Array.prototype.forEach.call(root.querySelectorAll("[data-keep]"), function(el){
      var k = el.getAttribute("data-keep");
      if (Object.prototype.hasOwnProperty.call(s.snap, k)) el.value = s.snap[k];
    });
    if (!s.focusKey) return;
    var el = root.querySelector('[data-keep="' + s.focusKey + '"],[data-fkey="' + s.focusKey + '"]');
    if (!el) return;
    el.focus();
    if (s.sel != null){ try { el.setSelectionRange(s.sel, s.sel); } catch (e){} }
  }

  function render(){
    var body = $("jh-body");
    if (!body) return;
    Array.prototype.forEach.call(document.querySelectorAll("#jh-tabs .pv-contracts-tab"), function(b){
      b.classList.toggle("is-active", b.getAttribute("data-tab") === S.tab);
    });
    if (!S.loaded && !S.loadErr){ body.innerHTML = '<div class="sched-empty">読み込み中…</div>'; return; }
    var snap = snapshotInputs(body);
    var html = "";
    if (S.loadErr){
      html += '<section class="panel jh-notice is-err"><div class="jh-toolrow"><span>' + esc(S.loadErr) + '</span>' + btn("再読み込み", "reload") + '</div></section>';
    }
    if (S.importLog) html += importNoticeHtml();
    try {
      html += RENDERERS[S.tab]();
    } catch (err){
      console.error("[jimuhack] render", err);
      html += '<section class="panel jh-notice is-err">表示中にエラーが発生しました：' + esc(err && err.message) + '</section>';
    }
    body.innerHTML = html;
    restoreInputs(body, snap);
    updateSim(); // 収益タブの AdSense 目安（入力が無ければ何もしない）
  }
  function importNoticeHtml(){
    var L = S.importLog;
    return '<section class="panel jh-notice' + (L.ng.length ? " is-err" : "") + '">' +
      '<div class="jh-toolrow"><span>' + esc(L.title || "CSV 取り込み") + '：成功 ' + L.ok.length + ' 件' + (L.ng.length ? ' ・ 失敗 ' + L.ng.length + ' 件' : '') +
      ((L.skip || []).length ? ' ・ データなしでスキップ ' + L.skip.length + ' 件' : '') + '</span>' +
      btn("閉じる", "import-dismiss") + '</div><ul>' +
      L.ok.map(function(s){ return '<li>' + esc(s) + '</li>'; }).join("") +
      (L.skip || []).map(function(s){ return '<li class="jh-faint">データなし：' + esc(s) + '</li>'; }).join("") +
      L.ng.map(function(s){ return '<li class="jh-err">' + esc(s) + '</li>'; }).join("") + '</ul>' +
      (L.note ? '<p class="jh-legend">' + esc(L.note) + '</p>' : '') + '</section>';
  }

  function goTab(tab, patch){
    S.tab = tab;
    if (patch) patch();
    render();
    if (tab === "overview" || tab === "articles" || tab === "pages") loadPosts();
    if (tab === "plan" || tab === "overview"){
      CP.ensureTasksLoaded().then(function(){ if (S.tab === tab) render(); });
    }
    window.scrollTo(0, 0);
  }

  var wired = false;
  function wire(){
    if (wired) return;
    wired = true;
    var tabs = $("jh-tabs");
    if (tabs) tabs.addEventListener("click", function(e){
      var b = e.target.closest("[data-tab]");
      if (b) goTab(b.getAttribute("data-tab"));
    });
    var fileIn = $("jh-file-in"), dirIn = $("jh-dir-in");
    $("jh-import-files").addEventListener("click", function(){ fileIn.click(); });
    $("jh-import-dir").addEventListener("click", function(){ dirIn.click(); });
    [fileIn, dirIn].forEach(function(inp){
      inp.addEventListener("change", function(){
        importFiles(inp.files).then(function(){ inp.value = ""; });
      });
    });

    var body = $("jh-body");
    body.addEventListener("click", function(e){
      var link = e.target.closest("a[href]");
      if (link && !link.hasAttribute("data-act")) return; // 外部リンクはそのまま開く
      if (/^(INPUT|SELECT|TEXTAREA|OPTION)$/.test(e.target.tagName)) return;
      var el = e.target.closest("[data-act]");
      if (!el || !body.contains(el)) return;
      var fn = ACTIONS[el.getAttribute("data-act")];
      if (!fn) return;
      e.preventDefault();
      fn(el.getAttribute("data-arg"), el, e);
    });
    body.addEventListener("change", function(e){
      var k = e.target.getAttribute && e.target.getAttribute("data-change");
      if (k && CHANGES[k]) CHANGES[k](e.target);
    });
    var inputTimer = null;
    body.addEventListener("input", function(e){
      var el = e.target, k = el.getAttribute && el.getAttribute("data-input");
      if (!k || !INPUTS[k]) return;
      clearTimeout(inputTimer);
      inputTimer = setTimeout(function(){ INPUTS[k](el); }, 220);
    });
    body.addEventListener("keydown", function(e){
      if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return; // 日本語変換の確定 Enter は無視
      var k = e.target.getAttribute && e.target.getAttribute("data-enter");
      if (!k || !ACTIONS[k]) return;
      e.preventDefault();
      ACTIONS[k](e.target.getAttribute("data-arg"), e.target, e);
    });
    // 本体のタスクが変わったら（完了・編集・他画面からの変更）計画と概要を描き直す。
    CP.onTasksChanged = function(){
      var v = $("view-jimuhack");
      if (v && !v.hidden && (S.tab === "plan" || S.tab === "overview")) render();
    };
  }

  // 自由タグ「事務ハック」（＋種別）を入れた状態で本体の新規タスクモーダルを開く。
  function newPlanTask(p){
    var tags = [PLAN_TAG];
    if (p.type && TASK_TYPES.indexOf(p.type) !== -1) tags.push(p.type);
    CP.openNewTaskPreset({ text: p.text || "", tags: tags, due: p.due || "", url: p.url || "", remarks: p.remarks || "" })
      .then(function(ok){
        if (!ok) setStatus("タスクの読み込みに失敗しているため作れません。タスク管理を開き直してください。", "err");
      });
  }
  function planTasks(){
    return (CP.getTasks() || []).filter(function(t){ return (t.tags || []).indexOf(PLAN_TAG) !== -1; });
  }

  ACTIONS["reload"] = function(){ loadData(); };
  ACTIONS["import-dismiss"] = function(){ S.importLog = null; render(); };
  ACTIONS["import-files"] = function(){ $("jh-file-in").click(); };
  ACTIONS["import-dir"] = function(){ $("jh-dir-in").click(); };
  ACTIONS["posts-reload"] = function(){ loadPosts(true); };
  ACTIONS["tab"] = function(arg){ goTab(arg); };
  ACTIONS["goto-articles"] = function(arg){ goTab("articles", function(){ S.a.filter = arg || "all"; S.a.search = ""; }); };
  ACTIONS["goto-queries"] = function(arg){
    goTab("queries", function(){ S.q.filter = arg || "all"; S.q.month = latest(S.queries) || "all"; S.q.search = ""; });
  };
  ACTIONS["goto-pages"] = function(m){
    goTab("pages", function(){ S.p.month = m || ""; S.p.sort = "si"; S.p.dir = -1; S.p.limit = 200; });
  };
  ACTIONS["sort"] = function(arg){
    var p = String(arg).split(":"), st = S[p[0]];
    if (!st) return;
    if (st.sort === p[1]) st.dir *= -1;
    else { st.sort = p[1]; st.dir = /^(title|q|page|cat)$/.test(p[1]) ? 1 : -1; }
    render();
  };
  ACTIONS["more"] = function(arg){ if (S[arg]){ S[arg].limit += 300; render(); } };
  ACTIONS["plan-new"] = function(arg){ newPlanTask({ type: arg }); };

  /* ---------------- 概要 ---------------- */
  function todos(){
    var list = [], t = todayKey();
    if (S.posts){
      var arts = articles();
      var lastDate = arts.map(function(a){ return a.date; }).sort().pop();
      var gap = daysBetween(lastDate, t);
      if (gap != null && gap >= 30){
        list.push({ lv: "warn", text: "最終投稿から " + gap + " 日。更新が止まっています（最終 " + lastDate.replace(/-/g, "/") + "）", act: "plan-new", arg: "新規記事", btn: "記事をタスク化" });
      }
      var noCta = arts.filter(function(a){ return !a.cta; }).length;
      if (noCta){
        list.push({ lv: "accent", text: "オンライン事務サービスへの導線がない記事 " + noCta + " / " + arts.length + " 本", act: "goto-articles", arg: "nocta", btn: "一覧" });
      }
      var stale = arts.filter(function(a){ return daysBetween(a.modified, t) >= 180; }).length;
      if (stale){
        list.push({ lv: "accent", text: "180日以上更新していない記事 " + stale + " 本", act: "goto-articles", arg: "stale", btn: "一覧" });
      }
    } else if (S.postsErr){
      list.push({ lv: "err", text: S.postsErr, act: "posts-reload", btn: "再取得" });
    }
    var expected = addMonths(curMonth(), -1);
    // ページとクエリは別々に出すので、種類ごとに見る（片方だけ新しいと、もう片方の抜けが隠れていた）
    var lastP = latest(S.pages), lastQ = latest(S.queries);
    if (!lastP && !lastQ){
      list.push({ lv: "warn", text: "GA4 の CSV がまだありません。CSVバックアップフォルダを取り込むと推移とクエリ分析が出ます", act: "import-dir", btn: "フォルダを選ぶ" });
    } else {
      [["ページとスクリーン", lastP], ["検索クエリ", lastQ]].forEach(function(k){
        if (!k[1]){
          list.push({ lv: "warn", text: k[0] + " の CSV がまだありません", act: "import-files", btn: "取り込む" });
        } else if (k[1] < expected){
          list.push({ lv: "warn", text: k[0] + " の CSV：" + monthLabel(addMonths(k[1], 1)) + "〜" + monthLabel(expected) + " が未取り込みです", act: "import-files", btn: "取り込む" });
        }
      });
    }
    var lq = latest(S.queries);
    if (lq){
      var chance = S.queries[lq].filter(isChance).length;
      if (chance){
        list.push({ lv: "accent", text: monthLabel(lq) + "：10位以内なのにクリック0のクエリ " + chance + " 件（タイトル・説明文の見直し候補）", act: "goto-queries", arg: "chance", btn: "見る" });
      }
      var low = S.queries[lq].filter(isLowCtr).length;
      if (low){
        list.push({ lv: "accent", text: monthLabel(lq) + "：表示100回以上で CTR 1% 未満のクエリ " + low + " 件", act: "goto-queries", arg: "lowctr", btn: "見る" });
      }
    }
    var ll = latest(S.landing);
    if (ll){
      var weak = S.landing[ll].filter(function(r){ return r.i >= 500 && r.t < 1.5; });
      if (weak.length){
        var worst = weak.slice().sort(function(a, b){ return b.i - a.i; })[0], wp = postByPath(worst.page);
        list.push({
          lv: "accent",
          text: monthLabel(ll) + "：検索で500回以上表示されているのに CTR 1.5% 未満の記事 " + weak.length + " 本（最大：" +
            (wp ? wp.title : worst.page) + " ・ 表示 " + fmtN(worst.i) + " ・ CTR " + fmtPct(worst.t) + "）",
          act: "goto-pages", arg: ll, btn: "ページで見る"
        });
      }
    }
    var over = planTasks().filter(function(x){ return !x.done && x.due && x.due < t; }).length;
    if (over) list.push({ lv: "err", text: "事務ハックのタスクが " + over + " 件 期限切れ", act: "tab", arg: "plan", btn: "計画" });
    return list;
  }

  var GOALS = [
    { k: "pv", label: "月間PV（最新月）", unit: "PV", cur: function(){ var ms = allMonths().filter(monthPV); return ms.length ? monthPV(ms[ms.length - 1]).v : 0; } },
    { k: "clicks", label: "検索クリック（最新月）", unit: "件", cur: function(){ var m = latestSearchMonth(); return m ? searchStats(m).c : 0; } },
    { k: "posts", label: "今月の新規記事", unit: "本", cur: function(){ var cm = curMonth(); return articles().filter(function(a){ return a.date.indexOf(cm) === 0; }).length; } },
    { k: "revenue", label: "今月の収益", unit: "円", cur: function(){ return revenueIn(curMonth()); } }
  ];
  function goalsCard(){
    var g = S.state.goals;
    var body = GOALS.map(function(d){
      if (S.goalEdit){
        return '<div class="jh-goal"><div class="jh-goal-head"><span>' + esc(d.label) + '</span><span class="jh-form">' +
          '<input type="number" min="0" class="jh-in is-num" style="width:110px" data-goal="' + d.k + '" value="' + esc(g[d.k] || 0) + '">' +
          '<span class="jh-faint">' + esc(d.unit) + '</span></span></div></div>';
      }
      var cur = d.cur() || 0, tgt = +g[d.k] || 0;
      if (!tgt){
        return '<div class="jh-goal"><div class="jh-goal-head"><span>' + esc(d.label) + '</span><span class="jh-goal-val">' + fmtN(cur) + ' ' + esc(d.unit) + ' ・ 目標未設定</span></div></div>';
      }
      var on = Math.round(Math.min(1, cur / tgt) * 10), seg = "";
      for (var i = 0; i < 10; i++) seg += '<i' + (i < on ? ' class="on"' : '') + '></i>';
      return '<div class="jh-goal"><div class="jh-goal-head"><span>' + esc(d.label) + '</span><span class="jh-goal-val">' +
        fmtN(cur) + ' / ' + fmtN(tgt) + ' ' + esc(d.unit) + ' ・ ' + Math.round(cur / tgt * 100) + '%</span></div>' +
        '<div class="jh-seg' + (cur >= tgt ? ' is-done' : '') + '">' + seg + '</div></div>';
    }).join("");
    var head = S.goalEdit
      ? '<span class="jh-head-actions">' + btn("やめる", "goal-cancel") + btn("保存", "goal-save", null, "is-primary") + '</span>'
      : btn("編集", "goal-edit");
    return card("目標", body, { head: head });
  }
  ACTIONS["goal-edit"] = function(){ S.goalEdit = true; render(); };
  ACTIONS["goal-cancel"] = function(){ S.goalEdit = false; render(); };
  ACTIONS["goal-save"] = function(){
    Array.prototype.forEach.call(document.querySelectorAll("#jh-body [data-goal]"), function(inp){
      S.state.goals[inp.getAttribute("data-goal")] = Math.max(0, Math.round(+inp.value || 0));
    });
    S.goalEdit = false;
    saveState();
    render();
  };

  function monthlyCard(){
    var ms = allMonths();
    if (!ms.length){
      return card("月次推移", '<div class="sched-empty">まだデータがありません。右上の「フォルダ」から CSVバックアップフォルダを取り込んでください。</div>');
    }
    var show = ms.slice(-12);
    var pvs = show.map(function(m){ var x = monthPV(m); return x ? x.v : null; });
    var pvMarks = show.map(function(m){ var x = monthPV(m); return !x ? "" : x.manual ? "is-manual" : partialEnd("pages", m) ? "is-partial" : ""; });
    var cls = show.map(function(m){ var s = searchStats(m); return s ? s.c : null; });
    var clMarks = show.map(function(m){ return searchPartialEnd(m) ? "is-partial" : ""; });
    var chart = '<div class="jh-bars-title">PV</div>' + bars(show, pvs, fmtK, pvMarks) +
      '<div class="jh-bars-title">検索クリック</div>' + bars(show, cls, fmtK, clMarks, true) +
      '<p class="jh-legend">薄い棒＝手入力の月 / 月の途中までの CSV。検索クリック・表示・CTR・順位は、ランディングページ CSV がある月はその合計（クエリの匿名化で消える分も含む）、無い月は検索クエリ CSV の合計。平均順位は表示回数で重み付けした平均。</p>';
    var rows = ms.slice().reverse().map(function(m){
      var pv = monthPV(m), s = searchStats(m), pe = partialEnd("pages", m) || searchPartialEnd(m);
      return '<tr><td>' + monthLabel(m) + (pe ? ' <span class="jh-faint">〜' + pe + '日</span>' : '') + '</td>' +
        '<td class="num">' + (pv ? fmtN(pv.v) + (pv.manual ? ' <span class="jh-faint">手入力</span> ' + btn("✕", "mpv-del", m, "is-danger") : '') : '—') + '</td>' +
        '<td class="num">' + (s ? fmtN(s.c) : '—') + '</td>' +
        '<td class="num">' + (s ? fmtN(s.i) : '—') + '</td>' +
        '<td class="num">' + (s ? fmtPct(s.ctr, 2) : '—') + '</td>' +
        '<td class="num">' + (s ? s.pos.toFixed(1) : '—') + '</td>' +
        '<td class="num jh-faint">' + (S.pages[m] ? S.pages[m].length : '—') + ' / ' + (S.queries[m] ? S.queries[m].length : '—') + ' / ' + (S.landing[m] ? S.landing[m].length : '—') + '</td></tr>';
    }).join("");
    var table = '<div class="jh-table-wrap" style="max-height:320px;margin-top:12px"><table class="jh-table"><thead><tr>' +
      '<th>月</th><th class="num">PV</th><th class="num">検索クリック</th><th class="num">表示</th><th class="num">CTR</th><th class="num">平均順位</th><th class="num">行数 ページ/クエリ/LP</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';
    var form = '<div class="jh-form" style="margin-top:10px"><span class="jh-faint">CSV が無い月の PV を手入力：</span>' +
      '<input type="month" class="jh-in is-num" data-keep="jh-mpv-m">' +
      '<input type="number" min="0" class="jh-in is-num" style="width:110px" placeholder="PV" data-keep="jh-mpv-v" data-enter="mpv-save">' +
      btn("保存", "mpv-save") + '</div>';
    return card("月次推移", chart + table + form, { head: '<span class="jh-note">GA4 CSV（ページとスクリーン / オーガニック検索クエリ）</span>' });
  }
  ACTIONS["mpv-save"] = function(){
    var m = document.querySelector('#jh-body [data-keep="jh-mpv-m"]'), v = document.querySelector('#jh-body [data-keep="jh-mpv-v"]');
    if (!m || !v || !m.value || v.value === ""){ setStatus("年月と PV を入れてください", "err"); return; }
    S.state.manualPV[m.value] = Math.max(0, Math.round(+v.value));
    m.value = "";
    v.value = "";
    saveState();
    render();
  };
  ACTIONS["mpv-del"] = function(m){ delete S.state.manualPV[m]; saveState(); render(); };

  function renderOverview(){
    var pvMonths = allMonths().filter(monthPV), lp = pvMonths[pvMonths.length - 1];
    var pvK = "—", pvSub = "CSV 未取り込み", pvCls = "";
    if (lp){
      var cur = monthPV(lp), prev = monthPV(addMonths(lp, -1)), pe = partialEnd("pages", lp);
      pvK = fmtN(cur.v);
      pvSub = monthLabel(lp) + (pe ? "（〜" + pe + "日）" : "") + (cur.manual ? " 手入力" : "");
      if (prev && prev.v){
        var d = (cur.v - prev.v) / prev.v * 100;
        pvSub += " ・ 前月比 " + (d >= 0 ? "+" : "") + d.toFixed(0) + "%";
        pvCls = d >= 0 ? "is-good" : "is-bad";
      }
    }
    var lq = latestSearchMonth(), qs = lq ? searchStats(lq) : null, qp = lq ? searchStats(addMonths(lq, -1)) : null;
    var arts = articles(), lastPost = arts.map(function(a){ return a.date; }).sort().pop();
    var ago = lastPost ? daysBetween(lastPost, todayKey()) : null;
    var revGoal = +S.state.goals.revenue || 0;
    var html = '<section class="panel kpi-band">' +
      kpi("最新月 PV", pvK, pvSub, pvCls, true) +
      kpi("検索クリック" + (lq ? "（" + shortMonth(lq) + "）" : ""), qs ? fmtN(qs.c) : "—",
        qs ? "CTR " + fmtPct(qs.ctr) + " ・ 平均 " + qs.pos.toFixed(1) + " 位" : "CSV 未取り込み",
        qs && qp ? (qs.c >= qp.c ? "is-good" : "is-bad") : "") +
      kpi("公開記事", S.posts ? String(arts.length) : "—",
        lastPost ? "最終投稿 " + ago + " 日前" : (S.postsErr ? "取得失敗" : "WordPress から取得中…"),
        ago != null && ago >= 30 ? "is-bad" : "") +
      kpi("今月の収益", fmtYen(revenueIn(curMonth())),
        revGoal ? "目標 " + fmtYen(revGoal) : "累計 " + fmtYen(sum(S.state.revenue, function(r){ return +r.amount; }))) +
      '</section>';
    var list = todos();
    var todoHtml = list.length
      ? '<div class="jh-todo">' + list.map(function(x){
          return '<div class="jh-todo-row lv-' + x.lv + '"><span class="jh-todo-text">' + esc(x.text) + '</span>' + (x.act ? btn(x.btn, x.act, x.arg) : "") + '</div>';
        }).join("") + '</div>'
      : '<div class="sched-empty">いま自動で出せる改善候補はありません。</div>';
    html += '<div class="jh-grid2">' + card("やること", todoHtml, { head: '<span class="jh-note">データから自動で出しています</span>' }) + goalsCard() + '</div>';
    html += monthlyCard();
    return html;
  }

  /* ---------------- 記事（WordPress） ---------------- */
  var ART_FILTERS = [
    { k: "all", label: "すべて", test: function(){ return true; } },
    { k: "nocta", label: "サービス導線なし", test: function(a){ return !a.cta; } },
    { k: "stale", label: "180日以上未更新", test: function(a){ return a.age >= 180; } },
    { k: "noimg", label: "本文画像なし", test: function(a){ return a.imgs === 0; } },
    { k: "short", label: "2,000字未満", test: function(a){ return a.chars < 2000; } },
    { k: "lowctr", label: "検索表示多・CTR低", test: function(a){ return a.si >= 500 && a.sctr < 1.5; } },
    { k: "prio", label: "優先度あり", test: function(a){ return !!a.meta.pri; } }
  ];
  var PRI_LABEL = { high: "高", mid: "中", low: "低" };
  var PRI_RANK = { high: 3, mid: 2, low: 1 };

  function searchBox(inputKey, fkey, value, ph){
    return '<div class="mail-search-wrap"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>' +
      '<input type="search" placeholder="' + esc(ph) + '" data-input="' + inputKey + '" data-fkey="' + fkey + '" value="' + esc(value) + '" maxlength="80" autocomplete="off"></div>';
  }
  function words(s){ return String(s || "").trim().toLowerCase().split(/\s+/).filter(Boolean); }

  function articleRows(){
    var t = todayKey(), lm = latest(S.pages), pvMap = {}, ll = latest(S.landing), lpMap = {};
    if (lm) S.pages[lm].forEach(function(r){ pvMap[r.page] = (pvMap[r.page] || 0) + r.pv; });
    if (ll) S.landing[ll].forEach(function(r){ lpMap[r.page] = r; });
    return articles().map(function(a){
      var lp = lpMap[a.path];
      return Object.assign({}, a, {
        age: daysBetween(a.modified, t), pv: pvMap[a.path] || 0,
        sc: lp ? lp.c : 0, si: lp ? lp.i : 0, sctr: lp ? lp.t : 0,
        meta: S.state.articleMeta[a.slug] || {}
      });
    });
  }
  // 記事の詳細に出す、その記事の Google 検索実績（ランディングページ CSV の直近6か月）
  function landingTrendHtml(a){
    var rows = Object.keys(S.landing).sort().slice(-6).map(function(m){
      var r = (S.landing[m] || []).filter(function(x){ return x.page === a.path; })[0];
      return r ? '<tr><td>' + monthLabel(m) + '</td><td>' + fmtN(r.c) + '</td><td>' + fmtN(r.i) + '</td><td>' + fmtPct(r.t) + '</td><td>' + r.p.toFixed(1) + '</td></tr>' : "";
    }).reverse().join("");
    if (!rows) return "";
    return '<div class="jh-sublabel" style="margin-top:12px">この記事の Google 検索（ランディングページ）</div>' +
      '<table class="jh-mini-table"><thead><tr><th>月</th><th>クリック</th><th>表示</th><th>CTR</th><th>順位</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }
  // タイトルに、クエリの語（2文字以上）がすべて含まれる検索クエリ。最新月のみ。
  function relatedQueries(a){
    var lq = latest(S.queries);
    if (!lq) return [];
    var title = a.title.toLowerCase().replace(/\s+/g, "");
    return S.queries[lq].filter(function(r){
      var ws = r.q.toLowerCase().split(/\s+/).filter(function(w){ return w.length >= 2; });
      return ws.length && ws.every(function(w){ return title.indexOf(w) !== -1; });
    }).sort(function(x, y){ return y.i - x.i; }).slice(0, 6);
  }
  // クエリに対応していそうな記事。全語一致を優先し、無ければ語の過半が一致するもの。
  function relatedPosts(q){
    if (!S.posts) return [];
    var ws = q.toLowerCase().split(/\s+/).filter(function(w){ return w.length >= 2; });
    if (!ws.length) return [];
    var arts = articles();
    var full = arts.filter(function(a){ var t = a.title.toLowerCase(); return ws.every(function(w){ return t.indexOf(w) !== -1; }); });
    if (full.length) return full.slice(0, 3);
    var need = Math.max(1, ws.length - 1);
    return arts.map(function(a){
      var t = a.title.toLowerCase();
      return { a: a, n: ws.filter(function(w){ return t.indexOf(w) !== -1; }).length };
    }).filter(function(x){ return x.n >= need; }).sort(function(x, y){ return y.n - x.n; }).slice(0, 3).map(function(x){ return x.a; });
  }

  function articleDetail(a){
    var m = a.meta, lq = latest(S.queries), qs = relatedQueries(a);
    var priSel = '<select class="jh-in" data-change="art-pri" data-arg="' + esc(a.slug) + '">' +
      [["", "—"], ["high", "高"], ["mid", "中"], ["low", "低"]].map(function(o){
        return '<option value="' + o[0] + '"' + ((m.pri || "") === o[0] ? " selected" : "") + '>' + o[1] + '</option>';
      }).join("") + '</select>';
    return '<div class="jh-detail-grid"><div>' +
      '<div class="jh-sublabel">改善メモ</div>' +
      '<div class="jh-form" style="margin-bottom:6px"><span class="jh-faint">優先度</span>' + priSel + '</div>' +
      '<textarea class="jh-in" data-keep="jh-art-memo-' + esc(a.slug) + '" data-slug="' + esc(a.slug) + '" maxlength="1000" placeholder="例：導入文に実体験を足す / 例文を表にする">' + esc(m.memo || "") + '</textarea>' +
      '<div class="jh-actions">' + btn("メモを保存", "art-memo-save", a.slug, "is-primary") + btn("リライトをタスク化", "art-task", a.slug) +
      '<a class="jh-btn" href="' + esc(a.link) + '" target="_blank" rel="noopener noreferrer">記事を開く ↗</a>' +
      '<span class="jh-faint">見出し ' + a.h2 + ' ・ 内部リンク ' + a.internal + ' ・ 公開 ' + esc(a.date) + '</span></div>' +
      '</div><div><div class="jh-sublabel">関連しそうな検索クエリ（' + (lq ? monthLabel(lq) : "CSV なし") + '）</div>' +
      (qs.length
        ? '<table class="jh-mini-table"><thead><tr><th>クエリ</th><th>順位</th><th>表示</th><th>クリック</th></tr></thead><tbody>' +
          qs.map(function(q){ return '<tr><td>' + esc(q.q) + '</td><td>' + q.p.toFixed(1) + '</td><td>' + fmtN(q.i) + '</td><td>' + fmtN(q.c) + '</td></tr>'; }).join("") +
          '</tbody></table>'
        : '<div class="jh-faint">タイトルの語と一致するクエリはありません</div>') +
      landingTrendHtml(a) +
      '</div></div>';
  }

  function renderArticles(){
    if (!S.posts){
      if (S.postsErr) return card("記事", '<div class="jh-toolrow"><span class="jh-err">' + esc(S.postsErr) + '</span>' + btn("再取得", "posts-reload") + '</div>');
      return card("記事", '<div class="sched-empty">WordPress から記事一覧を取得中…</div>');
    }
    var all = articleRows(), st = S.a, lm = latest(S.pages), ll = latest(S.landing);
    var f = ART_FILTERS.filter(function(x){ return x.k === st.filter; })[0] || ART_FILTERS[0];
    var ws = words(st.search);
    var rows = all.filter(f.test).filter(function(a){
      if (!ws.length) return true;
      var hay = (a.title + " " + a.slug + " " + a.cat + " " + (a.meta.memo || "")).toLowerCase();
      return ws.every(function(w){ return hay.indexOf(w) !== -1; });
    });
    rows = sortRows(rows, st, {
      date: function(a){ return a.date; }, title: function(a){ return a.title; }, modified: function(a){ return a.modified; },
      chars: function(a){ return a.chars; }, imgs: function(a){ return a.imgs; }, cta: function(a){ return a.cta ? 1 : 0; },
      pv: function(a){ return a.pv; }, sc: function(a){ return a.sc; }, pri: function(a){ return PRI_RANK[a.meta.pri] || 0; }
    });
    var avg = all.length ? Math.round(sum(all, function(a){ return a.chars; }) / all.length) : 0;
    var summary = all.length + " 本 ・ 平均 " + fmtN(avg) + " 字 ・ 導線あり " + all.filter(function(a){ return a.cta; }).length +
      " ・ 本文画像あり " + all.filter(function(a){ return a.imgs > 0; }).length + " ・ 取得 " + fmtSavedAt(S.postsAt) +
      (rows.length !== all.length ? " ・ 表示 " + rows.length + " 本" : "");
    var chips = ART_FILTERS.map(function(x){ return chip(x.label, "art-filter", x.k, st.filter === x.k, all.filter(x.test).length); }).join("");
    var tool = '<div class="jh-toolrow"><div class="jh-chips">' + chips + '</div><div class="jh-form">' +
      searchBox("art-search", "jh-art-q", st.search, "タイトル・カテゴリ・メモ") + btn(S.postsLoading ? "取得中…" : "再取得", "posts-reload") + '</div></div>';
    var body = rows.map(function(a){
      var open = st.open === a.slug;
      var tr = '<tr class="is-row' + (open ? " is-open" : "") + '" data-act="art-open" data-arg="' + esc(a.slug) + '">' +
        '<td class="num">' + esc(a.date.slice(2).replace(/-/g, "/")) + '</td>' +
        '<td><span class="jh-cell-title" title="' + esc(a.title) + '">' + esc(a.title) + '</span>' +
          '<span class="jh-cell-sub">' + esc(a.cat) + (a.meta.memo ? " ・ メモあり" : "") + '</span></td>' +
        '<td class="num' + (a.age >= 180 ? " jh-warn" : "") + '">' + (a.age == null ? "—" : a.age + "日前") + '</td>' +
        '<td class="num' + (a.chars < 2000 ? " jh-faint" : "") + '">' + fmtN(a.chars) + '</td>' +
        '<td class="num">' + a.imgs + '</td>' +
        '<td class="num">' + (a.cta ? '<span class="jh-ok">✓</span>' : '<span class="jh-faint">—</span>') + '</td>' +
        '<td class="num">' + (lm ? fmtN(a.pv) : "—") + '</td>' +
        '<td class="num' + (a.si >= 500 && a.sctr < 1.5 ? " jh-warn" : "") + '" title="' + (ll ? esc("表示 " + fmtN(a.si) + " ・ CTR " + fmtPct(a.sctr)) : "") + '">' + (ll ? fmtN(a.sc) : "—") + '</td>' +
        '<td class="num">' + (a.meta.pri ? '<span class="jh-tag' + (a.meta.pri === "high" ? " is-warn" : " is-accent") + '">' + PRI_LABEL[a.meta.pri] + '</span>' : "") + '</td></tr>';
      if (open) tr += '<tr><td colspan="9" class="jh-detail">' + articleDetail(a) + '</td></tr>';
      return tr;
    }).join("");
    var table = '<div class="jh-table-wrap"><table class="jh-table"><thead><tr>' +
      th("公開", "a", "date", true) + th("タイトル", "a", "title") + th("更新", "a", "modified", true) + th("文字数", "a", "chars", true) +
      th("画像", "a", "imgs", true) + th("導線", "a", "cta", true) + th("PV" + (lm ? "（" + shortMonth(lm) + "）" : ""), "a", "pv", true) +
      th("検索" + (ll ? "（" + shortMonth(ll) + "）" : ""), "a", "sc", true) + th("優先", "a", "pri", true) +
      '</tr></thead><tbody>' + (body || '<tr><td colspan="9" class="jh-faint">該当する記事はありません</td></tr>') + '</tbody></table></div>';
    return card("記事", tool + '<p class="jh-summary">' + esc(summary) + '</p>' + table,
      { head: '<span class="jh-note">WordPress から自動取得（お知らせカテゴリは除く）。行を押すとメモ・関連クエリ</span>' }) + changesCard(all);
  }
  function setMeta(slug, patch){
    var m = Object.assign({}, S.state.articleMeta[slug] || {}, patch);
    Object.keys(m).forEach(function(k){ if (!m[k]) delete m[k]; });
    if (Object.keys(m).length) S.state.articleMeta[slug] = m;
    else delete S.state.articleMeta[slug];
    saveState();
  }
  ACTIONS["art-filter"] = function(k){ S.a.filter = k; S.a.open = null; render(); };
  INPUTS["art-search"] = function(el){ S.a.search = el.value; render(); };
  ACTIONS["art-open"] = function(slug){ S.a.open = S.a.open === slug ? null : slug; render(); };
  CHANGES["art-pri"] = function(el){ setMeta(el.getAttribute("data-arg"), { pri: el.value }); render(); };
  ACTIONS["art-memo-save"] = function(slug){
    var ta = document.querySelector('#jh-body textarea[data-slug="' + CSS.escape(slug) + '"]');
    setMeta(slug, { memo: ta ? ta.value.trim().slice(0, 1000) : "" });
    render();
  };
  ACTIONS["art-task"] = function(slug){
    var a = articles().filter(function(x){ return x.slug === slug; })[0];
    if (!a) return;
    var memo = (S.state.articleMeta[slug] || {}).memo || "";
    newPlanTask({ type: "リライト", text: "リライト：" + a.title, url: a.link, remarks: memo });
  };

  // 改善ログ（旧版の「記事改善トラッカー」）。いつ・どの記事で・何を変えたか。
  function changesCard(all){
    var titleOf = {};
    all.forEach(function(a){ titleOf[a.slug] = a.title; });
    var list = S.state.changes.slice().sort(function(x, y){ return String(y.date).localeCompare(String(x.date)); });
    var opts = '<option value="">記事を選ぶ</option>' + all.slice().sort(function(x, y){ return x.title.localeCompare(y.title, "ja"); }).map(function(a){
      return '<option value="' + esc(a.slug) + '">' + esc(a.title.slice(0, 40)) + '</option>';
    }).join("");
    var form = '<div class="jh-form">' +
      '<input type="date" class="jh-in is-num" data-keep="jh-chg-date" value="' + todayKey() + '">' +
      '<select class="jh-in jh-grow" data-keep="jh-chg-slug">' + opts + '</select>' +
      '<input type="text" class="jh-in jh-grow" maxlength="200" placeholder="何を変えたか（例：タイトルに「例文」を追加）" data-keep="jh-chg-what">' +
      '<input type="text" class="jh-in" style="width:120px" maxlength="40" placeholder="変更前（順位・CTR）" data-keep="jh-chg-before">' +
      '<input type="text" class="jh-in" style="width:120px" maxlength="40" placeholder="変更後" data-keep="jh-chg-after" data-enter="chg-add">' +
      btn("記録", "chg-add", null, "is-primary") + '</div>';
    var rows = list.map(function(c){
      return '<tr><td class="num">' + esc(String(c.date || "").replace(/-/g, "/")) + '</td>' +
        '<td><span class="jh-cell-title">' + esc(titleOf[c.slug] || c.slug || c.url || "") + '</span></td>' +
        '<td>' + esc(c.what || c.change || "") + '</td><td class="num">' + esc(c.before || "—") + '</td><td class="num">' + esc(c.after || "—") + '</td>' +
        '<td class="num">' + btn("✕", "chg-del", c.id, "is-danger") + '</td></tr>';
    }).join("");
    var listHtml = rows
      ? '<div class="jh-table-wrap" style="margin-top:10px;max-height:320px"><table class="jh-table"><thead><tr><th class="num">日付</th><th>記事</th><th>変更内容</th><th class="num">前</th><th class="num">後</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'
      : '<p class="jh-faint" style="margin:10px 0 0">リライトやタイトル変更を記録しておくと、あとで検索クエリの推移と見比べられます。</p>';
    return card("改善ログ", form + listHtml, { head: '<span class="jh-note">' + list.length + ' 件</span>' });
  }
  function keepEl(k){ return document.querySelector('#jh-body [data-keep="' + k + '"]'); }
  ACTIONS["chg-add"] = function(){
    var what = keepEl("jh-chg-what"), slug = keepEl("jh-chg-slug");
    if (!what || !slug || !what.value.trim() || !slug.value){ setStatus("記事と変更内容を入れてください", "err"); return; }
    S.state.changes.push({
      id: uid(), date: keepEl("jh-chg-date").value || todayKey(), slug: slug.value, what: what.value.trim(),
      before: keepEl("jh-chg-before").value.trim(), after: keepEl("jh-chg-after").value.trim()
    });
    what.value = "";
    keepEl("jh-chg-before").value = "";
    keepEl("jh-chg-after").value = "";
    saveState();
    render();
  };
  ACTIONS["chg-del"] = function(id){
    askConfirm("この改善ログを削除しますか？").then(function(ok){
      if (!ok) return;
      S.state.changes = S.state.changes.filter(function(c){ return c.id !== id; });
      saveState();
      render();
    });
  };

  /* ---------------- 検索クエリ ---------------- */
  var Q_FILTERS = [
    { k: "all", label: "すべて", test: function(){ return true; } },
    { k: "chance", label: "10位以内・0クリック", test: isChance },
    { k: "top10", label: "10位以内", test: function(r){ return r.p > 0 && r.p <= 10; } },
    { k: "clicked", label: "クリックあり", test: function(r){ return r.c > 0; } },
    { k: "lowctr", label: "表示100+・CTR1%未満", test: isLowCtr }
  ];
  var qHistCache = { ver: -1, map: {}, months: [] };
  // クエリ → 月ごとの行（無い月は null）。取り込み・読み込みのたびに dataVer が上がって作り直す。
  function qHistory(){
    if (qHistCache.ver === S.dataVer) return qHistCache;
    var months = Object.keys(S.queries).sort(), map = {};
    months.forEach(function(m, mi){
      S.queries[m].forEach(function(r){
        var h = map[r.q];
        if (!h){ h = map[r.q] = []; for (var i = 0; i < months.length; i++) h.push(null); }
        h[mi] = r;
      });
    });
    qHistCache = { ver: S.dataVer, map: map, months: months };
    return qHistCache;
  }
  function queryRows(month){
    if (month !== "all") return (S.queries[month] || []).map(function(r){ return Object.assign({ mc: 1 }, r); });
    var H = qHistory();
    return Object.keys(H.map).map(function(q){
      var hs = H.map[q].filter(Boolean);
      var c = sum(hs, function(r){ return r.c; }), i = sum(hs, function(r){ return r.i; }), pw = sum(hs, function(r){ return r.p * r.i; });
      return { q: q, c: c, i: i, t: i ? Math.round(c / i * 10000) / 100 : 0, p: i ? Math.round(pw / i * 10) / 10 : hs[hs.length - 1].p, mc: hs.length };
    });
  }

  function queryDetail(q){
    var H = qHistory(), hist = H.map[q] || [], last = null;
    for (var i = hist.length - 1; i >= 0; i--) if (hist[i]){ last = hist[i]; break; }
    var rowsHtml = H.months.map(function(m, idx){
      var r = hist[idx];
      return r ? '<tr><td>' + monthLabel(m) + '</td><td>' + r.p.toFixed(1) + '</td><td>' + fmtN(r.i) + '</td><td>' + fmtN(r.c) + '</td><td>' + fmtPct(r.t) + '</td></tr>' : "";
    }).reverse().join("");
    var posts = relatedPosts(q);
    var postsHtml = posts.length
      ? posts.map(function(p){
          return '<div class="jh-form" style="padding:4px 0"><a class="jh-link jh-grow" href="' + esc(p.link) + '" target="_blank" rel="noopener noreferrer">' + esc(p.title) + ' ↗</a>' +
            btn("この記事をリライト", "q-task", q + "||" + p.slug) + '</div>';
        }).join("")
      : '<div class="jh-faint">タイトルが一致する記事がありません（新規記事の候補かもしれません）</div>';
    return '<div class="jh-detail-grid"><div><div class="jh-sublabel">月別</div>' +
      '<table class="jh-mini-table"><thead><tr><th>月</th><th>順位</th><th>表示</th><th>クリック</th><th>CTR</th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div>' +
      '<div><div class="jh-sublabel">対応していそうな記事</div>' + postsHtml +
      '<div class="jh-actions">' + btn(posts.length ? "クエリだけタスク化" : "新規記事をタスク化", "q-task", q + "||") +
      (last ? '<span class="jh-faint">最新 ' + last.p.toFixed(1) + '位 ・ 表示 ' + fmtN(last.i) + ' ・ クリック ' + fmtN(last.c) + '</span>' : "") +
      '</div></div></div>';
  }

  function themesCard(month){
    var groups = THEMES.map(function(t){ return { label: t.label, keys: t.keys, rows: [] }; });
    var other = { label: "その他", rows: [] };
    queryRows(month).forEach(function(r){
      var ql = r.q.toLowerCase();
      var g = groups.filter(function(x){ return x.keys.some(function(k){ return ql.indexOf(k) !== -1; }); })[0];
      (g || other).rows.push(r);
    });
    var list = groups.concat([other]).filter(function(g){ return g.rows.length; }).map(function(g){
      var c = sum(g.rows, function(r){ return r.c; }), i = sum(g.rows, function(r){ return r.i; }), pw = sum(g.rows, function(r){ return r.p * r.i; });
      return { label: g.label, n: g.rows.length, c: c, i: i, ctr: i ? c / i * 100 : 0, pos: i ? pw / i : 0 };
    }).sort(function(a, b){ return b.i - a.i; });
    var body = list.map(function(g){
      return '<tr><td>' + esc(g.label) + '</td><td class="num">' + g.n + '</td><td class="num">' + fmtN(g.i) + '</td><td class="num">' + fmtN(g.c) + '</td>' +
        '<td class="num">' + fmtPct(g.ctr) + '</td><td class="num">' + g.pos.toFixed(1) + '</td></tr>';
    }).join("");
    return card("テーマ別", '<div class="jh-table-wrap" style="max-height:none"><table class="jh-table"><thead><tr><th>テーマ</th><th class="num">クエリ数</th><th class="num">表示</th><th class="num">クリック</th><th class="num">CTR</th><th class="num">平均順位</th></tr></thead><tbody>' + body + '</tbody></table></div>',
      { head: '<span class="jh-note">' + (month === "all" ? "全期間" : monthLabel(month)) + ' ・ クエリに含まれる語で機械的に分類</span>' });
  }

  function renderQueries(){
    var months = Object.keys(S.queries).sort();
    if (!months.length){
      return card("検索クエリ", '<div class="sched-empty">検索クエリの CSV がまだありません。右上の「CSV取り込み」「フォルダ」から GA4 の「Google のオーガニック検索クエリ」CSV を取り込んでください。</div>');
    }
    var st = S.q;
    if (st.month !== "all" && !S.queries[st.month]) st.month = "all";
    var base = queryRows(st.month);
    var f = Q_FILTERS.filter(function(x){ return x.k === st.filter; })[0] || Q_FILTERS[0];
    var ws = words(st.search);
    var rows = base.filter(f.test).filter(function(r){
      return !ws.length || ws.every(function(w){ return r.q.toLowerCase().indexOf(w) !== -1; });
    });
    rows = sortRows(rows, st, {
      q: function(r){ return r.q; }, p: function(r){ return r.p || 999; }, i: function(r){ return r.i; },
      c: function(r){ return r.c; }, t: function(r){ return r.t; }, mc: function(r){ return r.mc; }
    });
    var H = qHistory(), isAll = st.month === "all", cols = isAll ? 7 : 6;
    var monthChips = chip("全期間", "q-month", "all", isAll, months.length + "か月") +
      months.slice().reverse().map(function(m){
        return chip(monthLabel(m) + (partialEnd("queries", m) ? "*" : ""), "q-month", m, st.month === m, S.queries[m].length);
      }).join("");
    var filterChips = Q_FILTERS.map(function(x){ return chip(x.label, "q-filter", x.k, st.filter === x.k, base.filter(x.test).length); }).join("");
    var tool = '<div class="jh-toolrow"><div class="jh-chips">' + monthChips + '</div></div>' +
      '<div class="jh-toolrow"><div class="jh-chips">' + filterChips + '</div>' + searchBox("q-search", "jh-q-q", st.search, "クエリを検索") + '</div>';
    var shown = rows.slice(0, st.limit);
    var body = shown.map(function(r){
      var open = st.open === r.q, hist = H.map[r.q] || [];
      var tr = '<tr class="is-row' + (open ? " is-open" : "") + '" data-act="q-open" data-arg="' + esc(r.q) + '">' +
        '<td><span class="jh-cell-title" title="' + esc(r.q) + '">' + esc(r.q) + '</span></td>' +
        '<td class="num">' + rankBadge(r.p) + '</td>' +
        '<td class="num">' + fmtN(r.i) + '</td>' +
        '<td class="num' + (r.c ? "" : " jh-faint") + '">' + fmtN(r.c) + '</td>' +
        '<td class="num">' + fmtPct(r.t) + '</td>' +
        '<td>' + spark(hist.map(function(h){ return h ? h.p : null; }), true) + '</td>' +
        (isAll ? '<td class="num jh-faint">' + r.mc + '</td>' : "") + '</tr>';
      if (open) tr += '<tr><td colspan="' + cols + '" class="jh-detail">' + queryDetail(r.q) + '</td></tr>';
      return tr;
    }).join("");
    var head = '<tr>' + th("クエリ", "q", "q") + th("順位", "q", "p", true) + th("表示", "q", "i", true) + th("クリック", "q", "c", true) +
      th("CTR", "q", "t", true) + '<th>順位の推移</th>' + (isAll ? th("月数", "q", "mc", true) : "") + '</tr>';
    var table = '<div class="jh-table-wrap"><table class="jh-table"><thead>' + head + '</thead><tbody>' +
      (body || '<tr><td colspan="' + cols + '" class="jh-faint">該当なし</td></tr>') + '</tbody></table></div>' +
      (rows.length > shown.length ? btn("さらに表示（残り " + (rows.length - shown.length) + " 件）", "more", "q", "jh-more") : "");
    var summary = rows.length + " 件" + (isAll ? "（全期間の合計。順位は表示回数で重み付けした平均）" : "") +
      (months.some(function(m){ return partialEnd("queries", m); }) ? " ・ * は月の途中までの CSV" : "");
    return card("検索クエリ", tool + '<p class="jh-summary">' + esc(summary) + '</p>' + table,
      { head: '<span class="jh-note">GA4「Google のオーガニック検索クエリ」。行を押すと月別と対応記事</span>' }) + themesCard(st.month);
  }
  ACTIONS["q-month"] = function(m){ S.q.month = m; S.q.open = null; S.q.limit = 200; render(); };
  ACTIONS["q-filter"] = function(k){ S.q.filter = k; S.q.open = null; S.q.limit = 200; render(); };
  INPUTS["q-search"] = function(el){ S.q.search = el.value; S.q.limit = 200; render(); };
  ACTIONS["q-open"] = function(q){ S.q.open = S.q.open === q ? null : q; render(); };
  ACTIONS["q-task"] = function(arg){
    var parts = String(arg).split("||"), q = parts[0], slug = parts[1];
    var hist = (qHistory().map[q] || []).filter(Boolean), last = hist[hist.length - 1];
    var stat = last ? "（" + last.p.toFixed(1) + "位・表示" + last.i + "・クリック" + last.c + "）" : "";
    if (slug){
      var a = articles().filter(function(x){ return x.slug === slug; })[0];
      newPlanTask({
        type: "リライト", text: "リライト：" + (a ? a.title : slug), url: a ? a.link : "",
        remarks: "検索クエリ「" + q + "」" + stat + "。タイトル・説明文・見出しを検索意図に合わせる"
      });
    } else {
      var hasPost = relatedPosts(q).length > 0;
      newPlanTask({
        type: hasPost ? "リライト" : "新規記事",
        text: (hasPost ? "クエリ対策：" : "新規記事：") + "「" + q + "」",
        remarks: "検索クエリ「" + q + "」" + stat
      });
    }
  };

  /* ---------------- ページ（GA4 ページとスクリーン） ---------------- */
  function isArticlePath(path){
    if (S.posts){ var p = postByPath(path); return !!p && !p.notice; }
    return !/^\/($|category\/|tag\/|page\/|author\/|privacy-policy\/|contact\/|profile\/|about-jim-hack\/|online-support\/)/.test(path);
  }
  function diffHtml(cur, prev){
    if (prev == null) return '<span class="jh-faint">—</span>';
    if (!prev) return cur ? '<span class="jh-accent">新規</span>' : '<span class="jh-faint">—</span>';
    var d = cur - prev, pct = Math.round(d / prev * 100);
    return '<span class="' + (d >= 0 ? "jh-ok" : "jh-err") + '">' + (d >= 0 ? "+" : "") + fmtN(d) + '（' + (d >= 0 ? "+" : "") + pct + '%）</span>';
  }
  // ページ別。「ページとスクリーン」（PV・ユーザー・滞在）と「ランディングページ」（Google 検索のクリック・表示・CTR・順位）を
  // 同じ月・同じパスで横に並べる。どちらか片方しか無い月は、ある方の列だけ出す。
  function renderPages(){
    var set = {};
    Object.keys(S.pages).concat(Object.keys(S.landing)).forEach(function(x){ set[x] = 1; });
    var months = Object.keys(set).sort();
    if (!months.length){
      return card("ページ", '<div class="sched-empty">ページ別の CSV がまだありません。GA4 の「ページとスクリーン」または「Google オーガニック検索レポート: ランディング ページ」の CSV を取り込んでください。</div>');
    }
    var st = S.p;
    if (!st.month || !set[st.month]) st.month = months[months.length - 1];
    var m = st.month, hasPv = !!S.pages[m], hasLp = !!S.landing[m];
    var pvMonths = months.filter(function(x){ return S.pages[x]; });
    var pmaps = pvMonths.map(function(x){ var o = {}; S.pages[x].forEach(function(y){ o[y.page] = y.pv; }); return o; });
    var lpMonths = months.filter(function(x){ return S.landing[x]; });
    var lmaps = lpMonths.map(function(x){ var o = {}; S.landing[x].forEach(function(y){ o[y.page] = y; }); return o; });
    var prevPv = S.pages[addMonths(m, -1)] ? pmaps[pvMonths.indexOf(addMonths(m, -1))] : null;
    var lpNow = hasLp ? lmaps[lpMonths.indexOf(m)] : {};
    var byPage = {};
    (S.pages[m] || []).forEach(function(r){ byPage[r.page] = { page: r.page, pv: r.pv, users: r.users, sec: r.sec }; });
    (S.landing[m] || []).forEach(function(r){ if (!byPage[r.page]) byPage[r.page] = { page: r.page, pv: null, users: null, sec: null }; });
    var all = Object.keys(byPage).map(function(k){
      var r = byPage[k], post = postByPath(r.page), lp = lpNow[r.page];
      return Object.assign(r, {
        title: post ? post.title : "", post: post,
        prev: hasPv && prevPv && r.pv != null ? (prevPv[r.page] || 0) : null,
        sc: lp ? lp.c : null, si: lp ? lp.i : null, sctr: lp ? lp.t : null, spos: lp ? lp.p : null
      });
    });
    var rows = st.articlesOnly ? all.filter(function(r){ return isArticlePath(r.page); }) : all;
    if (!hasPv && /^(pv|users|sec|diff)$/.test(st.sort)){ st.sort = "sc"; st.dir = -1; }
    if (!hasLp && /^(sc|si|sctr|spos)$/.test(st.sort)){ st.sort = "pv"; st.dir = -1; }
    rows = sortRows(rows, st, {
      page: function(r){ return r.title || r.page; }, pv: function(r){ return r.pv; }, users: function(r){ return r.users; },
      sec: function(r){ return r.sec; }, diff: function(r){ return r.prev == null || r.pv == null ? 0 : r.pv - r.prev; },
      sc: function(r){ return r.sc; }, si: function(r){ return r.si; }, sctr: function(r){ return r.sctr; },
      spos: function(r){ return r.spos || 999; }
    });
    var parts = [];
    if (hasPv){
      var total = sum(S.pages[m], function(r){ return r.pv; });
      var artTotal = sum(S.pages[m].filter(function(r){ return isArticlePath(r.page); }), function(r){ return r.pv; });
      parts.push("PV " + fmtN(total) + "（記事 " + (total ? Math.round(artTotal / total * 100) : 0) + "%）");
    }
    if (hasLp){
      var ls = landingStats(m);
      parts.push("検索クリック " + fmtN(ls.c) + " ・ 表示 " + fmtN(ls.i) + " ・ CTR " + fmtPct(ls.ctr) + " ・ 平均 " + ls.pos.toFixed(1) + " 位");
    }
    parts.push(rows.length + " ページ");
    var monthOpts = months.slice().reverse().map(function(x){
      var pe = partialEnd("pages", x) || partialEnd("landing", x);
      var src = S.pages[x] && S.landing[x] ? "" : S.pages[x] ? "（PVのみ）" : "（検索のみ）";
      return '<option value="' + x + '"' + (x === m ? " selected" : "") + '>' + monthLabel(x) + (pe ? "（〜" + pe + "日）" : "") + src + '</option>';
    }).join("");
    var tool = '<div class="jh-toolrow"><div class="jh-form"><select class="jh-in" data-change="p-month">' + monthOpts + '</select>' +
      '<label class="jh-form jh-faint"><input type="checkbox" data-change="p-articles"' + (st.articlesOnly ? " checked" : "") + '> 記事だけ</label></div>' +
      '<span class="jh-summary">' + esc(parts.join(" ・ ")) + '</span></div>';
    var shown = rows.slice(0, st.limit);
    var body = shown.map(function(r){
      var titleCell = r.post
        ? '<a class="jh-link jh-cell-title" href="' + esc(r.post.link) + '" target="_blank" rel="noopener noreferrer" title="' + esc(r.page) + '">' + esc(r.title) + '</a><span class="jh-cell-sub">' + esc(r.page) + '</span>'
        : '<span class="jh-cell-title" title="' + esc(r.page) + '">' + esc(r.page) + '</span>';
      var lowCtr = r.si >= 500 && r.sctr < 1.5;
      var hist = hasLp
        ? lmaps.map(function(o){ return o[r.page] ? o[r.page].c : null; })
        : pmaps.map(function(o){ return o[r.page] != null ? o[r.page] : null; });
      return '<tr><td>' + titleCell + '</td>' +
        (hasPv
          ? '<td class="num">' + fmtN(r.pv) + '</td><td class="num">' + fmtN(r.users) + '</td>' +
            '<td class="num' + (r.sec != null && r.sec < 30 ? " jh-faint" : "") + '">' + (r.sec == null ? "—" : Math.round(r.sec)) + '</td>' +
            '<td class="num">' + (r.pv == null ? '<span class="jh-faint">—</span>' : diffHtml(r.pv, r.prev)) + '</td>'
          : "") +
        (hasLp
          ? '<td class="num' + (r.sc ? "" : " jh-faint") + '">' + fmtN(r.sc) + '</td><td class="num">' + fmtN(r.si) + '</td>' +
            '<td class="num' + (lowCtr ? " jh-warn" : "") + '">' + (r.sctr == null ? "—" : fmtPct(r.sctr)) + '</td>' +
            '<td class="num">' + (r.spos ? rankBadge(r.spos) : "—") + '</td>'
          : "") +
        '<td>' + spark(hist) + '</td>' +
        '<td class="num">' + (r.post ? (r.post.cta ? '<span class="jh-ok">✓</span>' : '<span class="jh-faint">—</span>') : "") + '</td></tr>';
    }).join("");
    var cols = 3 + (hasPv ? 4 : 0) + (hasLp ? 4 : 0);
    var head = th("ページ", "p", "page") +
      (hasPv ? th("PV", "p", "pv", true) + th("ユーザー", "p", "users", true) + th("滞在秒", "p", "sec", true) + th("前月比", "p", "diff", true) : "") +
      (hasLp ? th("検索クリック", "p", "sc", true) + th("表示", "p", "si", true) + th("CTR", "p", "sctr", true) + th("順位", "p", "spos", true) : "") +
      '<th>' + (hasLp ? "検索クリックの推移" : "PVの推移") + '</th><th class="num">導線</th>';
    var table = '<div class="jh-table-wrap"><table class="jh-table"><thead><tr>' + head + '</tr></thead><tbody>' +
      (body || '<tr><td colspan="' + cols + '" class="jh-faint">該当なし</td></tr>') + '</tbody></table></div>' +
      (rows.length > shown.length ? btn("さらに表示（残り " + (rows.length - shown.length) + " 件）", "more", "p", "jh-more") : "");
    return card("ページ", tool + table, {
      head: '<span class="jh-note">PV・ユーザー・滞在秒＝GA4「ページとスクリーン」／検索クリック・表示・CTR・順位＝「ランディングページ」。黄色の CTR＝表示500回以上で1.5%未満</span>'
    });
  }
  CHANGES["p-month"] = function(el){ S.p.month = el.value; S.p.limit = 200; render(); };
  CHANGES["p-articles"] = function(el){ S.p.articlesOnly = el.checked; render(); };

  /* ---------------- 計画（ポータルのタスク＋ネタ帳） ---------------- */
  var IDEA_ST = { stock: "候補", wip: "執筆中", done: "公開済み" };
  function taskType(t){
    var tags = t.tags || [];
    for (var i = 0; i < TASK_TYPES.length; i++) if (tags.indexOf(TASK_TYPES[i]) !== -1) return TASK_TYPES[i];
    return "";
  }
  function dueLabel(due, t){
    if (!due) return { text: "期限なし", over: false };
    var d = daysBetween(t, due);
    if (d < 0) return { text: (-d) + "日超過", over: true };
    if (d === 0) return { text: "今日", over: false };
    if (d === 1) return { text: "明日", over: false };
    return { text: mdShort(due) + "（あと" + d + "日）", over: false };
  }
  function renderPlan(){
    var tasks = planTasks(), t = todayKey(), cm = curMonth();
    var open = tasks.filter(function(x){ return !x.done; }), done = tasks.filter(function(x){ return x.done; });
    var groups = [
      { label: "期限切れ", warn: true, test: function(x){ return x.due && x.due < t; } },
      { label: "今週", test: function(x){ return x.due && x.due >= t && daysBetween(t, x.due) <= 7; } },
      { label: "それ以降", test: function(x){ return x.due && daysBetween(t, x.due) > 7; } },
      { label: "期限なし", test: function(x){ return !x.due; } }
    ];
    function rowHtml(x){
      var dl = dueLabel(x.due, t), ty = taskType(x);
      var dueText = x.done ? (x.completedAt ? "完了 " + mdShort(jstDateKey(new Date(x.completedAt))) : "完了") : dl.text;
      return '<div class="jh-task' + (x.done ? " is-done" : "") + '">' +
        '<button type="button" class="jh-task-check' + (x.done ? " is-done" : "") + '" data-act="task-toggle" data-arg="' + esc(x.id) + '" aria-label="' + (x.done ? "未完了に戻す" : "完了にする") + '">' + (x.done ? "✓" : "") + '</button>' +
        '<span class="jh-task-text" data-act="task-edit" data-arg="' + esc(x.id) + '" title="' + esc(x.text) + '">' + esc(x.text) + '</span>' +
        (ty ? '<span class="jh-tag' + (ty === "新規記事" ? " is-accent" : "") + '">' + esc(ty) + '</span>' : "") +
        (x.priority === "high" ? '<span class="jh-tag is-warn">高</span>' : "") +
        '<span class="jh-task-due' + (dl.over && !x.done ? " is-over" : "") + '">' + esc(dueText) + '</span></div>';
    }
    var listHtml;
    if (!tasks.length){
      listHtml = '<div class="sched-empty">まだ事務ハックのタスクはありません。上のボタンか、記事・検索クエリの「タスク化」から追加できます。' +
        'タスク管理で自由タグ「' + esc(PLAN_TAG) + '」を付けたタスクもここに出ます。</div>';
    } else {
      listHtml = groups.map(function(g){
        var xs = open.filter(g.test).sort(function(a, b){ return String(a.due || "9999").localeCompare(String(b.due || "9999")); });
        return xs.length ? '<div class="jh-plan-group' + (g.warn ? " is-warn" : "") + '">' + esc(g.label) + ' ・ ' + xs.length + '</div>' + xs.map(rowHtml).join("") : "";
      }).join("");
      if (done.length){
        listHtml += '<div class="jh-actions">' + btn(S.planShowDone ? "完了を隠す" : "完了 " + done.length + " 件を表示", "plan-done-toggle") + '</div>' +
          (S.planShowDone ? done.slice().sort(function(a, b){ return (b.completedAt || 0) - (a.completedAt || 0); }).map(rowHtml).join("") : "");
      }
    }
    var overdue = open.filter(groups[0].test).length;
    var doneThisMonth = done.filter(function(x){ return x.completedAt && jstDateKey(new Date(x.completedAt)).indexOf(cm) === 0; });
    var countBy = function(type){ return doneThisMonth.filter(function(x){ return taskType(x) === type; }).length; };
    var ideas = S.state.ideas;
    var kpis = '<section class="panel kpi-band">' +
      kpi("未完了", String(open.length), "期限切れ " + overdue + " 件", overdue ? "is-bad" : "", true) +
      kpi("今月完了", String(doneThisMonth.length), "新規記事 " + countBy("新規記事") + " ・ リライト " + countBy("リライト")) +
      kpi("ネタ帳", String(ideas.filter(function(i){ return i.st !== "done"; }).length), "執筆中 " + ideas.filter(function(i){ return i.st === "wip"; }).length) +
      kpi("今月の新規記事", S.posts ? String(articles().filter(function(a){ return a.date.indexOf(cm) === 0; }).length) : "—",
        S.state.goals.posts ? "目標 " + S.state.goals.posts + " 本" : "WordPress の公開数") +
      '</section>';
    var addBtns = '<div class="jh-actions" style="margin-top:0">' + TASK_TYPES.map(function(x){ return btn("＋ " + x, "plan-new", x); }).join("") + '</div>';
    return kpis + '<div class="jh-grid2">' +
      card("タスク", addBtns + listHtml, { head: '<span class="jh-note">ポータルのタスク（自由タグ「' + esc(PLAN_TAG) + '」）と同じもの</span>' }) +
      ideasCard() + '</div>';
  }
  function ideasCard(){
    var list = S.state.ideas;
    var form = '<div class="jh-form"><input type="text" class="jh-in jh-grow" maxlength="120" placeholder="記事タイトル案（Enter で追加）" data-keep="jh-idea-in" data-enter="idea-add">' +
      btn("追加", "idea-add", null, "is-primary") + '</div>';
    var rows = list.map(function(i){
      return '<div class="jh-idea' + (i.st === "done" ? " is-done" : "") + '">' +
        '<button type="button" class="jh-chip' + (i.st === "wip" ? " is-on" : "") + '" data-act="idea-cycle" data-arg="' + esc(i.id) + '" title="押すと 候補 → 執筆中 → 公開済み">' + esc(IDEA_ST[i.st] || "候補") + '</button>' +
        '<span class="jh-idea-title">' + esc(i.title) + '</span>' +
        (i.st !== "done" ? btn("タスク化", "idea-task", i.id) : "") + btn("✕", "idea-del", i.id, "is-danger") + '</div>';
    }).join("");
    return card("ネタ帳", form + (rows ? '<div style="margin-top:8px">' + rows + '</div>' : '<p class="jh-faint" style="margin:10px 0 0">思いついた記事タイトルを貯めておく場所です。</p>'),
      { head: '<span class="jh-note">' + list.length + ' 件</span>' });
  }
  function ideaById(id){ return S.state.ideas.filter(function(x){ return String(x.id) === String(id); })[0]; }
  ACTIONS["task-toggle"] = function(id){ CP.toggleTaskDoneById(id); };
  ACTIONS["task-edit"] = function(id){ CP.openEditTaskById(id); };
  ACTIONS["plan-done-toggle"] = function(){ S.planShowDone = !S.planShowDone; render(); };
  ACTIONS["idea-add"] = function(){
    var el = keepEl("jh-idea-in"), v = el && el.value.trim();
    if (!v) return;
    S.state.ideas.unshift({ id: uid(), title: v.slice(0, 120), st: "stock" });
    el.value = "";
    saveState();
    render();
  };
  ACTIONS["idea-cycle"] = function(id){
    var i = ideaById(id);
    if (!i) return;
    i.st = { stock: "wip", wip: "done", done: "stock" }[i.st] || "wip";
    saveState();
    render();
  };
  ACTIONS["idea-del"] = function(id){
    askConfirm("このネタを削除しますか？").then(function(ok){
      if (!ok) return;
      S.state.ideas = S.state.ideas.filter(function(x){ return String(x.id) !== String(id); });
      saveState();
      render();
    });
  };
  ACTIONS["idea-task"] = function(id){ var i = ideaById(id); if (i) newPlanTask({ type: "新規記事", text: "新規記事：" + i.title }); };

  /* ---------------- 収益 ---------------- */
  function statusCard(){
    var rows = STATUS_DEFS.map(function(d){
      var s = S.state.status[d.key] || { status: d.options[0] };
      var cls = s.status === "合格" ? " is-ok" : s.status === "要対策" ? " is-warn" : "";
      return '<div class="jh-status-row">' +
        '<span class="jh-status-name">' + esc(d.label) + ' <span class="jh-tag' + cls + '">' + esc(s.status) + '</span></span>' +
        '<select class="jh-in" data-change="st-status" data-arg="' + d.key + '">' +
          d.options.map(function(o){ return '<option' + (o === s.status ? " selected" : "") + '>' + esc(o) + '</option>'; }).join("") + '</select>' +
        '<input type="date" class="jh-in is-num" data-change="st-date" data-arg="' + d.key + '" value="' + esc(s.date || "") + '" title="申請日・結果が出た日">' +
        '<input type="text" class="jh-in" maxlength="100" data-change="st-note" data-arg="' + d.key + '" value="' + esc(s.note || "") + '" placeholder="メモ"></div>';
    }).join("");
    var ms = allMonths().filter(monthPV), lp = ms[ms.length - 1], pv = lp ? monthPV(lp).v : 0;
    var sim = '<div class="jh-sublabel" style="margin-top:14px">AdSense の目安</div>' +
      '<div class="jh-form"><span class="jh-faint">月間PV</span>' +
      '<input type="number" min="0" class="jh-in is-num" style="width:100px" data-keep="jh-sim-pv" data-input="sim" value="' + pv + '">' +
      '<span class="jh-faint">× RPM</span><input type="number" min="0" class="jh-in is-num" style="width:80px" data-keep="jh-sim-rpm" data-input="sim" value="150">' +
      '<span class="jh-faint">円 ＝</span><strong class="jh-accent" id="jh-sim-out"></strong></div>' +
      '<p class="jh-legend">RPM（1,000PV あたりの収益）は事務系ブログで 100〜300 円程度が目安。オンライン事務の受注1件の単価と見比べる用です。</p>';
    return card("収益化の状況", rows + sim);
  }
  function setStatusField(el, field){
    var k = el.getAttribute("data-arg");
    var s = Object.assign({ status: "未申請", date: "", note: "" }, S.state.status[k] || {});
    s[field] = el.value;
    S.state.status[k] = s;
    saveState();
    if (field === "status") render();
  }
  CHANGES["st-status"] = function(el){ setStatusField(el, "status"); };
  CHANGES["st-date"] = function(el){ setStatusField(el, "date"); };
  CHANGES["st-note"] = function(el){ setStatusField(el, "note"); };
  function updateSim(){
    var pv = keepEl("jh-sim-pv"), rpm = keepEl("jh-sim-rpm"), out = $("jh-sim-out");
    if (!pv || !rpm || !out) return;
    var v = Math.round((+pv.value || 0) / 1000 * (+rpm.value || 0));
    out.textContent = "月 " + fmtYen(v) + " ・ 年 " + fmtYen(v * 12);
  }
  INPUTS["sim"] = function(){ updateSim(); };

  function renderRevenue(){
    var rv = S.state.revenue, cm = curMonth(), pm = addMonths(cm, -1), yr = cm.slice(0, 4);
    var total = sum(rv, function(r){ return +r.amount; });
    var html = '<section class="panel kpi-band">' +
      kpi("今月", fmtYen(revenueIn(cm)), S.state.goals.revenue ? "目標 " + fmtYen(S.state.goals.revenue) : monthLabel(cm), "", true) +
      kpi("先月", fmtYen(revenueIn(pm)), monthLabel(pm)) +
      kpi(yr + "年", fmtYen(revenueIn(yr)), rv.filter(function(r){ return String(r.date).indexOf(yr) === 0; }).length + " 件") +
      kpi("累計", fmtYen(total), rv.length + " 件") + '</section>';
    var form = '<div class="jh-form">' +
      '<input type="date" class="jh-in is-num" data-keep="jh-rv-date" value="' + todayKey() + '">' +
      '<select class="jh-in" data-keep="jh-rv-type">' + REVENUE_TYPES.map(function(x){ return '<option>' + esc(x) + '</option>'; }).join("") + '</select>' +
      '<input type="number" min="1" class="jh-in is-num" style="width:120px" placeholder="金額（円）" data-keep="jh-rv-amt">' +
      '<input type="text" class="jh-in jh-grow" maxlength="100" placeholder="メモ（任意）" data-keep="jh-rv-memo" data-enter="rv-add">' +
      btn("追加", "rv-add", null, "is-primary") + '</div>';
    var ms = [];
    for (var i = 11; i >= 0; i--) ms.push(addMonths(cm, -i));
    var chart = total
      ? bars(ms, ms.map(function(m){ return revenueIn(m) || null; }), function(v){ return "¥" + fmtK(v); }, null, true)
      : '<div class="jh-faint">記録を追加すると月別の棒が出ます</div>';
    var byType = REVENUE_TYPES.map(function(ty){
      var xs = rv.filter(function(r){ return r.type === ty; });
      return { ty: ty, n: xs.length, v: sum(xs, function(r){ return +r.amount; }) };
    }).filter(function(x){ return x.n; });
    var typeHtml = byType.length
      ? '<table class="jh-mini-table" style="margin-top:10px"><thead><tr><th>種別</th><th>件数</th><th>累計</th><th>割合</th></tr></thead><tbody>' +
        byType.map(function(x){ return '<tr><td>' + esc(x.ty) + '</td><td>' + x.n + '</td><td>' + fmtYen(x.v) + '</td><td>' + (total ? Math.round(x.v / total * 100) : 0) + '%</td></tr>'; }).join("") +
        '</tbody></table>'
      : "";
    var rows = rv.slice().sort(function(a, b){ return String(b.date).localeCompare(String(a.date)); }).map(function(r){
      return '<tr><td class="num">' + esc(String(r.date).replace(/-/g, "/")) + '</td><td>' + esc(r.type) + '</td>' +
        '<td class="num">' + fmtYen(+r.amount) + '</td><td class="jh-faint">' + esc(r.memo || "") + '</td>' +
        '<td class="num">' + btn("✕", "rv-del", r.id, "is-danger") + '</td></tr>';
    }).join("");
    var table = rows
      ? '<div class="jh-table-wrap" style="margin-top:10px;max-height:360px"><table class="jh-table"><thead><tr><th class="num">日付</th><th>種別</th><th class="num">金額</th><th>メモ</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'
      : '<p class="jh-faint" style="margin:10px 0 0">まだ記録がありません。</p>';
    return html + '<div class="jh-grid2">' +
      card("収益の記録", form + '<div class="jh-bars-title" style="margin-top:12px">月別（直近12か月）</div>' + chart + typeHtml + table) +
      statusCard() + '</div>';
  }
  ACTIONS["rv-add"] = function(){
    var d = keepEl("jh-rv-date"), ty = keepEl("jh-rv-type"), a = keepEl("jh-rv-amt"), m = keepEl("jh-rv-memo");
    if (!d || !ty || !a || !m) return;
    var amt = Math.round(+a.value || 0);
    if (!d.value || amt < 1){ setStatus(!d.value ? "日付を入れてください" : "1円以上の金額を入れてください", "err"); return; }
    S.state.revenue.push({ id: uid(), date: d.value, type: ty.value, amount: amt, memo: m.value.trim().slice(0, 100) });
    a.value = "";
    m.value = "";
    saveState();
    render();
  };
  ACTIONS["rv-del"] = function(id){
    askConfirm("この収益の記録を削除しますか？").then(function(ok){
      if (!ok) return;
      S.state.revenue = S.state.revenue.filter(function(r){ return String(r.id) !== String(id); });
      saveState();
      render();
    });
  };

  CP.initJimuhack = function(){
    wire();
    render();
    loadData();
    loadPosts();
  };
  CP.renderJimuhack = function(){
    render();
    loadPosts();
  };
})();
