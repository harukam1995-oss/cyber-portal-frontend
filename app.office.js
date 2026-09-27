/* ================= AIオフィス — app.office.js =================
   プライベートの QUICK ACCESS「AIオフィス」と、HOME の INBOX「オーナーの出番」から開く #view-office。
   初回に app.js の loadModuleOnce() が注入する（index.html にも sw.js の SHELL にも入れない。app.smallbiz.js と同じ扱い）。

   何を出すか
   ・Claude の会話ごとの状態（作業中・確認待ち・完了）を、5人のキャラ（本部3人・制作部2人）に割り当てて見せる。
   ・データは /api/office（Firestore users/{uid}/office/state）。書くのは Claude Code のフック
     （~/.claude/office/office-status.mjs → POST /api/office/ingest）。画面からは書かない。
   ・「待機中」は保存されない。完了から OF_DONE_MS たったもの、止まったままの作業中を、ここで待機中として出す。
   ・読み取りは開いたときと「再読み込み」だけ（Firestore の読み取り上限があるので自動では読み直さない）。

   見た目
   ・この画面だけデザイン方針（B/アンバー）の例外（2026-09-27 オーナー判断）。スタイルは office.css に閉じ込め、
     style.css には書かない。部屋（.of-room）の外側のツールバーはポータルの部品のまま。 */
(function(){
  "use strict";

  var CP = window.__CP;
  var escapeHtml = CP.escapeHtml;
  var apiFetch = CP.apiFetch;
  var apiErrorMessage = CP.apiErrorMessage;

  var OF_REVIEW_MS = 48 * 3600 * 1000; // 確認待ちはこの間だけ出す
  var OF_WORK_MS = 3 * 3600 * 1000;    // 作業中の知らせが来てからこれ以上たったら止まったとみなす
  var OF_DONE_MS = 2 * 3600 * 1000;    // 完了はこの間だけ出し、あとは待機中

  var ST = {
    work:   { label: "作業中",   rank: 3 },
    review: { label: "確認待ち", rank: 4 },
    done:   { label: "完了",     rank: 2 },
    idle:   { label: "待機中",   rank: 1 }
  };
  // 仕事の種類（フックが送る job）。色は office.css の .of-b-<key>
  var JOB = {
    secretary: "秘書の仕事", money: "お金まわり", client: "客先", tidy: "片付け",
    game: "ゲーム工房", stock: "素材スタジオ", blog: "事務ハック", portal: "ポータル", research: "調査"
  };

  var DEPTS = [
    { id: "hq", name: "本部", desc: "報告・お金・事務。毎日の土台を回す3人。", members: [
      { id: "koharu", n: "コハル", role: "秘書", model: "Opus", jobs: [
        { t: "タスク管理", s: "やることリスト・週末の予定", r: "判断はオーナーに残し、推奨を添える。" },
        { t: "朝の報告", s: "daily-standup", r: "結論から書く。確かめたことと推測を分ける。" },
        { t: "Slackダイジェスト", s: "予約タスク：毎日 9・13・16・18時", r: "要約してポータルに書く。返信はしない。" },
        { t: "判断待ちの見直し", s: "予約タスク：毎週日曜 9時", r: "「今週決めること」を書き換える。" }
      ] },
      { id: "ritsu", n: "リツ", role: "経理", model: "Opus", jobs: [
        { t: "MF会計の仕訳", s: "MF会計（MCP接続）", r: "最初の月は下書きまで。オーナーが承認する。" },
        { t: "請求書・領収書", s: "決まったファイル名で保存", r: "送信はオーナーがする。" },
        { t: "確定申告・e-Tax", s: "作成コーナーの操作", r: "提出ボタンはオーナーが押す。" },
        { t: "口座まわり", s: "屋号口座への切り替えなど", r: "お金の移動はしない。一覧と手順を作るだけ。" }
      ] },
      { id: "shiori", n: "シオリ", role: "事務係", model: "Opus・Sonnet", jobs: [
        { t: "客先業務", b: "client", s: "調査・報告・議事録・手順書", r: "読むだけで調べ、日付つきで報告して待つ。取引先名や契約は外に書かない。" },
        { t: "片付け", b: "tidy", s: "ダウンロード仕分け（毎週日曜 21時）・ドライブ・メール・保管庫の点検", r: "移動と整理まで。削除はしない。機密ノートは開かない。" }
      ] }
    ] },
    { id: "make", name: "制作部", desc: "ゲーム・素材・記事・ポータル。考えて見る人と、作る人を分けた2人。", members: [
      { id: "akane", n: "アカネ", role: "企画・評価係", model: "Opus", jobs: [
        { t: "ゲームの企画と評価", b: "game", s: "webgame-build", r: "方針7項目と3つのゲートを通す。" },
        { t: "素材の企画と提出前点検", b: "stock", s: "vector-submit", r: "企画ゲートと提出前ゲートで、落ちるものを止める。" },
        { t: "記事の企画と点検", b: "blog", s: "jimu-hack-post", r: "ペンネームで書く。屋号は出さない。" },
        { t: "調査", b: "research", s: "市場・トレンド・却下理由の分析", r: "数字と出典で書く。" }
      ] },
      { id: "momo", n: "モモ", role: "制作係", model: "Sonnet・Opus", jobs: [
        { t: "ゲームの実装", b: "game", s: "設計が絡むものは Opus", r: "原因が分かっているバグから直す。" },
        { t: "素材SVG", b: "stock", s: "企画確定後の量産は Sonnet", r: "企画にないものは描かない。" },
        { t: "記事・アイキャッチ", b: "blog", s: "本文は Opus、画像は Sonnet", r: "WordPress は下書き保存のみ。" },
        { t: "ポータル", b: "portal", s: "個人のポータルサイト", r: "データを何度も読みに行かない。" }
      ] }
    ] }
  ];

  var S = { loading: false, loaded: false, err: null, sessions: [], updatedAt: null, tab: "all" };
  var SELF_Q = (function(){
    var cs = document.currentScript;
    var m = cs && cs.src ? /\?v=(\d+)/.exec(cs.src) : null;
    return m ? "?v=" + m[1] : "";
  })();

  function $(id){ return document.getElementById(id); }
  function setStatus(text){ var el = $("of-status"); if (el) el.textContent = text; }
  function fmtTime(ms){
    if (!ms) return "";
    var p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
      .formatToParts(new Date(ms)).reduce(function(a, x){ a[x.type] = x.value; return a; }, {});
    return Number(p.month) + "/" + Number(p.day) + " " + (p.hour === "24" ? "00" : p.hour) + ":" + p.minute;
  }
  function imgOf(id, st){ return "img/office/" + id + "-" + st + ".webp"; }

  // 画面で使う状態。止まった作業中・古い完了は待機中に落とす（保存はしない）。
  function effective(s, now){
    var age = now - (s.at || 0);
    if (s.state === "review" && age < OF_REVIEW_MS) return "review";
    if (s.state === "work" && age < OF_WORK_MS) return "work";
    if (s.state === "done" && age < OF_DONE_MS) return "done";
    return "idle";
  }
  function memberView(m, now){
    var list = S.sessions.filter(function(s){ return s.member === m.id; })
      .map(function(s){ return { s: s, st: effective(s, now) }; })
      .sort(function(a, b){ return (b.s.at || 0) - (a.s.at || 0); });
    var best = null;
    list.forEach(function(x){ if (!best || ST[x.st].rank > ST[best.st].rank) best = x; });
    var st = best ? best.st : "idle";
    return {
      st: st,
      top: best && st !== "idle" ? best.s : null,
      working: list.filter(function(x){ return x.st === "work"; }).length,
      list: list
    };
  }

  async function load(){
    if (S.loading) return;
    S.loading = true;
    setStatus("読み込み中…");
    try {
      var r = await apiFetch("/api/office");
      S.sessions = r && Array.isArray(r.sessions) ? r.sessions : [];
      S.updatedAt = r && r.updatedAt ? r.updatedAt : null;
      S.err = null;
      S.loaded = true;
      setStatus(S.updatedAt ? "最後の知らせ " + fmtTime(S.updatedAt) : "まだ知らせがありません");
      if (typeof CP.applyHomeOffice === "function") CP.applyHomeOffice(r);
    } catch (err) {
      S.err = err;
      setStatus(apiErrorMessage(err, "AIオフィス"));
    } finally {
      S.loading = false;
    }
    render();
  }

  function stTag(st){
    return '<span class="of-tag of-st of-st-' + st + '"><i></i>' + ST[st].label + '</span>';
  }
  function jobTag(key, pre){
    if (!JOB[key]) return "";
    return '<span class="of-tag of-job of-b-' + key + '"><span class="of-dot"></span>' + escapeHtml((pre || "") + JOB[key]) + '</span>';
  }
  function modelTag(model){
    return '<span class="of-tag ' + (/^Opus/.test(model) ? "of-m-opus" : "of-m-sonnet") + '">' + escapeHtml(model) + '</span>';
  }

  function card(m, v){
    var kinds = [];
    m.jobs.forEach(function(j){ if (j.b && kinds.indexOf(j.b) === -1) kinds.push(j.b); });
    var jobs = kinds.length ? kinds.map(function(k){ return jobTag(k); }).join("")
      : m.jobs.map(function(j){ return '<span class="of-tag">' + escapeHtml(j.t) + '</span>'; }).join("");
    var doing = "";
    if (v.top){
      doing = '<div class="of-doing">' + (v.top.job ? jobTag(v.top.job, "いま：") : "") +
        escapeHtml(v.top.text || "") + '<span class="of-time">' + escapeHtml(fmtTime(v.top.at)) + '</span>' +
        (v.working > 1 ? '<span class="of-more">ほかに作業中 ' + (v.working - 1) + '件</span>' : "") + '</div>';
    }
    return '<button type="button" class="of-card of-s-' + v.st + '" data-id="' + m.id + '">' +
      '<span class="of-av"><img src="' + imgOf(m.id, v.st) + '" alt="' + escapeHtml(m.n + "（" + ST[v.st].label + "）") + '" width="320" height="320" loading="lazy"></span>' +
      '<span class="of-info">' +
        '<span class="of-nrow"><span class="of-name">' + escapeHtml(m.n) + '</span><span class="of-role">' + escapeHtml(m.role) + '</span></span>' +
        '<span class="of-tags">' + stTag(v.st) + modelTag(m.model) + '</span>' +
        doing +
        '<span class="of-jobs">' + jobs + '</span>' +
      '</span></button>';
  }

  function render(){
    var host = $("of-body");
    if (!host) return;
    if (S.err && !S.loaded){
      host.innerHTML = '<div class="of-room"><div class="of-empty"><p>読み込めませんでした。</p><p>' +
        escapeHtml(apiErrorMessage(S.err, "AIオフィス")) + '</p></div></div>';
      return;
    }
    if (!S.loaded){ host.innerHTML = ""; return; }
    var now = Date.now();
    var views = {};
    DEPTS.forEach(function(d){ d.members.forEach(function(m){ views[m.id] = memberView(m, now); }); });

    var reviews = [];
    DEPTS.forEach(function(d){ d.members.forEach(function(m){
      views[m.id].list.forEach(function(x){ if (x.st === "review") reviews.push({ m: m, s: x.s }); });
    }); });
    var turn = reviews.length ? '<div class="of-turn"><strong>オーナーの出番 ' + reviews.length + '件</strong>' +
      reviews.map(function(r){
        return '<span class="of-turn-item">' + escapeHtml(r.m.n) + '：' + escapeHtml(r.s.text || "確認をお願いします") +
          '<span class="of-time">' + escapeHtml(fmtTime(r.s.at)) + '</span>' +
          '<button type="button" class="of-open" data-id="' + r.m.id + '">見る</button></span>';
      }).join("") + '</div>' : "";

    var tabs = [{ id: "all", name: "全体", members: [] }].concat(DEPTS);
    var tabHtml = '<div class="of-tabs" role="tablist">' + tabs.map(function(t){
      var ms = t.id === "all" ? DEPTS.reduce(function(a, d){ return a.concat(d.members); }, []) : t.members;
      var wk = ms.filter(function(m){ return views[m.id].st === "work"; }).length;
      var rv = ms.filter(function(m){ return views[m.id].st === "review"; }).length;
      return '<button type="button" role="tab" class="of-tab of-tab-' + t.id + '" data-tab="' + t.id + '" aria-selected="' + (S.tab === t.id) + '">' +
        '<span class="of-dot"></span>' + escapeHtml(t.name) +
        (wk ? '<span class="of-badge of-badge-work" title="作業中">' + wk + '</span>' : "") +
        (rv ? '<span class="of-badge of-badge-review" title="確認待ち">' + rv + '</span>' : "") + '</button>';
    }).join("") + '</div>';

    var legend = '<div class="of-legend">' + ["work", "review", "done", "idle"].map(function(k){
      return '<span><span class="of-dot of-st-' + k + '"></span>' + ST[k].label + '</span>';
    }).join("") + '</div>';

    var depts = DEPTS.filter(function(d){ return S.tab === "all" || S.tab === d.id; }).map(function(d){
      return '<section class="of-dept of-dept-' + d.id + '"><div class="of-dhead"><span class="of-dname">' + escapeHtml(d.name) + '</span>' +
        '<span class="of-ddesc">' + escapeHtml(d.desc) + '</span></div>' +
        '<div class="of-grid">' + d.members.map(function(m){ return card(m, views[m.id]); }).join("") + '</div></section>';
    }).join("");

    var empty = S.sessions.length ? "" : '<p class="of-note">まだ知らせがありません。Claude の会話が動くと、ここに状態が出ます。</p>';
    host.innerHTML = '<div class="of-room">' + '<div class="of-head"><h2 class="of-title"><small>Claude の5人チーム</small>ちいさなAIオフィス</h2>' + legend + '</div>' +
      turn + empty + tabHtml + depts + '</div>' + modalShell();
  }

  function modalShell(){
    return '<div class="of-modal" id="of-modal" hidden><div class="of-modal-box" role="dialog" aria-modal="true" aria-labelledby="of-modal-name" id="of-modal-body"></div></div>';
  }
  function openMember(id){
    var m = null, d = null;
    DEPTS.forEach(function(dd){ dd.members.forEach(function(mm){ if (mm.id === id){ m = mm; d = dd; } }); });
    if (!m) return;
    var v = memberView(m, Date.now());
    var box = $("of-modal-body"), wrap = $("of-modal");
    if (!box || !wrap) return;
    var recent = v.list.slice(0, 8).map(function(x){
      return '<li><span class="of-time">' + escapeHtml(fmtTime(x.s.at)) + '</span>' + stTag(x.st) + (x.s.job ? jobTag(x.s.job) : "") +
        '<span>' + escapeHtml(x.s.text || "") + '</span></li>';
    }).join("");
    box.innerHTML =
      '<div class="of-mtop"><span class="of-av of-av-lg"><img src="' + imgOf(m.id, v.st) + '" alt=""></span>' +
        '<div><div class="of-role">' + escapeHtml(d.name) + '</div><h3 id="of-modal-name">' + escapeHtml(m.n) + '</h3>' +
        '<div class="of-role">' + escapeHtml(m.role + "・" + m.model) + '</div><div class="of-tags">' + stTag(v.st) + '</div></div></div>' +
      '<div class="of-sec">4つの状態</div><div class="of-poses">' + ["work", "review", "done", "idle"].map(function(k){
        return '<figure class="' + (k === v.st ? "is-cur" : "") + '"><img src="' + imgOf(m.id, k) + '" alt="' + escapeHtml(m.n + "（" + ST[k].label + "）") + '" loading="lazy"><figcaption>' + ST[k].label + '</figcaption></figure>';
      }).join("") + '</div>' +
      '<div class="of-sec">最近の会話</div>' + (recent ? '<ul class="of-recent">' + recent + '</ul>' : '<p class="of-note">この3日の記録はありません。</p>') +
      '<div class="of-sec">受け持つ仕事と決まり</div><ul class="of-joblist">' + m.jobs.map(function(j){
        return '<li><span class="of-jt">' + (j.b ? '<span class="of-dot of-b-' + j.b + '"></span>' : "") + escapeHtml(j.t) + '</span>' +
          '<span class="of-js">' + escapeHtml(j.s) + '</span><span class="of-jr">' + escapeHtml(j.r) + '</span></li>';
      }).join("") + '</ul>' +
      '<button type="button" class="of-close" id="of-modal-close">閉じる</button>';
    wrap.hidden = false;
    var c = $("of-modal-close");
    if (c) c.focus();
  }
  function closeMember(){ var w = $("of-modal"); if (w) w.hidden = true; }

  function ensureStyle(){
    if ($("of-style")) return;
    var fonts = document.createElement("link");
    fonts.rel = "stylesheet";
    fonts.href = "https://fonts.googleapis.com/css2?family=M+PLUS+Rounded+1c:wght@500;800&family=Zen+Maru+Gothic:wght@500;700&display=swap";
    document.head.appendChild(fonts);
    var css = document.createElement("link");
    css.rel = "stylesheet";
    css.id = "of-style";
    css.href = "office.css" + SELF_Q;
    document.head.appendChild(css);
  }

  function wire(){
    var btn = $("of-reload");
    if (btn) btn.addEventListener("click", load);
    var host = $("of-body");
    if (!host) return;
    host.addEventListener("click", function(e){
      var t = e.target && e.target.closest ? e.target : null;
      if (!t) return;
      var tab = t.closest(".of-tab");
      if (tab){ S.tab = tab.getAttribute("data-tab"); render(); return; }
      var open = t.closest(".of-card, .of-open");
      if (open){ openMember(open.getAttribute("data-id")); return; }
      if (t.closest("#of-modal-close") || t.id === "of-modal") closeMember();
    });
    CP.registerEscModal("of-modal", closeMember);
  }

  CP.initOffice = function(){ ensureStyle(); wire(); load(); };
  // 開き直すたびに取り直す（フックが別の場所から書いているため）。
  CP.renderOffice = function(){ load(); };
  CP.openOfficeMember = function(id){ openMember(id); };
})();
