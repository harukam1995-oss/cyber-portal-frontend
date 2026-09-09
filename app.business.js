/* Cyber Portal — ビジネスタブ: 契約書トラッカー / プロジェクトボード / Slackダイジェスト
   app.js 本体から分離したモジュール。ビジネスタブ(または #view-contracts)を初回に
   開いたときだけ app.js の loadBusinessModule() が <script> を注入してロードする
   (index.html には置かない・sw.js の SHELL にも入れない＝開いたとき取得→実行時キャッシュ)。
   本体 IIFE のヘルパーは window.__CP 経由で受け取る。
   ※「最近のメモ / 最近のタスク」カードの配線は tasks/notes モジュール依存のため
     app.js 側の initBusiness に残してある。ここは契約書/プロジェクト/Slack のみ。 */
(function(){
  "use strict";
  var CP = window.__CP;
  if (!CP || !CP.apiFetch){
    console.error("[business] window.__CP 未初期化。app.business.js は app.js の後にのみロードされる想定です。");
    return;
  }
  var apiFetch = CP.apiFetch, apiErrorMessage = CP.apiErrorMessage, escapeHtml = CP.escapeHtml,
      jstDateKey = CP.jstDateKey, addDaysKey = CP.addDaysKey, fmtSavedAt = CP.fmtSavedAt,
      uid = CP.uid, mdLabel = CP.mdLabel, makeStatusSetter = CP.makeStatusSetter,
      askConfirm = CP.askConfirm, mkHabitIconBtn = CP.mkHabitIconBtn, showView = CP.showView;

  /* ================= ビジネス: 契約書トラッカー =================
     営業から依頼される契約書送付の進捗を管理する。案件管理(cases)と同じ master-detail 管理モーダル。
     client(会社名)が主識別子。title(契約書名)は任意の補足。
     status は手動選択。requestedDate/sentDate/signedDate(依頼日/送付日/締結日)で遅延をアラート表示する。 */
  var CONTRACT_STATUSES = ["依頼受領", "送付済み", "締結済み", "報告済み"];
  // 意味のある状態(要対応=warn / 締結済み=ok)だけ色を持たせ、途中経過はニュートラルに(虹色をやめる)
  var CONTRACT_STATUS_COLOR = { "依頼受領": "var(--warn)", "送付済み": "var(--text-faint)", "締結済み": "var(--ok)", "報告済み": "var(--text-faint)" };
  var CONTRACT_REQUESTERS = ["河野", "藤井", "船木", "竹内"]; // 依頼者の quick-pick / 絞り込み候補
  var contractsState = [];      // [{id,title,client,requestedBy,status,requestedDate,sentDate,signedDate,dueDate,confidential,source,order}]
  var contractsTab = "";        // "" = すべて / "alert" / "依頼受領" / "送付済み" / "締結済み"
  var contractsQuery = "";      // 検索窓の文字列
  var contractsRequester = "";  // 依頼者の絞り込み("" = すべて、"__other" = 既知4名以外)
  var contractEditRows = [];    // 管理モーダルの作業コピー
  var contractDetailIdx = null; // null = 一覧ビュー、数値 = その契約書の詳細ビュー
  var contractsWired = false;
  var contractsLoadOk = false;  // 一度でも取得に成功したか(空配列での全消し保存を防ぐガード)
  var contractsShowDone = false; // 一覧ページで「報告済み」(完了)を展開しているか

  // 依頼日があるのに未送付 / 送付から1週間で未締結 / 期限超過、のいずれかをアラートとする。
  function contractAlertLabels(c){
    var today = jstDateKey(new Date());
    var out = [];
    if (c.requestedDate && !c.sentDate) out.push("⚠ 送付待ち");
    if (c.sentDate && !c.signedDate && addDaysKey(c.sentDate, 7) < today) out.push("⚠ 締結遅延");
    var unsigned = c.status !== "締結済み" && c.status !== "報告済み";
    if (c.dueDate && c.dueDate < today && unsigned) out.push("⚠ 期限超過");
    return out;
  }

  // 状態の進行度 = CONTRACT_STATUSES の添字。未知の値は 0(依頼受領)扱い。
  function contractStatusIdx(c){
    var i = CONTRACT_STATUSES.indexOf(c.status);
    return i === -1 ? 0 : i;
  }
  // 並べ替えの優先度(小さいほど上)。アラート → 未締結 → 締結済み(報告待ち) → 報告済み。
  function contractUrgency(c){
    if (contractAlertLabels(c).length) return 0;
    var idx = contractStatusIdx(c);
    if (idx < 2) return 1;
    if (idx === 2) return 2;
    return 3;
  }
  // 要対応を先頭に寄せる。カードは先頭3件しか出ないので、これが無いと
  // 完了済みだけが並んでアラート行が「すべて表示」の中に埋もれる。
  // 同順位は元の order を保つ(Array#sort は安定)。
  function sortContractsByUrgency(list){
    return list.slice().sort(function(a, b){ return contractUrgency(a) - contractUrgency(b); });
  }
  // "YYYY-MM-DD" 同士の日数差(b - a)。どちらかが日付キーでなければ null。
  function dateKeyDiffDays(a, b){
    var pa = /^(\d{4})-(\d{2})-(\d{2})$/.exec(a || "");
    var pb = /^(\d{4})-(\d{2})-(\d{2})$/.exec(b || "");
    if (!pa || !pb) return null;
    return Math.round((Date.UTC(+pb[1], +pb[2] - 1, +pb[3]) - Date.UTC(+pa[1], +pa[2] - 1, +pa[3])) / 86400000);
  }

  var contractSetStatus = makeStatusSetter("pv-contracts-status");

  function applyContracts(list){
    contractsState = list || [];
    contractsLoadOk = true;
    renderContractsAll();
    contractSetStatus("");
  }
  function failContracts(err){
    contractsState = [];
    renderContractsAll();
    contractSetStatus(apiErrorMessage(err, "契約書トラッカー"), true);
  }
  async function loadContracts(){
    var list = document.getElementById("pv-contracts-list");
    if (!list) return;
    contractSetStatus("読み込み中…");
    try { applyContracts((await apiFetch("/api/contracts")).contracts); }
    catch (err){ failContracts(err); }
  }

  function renderContractsTabs(){
    var bar = document.getElementById("pv-contracts-tabs");
    if (!bar) return;
    Array.prototype.forEach.call(bar.querySelectorAll(".pv-contracts-tab"), function(btn){
      btn.classList.toggle("is-active", btn.getAttribute("data-tab") === contractsTab);
    });
  }

  function contractMD(key){ return mdLabel(key); }

  function contractMatchesQuery(c, q){
    var hay = [c.client, c.title, c.requestedBy, c.status].join(" ");
    ["requestedDate", "sentDate", "signedDate", "dueDate"].forEach(function(k){
      if (c[k]) hay += " " + c[k] + " " + contractMD(c[k]);
    });
    return hay.toLowerCase().indexOf(q) !== -1;
  }

  // タブ / 依頼者 / 検索窓のフィルタ。カードと一覧ページで共用。
  function filterContracts(){
    var q = contractsQuery.trim().toLowerCase();
    return contractsState.filter(function(c){
      // タブ
      if (contractsTab === "alert"){ if (!contractAlertLabels(c).length) return false; }
      else if (contractsTab === "締結済み"){ if (c.status !== "締結済み" && c.status !== "報告済み") return false; }
      else if (contractsTab){ if (c.status !== contractsTab) return false; }
      // 依頼者
      if (contractsRequester === "__other"){
        if (CONTRACT_REQUESTERS.some(function(n){ return (c.requestedBy || "").indexOf(n) !== -1; })) return false;
      } else if (contractsRequester){
        if ((c.requestedBy || "").indexOf(contractsRequester) === -1) return false;
      }
      // 検索窓
      if (q && !contractMatchesQuery(c, q)) return false;
      return true;
    });
  }

  // 進捗ステッパーの4段。「報告」だけは対応する日付フィールドが無い(status でしか分からない)。
  var CONTRACT_STEPS = [
    { label: "依頼", key: "requestedDate" },
    { label: "送付", key: "sentDate" },
    { label: "締結", key: "signedDate" },
    { label: "報告", key: "" }
  ];
  // 依頼→送付→締結→報告 のセグメント進捗。日付を横に並べただけの行より
  // 「今どこで止まっているか」が一目で分かる。status の添字までを到達済みとする。
  function buildContractStepper(c, overdue){
    var idx = contractStatusIdx(c);
    var wrap = document.createElement("div");
    wrap.className = "pv-contract-steps";
    CONTRACT_STEPS.forEach(function(s, i){
      var step = document.createElement("div");
      step.className = "pv-contract-step" + (i <= idx ? " is-done" : "") +
        (i === idx ? " is-current" : "") + (overdue && i === idx ? " is-overdue" : "");
      var bar = document.createElement("span");
      bar.className = "pv-contract-step-bar";
      var lbl = document.createElement("span");
      lbl.className = "pv-contract-step-label";
      lbl.textContent = s.label;
      var dt = document.createElement("span");
      dt.className = "pv-contract-step-date";
      var v = s.key ? c[s.key] : "";
      dt.textContent = v ? contractMD(v) : "–";
      step.appendChild(bar); step.appendChild(lbl); step.appendChild(dt);
      wrap.appendChild(step);
    });
    return wrap;
  }

  // 1件ぶんの行 DOM。カード(#pv-contracts-list)と一覧ページ(#contracts-page-list)で共用。
  // タップで管理モーダルのその契約書の詳細ビューへ直行。
  function buildContractRow(c){
    var alerts = contractAlertLabels(c);
    var pending = c.status !== "締結済み" && c.status !== "報告済み";
    var overdue = alerts.indexOf("⚠ 期限超過") !== -1;
    var row = document.createElement("div");
    row.className = "pv-contract-row" + (pending ? " is-pending" : "") + (alerts.length ? " is-alert" : "") +
      (overdue ? " is-overdue" : "") + (c.status === "報告済み" ? " is-done" : "");
    row.style.setProperty("--contract-accent", CONTRACT_STATUS_COLOR[c.status] || "var(--text-faint)");

    var head = document.createElement("div");
    head.className = "pv-case-head";
    var name = document.createElement("span");
    name.className = "pv-case-name";
    name.textContent = c.client || c.title || "(名称未設定)";
    head.appendChild(name);
    if (c.confidential){
      var lock = document.createElement("span");
      lock.className = "pv-case-lock";
      lock.textContent = "🔒";
      lock.title = "機密案件";
      head.appendChild(lock);
    }
    if (alerts.length){
      alerts.forEach(function(t){
        var a = document.createElement("span");
        a.className = "pv-contract-alert" + (t === "⚠ 期限超過" ? " is-err" : "");
        a.textContent = t;
        head.appendChild(a);
      });
    } else if (pending){
      var alertEl = document.createElement("span");
      alertEl.className = "pv-contract-alert";
      alertEl.textContent = "⚠ 未締結";
      head.appendChild(alertEl);
    }
    var status = document.createElement("span");
    status.className = "pv-case-status-badge";
    status.style.setProperty("--case-accent", CONTRACT_STATUS_COLOR[c.status] || "var(--text-faint)");
    status.textContent = c.status;
    head.appendChild(status);
    if (c.source === "slack"){
      var slackBadge = document.createElement("span");
      slackBadge.className = "pv-contract-slack-badge";
      slackBadge.textContent = "Slack検知";
      slackBadge.title = "Slackダイジェストが自動検知・更新した項目です。内容を確認してください。";
      head.appendChild(slackBadge);
    }
    if (c.slackUrl && /^https:\/\//i.test(c.slackUrl)){
      var slackLink = document.createElement("a");
      slackLink.className = "pv-contract-slack-link";
      slackLink.href = c.slackUrl;
      slackLink.target = "_blank";
      slackLink.rel = "noopener noreferrer";
      slackLink.textContent = "Slack ↗";
      slackLink.title = "Slackスレッドを開く";
      slackLink.addEventListener("click", function(e){ e.stopPropagation(); });
      head.appendChild(slackLink);
    }
    row.appendChild(head);

    // 契約書名が会社名と別なら、小さくサブ行に出す。
    if (c.title && c.title !== c.client){
      var sub = document.createElement("div");
      sub.className = "pv-contract-subtitle";
      sub.textContent = c.title;
      row.appendChild(sub);
    }

    // 日付3つはステッパー側に移したので、ここは依頼者と期限だけ。
    row.appendChild(buildContractStepper(c, overdue));

    var metaLine = [];
    if (c.requestedBy) metaLine.push(c.requestedBy + " 依頼");
    if (c.dueDate) metaLine.push("期限 " + contractMD(c.dueDate) + " まで");
    if (metaLine.length){
      var meta = document.createElement("div");
      meta.className = "pv-contract-meta";
      meta.textContent = metaLine.join(" ・ ");
      row.appendChild(meta);
    }

    row.tabIndex = 0;
    row.setAttribute("role", "button");
    (function(id){
      function open(){ openContractModal(id); }
      row.addEventListener("click", open);
      row.addEventListener("keydown", function(e){
        if (e.key === "Enter" || e.key === " "){ e.preventDefault(); open(); }
      });
    })(c.id);

    return row;
  }

  // ビジネスカード用のコンパクト行（1行＝契約書名・依頼者・ステータスのみ）。
  // 縦を詰めてカードに多めに載せるため。詳細（日付/アラート/Slack）は一覧ページか
  // 行タップで開く管理モーダルで見る。
  function buildContractRowCompact(c){
    var pending = c.status !== "締結済み" && c.status !== "報告済み";
    var alerts = contractAlertLabels(c);
    var overdue = alerts.indexOf("⚠ 期限超過") !== -1;
    var row = document.createElement("div");
    row.className = "pv-contract-row is-compact" + (pending ? " is-pending" : "") +
      (alerts.length ? " is-alert" : "") + (overdue ? " is-overdue" : "") +
      (c.status === "報告済み" ? " is-done" : "");
    row.style.setProperty("--contract-accent", CONTRACT_STATUS_COLOR[c.status] || "var(--text-faint)");

    var name = document.createElement("span");
    name.className = "pv-case-name";
    name.textContent = c.client || c.title || "(名称未設定)";
    row.appendChild(name);

    if (c.confidential){
      var lock = document.createElement("span");
      lock.className = "pv-case-lock"; lock.textContent = "🔒"; lock.title = "機密案件";
      row.appendChild(lock);
    }
    if (c.requestedBy){
      var req = document.createElement("span");
      req.className = "pv-contract-req";
      req.textContent = c.requestedBy;
      row.appendChild(req);
    }
    var status = document.createElement("span");
    status.className = "pv-case-status-badge";
    status.style.setProperty("--case-accent", CONTRACT_STATUS_COLOR[c.status] || "var(--text-faint)");
    status.textContent = c.status;
    row.appendChild(status);

    row.tabIndex = 0;
    row.setAttribute("role", "button");
    (function(id){
      function open(){ openContractModal(id); }
      row.addEventListener("click", open);
      row.addEventListener("keydown", function(e){
        if (e.key === "Enter" || e.key === " "){ e.preventDefault(); open(); }
      });
    })(c.id);
    return row;
  }

  // カードとページの両方を更新する(フィルタ状態は共用なので片方を触ったらもう片方も揃える)。
  function renderContractsAll(){ renderContracts(); renderContractsPage(); }

  function renderContracts(){
    var list = document.getElementById("pv-contracts-list");
    if (!list) return;
    renderContractsTabs();
    list.innerHTML = "";
    if (!contractsState.length){
      list.innerHTML = '<div class="pv-habit-empty">「管理」から契約書を追加してください。</div>';
      return;
    }
    // 要対応(アラート→未締結)を先頭に寄せてから3件を切る。order 順のままだと
    // 完了済みでカード枠が埋まり、アラート行が一覧ページ側に隠れてしまう。
    var filtered = sortContractsByUrgency(filterContracts());
    if (!filtered.length){
      list.innerHTML = '<div class="pv-habit-empty">該当する契約書がありません。</div>';
      return;
    }
    // カードは3件まで（コンパクト行）。残りは「すべて表示（ほか N 件）」で一覧ページ(#view-contracts)へ。
    var CONTRACTS_CARD_MAX = 3;
    filtered.slice(0, CONTRACTS_CARD_MAX).forEach(function(c){ list.appendChild(buildContractRowCompact(c)); });
    if (filtered.length > CONTRACTS_CARD_MAX){
      var more = document.createElement("button");
      more.type = "button";
      more.className = "pv-list-more";
      more.textContent = "すべて表示（ほか " + (filtered.length - CONTRACTS_CARD_MAX) + " 件）";
      more.addEventListener("click", function(){ showView("contracts"); });
      list.appendChild(more);
    }
  }

  /* ---- 契約書トラッカー 一覧ページ (#view-contracts) ---- */
  var contractsPageSetStatus = makeStatusSetter("contracts-page-status");
  var contractsPageWired = false;

  function renderContractsPageTabs(){
    var bar = document.getElementById("contracts-page-tabs");
    if (!bar) return;
    Array.prototype.forEach.call(bar.querySelectorAll(".pv-contracts-tab"), function(btn){
      btn.classList.toggle("is-active", btn.getAttribute("data-tab") === contractsTab);
    });
  }

  function renderContractsPage(){
    var list = document.getElementById("contracts-page-list");
    if (!list) return;
    renderContractsPageTabs();
    var q = document.getElementById("contracts-page-q");
    if (q && q.value !== contractsQuery) q.value = contractsQuery;
    var reqSel = document.getElementById("contracts-page-requester");
    if (reqSel && reqSel.value !== contractsRequester) reqSel.value = contractsRequester;

    list.innerHTML = "";
    if (!contractsLoadOk && !contractsState.length){
      list.innerHTML = '<div class="sched-empty">読み込み中…</div>';
      contractsPageSetStatus("読み込み中…");
      return;
    }
    if (!contractsState.length){
      list.innerHTML = '<div class="pv-habit-empty">契約書がまだありません。「＋ 新規」から追加できます。</div>';
      contractsPageSetStatus("0 件");
      return;
    }
    var filtered = sortContractsByUrgency(filterContracts());
    if (!filtered.length){
      list.innerHTML = '<div class="pv-habit-empty">該当する契約書がありません。</div>';
      renderContractsKpi(0);
      return;
    }

    // 完了(報告済み)は既定で畳む。件数の大半が完了なので、畳まないと要対応が埋もれる。
    //   - タブが「すべて」以外のときは畳まない（「締結」タブは報告済みを見るためのタブ）
    //   - 検索中も畳まない（探している行が黙って隠れるのを避ける）
    //   - 全件が完了のときも畳まない（1行も出ないのは不親切）
    var doneRows = filtered.filter(function(c){ return c.status === "報告済み"; });
    var canCollapse = contractsTab === "" && !contractsQuery.trim() &&
      doneRows.length > 0 && doneRows.length < filtered.length;
    var shown = (canCollapse && !contractsShowDone)
      ? filtered.filter(function(c){ return c.status !== "報告済み"; })
      : filtered;

    shown.forEach(function(c){ list.appendChild(buildContractRow(c)); });

    if (canCollapse){
      var toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "pv-list-more contracts-page-toggle";
      toggle.textContent = contractsShowDone
        ? ("完了 " + doneRows.length + " 件を隠す")
        : ("完了 " + doneRows.length + " 件を表示");
      toggle.addEventListener("click", function(){
        contractsShowDone = !contractsShowDone;
        renderContractsPage();
      });
      list.appendChild(toggle);
    }
    renderContractsKpi(filtered.length);
  }

  // 一覧ページのステータスバーを KPI バンドにする。件数だけでは「今どういう状況か」が
  // 分からないため、母数は絞り込みではなく contractsState 全体で数える。
  function renderContractsKpi(filteredCount){
    var el = document.getElementById("contracts-page-status");
    if (!el) return;
    el.classList.remove("is-err");
    el.hidden = false;
    el.innerHTML = "";

    var total = contractsState.length;
    var ym = jstDateKey(new Date()).slice(0, 7);
    var pending = 0, alerts = 0, signedThisMonth = 0, leadSum = 0, leadN = 0;
    contractsState.forEach(function(c){
      if (contractStatusIdx(c) < 2) pending++;
      if (contractAlertLabels(c).length) alerts++;
      if (c.signedDate && c.signedDate.slice(0, 7) === ym) signedThisMonth++;
      var d = dateKeyDiffDays(c.sentDate, c.signedDate);
      if (d != null && d >= 0){ leadSum += d; leadN++; }
    });

    [
      { label: "件数", value: filteredCount === total ? String(total) : (filteredCount + " / " + total) },
      { label: "未締結", value: String(pending), tone: pending ? "is-warn" : "" },
      { label: "アラート", value: String(alerts), tone: alerts ? "is-err" : "" },
      { label: "今月締結", value: String(signedThisMonth) },
      { label: "送付→締結 平均", value: leadN ? ((leadSum / leadN).toFixed(1) + " 日") : "—" }
    ].forEach(function(it){
      var box = document.createElement("div");
      box.className = "contracts-kpi" + (it.tone ? " " + it.tone : "");
      var lbl = document.createElement("span");
      lbl.className = "contracts-kpi-label";
      lbl.textContent = it.label;
      var val = document.createElement("span");
      val.className = "contracts-kpi-value";
      val.textContent = it.value;
      box.appendChild(lbl); box.appendChild(val);
      el.appendChild(box);
    });
  }

  function wireContractsPage(){
    if (contractsPageWired) return;
    contractsPageWired = true;
    var tabs = document.getElementById("contracts-page-tabs");
    if (tabs) tabs.addEventListener("click", function(e){
      var btn = e.target.closest(".pv-contracts-tab");
      if (!btn) return;
      contractsTab = btn.getAttribute("data-tab") || "";
      renderContractsAll();
    });
    var q = document.getElementById("contracts-page-q");
    if (q) q.addEventListener("input", function(){ contractsQuery = q.value; renderContractsAll(); });
    var reqSel = document.getElementById("contracts-page-requester");
    if (reqSel) reqSel.addEventListener("change", function(){ contractsRequester = reqSel.value; renderContractsAll(); });
    var newBtn = document.getElementById("contracts-page-new");
    if (newBtn) newBtn.addEventListener("click", function(){
      openContractModal();
      if (contractsLoadOk){
        contractEditRows.push(contractNewRow());
        contractDetailIdx = contractEditRows.length - 1;
        renderContractModal();
      }
    });
  }

  function initContractsPage(){
    wireContractsPage();
    if (!contractsLoadOk) loadContracts(); // 成功時 applyContracts → renderContractsAll
    else renderContractsPage();
  }

  /* ---- 管理モーダル (一覧 → タイトルを押して詳細 / 新規作成) ---- */
  function openContractModal(targetId){
    var modal = document.getElementById("contract-modal");
    if (!modal) return;
    if (!contractsLoadOk){
      contractSetStatus("読み込みに失敗しています。再読み込みしてから操作してください。", true);
      loadContracts();
      return;
    }
    var errEl = document.getElementById("contract-form-error");
    if (errEl){ errEl.hidden = true; errEl.textContent = ""; }
    contractEditRows = contractsState.map(function(c){
      return {
        id: c.id, title: c.title, client: c.client || "", requestedBy: c.requestedBy || "",
        status: CONTRACT_STATUSES.indexOf(c.status) !== -1 ? c.status : "依頼受領",
        requestedDate: c.requestedDate || "", sentDate: c.sentDate || "", signedDate: c.signedDate || "",
        dueDate: c.dueDate || "", confidential: c.confidential === true,
        slackUrl: c.slackUrl || "",
        source: c.source === "slack" ? "slack" : "manual"
      };
    });
    contractDetailIdx = null;
    if (targetId){
      for (var i = 0; i < contractEditRows.length; i++){
        if (contractEditRows[i].id === targetId){ contractDetailIdx = i; break; }
      }
    }
    renderContractModal();
    modal.hidden = false;
  }
  function closeContractModal(){
    var modal = document.getElementById("contract-modal");
    if (modal) modal.hidden = true;
  }
  function contractModalBack(){
    if (contractDetailIdx != null){ contractDetailIdx = null; renderContractModal(); }
    else closeContractModal();
  }
  function contractNewRow(){
    return { id: uid(), title: "", client: "", requestedBy: "", status: "依頼受領", requestedDate: "", sentDate: "", signedDate: "", dueDate: "", confidential: false, slackUrl: "", source: "manual" };
  }
  function contractHint(r){
    var pending = r.status !== "締結済み" && r.status !== "報告済み";
    return (r.status || "依頼受領") + (pending ? " ・ ⚠未締結" : "") + (r.confidential ? " ・ 🔒機密" : "") + (r.source === "slack" ? " ・ Slack検知" : "");
  }
  function renderContractModal(){
    var listView = document.getElementById("contract-list-view");
    var detailView = document.getElementById("contract-detail-view");
    var title = document.getElementById("contract-modal-title");
    var inDetail = contractDetailIdx != null && !!contractEditRows[contractDetailIdx];
    if (!inDetail) contractDetailIdx = null;
    if (listView) listView.hidden = inDetail;
    if (detailView) detailView.hidden = !inDetail;
    if (title) title.textContent = inDetail ? "契約書の設定" : "契約書トラッカーの管理";
    if (inDetail) renderContractDetailView(contractDetailIdx);
    else renderContractListView();
  }
  function renderContractListView(){
    var wrap = document.getElementById("contract-rows");
    if (!wrap) return;
    wrap.innerHTML = "";
    if (!contractEditRows.length){
      wrap.innerHTML = '<div class="habit-edit-empty">契約書がありません。「＋ 新規作成」から追加してください。</div>';
      return;
    }
    var single = contractEditRows.length <= 1;
    contractEditRows.forEach(function(r, idx){
      var row = document.createElement("div");
      row.className = "habit-list-row";
      row.tabIndex = 0;
      row.setAttribute("role", "button");

      var txt = document.createElement("div");
      txt.className = "habit-list-txt";
      var nm = document.createElement("div");
      nm.className = "habit-list-name";
      nm.textContent = (r.client || "").trim() || (r.title || "").trim() || "（名称未設定）";
      var hint = document.createElement("div");
      hint.className = "habit-list-hint";
      hint.textContent = contractHint(r);
      txt.appendChild(nm); txt.appendChild(hint);

      var up = mkHabitIconBtn("↑", "上へ", "", function(e){
        e.stopPropagation();
        if (idx > 0){ var t = contractEditRows[idx - 1]; contractEditRows[idx - 1] = r; contractEditRows[idx] = t; renderContractListView(); }
      });
      var down = mkHabitIconBtn("↓", "下へ", "", function(e){
        e.stopPropagation();
        if (idx < contractEditRows.length - 1){ var t = contractEditRows[idx + 1]; contractEditRows[idx + 1] = r; contractEditRows[idx] = t; renderContractListView(); }
      });
      up.hidden = down.hidden = single;
      up.disabled = idx === 0;
      down.disabled = idx === contractEditRows.length - 1;

      var chev = document.createElement("span");
      chev.className = "habit-list-chev";
      chev.textContent = "›";

      row.appendChild(txt); row.appendChild(up); row.appendChild(down); row.appendChild(chev);
      function open(){ contractDetailIdx = idx; renderContractModal(); }
      row.addEventListener("click", open);
      row.addEventListener("keydown", function(e){ if (e.key === "Enter" || e.key === " "){ e.preventDefault(); open(); } });
      wrap.appendChild(row);
    });
  }
  function renderContractDetailView(idx){
    var body = document.getElementById("contract-detail-body");
    var r = contractEditRows[idx];
    if (!body || !r) return;
    body.innerHTML = "";

    if (r.source === "slack"){
      var slackNote = document.createElement("div");
      slackNote.className = "pv-contract-slack-note";
      slackNote.textContent = "Slackダイジェストが自動検知・更新した項目です。内容を確認し、必要なら修正してください。";
      body.appendChild(slackNote);
    }

    var client = document.createElement("input");
    client.type = "text"; client.className = "habit-edit-name"; client.maxLength = 60;
    client.placeholder = "クライアント名（会社名）"; client.value = r.client || "";
    client.addEventListener("input", function(){ r.client = client.value; r.source = "manual"; });
    body.appendChild(client);

    var title = document.createElement("input");
    title.type = "text"; title.className = "habit-edit-name"; title.maxLength = 80;
    title.placeholder = "契約書名（任意・会社名と別のとき）"; title.value = r.title || "";
    title.addEventListener("input", function(){ r.title = title.value; r.source = "manual"; });
    body.appendChild(title);

    var requestedBy = document.createElement("input");
    requestedBy.type = "text"; requestedBy.className = "habit-edit-name"; requestedBy.maxLength = 40;
    requestedBy.placeholder = "依頼者（任意）"; requestedBy.value = r.requestedBy || "";
    requestedBy.addEventListener("input", function(){ r.requestedBy = requestedBy.value; r.source = "manual"; });
    body.appendChild(requestedBy);

    var reqChips = document.createElement("div");
    reqChips.className = "pv-contract-chips";
    CONTRACT_REQUESTERS.forEach(function(nm){
      var chip = document.createElement("button");
      chip.type = "button";
      chip.className = "pv-contract-chip" + (r.requestedBy === nm ? " is-active" : "");
      chip.textContent = nm;
      chip.addEventListener("click", function(){
        r.requestedBy = (r.requestedBy === nm) ? "" : nm;
        r.source = "manual";
        requestedBy.value = r.requestedBy;
        renderContractDetailView(idx);
      });
      reqChips.appendChild(chip);
    });
    body.appendChild(reqChips);

    var lineStatus = document.createElement("div");
    lineStatus.className = "habit-block-line";
    var status = document.createElement("select");
    status.className = "habit-edit-cadence case-edit-status";
    status.innerHTML = CONTRACT_STATUSES.map(function(s){ return '<option value="' + s + '">' + s + "</option>"; }).join("");
    status.value = r.status;
    status.addEventListener("change", function(){ r.status = status.value; r.source = "manual"; });
    var due = document.createElement("input");
    due.type = "date"; due.className = "case-edit-due";
    due.value = r.dueDate || "";
    due.setAttribute("aria-label", "期限（任意）");
    due.addEventListener("input", function(){ r.dueDate = due.value; r.source = "manual"; });
    lineStatus.appendChild(status); lineStatus.appendChild(due);
    body.appendChild(lineStatus);

    [
      { key: "requestedDate", label: "依頼日" },
      { key: "sentDate", label: "送付日" },
      { key: "signedDate", label: "締結日" }
    ].forEach(function(f){
      var line = document.createElement("div");
      line.className = "habit-block-line";
      var lbl = document.createElement("span");
      lbl.className = "pv-contract-field-label";
      lbl.textContent = f.label + "（任意）";
      var inp = document.createElement("input");
      inp.type = "date"; inp.className = "case-edit-due";
      inp.value = r[f.key] || "";
      inp.setAttribute("aria-label", f.label + "（任意）");
      inp.addEventListener("input", function(){ r[f.key] = inp.value; r.source = "manual"; });
      line.appendChild(lbl); line.appendChild(inp);
      body.appendChild(line);
    });

    var slackWrap = document.createElement("div");
    slackWrap.className = "habit-block-line";
    var slackLbl = document.createElement("span");
    slackLbl.className = "pv-contract-field-label";
    slackLbl.textContent = "Slackスレッド（任意）";
    var slackInp = document.createElement("input");
    slackInp.type = "url"; slackInp.className = "habit-edit-name"; slackInp.maxLength = 500;
    slackInp.placeholder = "https://＜workspace＞.slack.com/archives/…";
    slackInp.value = r.slackUrl || "";
    slackInp.setAttribute("aria-label", "Slackスレッドのリンク（任意）");
    slackInp.addEventListener("input", function(){ r.slackUrl = slackInp.value; r.source = "manual"; });
    slackWrap.appendChild(slackLbl); slackWrap.appendChild(slackInp);
    body.appendChild(slackWrap);

    var lineMisc = document.createElement("div");
    lineMisc.className = "habit-block-line";
    var conf = document.createElement("label");
    conf.className = "habit-pause";
    var ccb = document.createElement("input");
    ccb.type = "checkbox"; ccb.checked = r.confidential === true;
    ccb.addEventListener("change", function(){ r.confidential = ccb.checked; r.source = "manual"; });
    conf.appendChild(ccb);
    conf.appendChild(document.createTextNode(" 機密案件（クライアントの秘密情報を含む）"));
    lineMisc.appendChild(conf);
    body.appendChild(lineMisc);
  }

  async function onContractModalSubmit(e){
    e.preventDefault();
    var errEl = document.getElementById("contract-form-error");
    var saveBtn = document.getElementById("contract-save");
    if (errEl){ errEl.hidden = true; errEl.textContent = ""; }
    function showErr(msg){ if (errEl){ errEl.textContent = msg; errEl.hidden = false; } }
    function failAt(i, msg){ contractDetailIdx = i; renderContractModal(); showErr(msg); }
    if (!contractsLoadOk){ showErr("読み込みに失敗しています。再読み込みしてからやり直してください。"); return; }
    var cleaned = [];
    for (var i = 0; i < contractEditRows.length; i++){
      var r = contractEditRows[i];
      var cl = (r.client || "").trim();
      var nm = (r.title || "").trim();
      if (!cl && !nm){ failAt(i, "クライアント名（会社名）を入力してください。"); return; }
      cleaned.push({
        id: r.id, title: nm.slice(0, 80), client: cl.slice(0, 60),
        requestedBy: (r.requestedBy || "").trim().slice(0, 40),
        status: CONTRACT_STATUSES.indexOf(r.status) !== -1 ? r.status : "依頼受領",
        requestedDate: r.requestedDate || "", sentDate: r.sentDate || "", signedDate: r.signedDate || "",
        dueDate: r.dueDate || "", confidential: r.confidential === true,
        slackUrl: (r.slackUrl || "").trim().slice(0, 500),
        source: r.source === "slack" ? "slack" : "manual"
      });
    }
    if (saveBtn){ saveBtn.disabled = true; saveBtn.textContent = "保存中…"; }
    try {
      await apiFetch("/api/contracts/bulk", {
        method: "PUT",
        headers: { "X-Allow-Empty": "1" },
        body: JSON.stringify({ contracts: cleaned })
      });
      closeContractModal();
      loadContracts();
    } catch (err){
      if (errEl){ errEl.textContent = apiErrorMessage(err, "契約書トラッカー"); errEl.hidden = false; }
    } finally {
      if (saveBtn){ saveBtn.disabled = false; saveBtn.textContent = "保存"; }
    }
  }

  function wireContracts(){
    if (contractsWired) return;
    contractsWired = true;
    var manageBtn = document.getElementById("pv-contracts-manage");
    if (manageBtn) manageBtn.addEventListener("click", function(){ openContractModal(); });

    var tabsBar = document.getElementById("pv-contracts-tabs");
    if (tabsBar) tabsBar.addEventListener("click", function(e){
      var btn = e.target.closest(".pv-contracts-tab");
      if (!btn) return;
      contractsTab = btn.getAttribute("data-tab") || "";
      renderContractsAll();
    });
    var qInput = document.getElementById("pv-contracts-q");
    if (qInput) qInput.addEventListener("input", function(){ contractsQuery = qInput.value; renderContractsAll(); });
    var reqSel = document.getElementById("pv-contracts-requester");
    if (reqSel) reqSel.addEventListener("change", function(){ contractsRequester = reqSel.value; renderContractsAll(); });

    // 検索窓は既定で畳んでおき、「すべて」右の虫めがねで開閉する。
    // 畳むときは絞り込みを解除する(隠れたフィルタを残さない)。
    var searchToggle = document.getElementById("pv-contracts-search-toggle");
    var searchBox = document.getElementById("pv-contracts-search");
    if (searchToggle && searchBox) searchToggle.addEventListener("click", function(){
      var willShow = searchBox.hidden;
      searchBox.hidden = !willShow;
      searchToggle.classList.toggle("is-on", willShow);
      if (willShow){
        if (qInput) qInput.focus();
      } else {
        contractsQuery = "";
        contractsRequester = "";
        if (qInput) qInput.value = "";
        if (reqSel) reqSel.value = "";
        renderContractsAll();
      }
    });

    var modal = document.getElementById("contract-modal");
    var closeBtn = document.getElementById("contract-modal-close");
    var cancelBtn = document.getElementById("contract-cancel");
    var newBtn = document.getElementById("contract-new");
    var backBtn = document.getElementById("contract-detail-back");
    var delBtn = document.getElementById("contract-detail-del");
    var form = document.getElementById("contract-form");
    if (closeBtn) closeBtn.addEventListener("click", closeContractModal);
    if (cancelBtn) cancelBtn.addEventListener("click", closeContractModal);
    if (modal) modal.addEventListener("click", function(e){ if (e.target === modal) closeContractModal(); });
    if (newBtn) newBtn.addEventListener("click", function(){
      contractEditRows.push(contractNewRow());
      contractDetailIdx = contractEditRows.length - 1;
      renderContractModal();
    });
    if (backBtn) backBtn.addEventListener("click", function(){ contractDetailIdx = null; renderContractModal(); });
    if (delBtn) delBtn.addEventListener("click", async function(){
      if (contractDetailIdx == null) return;
      var r = contractEditRows[contractDetailIdx];
      if (r && r.title && !(await askConfirm('「' + r.title + '」を削除しますか?'))) return;
      contractEditRows.splice(contractDetailIdx, 1);
      contractDetailIdx = null;
      renderContractModal();
    });
    if (form) form.addEventListener("submit", onContractModalSubmit);
  }

  /* ================= ビジネス: プロジェクトボード =================
     表示名は「プロジェクトボード」だが内部の識別子・コレクション・API は event_trackers のまま
     (旧「イベント／月次トラッカー」。旧 cases ベースのプロジェクトボードは 2026/09/06 に廃止)。
     事前定義したプロジェクト(月次決算・オフィス引っ越し等)のチェックリスト。
     定期タスク event-digest がメール＋Slackから進捗を自動入力する(契約書トラッカーと同型)。
     手動編集した項目は自動反映が上書きしない。 */
  var EVENT_KINDS = [{ v: "recurring", label: "周期" }, { v: "oneoff", label: "単発" }];
  var EVENT_STATUSES = ["計画中", "進行中", "完了"];
  var eventTrackersState = [];
  var eventTemplatesState = [];
  var eventEditRows = [];         // 管理モーダルの作業コピー(アクティブ＋アーカイブ 両方持つ)
  var eventTplRows = [];          // テンプレの作業コピー
  var eventDetailIdx = null;
  var eventTplDetailIdx = null;
  var pbView = "list";            // "list" = プロジェクト / "templates" = テンプレ
  var pbShowArchived = false;
  var eventTrackersWired = false;
  var eventTrackersLoadOk = false;

  var eventSetStatus = makeStatusSetter("pv-events-status");

  function eventKindLabel(k){ var f = EVENT_KINDS.filter(function(e){ return e.v === k; })[0]; return f ? f.label : "単発"; }
  function eventProgress(t){
    var items = t.items || [];
    if (typeof t.progress === "number" && !items.length) return t.progress;
    if (!items.length) return 0;
    return Math.round(items.filter(function(it){ return it.done; }).length / items.length * 100);
  }
  function eventDoneCount(t){
    var items = t.items || [];
    return items.filter(function(it){ return it.done; }).length + "/" + items.length;
  }
  // 期限切れ項目(dueDate あり・未完了・今日より前)の配列
  function eventOverdueItems(t){
    var today = jstDateKey(new Date());
    return (t.items || []).filter(function(it){ return it.dueDate && !it.done && it.dueDate < today; });
  }
  // 未完了の先頭項目(期限が近いものを優先)。カード/一覧ページの「▶ 次」表示に使う。
  function eventNextItem(t){
    var items = (t.items || []).filter(function(it){ return !it.done && (it.text || "").trim(); });
    if (!items.length) return null;
    items.sort(function(a, b){
      var ad = a.dueDate || "9999-99-99", bd = b.dueDate || "9999-99-99";
      return ad < bd ? -1 : ad > bd ? 1 : 0;
    });
    return items[0];
  }
  var EVENT_STATUS_COLOR = { "計画中": "var(--text-faint)", "進行中": "var(--accent)", "完了": "var(--ok)" };

  /* ---- タブ / 検索 / 並び順。カード(#pv-events-list)と一覧ページ(#view-projects)で共用 ---- */
  var eventTab = "";        // "" = すべて(アクティブ) / "進行中" / "計画中" / "完了" / "alert" / "archived"
  var eventQuery = "";
  var eventPageSort = "order";
  function eventHasAlert(t){
    var today = jstDateKey(new Date());
    var done = t.status === "完了" || eventProgress(t) >= 100;
    if (t.dueDate && t.dueDate < today && !done) return true;
    return eventOverdueItems(t).length > 0;
  }
  function eventMatchesQuery(t, q){
    var hay = [t.name, t.status, (t.digest || []).join(" ")].join(" ");
    (t.items || []).forEach(function(it){ hay += " " + (it.text || "") + " " + (it.note || ""); });
    return hay.toLowerCase().indexOf(q) !== -1;
  }
  function filterEventTrackers(withSort){
    var q = eventQuery.trim().toLowerCase();
    var arr = eventTrackersState.filter(function(t){
      if (eventTab === "archived"){ if (!t.archived) return false; }
      else if (t.archived) return false;
      if (eventTab === "alert"){ if (!eventHasAlert(t)) return false; }
      else if (eventTab && eventTab !== "archived"){ if (t.status !== eventTab) return false; }
      if (q && !eventMatchesQuery(t, q)) return false;
      return true;
    });
    if (withSort){
      if (eventPageSort === "due"){
        arr.sort(function(a, b){ return (a.dueDate || "9999") < (b.dueDate || "9999") ? -1 : (a.dueDate || "9999") > (b.dueDate || "9999") ? 1 : 0; });
      } else if (eventPageSort === "updated"){
        arr.sort(function(a, b){ return (b.updatedAt || 0) - (a.updatedAt || 0); });
      } else if (eventPageSort === "progress"){
        arr.sort(function(a, b){ return eventProgress(a) - eventProgress(b); });
      }
    }
    return arr;
  }

  function applyEventTrackers(list, templates){
    eventTrackersState = list || [];
    if (templates !== undefined) eventTemplatesState = templates || [];
    eventTrackersLoadOk = true;
    renderEventTrackersAll();
    eventSetStatus("");
  }
  function failEventTrackers(err){
    eventTrackersState = [];
    renderEventTrackersAll();
    eventSetStatus(apiErrorMessage(err, "プロジェクトボード"), true);
  }
  async function loadEventTrackers(){
    var list = document.getElementById("pv-events-list");
    if (!list) return;
    eventSetStatus("読み込み中…");
    try {
      var res = await apiFetch("/api/event-trackers");
      applyEventTrackers(res.eventTrackers, res.templates);
    } catch (err){ failEventTrackers(err); }
  }

  // 1件ぶんの行 DOM。カード(page=false・コンパクト)と一覧ページ(page=true・チェックリスト付き)で共用。
  function buildEventRow(t, page){
    var pct = eventProgress(t);
    var done = t.status === "完了" || pct >= 100;
    var today = jstDateKey(new Date());
    var overdue = t.dueDate && t.dueDate < today && !done;
    var overdueItems = eventOverdueItems(t);
    var next = eventNextItem(t);

    var row = document.createElement("div");
    row.className = "pv-event-row" + (done ? " is-done" : "") + (overdue ? " is-overdue" : "") +
      (t.archived ? " is-archived" : "") + (page ? " is-page" : "");
    if (!done && !overdue) row.style.borderLeftColor = EVENT_STATUS_COLOR[t.status] || "var(--accent)";
    row.tabIndex = 0;
    row.setAttribute("role", "button");

    var head = document.createElement("div");
    head.className = "pv-case-head";
    var name = document.createElement("span");
    name.className = "pv-case-name";
    name.textContent = t.name || "（名称未設定）";
    head.appendChild(name);
    if (t.confidential){
      var lk = document.createElement("span"); lk.className = "pv-case-lock"; lk.textContent = "🔒"; lk.title = "機密"; head.appendChild(lk);
    }
    var kind = document.createElement("span");
    kind.className = "pv-event-kind";
    kind.textContent = eventKindLabel(t.kind);
    head.appendChild(kind);
    if (overdue){
      var od = document.createElement("span"); od.className = "pv-contract-alert is-err"; od.textContent = "⚠ 期限超過"; head.appendChild(od);
    }
    if (overdueItems.length){
      var oi = document.createElement("span"); oi.className = "pv-contract-alert is-err";
      oi.textContent = "⚠ 項目期限切れ " + overdueItems.length;
      oi.title = overdueItems.map(function(it){ return it.text; }).join("\n");
      head.appendChild(oi);
    }
    var st = document.createElement("span");
    st.className = "pv-case-status-badge";
    st.textContent = t.archived ? "アーカイブ" : t.status;
    head.appendChild(st);
    if (t.autoIngest === false){
      var ao = document.createElement("span"); ao.className = "pv-event-autooff"; ao.textContent = "自動オフ"; ao.title = "event-digest の対象外"; head.appendChild(ao);
    } else if (t.digest && t.digest.length){
      var ab = document.createElement("span"); ab.className = "pv-contract-slack-badge"; ab.textContent = "自動反映"; ab.title = "メール／Slackから自動入力された進捗があります"; head.appendChild(ab);
    }
    row.appendChild(head);

    // 「次にやること」= 未完了の先頭項目。進捗メタより上・明るい色で主役にする。
    var nx = document.createElement("div");
    nx.className = "pv-event-next" + (done ? " is-done" : "");
    if (done) nx.textContent = "✓ 全項目完了";
    else if (next) nx.textContent = "▶ 次: " + next.text + (next.dueDate ? "（期限 " + mdLabel(next.dueDate) + "）" : "");
    else nx.textContent = "項目が未登録です";
    row.appendChild(nx);

    var bar = document.createElement("div");
    bar.className = "pv-event-progress";
    var fill = document.createElement("div");
    fill.className = "pv-event-progress-fill";
    fill.style.width = pct + "%";
    bar.appendChild(fill);
    row.appendChild(bar);

    var meta = [];
    meta.push(eventDoneCount(t) + " 完了 (" + pct + "%)");
    if (t.kind === "recurring" && t.period) meta.push(t.period);
    if (t.dueDate) meta.push("期限 " + mdLabel(t.dueDate));
    var m = document.createElement("div");
    m.className = "pv-case-client";
    m.textContent = meta.join(" ・ ");
    row.appendChild(m);

    if (t.digest && t.digest[0]){
      var dg = document.createElement("div");
      dg.className = "pv-event-digest";
      dg.textContent = "💬 " + (page ? t.digest.slice(0, 2).join("  /  ") : t.digest[0]);
      row.appendChild(dg);
    }

    if (page){
      var items = t.items || [];
      if (items.length){
        var cl = document.createElement("ul");
        cl.className = "pv-event-checklist";
        items.slice(0, 8).forEach(function(it){
          var li = document.createElement("li");
          if (it.done) li.className = "is-done";
          else if (it.dueDate && !it.done && it.dueDate < today) li.className = "is-overdue";
          li.textContent = (it.done ? "✓ " : "・ ") + (it.text || "") + (!it.done && it.dueDate ? "（" + mdLabel(it.dueDate) + "）" : "");
          cl.appendChild(li);
        });
        if (items.length > 8){
          var more = document.createElement("li");
          more.className = "is-more";
          more.textContent = "…ほか " + (items.length - 8) + " 項目";
          cl.appendChild(more);
        }
        row.appendChild(cl);
      }
    }

    (function(id){
      function open(){ openEventModal(id); }
      row.addEventListener("click", open);
      row.addEventListener("keydown", function(e){ if (e.key === "Enter" || e.key === " "){ e.preventDefault(); open(); } });
    })(t.id);
    return row;
  }

  // カード(ビジネス右列)。フィルタ適用・3件まで・超過は「すべて表示」で #view-projects へ。
  function renderEventTrackersCard(){
    var list = document.getElementById("pv-events-list");
    if (!list) return;
    list.innerHTML = "";
    if (!eventTrackersState.length){
      list.innerHTML = '<div class="pv-habit-empty">「管理」からプロジェクトを追加してください。</div>';
      return;
    }
    var filtered = filterEventTrackers(false);
    if (!filtered.length){
      list.innerHTML = '<div class="pv-habit-empty">該当するプロジェクトがありません。</div>';
      return;
    }
    var CARD_MAX = 2; // ページ行は複数行なので少なめ。全部は「すべて表示」→ #view-projects
    filtered.slice(0, CARD_MAX).forEach(function(t){ list.appendChild(buildEventRow(t, false)); });
    var more = document.createElement("button");
    more.type = "button";
    more.className = "pv-list-more";
    more.textContent = filtered.length > CARD_MAX
      ? "すべて表示（ほか " + (filtered.length - CARD_MAX) + " 件）"
      : "一覧ページを開く";
    more.addEventListener("click", function(){ showView("projects"); });
    list.appendChild(more);
  }

  /* ---- プロジェクトボード 一覧ページ (#view-projects) ---- */
  var projectsPageWired = false;
  var projectsPageSetStatus = makeStatusSetter("projects-page-status");

  function renderEventPageTabs(){
    var bar = document.getElementById("projects-page-tabs");
    if (!bar) return;
    Array.prototype.forEach.call(bar.querySelectorAll(".pv-contracts-tab"), function(btn){
      btn.classList.toggle("is-active", (btn.getAttribute("data-tab") || "") === eventTab);
    });
  }

  function renderProjectsPage(){
    var list = document.getElementById("projects-page-list");
    if (!list) return;
    renderEventPageTabs();
    var q = document.getElementById("projects-page-q");
    if (q && q.value !== eventQuery) q.value = eventQuery;
    var sortSel = document.getElementById("projects-page-sort");
    if (sortSel && sortSel.value !== eventPageSort) sortSel.value = eventPageSort;

    list.innerHTML = "";
    if (!eventTrackersLoadOk && !eventTrackersState.length){
      list.innerHTML = '<div class="sched-empty">読み込み中…</div>';
      projectsPageSetStatus("読み込み中…");
      return;
    }
    if (!eventTrackersState.length){
      list.innerHTML = '<div class="pv-habit-empty">プロジェクトがまだありません。「＋ 新規」から追加できます。</div>';
      projectsPageSetStatus("0 件");
      return;
    }
    var filtered = filterEventTrackers(true);
    if (!filtered.length){
      list.innerHTML = '<div class="pv-habit-empty">該当するプロジェクトがありません。</div>';
      projectsPageSetStatus("0 / " + eventTrackersState.length + " 件");
      return;
    }
    filtered.forEach(function(t){ list.appendChild(buildEventRow(t, true)); });
    projectsPageSetStatus(
      filtered.length === eventTrackersState.length
        ? (eventTrackersState.length + " 件")
        : (filtered.length + " / " + eventTrackersState.length + " 件（絞り込み中）")
    );
  }

  function renderEventTrackersAll(){ renderEventTrackersCard(); renderProjectsPage(); }

  function wireProjectsPage(){
    if (projectsPageWired) return;
    projectsPageWired = true;
    var tabs = document.getElementById("projects-page-tabs");
    if (tabs) tabs.addEventListener("click", function(e){
      var btn = e.target.closest(".pv-contracts-tab");
      if (!btn) return;
      eventTab = btn.getAttribute("data-tab") || "";
      renderEventTrackersAll();
    });
    var q = document.getElementById("projects-page-q");
    if (q) q.addEventListener("input", function(){ eventQuery = q.value; renderEventTrackersAll(); });
    var sortSel = document.getElementById("projects-page-sort");
    if (sortSel) sortSel.addEventListener("change", function(){ eventPageSort = sortSel.value; renderProjectsPage(); });
    var newBtn = document.getElementById("projects-page-new");
    if (newBtn) newBtn.addEventListener("click", function(){
      openEventModal();
      if (eventTrackersLoadOk){
        eventEditRows.push(eventNewRow());
        eventDetailIdx = eventEditRows.length - 1;
        renderEventModal();
      }
    });
  }

  function initProjectsPage(){
    wireProjectsPage();
    if (!eventTrackersLoadOk) loadEventTrackers(); // 成功時 applyEventTrackers → renderEventTrackersAll
    else renderProjectsPage();
  }

  /* ---- イベントトラッカー管理モーダル (cases/contracts と同じ master-detail) ---- */
  function openEventModal(targetId){
    var modal = document.getElementById("pb-modal");
    if (!modal) return;
    if (!eventTrackersLoadOk){
      eventSetStatus("読み込みに失敗しています。再読み込みしてから操作してください。", true);
      loadEventTrackers();
      return;
    }
    var errEl = document.getElementById("pb-form-error");
    if (errEl){ errEl.hidden = true; errEl.textContent = ""; }
    eventEditRows = eventTrackersState.map(function(t){
      var m = t.match || {};
      return {
        id: t.id,
        name: t.name || "",
        kind: EVENT_KINDS.some(function(e){ return e.v === t.kind; }) ? t.kind : "oneoff",
        period: t.period || "",
        dueDate: t.dueDate || "",
        status: EVENT_STATUSES.indexOf(t.status) !== -1 ? t.status : "計画中",
        autoIngest: t.autoIngest !== false,
        archived: t.archived === true,
        confidential: t.confidential === true,
        match: {
          keywords: (m.keywords || []).slice(),
          gmailQuery: m.gmailQuery || "",
          senders: (m.senders || []).slice(),
          slackChannels: (m.slackChannels || []).slice()
        },
        items: (t.items || []).map(function(it){
          return { id: it.id || uid(), text: it.text || "", done: it.done === true, note: it.note || "",
            dueDate: it.dueDate || "", source: it.source === "manual" ? "manual" : "auto" };
        }),
        digest: (t.digest || []).slice()
      };
    });
    eventTplRows = (eventTemplatesState || []).map(function(tp){
      var m = tp.match || {};
      return {
        id: tp.id, name: tp.name || "", cadence: tp.cadence === "monthly" ? "monthly" : "manual",
        match: { keywords: (m.keywords || []).slice(), gmailQuery: m.gmailQuery || "",
          senders: (m.senders || []).slice(), slackChannels: (m.slackChannels || []).slice() },
        items: (tp.items || []).map(function(it){ return { id: it.id || uid(), text: it.text || "" }; })
      };
    });
    pbView = "list"; pbShowArchived = false;
    eventDetailIdx = null; eventTplDetailIdx = null;
    if (targetId){
      for (var i = 0; i < eventEditRows.length; i++){ if (eventEditRows[i].id === targetId){ eventDetailIdx = i; break; } }
    }
    renderEventModal();
    modal.hidden = false;
  }
  function closePbModal(){ var m = document.getElementById("pb-modal"); if (m) m.hidden = true; }
  function pbModalBack(){
    if (pbView === "templates"){
      if (eventTplDetailIdx != null){ eventTplDetailIdx = null; renderEventModal(); return; }
    } else if (eventDetailIdx != null){ eventDetailIdx = null; renderEventModal(); return; }
    closePbModal();
  }
  function eventNewRow(){
    return { id: uid(), name: "", kind: "oneoff", period: "", dueDate: "", status: "計画中",
      autoIngest: true, archived: false, confidential: false,
      match: { keywords: [], gmailQuery: "", senders: [], slackChannels: [] }, items: [], digest: [] };
  }
  function pbTemplateNewRow(){
    return { id: uid(), name: "", cadence: "manual",
      match: { keywords: [], gmailQuery: "", senders: [], slackChannels: [] }, items: [] };
  }
  function pbTemplateHint(r){
    return (r.cadence === "monthly" ? "毎月自動" : "手動") + " ・ " + (r.items || []).length + " 項目";
  }
  // テンプレから新規プロジェクト作業行を1件つくって詳細を開く
  function pbCreateFromTemplate(tpl){
    var name = tpl.name || "";
    if (tpl.cadence === "monthly"){
      var p = keyParts(jstDateKey(new Date()));
      name = p.y + "年" + p.m + "月度_" + name;
    }
    var row = {
      id: uid(), name: name, kind: tpl.cadence === "monthly" ? "recurring" : "oneoff",
      period: tpl.cadence === "monthly" ? (function(){ var p = keyParts(jstDateKey(new Date())); return p.y + "-" + String(p.m).padStart(2, "0"); })() : "",
      dueDate: "", status: "計画中", autoIngest: true, archived: false, confidential: false,
      match: {
        keywords: (tpl.match.keywords || []).slice(), gmailQuery: tpl.match.gmailQuery || "",
        senders: (tpl.match.senders || []).slice(), slackChannels: (tpl.match.slackChannels || []).slice()
      },
      items: (tpl.items || []).map(function(it){ return { id: uid(), text: it.text || "", done: false, note: "", dueDate: "", source: "auto" }; }),
      digest: []
    };
    eventEditRows.push(row);
    pbView = "list";
    eventDetailIdx = eventEditRows.length - 1;
    eventTplDetailIdx = null;
    renderEventModal();
  }
  function eventHint(r){
    var n = (r.items || []).length;
    var d = (r.items || []).filter(function(it){ return it.done; }).length;
    return (r.status || "計画中") + " ・ " + d + "/" + n + " 完了" + (r.autoIngest === false ? " ・ 自動オフ" : "") + (r.confidential ? " ・ 🔒機密" : "");
  }
  function renderPbTabs(){
    var bar = document.getElementById("pb-tabs");
    if (!bar) return;
    Array.prototype.forEach.call(bar.querySelectorAll("[data-pbtab]"), function(b){
      b.classList.toggle("is-active", b.getAttribute("data-pbtab") === pbView);
    });
  }
  function renderEventModal(){
    renderPbTabs();
    var listView = document.getElementById("pb-list-view");
    var detailView = document.getElementById("pb-detail-view");
    var tplListView = document.getElementById("pb-tpl-list-view");
    var tplDetailView = document.getElementById("pb-tpl-detail-view");
    var title = document.getElementById("pb-modal-title");

    var isTpl = pbView === "templates";
    var inTrkDetail = !isTpl && eventDetailIdx != null && !!eventEditRows[eventDetailIdx];
    var inTplDetail = isTpl && eventTplDetailIdx != null && !!eventTplRows[eventTplDetailIdx];
    if (!inTrkDetail) eventDetailIdx = null;
    if (!inTplDetail) eventTplDetailIdx = null;

    if (listView) listView.hidden = isTpl || inTrkDetail;
    if (detailView) detailView.hidden = isTpl || !inTrkDetail;
    if (tplListView) tplListView.hidden = !isTpl || inTplDetail;
    if (tplDetailView) tplDetailView.hidden = !isTpl || !inTplDetail;

    if (title) title.textContent =
      inTrkDetail ? "プロジェクトの設定" :
      inTplDetail ? "テンプレの設定" :
      isTpl ? "テンプレの管理" : "プロジェクトボードの管理";

    if (inTrkDetail) renderEventDetailView(eventDetailIdx);
    else if (isTpl && !inTplDetail) renderPbTplList();
    else if (inTplDetail) renderPbTplDetail(eventTplDetailIdx);
    else renderEventListView();
  }
  function pbListRow(r, globalIdx, activeSiblings){
    var row = document.createElement("div");
    row.className = "habit-list-row" + (r.archived ? " is-dim" : "");
    row.tabIndex = 0; row.setAttribute("role", "button");
    var txt = document.createElement("div"); txt.className = "habit-list-txt";
    var nm = document.createElement("div"); nm.className = "habit-list-name";
    nm.textContent = (r.name || "").trim() || "（名称未設定）";
    var hint = document.createElement("div"); hint.className = "habit-list-hint";
    hint.textContent = eventHint(r);
    txt.appendChild(nm); txt.appendChild(hint);
    var chev = document.createElement("span"); chev.className = "habit-list-chev"; chev.textContent = "›";
    // 並べ替えはアクティブ行のみ(アーカイブ行は順序を持たない扱い)
    if (!r.archived && activeSiblings && activeSiblings.length > 1){
      var myPos = activeSiblings.indexOf(r);
      var up = mkHabitIconBtn("↑", "上へ", "", function(e){
        e.stopPropagation();
        if (myPos > 0){ swapRows(r, activeSiblings[myPos - 1]); }
      });
      var down = mkHabitIconBtn("↓", "下へ", "", function(e){
        e.stopPropagation();
        if (myPos < activeSiblings.length - 1){ swapRows(r, activeSiblings[myPos + 1]); }
      });
      up.disabled = myPos === 0;
      down.disabled = myPos === activeSiblings.length - 1;
      row.appendChild(txt); row.appendChild(up); row.appendChild(down); row.appendChild(chev);
    } else {
      row.appendChild(txt); row.appendChild(chev);
    }
    function open(){ eventDetailIdx = eventEditRows.indexOf(r); renderEventModal(); }
    row.addEventListener("click", open);
    row.addEventListener("keydown", function(e){ if (e.key === "Enter" || e.key === " "){ e.preventDefault(); open(); } });
    return row;
  }
  function swapRows(a, b){
    var ia = eventEditRows.indexOf(a), ib = eventEditRows.indexOf(b);
    if (ia < 0 || ib < 0) return;
    eventEditRows[ia] = b; eventEditRows[ib] = a;
    renderEventListView();
  }
  function renderEventListView(){
    var wrap = document.getElementById("pb-rows");
    if (!wrap) return;
    wrap.innerHTML = "";
    var activeRows = eventEditRows.filter(function(r){ return !r.archived; });
    var archivedRows = eventEditRows.filter(function(r){ return r.archived; });

    if (!activeRows.length){
      var e = document.createElement("div");
      e.className = "habit-edit-empty";
      e.textContent = "プロジェクトがありません。「＋ 新規作成」から追加してください。";
      wrap.appendChild(e);
    } else {
      activeRows.forEach(function(r, idx){ wrap.appendChild(pbListRow(r, idx, activeRows)); });
    }

    if (archivedRows.length){
      var toggle = document.createElement("button");
      toggle.type = "button"; toggle.className = "pb-archived-toggle";
      toggle.textContent = (pbShowArchived ? "▾ " : "▸ ") + "アーカイブ済み (" + archivedRows.length + ")";
      toggle.addEventListener("click", function(){ pbShowArchived = !pbShowArchived; renderEventListView(); });
      wrap.appendChild(toggle);
      if (pbShowArchived){
        var box = document.createElement("div");
        box.className = "pb-archived-list";
        archivedRows.forEach(function(r){ box.appendChild(pbListRow(r, -1, null)); });
        wrap.appendChild(box);
      }
    }
  }
  function renderEventDetailView(idx){
    var body = document.getElementById("pb-detail-body");
    var r = eventEditRows[idx];
    if (!body || !r) return;
    body.innerHTML = "";

    var name = document.createElement("input");
    name.type = "text"; name.className = "habit-edit-name"; name.maxLength = 120;
    name.placeholder = "プロジェクト名（例：2026年9月度_月次決算 / オフィス引っ越し）"; name.value = r.name || "";
    name.addEventListener("input", function(){ r.name = name.value; });
    body.appendChild(name);

    var lineKind = document.createElement("div");
    lineKind.className = "habit-block-line";
    var kind = document.createElement("select");
    kind.className = "habit-edit-cadence case-edit-status";
    kind.innerHTML = EVENT_KINDS.map(function(e){ return '<option value="' + e.v + '">' + e.label + "</option>"; }).join("");
    kind.value = r.kind;
    var period = document.createElement("input");
    period.type = "text"; period.className = "case-edit-due"; period.maxLength = 7;
    period.placeholder = "YYYY-MM"; period.value = r.period || "";
    period.setAttribute("aria-label", "対象月（周期のみ）");
    period.addEventListener("input", function(){ r.period = period.value; });
    function syncKind(){ period.hidden = r.kind !== "recurring"; }
    kind.addEventListener("change", function(){ r.kind = kind.value; syncKind(); });
    syncKind();
    lineKind.appendChild(kind); lineKind.appendChild(period);
    body.appendChild(lineKind);

    var lineStatus = document.createElement("div");
    lineStatus.className = "habit-block-line";
    var status = document.createElement("select");
    status.className = "habit-edit-cadence case-edit-status";
    status.innerHTML = EVENT_STATUSES.map(function(s){ return '<option value="' + s + '">' + s + "</option>"; }).join("");
    status.value = r.status;
    status.addEventListener("change", function(){ r.status = status.value; });
    var due = document.createElement("input");
    due.type = "date"; due.className = "case-edit-due";
    due.value = r.dueDate || "";
    due.setAttribute("aria-label", "期限（任意）");
    due.addEventListener("input", function(){ r.dueDate = due.value; });
    lineStatus.appendChild(status); lineStatus.appendChild(due);
    body.appendChild(lineStatus);

    // --- items ---
    var itemsHead = document.createElement("div");
    itemsHead.className = "pv-event-field-label";
    itemsHead.textContent = "チェックリスト";
    body.appendChild(itemsHead);
    var itemsWrap = document.createElement("div");
    itemsWrap.className = "pv-event-items";
    body.appendChild(itemsWrap);
    var today = jstDateKey(new Date());
    function renderItems(){
      itemsWrap.innerHTML = "";
      r.items.forEach(function(it, i){
        var line = document.createElement("div");
        line.className = "pv-event-item-line";
        var cb = document.createElement("input");
        cb.type = "checkbox"; cb.checked = it.done === true;
        cb.setAttribute("aria-label", "完了");
        cb.addEventListener("change", function(){ it.done = cb.checked; it.source = "manual"; renderItems(); });
        var tx = document.createElement("input");
        tx.type = "text"; tx.className = "plan-tpl-text"; tx.maxLength = 200;
        tx.placeholder = "やること"; tx.value = it.text || "";
        tx.addEventListener("input", function(){ it.text = tx.value; it.source = "manual"; });
        var dd = document.createElement("input");
        dd.type = "date"; dd.className = "pv-event-item-due"; dd.value = it.dueDate || "";
        dd.setAttribute("aria-label", "項目の期限（任意）");
        if (it.dueDate && !it.done && it.dueDate < today) dd.classList.add("is-overdue");
        dd.addEventListener("input", function(){
          it.dueDate = dd.value; it.source = "manual";
          dd.classList.toggle("is-overdue", !!(it.dueDate && !it.done && it.dueDate < today));
          moreBtn.classList.toggle("has-val", !!(it.dueDate || it.note));
        });
        var note = document.createElement("input");
        note.type = "text"; note.className = "pv-event-item-note"; note.maxLength = 400;
        note.placeholder = "メモ（任意）"; note.value = it.note || "";
        note.addEventListener("input", function(){
          it.note = note.value; it.source = "manual";
          moreBtn.classList.toggle("has-val", !!(it.dueDate || it.note));
        });
        var sub = document.createElement("div");
        sub.className = "pv-event-item-sub";
        sub.appendChild(dd); sub.appendChild(note);
        // 期限・メモの行は既定で畳む(空ピッカーが項目数ぶん並ぶのを防ぐ)。値があれば開いた状態。
        var hasVal = !!(it.dueDate || it.note);
        sub.hidden = !hasVal;
        var moreBtn = mkHabitIconBtn("🗓", "期限・メモ", "pv-event-item-more", function(){
          sub.hidden = !sub.hidden;
          moreBtn.classList.toggle("is-open", !sub.hidden);
          if (!sub.hidden) dd.focus();
        });
        if (hasVal) moreBtn.classList.add("has-val");
        var up = mkHabitIconBtn("↑", "上へ", "pv-event-item-move", function(){
          if (i > 0){ var t = r.items[i - 1]; r.items[i - 1] = it; r.items[i] = t; renderItems(); }
        });
        var down = mkHabitIconBtn("↓", "下へ", "pv-event-item-move", function(){
          if (i < r.items.length - 1){ var t = r.items[i + 1]; r.items[i + 1] = it; r.items[i] = t; renderItems(); }
        });
        up.disabled = i === 0;
        down.disabled = i === r.items.length - 1;
        var del = mkHabitIconBtn("×", "削除", "habit-edit-del", function(){ r.items.splice(i, 1); renderItems(); });
        line.appendChild(cb); line.appendChild(tx);
        line.appendChild(up); line.appendChild(down);
        line.appendChild(moreBtn); line.appendChild(del);
        itemsWrap.appendChild(line);
        itemsWrap.appendChild(sub);
      });
      var add = document.createElement("button");
      add.type = "button"; add.className = "ev-btn plan-tpl-additem";
      add.textContent = "＋ 項目を追加";
      add.addEventListener("click", function(){ r.items.push({ id: uid(), text: "", done: false, note: "", dueDate: "", source: "auto" }); renderItems(); });
      itemsWrap.appendChild(add);
    }
    renderItems();

    // --- match (折りたたみ) ---
    var matchDetails = document.createElement("details");
    matchDetails.className = "pb-match-details";
    var matchSummary = document.createElement("summary");
    matchSummary.textContent = "自動反映の照合条件（メール／Slack）";
    matchDetails.appendChild(matchSummary);
    var hasMatch = (r.match.keywords || []).length || (r.match.slackChannels || []).length ||
      (r.match.senders || []).length || (r.match.gmailQuery || "");
    if (hasMatch) matchDetails.open = true;
    [
      { key: "keywords", label: "キーワード（カンマ区切り）", arr: true },
      { key: "slackChannels", label: "Slackチャンネル（カンマ区切り、# なし）", arr: true },
      { key: "senders", label: "差出人（カンマ区切り）", arr: true },
      { key: "gmailQuery", label: "Gmail 検索クエリ（任意・上級）", arr: false }
    ].forEach(function(f){
      var line = document.createElement("div");
      line.className = "habit-block-line";
      var lbl = document.createElement("span");
      lbl.className = "pv-contract-field-label";
      lbl.textContent = f.label;
      var inp = document.createElement("input");
      inp.type = "text"; inp.className = "plan-tpl-text"; inp.maxLength = 300;
      inp.value = f.arr ? (r.match[f.key] || []).join(", ") : (r.match[f.key] || "");
      inp.addEventListener("input", function(){
        r.match[f.key] = f.arr
          ? inp.value.split(",").map(function(s){ return s.trim(); }).filter(Boolean)
          : inp.value;
      });
      line.appendChild(lbl); line.appendChild(inp);
      matchDetails.appendChild(line);
    });
    body.appendChild(matchDetails);

    var lineFlags = document.createElement("div");
    lineFlags.className = "habit-block-line";
    var auto = document.createElement("label");
    auto.className = "habit-pause";
    var acb = document.createElement("input");
    acb.type = "checkbox"; acb.checked = r.autoIngest !== false;
    acb.addEventListener("change", function(){ r.autoIngest = acb.checked; });
    auto.appendChild(acb);
    auto.appendChild(document.createTextNode(" 自動反映を有効にする（event-digest の対象）"));
    lineFlags.appendChild(auto);
    body.appendChild(lineFlags);

    var lineConf = document.createElement("div");
    lineConf.className = "habit-block-line";
    var conf = document.createElement("label");
    conf.className = "habit-pause";
    var ccb = document.createElement("input");
    ccb.type = "checkbox"; ccb.checked = r.confidential === true;
    ccb.addEventListener("change", function(){ r.confidential = ccb.checked; });
    conf.appendChild(ccb);
    conf.appendChild(document.createTextNode(" 機密（🔒表示・エージェント経由では非展開）"));
    lineConf.appendChild(conf);
    body.appendChild(lineConf);

    // --- アーカイブ ---
    var archBtn = document.createElement("button");
    archBtn.type = "button";
    archBtn.className = "ev-btn pb-archive-btn";
    archBtn.textContent = r.archived ? "アーカイブから戻す" : "このプロジェクトをアーカイブ";
    archBtn.addEventListener("click", function(){
      r.archived = !r.archived;
      eventDetailIdx = null;
      renderEventModal();
    });
    body.appendChild(archBtn);

    if (r.digest && r.digest.length){
      var dgHead = document.createElement("div");
      dgHead.className = "pv-event-field-label";
      dgHead.textContent = "自動反映メモ（最新）";
      body.appendChild(dgHead);
      var dgList = document.createElement("ul");
      dgList.className = "pv-event-digest-list";
      r.digest.forEach(function(d){
        var li = document.createElement("li");
        li.textContent = d;
        dgList.appendChild(li);
      });
      body.appendChild(dgList);
    }
  }

  async function onEventModalSubmit(e){
    e.preventDefault();
    var errEl = document.getElementById("pb-form-error");
    var saveBtn = document.getElementById("pb-save");
    if (errEl){ errEl.hidden = true; errEl.textContent = ""; }
    function showErr(msg){ if (errEl){ errEl.textContent = msg; errEl.hidden = false; } }
    function failAt(i, msg){ eventDetailIdx = i; renderEventModal(); showErr(msg); }
    if (!eventTrackersLoadOk){ showErr("読み込みに失敗しています。再読み込みしてからやり直してください。"); return; }
    var cleaned = [];
    for (var i = 0; i < eventEditRows.length; i++){
      var r = eventEditRows[i];
      var nm = (r.name || "").trim();
      if (!nm){ failAt(i, "プロジェクト名を入力してください。"); return; }
      var kind = r.kind === "recurring" ? "recurring" : "oneoff";
      var items = (r.items || []).map(function(it){
        return { id: it.id || uid(), text: String(it.text || "").trim().slice(0, 200), done: it.done === true,
          note: String(it.note || "").trim().slice(0, 400), dueDate: it.dueDate || "",
          source: it.source === "manual" ? "manual" : "auto" };
      }).filter(function(it){ return it.text; });
      cleaned.push({
        id: r.id, name: nm.slice(0, 120), kind: kind,
        period: kind === "recurring" ? String(r.period || "").trim().slice(0, 7) : "",
        dueDate: r.dueDate || "",
        status: EVENT_STATUSES.indexOf(r.status) !== -1 ? r.status : "計画中",
        autoIngest: r.autoIngest !== false, archived: r.archived === true, confidential: r.confidential === true,
        match: {
          keywords: (r.match.keywords || []).slice(0, 30),
          gmailQuery: String(r.match.gmailQuery || "").trim().slice(0, 200),
          senders: (r.match.senders || []).slice(0, 20),
          slackChannels: (r.match.slackChannels || []).slice(0, 20)
        },
        items: items, digest: (r.digest || []).slice(0, 3)
      });
    }
    if (saveBtn){ saveBtn.disabled = true; saveBtn.textContent = "保存中…"; }
    try {
      await apiFetch("/api/event-trackers/bulk", {
        method: "PUT",
        headers: { "X-Allow-Empty": "1" },
        body: JSON.stringify({ eventTrackers: cleaned })
      });
      closePbModal();
      loadEventTrackers();
    } catch (err){
      if (errEl){ errEl.textContent = apiErrorMessage(err, "プロジェクトボード"); errEl.hidden = false; }
    } finally {
      if (saveBtn){ saveBtn.disabled = false; saveBtn.textContent = "保存"; }
    }
  }

  /* ---- テンプレ (繰り返しプロジェクトの雛形) ---- */
  function renderPbTplList(){
    var wrap = document.getElementById("pb-tpl-rows");
    if (!wrap) return;
    wrap.innerHTML = "";
    if (!eventTplRows.length){
      wrap.innerHTML = '<div class="habit-edit-empty">テンプレがありません。「＋ 新規作成」から追加してください。<br>周期=毎月自動 にすると毎月「YYYY年M月度_名前」が自動生成されます。</div>';
      return;
    }
    var single = eventTplRows.length <= 1;
    eventTplRows.forEach(function(r, idx){
      var row = document.createElement("div");
      row.className = "habit-list-row";
      row.tabIndex = 0; row.setAttribute("role", "button");
      var txt = document.createElement("div"); txt.className = "habit-list-txt";
      var nm = document.createElement("div"); nm.className = "habit-list-name";
      nm.textContent = (r.name || "").trim() || "（名称未設定）";
      var hint = document.createElement("div"); hint.className = "habit-list-hint";
      hint.textContent = pbTemplateHint(r);
      txt.appendChild(nm); txt.appendChild(hint);
      var mk = mkHabitIconBtn("＋", "このテンプレから作成", "", function(e){ e.stopPropagation(); pbCreateFromTemplate(r); });
      var up = mkHabitIconBtn("↑", "上へ", "", function(e){
        e.stopPropagation();
        if (idx > 0){ var t = eventTplRows[idx - 1]; eventTplRows[idx - 1] = r; eventTplRows[idx] = t; renderPbTplList(); }
      });
      var down = mkHabitIconBtn("↓", "下へ", "", function(e){
        e.stopPropagation();
        if (idx < eventTplRows.length - 1){ var t = eventTplRows[idx + 1]; eventTplRows[idx + 1] = r; eventTplRows[idx] = t; renderPbTplList(); }
      });
      up.hidden = down.hidden = single;
      up.disabled = idx === 0;
      down.disabled = idx === eventTplRows.length - 1;
      var chev = document.createElement("span"); chev.className = "habit-list-chev"; chev.textContent = "›";
      row.appendChild(txt); row.appendChild(mk); row.appendChild(up); row.appendChild(down); row.appendChild(chev);
      function open(){ eventTplDetailIdx = idx; renderEventModal(); }
      row.addEventListener("click", open);
      row.addEventListener("keydown", function(e){ if (e.key === "Enter" || e.key === " "){ e.preventDefault(); open(); } });
      wrap.appendChild(row);
    });
  }
  function renderPbTplDetail(idx){
    var body = document.getElementById("pb-tpl-detail-body");
    var r = eventTplRows[idx];
    if (!body || !r) return;
    body.innerHTML = "";

    var name = document.createElement("input");
    name.type = "text"; name.className = "habit-edit-name"; name.maxLength = 120;
    name.placeholder = "テンプレ名（例：月次決算）"; name.value = r.name || "";
    name.addEventListener("input", function(){ r.name = name.value; });
    body.appendChild(name);

    var lineCad = document.createElement("div");
    lineCad.className = "habit-block-line";
    var cad = document.createElement("select");
    cad.className = "habit-edit-cadence case-edit-status";
    cad.innerHTML = '<option value="manual">手動（ボタンで作成）</option><option value="monthly">毎月自動（YYYY年M月度_名前）</option>';
    cad.value = r.cadence;
    cad.addEventListener("change", function(){ r.cadence = cad.value; });
    lineCad.appendChild(cad);
    body.appendChild(lineCad);

    var itemsHead = document.createElement("div");
    itemsHead.className = "pv-event-field-label"; itemsHead.textContent = "チェックリスト（雛形）";
    body.appendChild(itemsHead);
    var itemsWrap = document.createElement("div"); itemsWrap.className = "pv-event-items";
    body.appendChild(itemsWrap);
    function renderItems(){
      itemsWrap.innerHTML = "";
      r.items.forEach(function(it, i){
        var line = document.createElement("div"); line.className = "plan-tpl-line";
        var tx = document.createElement("input");
        tx.type = "text"; tx.className = "plan-tpl-text"; tx.maxLength = 200;
        tx.placeholder = "やること"; tx.value = it.text || "";
        tx.addEventListener("input", function(){ it.text = tx.value; });
        var up = mkHabitIconBtn("↑", "上へ", "pv-event-item-move", function(){
          if (i > 0){ var t = r.items[i - 1]; r.items[i - 1] = it; r.items[i] = t; renderItems(); }
        });
        var down = mkHabitIconBtn("↓", "下へ", "pv-event-item-move", function(){
          if (i < r.items.length - 1){ var t = r.items[i + 1]; r.items[i + 1] = it; r.items[i] = t; renderItems(); }
        });
        up.disabled = i === 0;
        down.disabled = i === r.items.length - 1;
        var del = mkHabitIconBtn("×", "削除", "habit-edit-del", function(){ r.items.splice(i, 1); renderItems(); });
        line.appendChild(tx); line.appendChild(up); line.appendChild(down); line.appendChild(del);
        itemsWrap.appendChild(line);
      });
      var add = document.createElement("button");
      add.type = "button"; add.className = "ev-btn plan-tpl-additem"; add.textContent = "＋ 項目を追加";
      add.addEventListener("click", function(){ r.items.push({ id: uid(), text: "" }); renderItems(); });
      itemsWrap.appendChild(add);
    }
    renderItems();

    var matchDetails = document.createElement("details");
    matchDetails.className = "pb-match-details";
    var matchSummary = document.createElement("summary");
    matchSummary.textContent = "自動反映の照合条件（生成先に引き継ぐ）";
    matchDetails.appendChild(matchSummary);
    [
      { key: "keywords", label: "キーワード（カンマ区切り）", arr: true },
      { key: "slackChannels", label: "Slackチャンネル（# なし）", arr: true },
      { key: "senders", label: "差出人", arr: true },
      { key: "gmailQuery", label: "Gmail 検索クエリ", arr: false }
    ].forEach(function(f){
      var line = document.createElement("div"); line.className = "habit-block-line";
      var lbl = document.createElement("span"); lbl.className = "pv-contract-field-label"; lbl.textContent = f.label;
      var inp = document.createElement("input");
      inp.type = "text"; inp.className = "plan-tpl-text"; inp.maxLength = 300;
      inp.value = f.arr ? (r.match[f.key] || []).join(", ") : (r.match[f.key] || "");
      inp.addEventListener("input", function(){
        r.match[f.key] = f.arr ? inp.value.split(",").map(function(s){ return s.trim(); }).filter(Boolean) : inp.value;
      });
      line.appendChild(lbl); line.appendChild(inp);
      matchDetails.appendChild(line);
    });
    body.appendChild(matchDetails);

    var mkNow = document.createElement("button");
    mkNow.type = "button"; mkNow.className = "ev-btn ev-btn-primary pb-tpl-create";
    mkNow.textContent = "このテンプレからプロジェクトを作成";
    mkNow.addEventListener("click", function(){ pbCreateFromTemplate(r); });
    body.appendChild(mkNow);
  }
  async function onPbTemplateSubmit(){
    var errEl = document.getElementById("pb-form-error");
    var saveBtn = document.getElementById("pb-save");
    if (errEl){ errEl.hidden = true; errEl.textContent = ""; }
    var cleaned = [];
    for (var i = 0; i < eventTplRows.length; i++){
      var r = eventTplRows[i];
      var nm = (r.name || "").trim();
      if (!nm){ eventTplDetailIdx = i; renderEventModal(); if (errEl){ errEl.textContent = "テンプレ名を入力してください。"; errEl.hidden = false; } return; }
      var items = (r.items || []).map(function(it){ return { id: it.id || uid(), text: String(it.text || "").trim().slice(0, 200) }; })
        .filter(function(it){ return it.text; });
      cleaned.push({
        id: r.id, name: nm.slice(0, 120), cadence: r.cadence === "monthly" ? "monthly" : "manual",
        items: items,
        match: {
          keywords: (r.match.keywords || []).slice(0, 30),
          gmailQuery: String(r.match.gmailQuery || "").trim().slice(0, 200),
          senders: (r.match.senders || []).slice(0, 20),
          slackChannels: (r.match.slackChannels || []).slice(0, 20)
        }
      });
    }
    if (saveBtn){ saveBtn.disabled = true; saveBtn.textContent = "保存中…"; }
    try {
      await apiFetch("/api/event-trackers/templates", { method: "PUT", body: JSON.stringify({ templates: cleaned }) });
      closePbModal();
      loadEventTrackers();
    } catch (err){
      if (errEl){ errEl.textContent = apiErrorMessage(err, "プロジェクトボード"); errEl.hidden = false; }
    } finally {
      if (saveBtn){ saveBtn.disabled = false; saveBtn.textContent = "保存"; }
    }
  }

  function wireEventTrackers(){
    if (eventTrackersWired) return;
    eventTrackersWired = true;
    var manageBtn = document.getElementById("pv-events-manage");
    if (manageBtn) manageBtn.addEventListener("click", function(){ openEventModal(); });
    var allBtn = document.getElementById("pv-events-all");
    if (allBtn) allBtn.addEventListener("click", function(){ showView("projects"); });
    var modal = document.getElementById("pb-modal");
    var closeBtn = document.getElementById("pb-modal-close");
    var cancelBtn = document.getElementById("pb-cancel");
    var form = document.getElementById("pb-form");
    if (closeBtn) closeBtn.addEventListener("click", closePbModal);
    if (cancelBtn) cancelBtn.addEventListener("click", closePbModal);
    if (modal) modal.addEventListener("click", function(e){ if (e.target === modal) closePbModal(); });

    var tabs = document.getElementById("pb-tabs");
    if (tabs) tabs.addEventListener("click", function(e){
      var b = e.target.closest("[data-pbtab]");
      if (!b) return;
      pbView = b.getAttribute("data-pbtab") === "templates" ? "templates" : "list";
      eventDetailIdx = null; eventTplDetailIdx = null;
      renderEventModal();
    });

    // プロジェクト側
    var newBtn = document.getElementById("pb-new");
    var backBtn = document.getElementById("pb-detail-back");
    var delBtn = document.getElementById("pb-detail-del");
    if (newBtn) newBtn.addEventListener("click", function(){
      eventEditRows.push(eventNewRow());
      eventDetailIdx = eventEditRows.length - 1;
      renderEventModal();
    });
    if (backBtn) backBtn.addEventListener("click", function(){ eventDetailIdx = null; renderEventModal(); });
    if (delBtn) delBtn.addEventListener("click", async function(){
      if (eventDetailIdx == null) return;
      var r = eventEditRows[eventDetailIdx];
      if (r && (r.name || "").trim() && !(await askConfirm('「' + r.name + '」を削除しますか?'))) return;
      eventEditRows.splice(eventDetailIdx, 1);
      eventDetailIdx = null;
      renderEventModal();
    });

    // テンプレ側
    var tplNewBtn = document.getElementById("pb-tpl-new");
    var tplBackBtn = document.getElementById("pb-tpl-detail-back");
    var tplDelBtn = document.getElementById("pb-tpl-detail-del");
    if (tplNewBtn) tplNewBtn.addEventListener("click", function(){
      eventTplRows.push(pbTemplateNewRow());
      eventTplDetailIdx = eventTplRows.length - 1;
      renderEventModal();
    });
    if (tplBackBtn) tplBackBtn.addEventListener("click", function(){ eventTplDetailIdx = null; renderEventModal(); });
    if (tplDelBtn) tplDelBtn.addEventListener("click", async function(){
      if (eventTplDetailIdx == null) return;
      var r = eventTplRows[eventTplDetailIdx];
      if (r && (r.name || "").trim() && !(await askConfirm('テンプレ「' + r.name + '」を削除しますか?'))) return;
      eventTplRows.splice(eventTplDetailIdx, 1);
      eventTplDetailIdx = null;
      renderEventModal();
    });

    if (form) form.addEventListener("submit", function(e){
      e.preventDefault();
      if (pbView === "templates") onPbTemplateSubmit();
      else onEventModalSubmit(e);
    });
  }

  /* ================= ビジネス: Slackダイジェスト(フェーズB) =================
     読み取り専用。Claudeの定期実行タスクが /api/slack-digest へ書き込み、
     このカードはその最新10件を表示するだけ(手動の作成/編集/削除はない)。 */
  var slackDigestSetStatus = makeStatusSetter("pv-slack-status");

  // ダイジェスト本文から一覧用の見出し1行を作る。
  // 「■Claudeからの一言」直下の実文を優先。無ければ含まれるセクション名を並べる。
  function digestHeadline(summary){
    var lines = String(summary || "").split(/\r?\n/).map(function(s){ return s.trim(); }).filter(Boolean);
    for (var i = 0; i < lines.length; i++){
      if (lines[i].indexOf("■Claudeからの一言") === 0){
        if (lines[i + 1] && lines[i + 1].charAt(0) !== "■") return lines[i + 1];
        break;
      }
    }
    var heads = lines
      .filter(function(l){ return l.charAt(0) === "■" && l.indexOf("Claudeからの一言") === -1; })
      .map(function(l){ return l.replace(/^■/, "").replace(/の動き$/, ""); });
    if (heads.length) return heads.join("・");
    return lines[0] || "ダイジェスト";
  }

  function renderSlackDigest(digests){
    var list = document.getElementById("pv-slack-list");
    if (!list) return;
    list.innerHTML = "";
    if (!digests || !digests.length){
      list.innerHTML = '<div class="pv-habit-empty">まだダイジェストがありません。定期実行タスクの設定後、9/13/16/18時に届きます。</div>';
      return;
    }
    var SLACK_CARD_MAX = 3; // カードは最新3件まで
    digests.slice(0, SLACK_CARD_MAX).forEach(function(d){
      var item = document.createElement("div");
      item.className = "pv-slack-item";

      // 見出し行(クリックで詳細を開閉)
      var head = document.createElement("button");
      head.type = "button";
      head.className = "pv-slack-head";
      head.setAttribute("aria-expanded", "false");
      var time = document.createElement("span");
      time.className = "pv-slack-time";
      time.textContent = d.createdAt ? fmtSavedAt(d.createdAt) : "";
      var headline = document.createElement("span");
      headline.className = "pv-slack-headline";
      headline.textContent = digestHeadline(d.summary);
      head.appendChild(time);
      head.appendChild(headline);
      item.appendChild(head);

      // 詳細(既定は閉じている)
      var detail = document.createElement("div");
      detail.className = "pv-slack-detail";
      detail.hidden = true;
      if (d.channels && d.channels.length){
        var chans = document.createElement("div");
        chans.className = "pv-slack-channels";
        chans.textContent = d.channels.map(function(c){ return "#" + c; }).join(" ");
        detail.appendChild(chans);
      }
      var body = document.createElement("div");
      body.className = "pv-slack-summary";
      body.textContent = d.summary || "";
      detail.appendChild(body);
      item.appendChild(detail);

      head.addEventListener("click", function(){
        var open = detail.hidden;
        detail.hidden = !open;
        head.setAttribute("aria-expanded", open ? "true" : "false");
        item.classList.toggle("is-open", open);
      });

      list.appendChild(item);
    });
    if (digests.length > SLACK_CARD_MAX){
      var more = document.createElement("div");
      more.className = "pv-list-more is-static";
      more.textContent = "…ほか " + (digests.length - SLACK_CARD_MAX) + " 件";
      list.appendChild(more);
    }
  }

  // ビジネスタブ初期化: プロジェクトボード(event_trackers) / contracts / slack_digest を1回で取得。
  // (個別の loadEventTrackers / loadContracts は保存後の再取得・失敗時の再試行用に残している)
  async function loadBusinessBootstrap(){
    contractSetStatus("読み込み中…");
    eventSetStatus("読み込み中…");
    slackDigestSetStatus("読み込み中…");
    try {
      var res = await apiFetch("/api/bootstrap/business");
      applyContracts(res.contracts);
      applyEventTrackers(res.eventTrackers, res.eventTemplates);
      renderSlackDigest(res.digests || []);
      slackDigestSetStatus("");
    } catch (err){
      failContracts(err);
      failEventTrackers(err);
      var sl = document.getElementById("pv-slack-list");
      if (sl) sl.innerHTML = "";
      slackDigestSetStatus(apiErrorMessage(err, "Slackダイジェスト"), true);
    }
  }

  // app.js の initBusiness / showView(contracts分岐) / 設定モーダルが呼ぶ登録。
  CP.initBusinessCards = function(){ wireContracts(); wireEventTrackers(); loadBusinessBootstrap(); };
  CP.initContractsPage = initContractsPage;
  CP.renderContractsPage = renderContractsPage;
  CP.initProjectsPage = initProjectsPage;
  CP.renderProjectsPage = renderProjectsPage;
  CP.loadContracts = loadContracts;
  CP.loadEventTrackers = loadEventTrackers;
  // タスク画面の projectName() がプロジェクト名の予備解決に使う(主は tasks 側の projectsForLink)。
  CP.getEventTrackers = function(){ return eventTrackersState; };
})();
