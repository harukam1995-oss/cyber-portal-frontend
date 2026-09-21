/* ================= スモビジ（小規模事業）ダッシュボード — app.smallbiz.js =================
   プライベートの QUICK ACCESS「スモビジ」から開く #view-smallbiz。初回に app.js の loadModuleOnce() が注入する
   （index.html にも sw.js の SHELL にも入れない。app.jimuhack.js と同じ扱い）。

   データの置き場所
   ・/api/smallbiz（Firestore users/{uid}/smallbiz/state）… 事業ごとの状態・数字・次にやること・判断待ち・撤退基準・リンク
   ・正は Obsidian の各事業 INDEX（03_仕事/個人事業/…）。Claude が丸ごと置き換える。経路は2つ：
       PUT /api/smallbiz/ingest/state（X-Ingest-Token。Claude のセッションから直接。ふだんはこちら）
       __CP.smallbizPut(state)（オーナーのブラウザから。手当て用に残す）
     事業の数字は公開の GitHub Pages（このファイル）には書かない。
   ・画面からの編集は持たない（オーナーは読んで判断するだけ、という運用のため）。 */
(function(){
  "use strict";

  var CP = window.__CP;
  var escapeHtml = CP.escapeHtml;
  var apiFetch = CP.apiFetch;
  var apiErrorMessage = CP.apiErrorMessage;

  var S = { loading: false, loaded: false, err: null, state: null, updatedAt: null, openExits: {} };

  // 状態の表示。色は意味色だけ（デザイン方針「色を増やさない」）。
  var STATUS_TONE = { "稼働中": "ok", "検証中": "ok", "準備中": "", "検討中": "", "保留": "warn", "凍結": "warn", "撤退": "err" };
  // 「稼働中」として数えるものは許可リストで持つ。除外リスト方式だと、新しい状態（凍結など）を
  // 足したときに黙って稼働中へ数えられ、目標の合計まで膨らむ（2026-09-16 修正）。
  var ACTIVE_STATUS = { "稼働中": 1, "検証中": 1, "準備中": 1, "検討中": 1 };
  function isActive(b){ return ACTIVE_STATUS[String(b && b.status || "")] === 1; }

  function $(id){ return document.getElementById(id); }
  function setStatus(text){ var el = $("sb-status"); if (el) el.textContent = text; }
  function yen(n){ return (n < 0 ? "−¥" : "¥") + Math.abs(Math.round(n)).toLocaleString("ja-JP"); }
  function isNum(n){ return typeof n === "number" && isFinite(n); }
  function safeUrl(u){ u = String(u || ""); return /^(https?:\/\/|obsidian:\/\/)/i.test(u) ? u : ""; }
  // 判定日。"YYYY-MM-DD" だけを日付として扱う（「提出日＋60日」等はそのまま文字で出す）。
  function dueDate(v){
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ""));
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  }
  function dueText(v){ return String(v || "").replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$1/$2/$3"); }
  // その事業でいちばん近い「これから来る判定日」。過ぎたものは出さない。
  function nextDue(b){
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var best = null;
    (b.exits || []).forEach(function(e){
      var d = dueDate(e.due);
      if (d && d >= today && (!best || d < best.d)) best = { d: d, e: e };
    });
    return best;
  }
  // 前回との差。値は "37点" "¥0" "$0.00" "38,046" のような文字なので、最初の数字だけ取り出して比べる。
  // 増減の良し悪しは項目による（却下が増えるのは悪い）ので、色は付けずに数字だけ出す。
  // NFKC（全角数字・全角マイナス「－」）のあと、− ▲ △ もマイナスとして読む（"−¥1,200" "▲500"）。¥ $ は数字の前でも外す
  function numOf(v){
    var s = String(v == null ? "" : v).normalize("NFKC")
      .replace(/[−‐‒–▲△]/g, "-").replace(/[,¥$]/g, "");
    var m = s.match(/-?\d+(\.\d+)?/);
    return m ? Number(m[0]) : null;
  }
  function deltaOf(b, m){
    var prev = b.prev && b.prev.metrics ? b.prev.metrics[m.label] : null;
    if (prev == null) return null;
    var was = numOf(prev), now = numOf(m.value);
    if (was === null || now === null || was === now) return null;
    var d = Math.round((now - was) * 100) / 100;
    return { text: (d > 0 ? "+" : "−") + Math.abs(d).toLocaleString("ja-JP"), was: prev };
  }
  function prevStamp(b){
    if (!b.prev || !b.prev.at) return "";
    var d = new Date(b.prev.at);
    return isFinite(d) ? fmtStamp(b.prev.at).slice(0, 10) : "";
  }
  function fmtStamp(ms){
    if (!ms) return "";
    // 端末のタイムゾーンではなく日本時間で出す（他の画面と揃える）
    var p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
      .formatToParts(new Date(ms)).reduce(function(a, x){ a[x.type] = x.value; return a; }, {});
    return p.year + "/" + p.month + "/" + p.day + " " + (p.hour === "24" ? "00" : p.hour) + ":" + p.minute;
  }

  async function load(){
    if (S.loading) return;
    S.loading = true;
    setStatus("読み込み中…");
    try {
      var r = await apiFetch("/api/smallbiz");
      S.state = r && r.state ? r.state : null;
      S.updatedAt = S.state && S.state.updatedAt ? S.state.updatedAt : null;
      S.err = null;
      S.loaded = true;
      setStatus(S.updatedAt ? "更新 " + fmtStamp(S.updatedAt) : "未登録");
    } catch (err) {
      S.err = err;
      setStatus(apiErrorMessage(err, "スモビジ"));
    } finally {
      S.loading = false;
    }
    render();
  }

  function render(){
    var host = $("sb-body");
    if (!host) return;
    if (S.err && !S.loaded){
      host.innerHTML = '<section class="panel sb-empty"><p>読み込めませんでした。</p><p class="sb-faint">' +
        escapeHtml(apiErrorMessage(S.err, "スモビジ")) + '</p></section>';
      return;
    }
    if (!S.loaded){ host.innerHTML = ""; return; }
    var biz = (S.state && Array.isArray(S.state.businesses)) ? S.state.businesses : [];
    if (!biz.length){
      host.innerHTML = '<section class="panel sb-empty"><p>まだ事業のデータがありません。</p>' +
        '<p class="sb-faint">Claude が各事業の INDEX（Obsidian）から内容を登録します。</p></section>';
      return;
    }
    host.innerHTML = renderSummary(biz) + renderJumps(biz) + biz.map(renderBusiness).join("") +
      (S.state.note ? '<p class="sb-footnote">' + escapeHtml(S.state.note) + '</p>' : "");
  }

  function renderSummary(biz){
    var active = biz.filter(isActive).length;
    var profit = 0, goal = 0, hasProfit = false;
    var decisions = 0, ownerNext = 0, soonest = null;
    biz.forEach(function(b){
      if (isNum(b.profitThisMonth)){ profit += b.profitThisMonth; hasProfit = true; }
      // 目標の合計は動いている事業だけ（保留・凍結・撤退の目標を足すと実態より大きく見えるため）。
      if (isNum(b.goalMonthlyProfit) && isActive(b)) goal += b.goalMonthlyProfit;
      decisions += (b.decisions || []).length;
      ownerNext += (b.next || []).filter(function(n){ return /オーナー/.test(n.owner || ""); }).length;
      var nd = nextDue(b);
      if (nd && (!soonest || nd.d < soonest.d)) soonest = { d: nd.d, due: nd.e.due, name: b.name };
    });
    function kpi(label, value, cls){
      return '<div class="kpi"><span class="kpi-label">' + escapeHtml(label) + '</span><span class="kpi-value' +
        (cls ? " " + cls : "") + '">' + escapeHtml(value) + '</span></div>';
    }
    // 「次の判定」＝全事業でいちばん近い判定日（Obsidian の判定カレンダーと同じもの）。
    // 撤退・変更ルールは条件式だけだと「いつ見るか」が決まらないので、日付を1枚目に出す。
    var judge = soonest ? dueText(soonest.due) : "—";
    return '<section class="panel kpi-band sb-kpis">' +
      kpi("稼働中の事業", active + " / " + biz.length) +
      kpi("今月の入り（合計）", hasProfit ? yen(profit) : "—", profit > 0 ? "is-income" : "") +
      kpi("目標（稼働中・月）", goal ? yen(goal) : "—") +
      kpi("次の判定", judge, soonest ? "sb-warn" : "") +
      kpi("判断待ち / オーナー作業", decisions + " / " + ownerNext, decisions ? "sb-warn" : "") +
      '</section>' +
      (soonest ? '<p class="sb-footnote">次の判定：' + escapeHtml(dueText(soonest.due)) + '　' + escapeHtml(soonest.name) + '</p>' : "");
  }

  // 事業名のジャンプ行。hash は showView() のルーティングが使っているので、
  // <a href="#..."> ではなくボタン＋scrollIntoView にする（hash を書くと画面が切り替わってしまう）。
  function renderJumps(biz){
    if (biz.length < 3) return "";
    return '<nav class="sb-jumps">' + biz.map(function(b, i){
      var key = b.id || String(i);
      var tone = STATUS_TONE.hasOwnProperty(b.status) ? STATUS_TONE[b.status] : "";
      return '<button type="button" class="sb-jump' + (tone ? " is-" + tone : "") + '" data-key="' + escapeHtml(key) +
        '">' + escapeHtml(b.name) + '</button>';
    }).join("") + '</nav>';
  }

  function renderBusiness(b, idx){
    var tone = STATUS_TONE.hasOwnProperty(b.status) ? STATUS_TONE[b.status] : "";
    var goal = isNum(b.goalMonthlyProfit) ? b.goalMonthlyProfit : null;
    var profit = isNum(b.profitThisMonth) ? b.profitThisMonth : null;
    var pct = goal && profit != null ? Math.max(0, Math.min(1, profit / goal)) : 0;
    var segs = "";
    for (var i = 0; i < 10; i++) segs += '<i class="' + (i < Math.round(pct * 10) ? "on" : "") + '"></i>';

    var pstamp = prevStamp(b);
    var metrics = (b.metrics || []).map(function(m){
      var d = deltaOf(b, m);
      return '<div class="sb-metric' + (m.tone ? " is-" + m.tone : "") + '">' +
        '<span class="sb-metric-label">' + escapeHtml(m.label) + '</span>' +
        '<span class="sb-metric-value">' + escapeHtml(m.value) +
          (d ? '<span class="sb-delta" title="' + escapeHtml(pstamp + " は " + d.was) + '">' + escapeHtml(d.text) + '</span>' : "") +
        '</span>' +
        (m.note ? '<span class="sb-metric-note">' + escapeHtml(m.note) + '</span>' : "") + '</div>';
    }).join("");

    var next = (b.next || []).map(function(n){
      var owner = n.owner || "";
      return '<li><span class="sb-owner' + (/オーナー/.test(owner) ? " is-owner" : "") + '">' + escapeHtml(owner || "—") + '</span>' +
        '<span class="sb-li-text">' + escapeHtml(n.text) + '</span>' +
        (n.due ? '<span class="sb-due">' + escapeHtml(n.due) + '</span>' : "") + '</li>';
    }).join("");

    var decisions = (b.decisions || []).map(function(d){
      return '<li><span class="sb-li-text">' + escapeHtml(d.text) + '</span>' +
        (d.recommend ? '<span class="sb-rec">推奨：' + escapeHtml(d.recommend) + '</span>' : "") + '</li>';
    }).join("");

    var exits = (b.exits || []).map(function(e){
      return '<tr><td class="sb-code">' + escapeHtml(e.code || "") + '</td><td class="sb-due-cell">' +
        escapeHtml(dueText(e.due)) + '</td><td>' + escapeHtml(e.cond) + '</td><td>' +
        escapeHtml(e.action || "") + '</td></tr>';
    }).join("");
    var nd = nextDue(b);

    var links = (b.links || []).map(function(l){
      var url = safeUrl(l.url);
      if (!url) return "";
      var ext = /^https?:/i.test(url);
      return '<a class="sb-link" href="' + escapeHtml(url) + '"' + (ext ? ' target="_blank" rel="noopener noreferrer"' : "") + '>' +
        escapeHtml(l.label) + (ext ? " ↗" : "") + '</a>';
    }).join("");

    var key = b.id || String(idx);
    return '<section class="panel sb-card" id="sb-card-' + escapeHtml(key) + '">' +
      '<div class="card-head sb-head">' +
        '<h2>' + escapeHtml(b.name) + '</h2>' +
        '<span class="sb-status' + (tone ? " is-" + tone : "") + '">[ ' + escapeHtml(b.status || "—") + ' ]</span>' +
        (b.phase ? '<span class="sb-phase">' + escapeHtml(b.phase) + '</span>' : "") +
        (nd ? '<span class="sb-judge">次の判定 ' + escapeHtml(dueText(nd.e.due)) + '</span>' : "") +
        '<span class="sb-updated">' + (b.updated ? escapeHtml(b.updated.replace(/-/g, "/")) + " 時点" : "") +
          (pstamp ? '　<span class="sb-faint">差は ' + escapeHtml(pstamp) + ' との比較</span>' : "") + '</span>' +
      '</div>' +
      '<div class="card-body sb-body">' +
        (b.summary ? '<p class="sb-summary">' + escapeHtml(b.summary) + '</p>' : "") +
        (goal != null ? '<div class="sb-goal"><span class="sb-goal-label">' + escapeHtml(b.goalLabel || "今月の利益 / 目標") + '</span>' +
          '<span class="sb-goal-value">' + (profit != null ? yen(profit) : "—") + ' <span class="sb-faint">/ ' + yen(goal) + '</span></span>' +
          '<span class="sb-segs" aria-hidden="true">' + segs + '</span></div>' : "") +
        (metrics ? '<div class="sb-metrics">' + metrics + '</div>' : "") +
        '<div class="sb-cols">' +
          '<div class="sb-col"><h3>次にやること</h3>' + (next ? '<ul class="sb-list">' + next + '</ul>' : '<p class="sb-faint">なし</p>') + '</div>' +
          '<div class="sb-col"><h3>オーナーの判断待ち</h3>' + (decisions ? '<ul class="sb-list sb-decisions">' + decisions + '</ul>' : '<p class="sb-faint">なし</p>') + '</div>' +
        '</div>' +
        (exits ? '<details class="sb-exits" data-key="' + escapeHtml(key) + '"' + (S.openExits[key] ? " open" : "") + '>' +
          '<summary>撤退・変更ルール</summary><table class="sb-table"><tbody>' + exits + '</tbody></table></details>' : "") +
        (links || b.source ? '<div class="sb-foot">' + links +
          (b.source ? '<span class="sb-source">出典：' + escapeHtml(b.source) + '</span>' : "") + '</div>' : "") +
      '</div>' +
    '</section>';
  }

  function wire(){
    var btn = $("sb-reload");
    if (btn) btn.addEventListener("click", load);
    var host = $("sb-body");
    if (host) host.addEventListener("toggle", function(e){
      var d = e.target;
      if (d && d.classList && d.classList.contains("sb-exits")) S.openExits[d.getAttribute("data-key")] = d.open;
    }, true);
    if (host) host.addEventListener("click", function(e){
      var jump = e.target && e.target.closest ? e.target.closest(".sb-jump") : null;
      if (!jump) return;
      var card = $("sb-card-" + jump.getAttribute("data-key"));
      if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  CP.initSmallbiz = function(){ wire(); load(); };
  // 開き直すたびに取り直す（Claude が別の場所で更新しているため）。
  CP.renderSmallbiz = function(){ load(); };
  // オーナーのブラウザから内容を丸ごと置き換える入口（手当て用）。ふだんは ingest 経路を使う。成功したら読み直す。
  CP.smallbizPut = async function(state){
    var r = await apiFetch("/api/smallbiz/state", { method: "PUT", body: JSON.stringify({ state: state }) });
    await load();
    return r;
  };
})();
