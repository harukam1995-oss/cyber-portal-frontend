/* Cyber Portal — 請求書管理（SYSLEA 支払明細台帳 ＋ ベンダーマスタ）
   app.js 本体から分離したモジュール。#view-payables を初回に開いたときだけ
   app.js の loadPayablesModule() が <script> を注入してロードする
   (index.html には置かない・sw.js の SHELL にも入れない＝開いたとき取得→実行時キャッシュ)。
   本体 IIFE のヘルパーは window.__CP 経由で受け取る。 */
(function(){
  "use strict";
  var CP = window.__CP;
  if (!CP || !CP.apiFetch){
    console.error("[payables] window.__CP 未初期化。app.payables.js は app.js の後にのみロードされる想定です。");
    return;
  }
  var escapeHtml = CP.escapeHtml, apiFetch = CP.apiFetch, apiFetchBlob = CP.apiFetchBlob,
      apiErrorMessage = CP.apiErrorMessage, jstDateKey = CP.jstDateKey, acctPath = CP.acctPath,
      extractPdfText = CP.extractPdfText, mailAttachBytes = CP.mailAttachBytes;

  /* ================= 請求書管理（SYSLEA 支払明細台帳 ＋ ベンダーマスタ） =================
     受け取った請求書を「こちら側」で構造化して蓄積する。SYSLEA の Drive/スプシは触らず、
     Firestore(users/{uid}/syslea_payables, syslea_vendors)に持って CSV でいつでも書き出す。
     v1: 手入力フォーム ＋ 01.payment メールからの下書き取り込み。 */
  var PAY_METHODS = ["銀行振込", "UPSIDER", "口座振替", "その他"];
  var PAY_QUALIFIED = ["適格", "非適格", "不明"];
  var SYSLEA_MAIL_ADDR = "haruka.masumitsu@syslea.io";
  // 書き出し先スプレッドシート（本人の「SYSLEA支払管理」。SYSLEA 側のものではない）
  var PAY2_SHEET_ID = "1ri3pOCzWgh_PVpRqIWYJotlqCvBWgWUCYU43vWPwEYU";
  var PAY2_SHEET_URL = "https://docs.google.com/spreadsheets/d/" + PAY2_SHEET_ID + "/edit";

  var p2 = {
    payables: [], vendors: [], receipts: [], tab: p2SavedTab(),
    fMonth: "", fMethod: "", fUnpaid: false, fNeedInput: false, fQueue: false, fQ: "", fExcluded: false, fMismatch: false,
    vq: "", vFm: "", vFcat: "", vNoEmail: false, vOverdue: false, vFex: "hide",
    checkOpen: true, checkOverdueOnly: true, checkView: "matrix", checkQ: "", checkCat: "", checkMethod: "", checkCad: "", _recv: {}, qsum: null,
    wired: false, editId: null, vendId: null
  };

  function p2El(id){ return document.getElementById(id); }
  function p2ById(list, id){
    for (var i = 0; i < list.length; i++){ if (list[i].id === id) return list[i]; }
    return undefined;
  }
  // 差出人アドレスの正規化（"Name <a@b.com>" なら <> の中身、以降 小文字）
  function p2EmailKey(v){
    var s = String(v == null ? "" : v).trim();
    var m = s.match(/<([^>]+)>/);
    if (m) s = m[1].trim();
    return s.toLowerCase();
  }
  function p2VendorEmails(v){
    return String((v && v.emails) || "").split(/[\s,|;]+/).map(p2EmailKey).filter(Boolean);
  }
  function p2VendorByEmail(email){
    var k = p2EmailKey(email);
    if (!k) return null;
    return p2.vendors.filter(function(x){ return p2VendorEmails(x).indexOf(k) !== -1; })[0] || null;
  }
  function p2VendorByName(name){
    var n = String(name || "").trim();
    if (!n) return null;
    return p2.vendors.filter(function(x){ return (x.name || "").trim() === n; })[0] || null;
  }
  function p2Status(msg, cls){
    var el = p2El("pay2-status");
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle("err", cls === "err");
  }
  function p2CountStatus(){
    var msg = p2.payables.length + " 件の請求書 ／ ベンダー " + p2.vendors.length + " 社";
    p2Status(msg);
  }
  function p2Money(n){
    if (n == null || n === "" || !isFinite(n)) return "—";
    return "¥" + Math.round(Number(n)).toLocaleString("ja-JP");
  }
  function p2Ym(dstr){
    var m = String(dstr || "").match(/^(\d{4})-(\d{2})/);
    return m ? m[1] + "-" + m[2] : "";
  }
  function p2MethodBadge(method){
    var cls = method === "銀行振込" ? "pay2-b-furikomi"
      : method === "UPSIDER" ? "pay2-b-upsider"
      : method === "口座振替" ? "pay2-b-furikae" : "pay2-b-other";
    return '<span class="pay2-badge ' + cls + '">' + escapeHtml(method || "その他") + "</span>";
  }
  function p2Opt(list, cur){
    return list.map(function(v){
      return '<option value="' + escapeHtml(v) + '"' + (v === cur ? " selected" : "") + ">" + escapeHtml(v) + "</option>";
    }).join("");
  }

  var PAY_CATEGORIES = ["業務委託", "SaaS", "その他"];
  // 周期（何ヶ月ごと）: 0=スポット / 1=毎月 / 12=毎年 / N=Nヶ月ごと。旧 recurring(真偽) は 1/0 へ。
  function p2CadenceOf(v){
    var m = Number(v && v.cadenceMonths);
    if (isFinite(m) && m >= 0) return Math.round(m);
    return (v && v.recurring === true) ? 1 : 0;
  }
  function p2CadenceLabel(m){
    if (!m) return "スポット";
    if (m === 1) return "毎月";
    if (m === 12) return "毎年";
    return m + "ヶ月ごと";
  }
  function p2Mkey(s){ s = String(s || ""); return /^\d{4}-\d{2}/.test(s) ? s.slice(0, 7) : ""; }
  function p2MonthsDiff(a, b){ // b - a（月数）。a,b = "YYYY-MM"
    var x = a.split("-").map(Number), y = b.split("-").map(Number);
    return (y[0] - x[0]) * 12 + (y[1] - x[1]);
  }
  var PAY_EXPECT_DAY_FALLBACK = 25;
  function p2CurMonth(){ return p2Mkey(jstDateKey(new Date())); }
  function p2ExpectDay(v){
    var n = parseInt(v && v.expectDay, 10);
    return (n >= 1 && n <= 28) ? n : PAY_EXPECT_DAY_FALLBACK;
  }
  // 月あたりの件数（同じ支払月に届く請求書の数・既定1。Findy のように毎月2件来るベンダー用）
  function p2ExpectCount(v){
    var n = parseInt(v && v.expectCount, 10);
    return (n >= 1 && n <= 10) ? n : 1;
  }
  function p2RecvCount(v, month){
    var e = p2._recv[v.id];
    return (e && e.count && e.count[month]) || 0;
  }
  // 受領実績インデックス（サーバーで syslea_payables＋payments を threadId 名寄せ済みの
  // p2.receipts から）。vendorId → { last:"YYYY-MM", byMonth: { "YYYY-MM": receipt } }
  // receipt.month は「支払月」（いつ払うか）。受領チェックはこの支払月で並べる。
  // 案B: p2.receipts は syslea_payables 由来のみ（source は常に "payable"）。
  function p2RecvIndex(){
    var idx = {};
    (p2.receipts || []).forEach(function(r){
      if (!r || !r.vendorId || !r.month) return;
      var e = idx[r.vendorId] || (idx[r.vendorId] = { last: "", first: "", byMonth: {}, count: {} });
      if (!e.first || r.month < e.first) e.first = r.month;
      if (!e.byMonth[r.month] || r.source === "payable") e.byMonth[r.month] = r; // 同月は手入力行を優先
      e.count[r.month] = (e.count[r.month] || 0) + 1; // 同じ支払月に届いた請求書の数（月N件のベンダー用）
      if (r.month > e.last) e.last = r.month;
    });
    return idx;
  }
  // 定期ベンダー v が month（"YYYY-MM"）に到来予定か。毎月は常時、Nヶ月毎は直近受領月を位相基準に判定。
  function p2ExpectedInMonth(v, month){
    var cm = p2CadenceOf(v);
    if (cm < 1) return false;
    var e = p2._recv[v.id];
    if (e && e.first && month < e.first) return false; // 最初に受け取った支払月より前は数えない（途中から取引の始まったベンダーの過去月を未着にしない）
    if (cm === 1) return true;
    var anchor = e && e.last;
    if (!anchor) return false;              // 位相不明は判定保留（誤検知させない）
    return month > anchor && p2MonthsDiff(anchor, month) % cm === 0;
  }
  // month 時点の状態: "received" | "overdue" | "waiting" | ""（対象外）
  function p2VendorMonthState(v, month){
    if (!p2ExpectedInMonth(v, month)) return "";
    var e = p2._recv[v.id];
    if (p2RecvCount(v, month) >= p2ExpectCount(v)) return "received"; // 月N件のベンダーは N件そろって受領
    if (!e || !e.last) return "waiting";   // 受領実績ゼロは未着にしない（静かに・要件 §6）
    var cur = p2CurMonth();
    if (month < cur) return "overdue";
    if (month === cur){
      var day = parseInt(jstDateKey(new Date()).slice(8, 10), 10) || 1;
      return day >= p2ExpectDay(v) ? "overdue" : "waiting";
    }
    return "waiting";
  }
  function p2VendorLate(v){ return p2VendorMonthState(v, p2CurMonth()) === "overdue"; }
  function p2AmountFlag(r){
    if (r.amountExcl != null && r.tax != null && r.amountIncl != null){
      if (Math.abs((Number(r.amountExcl) + Number(r.tax)) - Number(r.amountIncl)) > 1){
        return '<span class="pay2-flag">税額不一致</span>';
      }
    }
    return "";
  }

  // 直近 P2_RECENT_DAYS 日に受け取った未払いで、金額か支払期日が空＝まだ払える状態でない行。
  // 過去の未払い（総合振込で払ったが支払済にしていない行）まで数えると件数が大きすぎて役に立たないので直近に限る。
  var P2_RECENT_DAYS = 60;
  function p2NeedsInput(r){
    if (r.paid || r.excluded) return false;
    if (r.amountIncl != null && r.dueDate) return false;
    return String(r.receivedDate || "") >= jstDateKey(new Date(Date.now() - P2_RECENT_DAYS * 864e5));
  }
  function p2IsOverdue(r, today){ return !r.paid && !r.excluded && !!r.dueDate && r.dueDate < today; }
  function p2PayToAlert(r){ return !!(r.payToMismatch && !r.payToChecked && !r.excluded && !r.paid); }
  function p2Badge(text, tone){ return '<span class="ui-badge pay2-st-' + tone + '">' + escapeHtml(text) + "</span>"; }

  /* ---- 今月やること（ページ上部の KPI 帯・2026/09/14）----
     開いた瞬間に「来ていない・払っていない・確かめていない」が分かるように、読み込み済みの台帳とベンダーマスタから数える（API は増やさない）。
     押すとその一覧へ飛ぶ。未処理メールは Gmail との突き合わせが重いので、押してキューを開く。 */
  function p2RenderKpis(){
    var band = p2El("pay2-kpis");
    if (!band) return;
    var today = jstDateKey(new Date());
    var soon = jstDateKey(new Date(Date.now() + 7 * 864e5));
    var cur = p2CurMonth(), prev = p2MonthAdd(cur, -1);
    var late = 0, lateCur = 0, latePrev = 0;
    p2.vendors.forEach(function(v){
      if (v.excluded) return;
      var a = p2VendorMonthState(v, cur) === "overdue", b = p2VendorMonthState(v, prev) === "overdue";
      if (a || b) late++;
      if (a) lateCur++;
      if (b) latePrev++;
    });
    var od = { n: 0, sum: 0 }, sn = { n: 0, sum: 0 }, mis = 0, need = 0;
    p2.payables.forEach(function(r){
      var amt = r.amountIncl != null ? Number(r.amountIncl) : 0;
      if (p2IsOverdue(r, today)){ od.n++; od.sum += amt; }
      else if (!r.paid && !r.excluded && r.dueDate && r.dueDate <= soon){ sn.n++; sn.sum += amt; }
      if (p2PayToAlert(r)) mis++;
      if (p2NeedsInput(r)) need++;
    });
    var money = function(o){ return o.n ? (o.sum ? p2Money(o.sum) : "金額未入力") : "—"; };
    var tile = function(key, label, value, sub, tone){
      return '<button type="button" class="kpi pay2-kpi" data-kpi="' + key + '">' +
        '<span class="kpi-label">' + label + "</span>" +
        '<span class="kpi-value' + (tone ? " " + tone : "") + '">' + value + "</span>" +
        '<span class="kpi-sub">' + sub + "</span></button>";
    };
    var qs = p2.qsum || {};
    var qN = typeof qs.parent === "number" ? qs.parent : null;
    var qSub = qs.connected === false ? "SYSLEA の Google 連携が必要"
      : qs.last ? "前回の突き合わせ " + qs.last.total + "件・" + p2TimeLabel(qs.last.at)
      : "押して突き合わせ";
    band.innerHTML =
      tile("queue", "未処理メール", qN == null ? "—" : qN + "件", qSub, qN ? "is-neg" : "") +
      tile("late", "未着", late + "社", "今月 " + lateCur + " ／ 先月 " + latePrev, late ? "is-neg" : "") +
      tile("overdue", "支払期限切れ", od.n + "件", money(od), od.n ? "is-neg" : "") +
      tile("soon", "7日以内に支払", sn.n + "件", money(sn), sn.n ? "is-warn" : "") +
      tile("mismatch", "口座変更（未確認）", mis + "件", "振込の前に確認", mis ? "is-neg" : "") +
      tile("need", "金額・期日が未入力", need + "件", "直近" + P2_RECENT_DAYS + "日・未払い", need ? "is-warn" : "");
    band.hidden = false;
  }
  function p2KpiClick(e){
    var b = e.target && e.target.closest ? e.target.closest("[data-kpi]") : null;
    if (!b) return;
    var k = b.getAttribute("data-kpi");
    if (k === "queue"){ p2OpenImport(); return; }
    if (k === "late"){
      Object.assign(p2, { checkOpen: true, checkOverdueOnly: true, checkView: "matrix", checkQ: "", checkCat: "", checkMethod: "", checkCad: "" });
      p2El("pay2-check-month").value = p2CurMonth();
      P2_CHECK_FILTER_IDS.forEach(function(id){ p2El(id).value = ""; });
      p2SwitchTab("check");
      p2El("pay2-check").scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    p2JumpDetail({ fQueue: k === "overdue" || k === "soon", fMismatch: k === "mismatch", fNeedInput: k === "need" });
  }
  // 明細の絞り込みをいったん既定に戻してから opts を当て、表まで送る（帯の件数と表の件数をそろえる）
  function p2JumpDetail(opts){
    Object.assign(p2, { fMonth: "", fMethod: "", fQ: "", fUnpaid: false, fNeedInput: false, fQueue: false, fExcluded: false, fMismatch: false }, opts);
    p2El("pay2-month").value = p2.fMonth;
    p2El("pay2-method").value = p2.fMethod;
    p2El("pay2-q").value = p2.fQ;
    p2El("pay2-queue").checked = p2.fQueue;
    p2El("pay2-unpaid").checked = p2.fUnpaid;
    p2El("pay2-need-input").checked = p2.fNeedInput;
    p2El("pay2-show-excluded").checked = p2.fExcluded;
    if (p2.tab !== "detail") p2SwitchTab("detail"); else p2RenderDetail();
    p2El("pay2-detail-wrap").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function initPayables(){
    if (!p2.wired){
      p2.wired = true;
      // タブ切替
      document.querySelectorAll("#pay2-tabs .acct-tab").forEach(function(btn){
        btn.addEventListener("click", function(){ p2SwitchTab(btn.getAttribute("data-p2tab")); });
      });
      // フィルタ
      p2El("pay2-month").addEventListener("change", function(){ p2.fMonth = this.value; p2RenderDetail(); });
      p2El("pay2-method").addEventListener("change", function(){ p2.fMethod = this.value; p2RenderDetail(); });
      p2El("pay2-queue").addEventListener("change", function(){ p2.fQueue = this.checked; p2RenderDetail(); });
      p2El("pay2-unpaid").addEventListener("change", function(){ p2.fUnpaid = this.checked; p2RenderDetail(); });
      p2El("pay2-need-input").addEventListener("change", function(){ p2.fNeedInput = this.checked; p2RenderDetail(); });
      p2El("pay2-q").addEventListener("input", function(){ p2.fQ = this.value; p2RenderDetail(); });
      p2El("pay2-show-excluded").addEventListener("change", function(){ p2.fExcluded = this.checked; p2RenderDetail(); });
      // 未着チェック（支払月・要対応/すべて・月別/一覧）
      p2El("pay2-check-month").addEventListener("change", function(){ p2RenderCheck(); p2RenderTabCounts(); });
      p2El("pay2-check-filter").addEventListener("click", function(e){
        var b = e.target && e.target.closest ? e.target.closest("[data-f]") : null;
        if (!b) return;
        p2.checkOverdueOnly = b.getAttribute("data-f") !== "all";
        p2RenderCheck();
      });
      p2El("pay2-check-view").addEventListener("click", function(e){
        var b = e.target && e.target.closest ? e.target.closest("[data-view]") : null;
        if (!b) return;
        p2.checkView = b.getAttribute("data-view") === "list" ? "list" : "matrix";
        p2RenderCheck();
      });
      // 未着チェックの検索・絞り込み（区分・方式・周期）
      P2_CHECK_FILTER_IDS.forEach(function(id){
        p2El(id).addEventListener(id === "pay2-check-q" ? "input" : "change", function(){
          p2.checkQ = p2El("pay2-check-q").value;
          p2.checkCat = p2El("pay2-check-fcat").value;
          p2.checkMethod = p2El("pay2-check-fm").value;
          p2.checkCad = p2El("pay2-check-fcad").value;
          p2RenderCheck();
        });
      });
      // 今月やること（帯）
      p2El("pay2-kpis").addEventListener("click", p2KpiClick);
      // ボタン
      p2El("pay2-new-btn").addEventListener("click", function(){ p2OpenEdit(null); });
      p2El("pay2-import-btn").addEventListener("click", p2OpenImport);
      p2StmtWire();
      p2El("pay2-csv-btn").addEventListener("click", function(){ p2Csv("syslea_payables"); });
      p2El("pay2-sheet-btn").addEventListener("click", p2SheetSync);
      p2El("pay2-sheetpull-btn").addEventListener("click", p2SheetPull);
      p2El("pay2-vendor-sheetpull-btn").addEventListener("click", p2SheetPull);
      p2El("pay2-vendor-new-btn").addEventListener("click", function(){ p2OpenVendor(null); });
      p2El("pay2-vendor-csv-btn").addEventListener("click", function(){ p2Csv("syslea_vendors"); });
      p2El("pay2-vendor-sheet-btn").addEventListener("click", p2SheetSync);
      // ベンダーマスタの検索・フィルタ
      p2El("pay2-vendor-q").addEventListener("input", function(){ p2.vq = this.value; p2RenderVendors(); });
      p2El("pay2-vendor-fm").addEventListener("change", function(){ p2.vFm = this.value; p2RenderVendors(); });
      p2El("pay2-vendor-fcat").addEventListener("change", function(){ p2.vFcat = this.value; p2RenderVendors(); });
      p2El("pay2-vendor-noemail").addEventListener("change", function(){ p2.vNoEmail = this.checked; p2RenderVendors(); });
      p2El("pay2-vendor-overdue").addEventListener("change", function(){ p2.vOverdue = this.checked; p2RenderVendors(); });
      p2El("pay2-vendor-fex").addEventListener("change", function(){ p2.vFex = this.value; p2RenderVendors(); });
      // 明細モーダル
      p2El("pay2-edit-close").addEventListener("click", p2CloseEdit);
      p2El("pay2-edit-cancel").addEventListener("click", p2CloseEdit);
      p2El("pay2-edit-form").addEventListener("submit", function(e){ e.preventDefault(); p2SaveEdit(); });
      p2El("pay2-edit-del").addEventListener("click", function(){ p2DeleteDoc("payable"); });
      // ベンダーモーダル
      p2El("pay2-vendor-close").addEventListener("click", p2CloseVendor);
      p2El("pay2-vendor-cancel").addEventListener("click", p2CloseVendor);
      p2El("pay2-vendor-form").addEventListener("submit", function(e){ e.preventDefault(); p2SaveVendor(); });
      p2El("pay2-vendor-del").addEventListener("click", function(){ p2DeleteDoc("vendor"); });
      // 未処理キュー（旧 取り込みモーダル）
      p2El("pay2-import-close").addEventListener("click", p2CloseImport);
      p2El("pay2-import-cancel").addEventListener("click", p2CloseImport);
      p2El("pay2-queue-reload").addEventListener("click", function(){ p2QueueLoad(true); });
      p2El("pay2-queue-dismiss-junk").addEventListener("click", p2QueueDismissJunk);
      p2El("pay2-import-list").addEventListener("click", p2QueueClick);
      p2El("pay2-import-list").addEventListener("input", p2QueueFormInput);
      p2El("pay2-import-list").addEventListener("change", p2QueueFormInput);
    }
    p2Load();
  }

  // Promise を返す(p2SheetPull などが p2Load().then で完了を待つ。返していなかったので
  // スプシ取り込みが成功しても TypeError でエラー表示になっていた)。
  function p2Load(){
    p2Status("読み込み中…");
    return apiFetch("/api/payables").then(function(res){
      p2.payables = (res && res.payables) || [];
      p2.vendors = (res && res.vendors) || [];
      p2.receipts = (res && res.receipts) || [];
      p2RenderAll();
      p2El("pay2-summary").hidden = (p2.tab !== "detail");
      p2CountStatus();
      p2QueueSummaryLoad();
    }).catch(function(err){
      p2Status(apiErrorMessage(err, "請求書管理"), "err");
    });
  }
  // 「未処理メール」の件数（親 01.payment のメール数＋前回の突き合わせ）。重い突き合わせはしない。
  function p2QueueSummaryLoad(){
    return apiFetch("/api/payables/queue/summary").then(function(res){
      p2.qsum = res || {};
    }).catch(function(){
      p2.qsum = { error: true };
    }).then(p2RenderKpis);
  }
  function p2TimeLabel(ms){
    if (!ms) return "";
    try { return new Date(Number(ms)).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
    catch(e){ return ""; }
  }

  /* ---- タブ（2026/09/14）: 未着チェック｜台帳｜明細の突き合わせ｜ベンダー。1画面に1つだけ出す ----
     以前は 未着チェック・明細の突き合わせ・台帳の表 が1ページに縦に並び、合計の行も未着チェックの上にあって見分けにくかった。
     最後に開いたタブはこの端末に覚える。 */
  var P2_TABS = ["check", "detail", "stmt", "vendor"];
  function p2SavedTab(){
    try { var t = localStorage.getItem("cp_p2_tab"); return ["check", "detail", "stmt", "vendor"].indexOf(t) !== -1 ? t : "check"; }
    catch(e){ return "check"; }
  }
  function p2ApplyTab(){
    var t = p2.tab;
    document.querySelectorAll("#pay2-tabs .acct-tab").forEach(function(b){
      var on = b.getAttribute("data-p2tab") === t;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    p2El("pay2-detail-tools").hidden = t !== "detail";
    p2El("pay2-vendor-tools").hidden = t !== "vendor";
    p2El("pay2-check").hidden = t !== "check";
    p2El("pay2-stmt").hidden = t !== "stmt";
    p2El("pay2-summary").hidden = t !== "detail";
    p2El("pay2-detail-wrap").hidden = t !== "detail";
    p2El("pay2-vendor-wrap").hidden = t !== "vendor";
  }
  function p2RenderActive(){
    if (p2.tab === "check") p2RenderCheck();
    else if (p2.tab === "vendor") p2RenderVendors();
    else if (p2.tab === "stmt"){
      p2s.open = true;
      if (!p2s.data && !p2s.loading) p2StmtLoad(); else p2StmtRender();
    }
    else p2RenderDetail();
  }
  function p2SwitchTab(tab){
    p2.tab = P2_TABS.indexOf(tab) !== -1 ? tab : "check";
    try { localStorage.setItem("cp_p2_tab", p2.tab); } catch(e){}
    p2ApplyTab();
    p2RenderActive();
  }
  // タブの件数: 未着チェック＝要対応の社数（赤）／台帳＝対象外を除く件数／ベンダー＝対象外を除く社数
  function p2RenderTabCounts(){
    var set = function(id, txt, alert){ var el = p2El(id); if (el){ el.textContent = txt; el.classList.toggle("is-alert", !!alert); } };
    var mEl = p2El("pay2-check-month");
    var need = p2CheckMatrixRows((mEl && mEl.value) || p2CurMonth()).filter(function(r){ return r.lateIdx !== -1; }).length;
    set("pay2-tab-n-check", need ? String(need) : "", need > 0);
    set("pay2-tab-n-detail", String(p2.payables.filter(function(r){ return !r.excluded; }).length));
    set("pay2-tab-n-vendor", String(p2.vendors.filter(function(v){ return !v.excluded; }).length));
  }

  function p2RenderAll(){
    p2._recv = p2RecvIndex();
    // 月セレクトの選択肢を受領日から作る
    var months = {};
    p2.payables.forEach(function(r){ var ym = p2Ym(r.receivedDate); if (ym) months[ym] = 1; });
    var keys = Object.keys(months).sort().reverse();
    var sel = p2El("pay2-month");
    var cur = p2.fMonth;
    sel.innerHTML = '<option value="">受領月（すべて）</option>' + keys.map(function(k){
      return '<option value="' + k + '"' + (k === cur ? " selected" : "") + ">" + k + "</option>";
    }).join("");
    p2RenderKpis();
    p2RenderTabCounts();
    p2ApplyTab();
    p2RenderActive();
  }

  function p2Filtered(){
    var q = (p2.fQ || "").trim().toLowerCase();
    return p2.payables.filter(function(r){
      if (!p2.fExcluded && r.excluded) return false;
      if (p2.fMonth && p2Ym(r.receivedDate) !== p2.fMonth) return false;
      if (p2.fMethod && r.method !== p2.fMethod) return false;
      if (p2.fUnpaid && r.paid) return false;
      if (p2.fQueue && (r.paid || r.excluded)) return false;
      if (p2.fNeedInput && !p2NeedsInput(r)) return false;
      if (p2.fMismatch && !p2PayToAlert(r)) return false;
      if (q){
        var hay = [r.vendorName, r.fromEmail, r.invoiceNo, r.payTo, r.note, r.regNo].join(" ").toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  function p2RenderDetail(){
    var today = jstDateKey(new Date());
    var soon = jstDateKey(new Date(Date.now() + 7 * 864e5));
    var isOverdue = function(r){ return p2IsOverdue(r, today); };
    var filtered = p2Filtered();
    var rows = filtered.slice();
    if (p2.fQueue){
      // 支払キュー: 期限切れ→期日順（期日なしは末尾）
      rows.sort(function(a, b){
        var ao = isOverdue(a) ? 0 : 1, bo = isOverdue(b) ? 0 : 1;
        if (ao !== bo) return ao - bo;
        var ad = a.dueDate || "9999-99-99", bd = b.dueDate || "9999-99-99";
        return ad.localeCompare(bd) || String(a.vendorName || "").localeCompare(String(b.vendorName || ""), "ja");
      });
    } else {
      rows.sort(function(a, b){ return String(b.receivedDate || "").localeCompare(String(a.receivedDate || "")); });
    }

    var s = p2El("pay2-summary");
    if (p2.fQueue){
      var qN = 0, qSum = 0, odN = 0, odSum = 0, soonN = 0, soonSum = 0;
      rows.forEach(function(r){
        var amt = r.amountIncl != null ? Number(r.amountIncl) : 0;
        qN++; qSum += amt;
        if (isOverdue(r)){ odN++; odSum += amt; }
        else if (r.dueDate && r.dueDate <= soon){ soonN++; soonSum += amt; }
      });
      s.innerHTML =
        "支払予定 <b>" + qN + "</b> 件 ／ 合計 <b>" + p2Money(qSum) + "</b>" +
        ' ／ <span class="warn">⚠ 期限切れ ' + odN + " 件 " + p2Money(odSum) + "</span>" +
        " ／ 7日以内 " + soonN + " 件 " + p2Money(soonSum);
    } else {
      var sumIncl = 0, unpaidN = 0, unpaidSum = 0, exclN = 0;
      filtered.forEach(function(r){
        if (r.excluded){ exclN++; return; }
        if (r.amountIncl != null) sumIncl += Number(r.amountIncl);
        if (!r.paid){ unpaidN++; if (r.amountIncl != null) unpaidSum += Number(r.amountIncl); }
      });
      // 「未確認」は運用で使っていない（ほぼ全行に付いて警告が埋もれていた）ので出さない。今月やることは上の帯に出す。
      s.innerHTML =
        "対象 <b>" + (rows.length - exclN) + "</b> 件" +
        (exclN ? ' <span class="pay2-sum-muted">（対象外 ' + exclN + " 件）</span>" : "") +
        " ／ 税込合計 <b>" + p2Money(sumIncl) + "</b>" +
        ' ／ <span class="pay2-sum-muted">未払い ' + unpaidN + " 件 " + p2Money(unpaidSum) + "</span>";
    }
    if (p2.fMismatch){
      s.insertAdjacentHTML("afterbegin", '<button type="button" class="ui-chip is-on" id="pay2-fmismatch-clear" title="この絞り込みを外す">口座変更（未確認）のみ ✕</button>');
      p2El("pay2-fmismatch-clear").addEventListener("click", function(){ p2.fMismatch = false; p2RenderDetail(); });
    }

    var table = p2El("pay2-detail-table");
    var empty = p2El("pay2-detail-empty");
    if (!rows.length){
      table.innerHTML = "";
      empty.hidden = false;
      empty.textContent = p2.fQueue ? "未払いの請求書はありません。"
        : p2.payables.length ? "この条件に合う請求書はありません。"
        : "まだ請求書がありません。「＋ 新規」か「✉ 未処理キュー」で追加してください。";
      return;
    }
    empty.hidden = true;
    var head = "<thead><tr>" +
      ["済", "支払期日", "ベンダー", "請求書番号", "税込", "方式", "支払予定", "何月分", "状態", "備考"]
        .map(function(h){ return "<th>" + h + "</th>"; }).join("") +
      "</tr></thead>";
    var body = "<tbody>" + rows.map(function(r){
      // 状態は意味色のバッジだけ（赤＝払う前に止まる、黄＝入力・確認が要る）
      var st = [];
      if (r.excluded) st.push(p2Badge("対象外", "mute"));
      if (p2PayToAlert(r)) st.push(p2Badge("口座変更", "err"));
      if (r.reconciled === "不一致") st.push(p2Badge("照合NG", "warn"));
      if (p2AmountFlag(r) && !r.excluded) st.push(p2Badge("税額不一致", "warn"));
      if (p2NeedsInput(r)) st.push(p2Badge(r.amountIncl == null ? (r.dueDate ? "金額未入力" : "金額・期日未入力") : "期日未入力", "warn"));
      var cls = r.excluded ? "pay2-row-excluded" : isOverdue(r) ? "pay2-row-overdue" : r.paid ? "pay2-row-paid" : "";
      return '<tr data-id="' + escapeHtml(r.id) + '" class="' + cls + '">' +
        '<td class="center"><input type="checkbox" class="p2-paid-cb" data-id="' + escapeHtml(r.id) + '"' + (r.paid ? " checked" : "") + '></td>' +
        "<td>" + escapeHtml(r.dueDate || "—") + (isOverdue(r) ? " " + p2Badge("期限切れ", "err") : "") + "</td>" +
        '<td class="strong">' + escapeHtml(r.vendorName || "—") + "</td>" +
        "<td>" + escapeHtml(r.invoiceNo || "") + "</td>" +
        '<td class="num">' + (r.amountIncl != null ? p2Money(r.amountIncl) : "") + "</td>" +
        "<td>" + p2MethodBadge(r.method) + "</td>" +
        "<td>" + escapeHtml(r.scheduledDate || "") + "</td>" +
        "<td>" + escapeHtml(r.periodMonth || "") + "</td>" +
        "<td>" + st.join(" ") + "</td>" +
        "<td>" + escapeHtml(String(r.note || "").slice(0, 24)) + "</td>" +
        "</tr>";
    }).join("") + "</tbody>";
    table.innerHTML = head + body;
    table.querySelectorAll(".p2-paid-cb").forEach(function(cb){
      cb.addEventListener("click", function(e){ e.stopPropagation(); });
      cb.addEventListener("change", function(){
        var id = cb.getAttribute("data-id");
        var r = p2ById(p2.payables, id);
        if (!r) return;
        if (cb.checked && r.payToMismatch && !r.payToChecked){
          if (!window.confirm("この請求書は振込先がベンダー登録と違います（⚠口座変更）。確認済みですか？\nOK で「口座を確認した」＋「支払済」にします。")){
            cb.checked = false; return;
          }
          p2TogglePaid(id, true, true);
        } else {
          p2TogglePaid(id, cb.checked, false);
        }
      });
    });
    table.querySelectorAll("tbody tr").forEach(function(tr){
      tr.addEventListener("click", function(){
        var rec = p2ById(p2.payables, tr.getAttribute("data-id"));
        if (rec) p2OpenEdit(rec);
      });
    });
  }
  function p2TogglePaid(id, paid, alsoPayToChecked){
    var row = p2ById(p2.payables, id);
    if (!row) return;
    var body = Object.assign({}, row, { paid: paid });
    if (alsoPayToChecked) body.payToChecked = true;
    apiFetch("/api/payables/payables/" + encodeURIComponent(id), { method: "PUT", body: JSON.stringify(body) })
      .then(function(res){
        var saved = (res && res.payable) || {};
        p2.payables = p2.payables.map(function(x){ return x.id === id ? Object.assign({}, x, saved) : x; });
        p2RenderAll();
        p2CountStatus();
      })
      .catch(function(err){ p2Status(apiErrorMessage(err, "支払済"), "err"); p2RenderDetail(); });
  }

  function p2VendorFiltered(){
    var q = (p2.vq || "").trim().toLowerCase();
    return p2.vendors.filter(function(v){
      if (p2.vFex === "hide" && v.excluded === true) return false;
      if (p2.vFex === "only" && v.excluded !== true) return false;
      if (p2.vFm && (v.defaultMethod || "その他") !== p2.vFm) return false;
      if (p2.vFcat && (v.category || "その他") !== p2.vFcat) return false;
      if (p2.vNoEmail && String(v.emails || "").trim()) return false;
      if (p2.vOverdue && !p2VendorLate(v)) return false;
      if (q){
        var hay = [v.name, v.contact, v.aliases, v.emails, v.paymentTerms, v.category, v.note]
          .join(" ").toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  function p2RenderVendors(){
    var rows = p2VendorFiltered().slice().sort(function(a, b){ return String(a.name || "").localeCompare(String(b.name || "")); });
    var table = p2El("pay2-vendor-table");
    var empty = p2El("pay2-vendor-empty");
    var countEl = p2El("pay2-vendor-count");
    if (countEl){
      countEl.textContent = p2.vendors.length
        ? (rows.length === p2.vendors.length ? p2.vendors.length + " 社" : rows.length + " / " + p2.vendors.length + " 社（絞り込み中）")
        : "";
    }
    if (!rows.length){
      table.innerHTML = "";
      empty.hidden = false;
      empty.textContent = p2.vendors.length
        ? "この条件に合うベンダーはありません。"
        : "ベンダー未登録です。「＋ ベンダー追加」から登録してください。";
      return;
    }
    empty.hidden = true;
    var hasLedger = (p2.receipts || []).length > 0 || (p2.payables || []).length > 0;
    var head = "<thead><tr>" +
      ["ベンダー", "担当者", "メールアドレス", "支払方法", "支払サイト", "周期", "区分", "最終受領"]
        .map(function(h){ return "<th>" + h + "</th>"; }).join("") + "</tr></thead>";
    var body = "<tbody>" + rows.map(function(v){
      var cm = p2CadenceOf(v);
      var recCell = "";
      if (hasLedger){
        var r = p2._recv[v.id];
        if (r && r.last){
          recCell = escapeHtml(r.last) + (p2VendorLate(v) ? ' <span class="pay2-flag">未着</span>' : "");
        } else if (cm >= 1){
          recCell = '<span class="pay2-muted">受領なし</span>';
        }
      }
      return '<tr data-id="' + escapeHtml(v.id) + '"' + (v.excluded ? ' class="pay2-row-excluded"' : "") + ">" +
        '<td class="strong">' + escapeHtml(v.name || "") + (v.excluded ? ' <span class="pay2-flag">対象外</span>' : "") + "</td>" +
        "<td>" + escapeHtml(v.contact || "") + "</td>" +
        "<td>" + escapeHtml(v.emails || "") + "</td>" +
        "<td>" + p2MethodBadge(v.defaultMethod) + "</td>" +
        "<td>" + escapeHtml(v.paymentTerms || "") + "</td>" +
        '<td class="center">' + escapeHtml(p2CadenceLabel(cm)) + "</td>" +
        '<td class="center">' + escapeHtml(v.category || "その他") + "</td>" +
        '<td class="center">' + recCell + "</td>" +
        "</tr>";
    }).join("") + "</tbody>";
    table.innerHTML = head + body;
    table.querySelectorAll("tbody tr").forEach(function(tr){
      tr.addEventListener("click", function(){
        var v = p2ById(p2.vendors, tr.getAttribute("data-id"));
        if (v) p2OpenVendor(v);
      });
    });
  }

  /* ---- 支払月の受領チェック（③ 未着アラート） ----
     定期ベンダー（毎月／Nヶ月毎）ごとに、選んだ「支払月」に払う請求書が届いているか一覧。
     受領実績 p2.receipts は `syslea_payables` 由来（案B）。receipt.month＝支払月
     （支払予定日→支払期日→受領日→請求日→何月分）。
     状態: 受領（その支払月の台帳行あり）／未着（到来予定・未受領・当月で想定到着日超 or 過去月）
     ／待機（到来予定・未受領・想定到着日前）。受領実績ゼロのベンダーは未着にしない。
     「要対応」（既定）で欠落のあるベンダーだけ、「すべて」で全部。行クリックで台帳行 or ベンダー編集。 */
  function p2RenderCheck(){
    var wrap = p2El("pay2-check");
    if (!wrap) return;
    wrap.hidden = (p2.tab !== "check");
    var mEl = p2El("pay2-check-month");
    if (mEl && !mEl.value) mEl.value = p2CurMonth();
    var month = (mEl && mEl.value) || p2CurMonth();
    var mxRows = p2CheckMatrixRows(month, true);

    var allRows = p2.vendors
      .filter(function(v){ return !v.excluded && p2ExpectedInMonth(v, month) && p2CheckMatch(v); })
      .map(function(v){ return { v: v, st: p2VendorMonthState(v, month) }; });
    var rc = 0, oc = 0, wc = 0;
    allRows.forEach(function(r){ if (r.st === "received") rc++; else if (r.st === "overdue") oc++; else wc++; });
    var rows = p2.checkOverdueOnly ? allRows.filter(function(r){ return r.st === "overdue"; }) : allRows;
    var rank = { overdue: 0, waiting: 1, received: 2 };
    rows.sort(function(a, b){
      return (rank[a.st] - rank[b.st]) || String(a.v.name || "").localeCompare(String(b.v.name || ""), "ja");
    });
    var sum = p2El("pay2-check-sum");
    if (sum){
      sum.innerHTML = allRows.length
        ? ("対象 <b>" + allRows.length + "</b> 社 ／ <span class=\"ok\">受領 " + rc + "</span>" +
           " ／ <span class=\"warn\">未着 " + oc + "</span> ／ 待機 " + wc)
        : (p2CheckFiltering() ? "条件に合うベンダーはありません。" : "この支払月に払う予定の定期ベンダーはありません。");
    }

    var body = p2El("pay2-check-body");
    if (!body) return;
    var vw = p2El("pay2-check-view");
    if (vw) vw.querySelectorAll("[data-view]").forEach(function(b){ b.classList.toggle("is-on", b.getAttribute("data-view") === p2.checkView); });
    // 要対応／すべて の件数（月別＝6か月のどこかに未着がある社、一覧＝この支払月に未着の社）
    var isList = p2.checkView === "list";
    var needN = isList ? oc : mxRows.filter(function(r){ return r.lateIdx !== -1; }).length;
    var allN = isList ? allRows.length : mxRows.length;
    var fl = p2El("pay2-check-filter");
    if (fl) fl.querySelectorAll("[data-f]").forEach(function(b){
      var need = b.getAttribute("data-f") === "need";
      b.classList.toggle("is-on", need === p2.checkOverdueOnly);
      b.textContent = (need ? "要対応 " + needN : "すべて " + allN) + "社";
    });
    body.hidden = false;
    var sugg = p2CheckSuggestions();
    body.innerHTML = p2SuggestHtml(sugg) + (isList ? p2CheckListHtml(allRows, rows, month) : p2CheckMatrixHtml(month, mxRows));
    body.querySelectorAll("tbody tr").forEach(function(tr){
      tr.addEventListener("click", function(ev){
        // 月別の表はマス（td）に、一覧は行（tr）に台帳行の id を持たせてある
        var hit = ev.target && ev.target.closest ? ev.target.closest("[data-pid]") : null;
        var pid = hit ? hit.getAttribute("data-pid") : "";
        if (pid){
          var rec = p2ById(p2.payables, pid);
          if (rec){ p2OpenEdit(rec); return; }
        }
        var v = p2ById(p2.vendors, tr.getAttribute("data-vid"));
        if (v) p2OpenVendor(v);
      });
    });
    body.querySelectorAll("[data-find]").forEach(function(b){
      b.addEventListener("click", function(ev){ ev.stopPropagation(); p2FindMail(b.getAttribute("data-find")); });
    });
    body.querySelectorAll("[data-remind]").forEach(function(b){
      b.addEventListener("click", function(ev){ ev.stopPropagation(); p2RemindDraft(b.getAttribute("data-remind"), b.getAttribute("data-month") || month, b); });
    });
    p2WireSuggestions(body, sugg);
  }
  function p2CheckActs(v, month){
    return '<button type="button" class="pay2-mini-btn" data-find="' + escapeHtml(v.id) + '">メールを探す</button>' +
      '<button type="button" class="pay2-mini-btn" data-remind="' + escapeHtml(v.id) + '" data-month="' + escapeHtml(month) + '"' +
        (p2VendorEmails(v).length ? "" : ' disabled title="ベンダーのメールアドレスが未登録です"') + ">催促メールを作成</button>";
  }
  // 一覧（選んだ支払月だけ・従来の表）
  function p2CheckListHtml(allRows, rows, month){
    if (!rows.length) return p2.checkOverdueOnly && allRows.length ? '<p class="pay2-empty">未着はありません。</p>'
      : p2CheckFiltering() ? '<p class="pay2-empty">条件に合うベンダーはありません。</p>' : "";
    return '<table class="pay2-table"><thead><tr><th>ベンダー</th><th>周期</th><th>支払サイト</th><th>想定</th><th>最終受領</th><th>状態</th><th>金額</th><th></th></tr></thead><tbody>' +
      rows.map(function(r){
        var e = p2._recv[r.v.id];
        var rec = (e && e.byMonth[month]) || null;
        var need = p2ExpectCount(r.v), got = p2RecvCount(r.v, month);
        var frac = need > 1 ? " " + got + "/" + need : "";
        var stHtml = r.st === "received" ? '<span class="pay2-flag ok">受領' + frac + "</span>"
          : r.st === "overdue" ? p2Badge((got ? "一部未着" : "未着") + frac, "err")
          : '<span class="pay2-muted">待機' + frac + "</span>";
        return '<tr data-vid="' + escapeHtml(r.v.id) + '"' + (rec && rec.payableId ? ' data-pid="' + escapeHtml(rec.payableId) + '"' : "") + ">" +
          '<td class="strong">' + escapeHtml(r.v.name || "") + "</td>" +
          '<td class="center">' + escapeHtml(p2CadenceLabel(p2CadenceOf(r.v))) + "</td>" +
          "<td>" + escapeHtml(String(r.v.paymentTerms || "").slice(0, 18)) + "</td>" +
          '<td class="center">' + escapeHtml(String(p2ExpectDay(r.v)) + "日") + "</td>" +
          '<td class="center">' + escapeHtml((e && e.last) || "—") + "</td>" +
          "<td>" + stHtml + "</td>" +
          '<td class="num">' + (rec && rec.amountIncl != null ? p2Money(rec.amountIncl) : "") + "</td>" +
          '<td class="pay2-check-act">' + (r.st === "overdue" ? p2CheckActs(r.v, month) : "") + "</td>" +
          "</tr>";
      }).join("") + "</tbody></table>";
  }
  /* 月別（2026/09/14）: 行＝定期ベンダー、列＝選んだ支払月までの直近6か月。抜けた月が一目で分かるように。
     マス＝ ✓（受領。月N件は 2/2）／未着（赤。一部だけなら「一部 1/2」）／待機（想定到着日の前）／―（その月は来ない・取引の前）。
     未着のある行が上（右の月ほど上）。✓・一部のマスを押すとその台帳行、ほかはベンダーの編集。 */
  var P2_MX_MONTHS = 6;
  function p2MxCell(v, m){
    var e = p2._recv[v.id];
    var got = p2RecvCount(v, m), need = p2ExpectCount(v);
    var st = p2VendorMonthState(v, m);
    var frac = need > 1 ? got + "/" + need : "";
    var pid = (e && e.byMonth[m] && e.byMonth[m].payableId) || "";
    if (st === "received" || (!st && got)) return { k: "ok", pid: pid, html: '<span class="pay2-mx-ok">✓' + (frac ? " " + frac : "") + "</span>" };
    if (st === "overdue") return { k: "late", pid: pid, html: p2Badge(got ? "一部 " + frac : "未着", "err") };
    if (st === "waiting") return { k: "wait", pid: pid, html: '<span class="pay2-mx-dim">待機' + (frac ? " " + frac : "") + "</span>" };
    return { k: "none", pid: "", html: '<span class="pay2-mx-dim">―</span>' };
  }
  function p2CheckMonths(month){
    var months = [];
    for (var i = P2_MX_MONTHS - 1; i >= 0; i--) months.push(p2MonthAdd(month, -i));
    return months;
  }
  // 定期ベンダーごとの6か月分のマス（lateIdx＝未着のある一番右の月・無ければ -1）
  // useFilter＝検索・絞り込みを当てる（タブの件数は絞り込みに関係なく全体で数える）
  function p2CheckMatrixRows(month, useFilter){
    var months = p2CheckMonths(month);
    return p2.vendors
      .filter(function(v){ return !v.excluded && p2CadenceOf(v) >= 1 && (!useFilter || p2CheckMatch(v)); })
      .map(function(v){
        var cells = months.map(function(m){ return p2MxCell(v, m); });
        var lateIdx = -1;
        cells.forEach(function(c, j){ if (c.k === "late") lateIdx = j; });
        return { v: v, cells: cells, lateIdx: lateIdx };
      });
  }
  function p2CheckMatrixHtml(month, allRows){
    var months = p2CheckMonths(month);
    var cur = p2CurMonth();
    var rows = allRows.slice();
    if (p2.checkOverdueOnly) rows = rows.filter(function(r){ return r.lateIdx !== -1; });
    rows.sort(function(a, b){ return (b.lateIdx - a.lateIdx) || String(a.v.name || "").localeCompare(String(b.v.name || ""), "ja"); });
    if (!rows.length) return '<p class="pay2-empty">' + (!allRows.length && p2CheckFiltering() ? "条件に合うベンダーはありません。"
      : p2.checkOverdueOnly ? "この6か月に未着はありません" + (p2CheckFiltering() ? "（絞り込み中）" : "") + "。"
      : "定期ベンダー（毎月・Nヶ月ごと）が登録されていません。") + "</p>";
    var head = "<thead><tr><th>ベンダー</th><th>周期</th>" + months.map(function(m){
      return '<th class="pay2-mx-m' + (m === cur ? " is-cur" : "") + '" title="' + m + '">' + Number(m.slice(5)) + "月</th>";
    }).join("") + "<th>最終受領</th><th></th></tr></thead>";
    return '<div class="pay2-tablewrap"><table class="pay2-table pay2-mx">' + head + "<tbody>" + rows.map(function(r){
      var e = p2._recv[r.v.id];
      return '<tr data-vid="' + escapeHtml(r.v.id) + '">' +
        '<td class="strong">' + escapeHtml(r.v.name || "") + "</td>" +
        '<td class="center">' + escapeHtml(p2CadenceLabel(p2CadenceOf(r.v))) + "</td>" +
        r.cells.map(function(c, j){
          return '<td class="pay2-mx-c"' + (c.pid ? ' data-pid="' + escapeHtml(c.pid) + '"' : "") + ' title="' + months[j] + '">' + c.html + "</td>";
        }).join("") +
        '<td class="center">' + escapeHtml((e && e.last) || "—") + "</td>" +
        '<td class="pay2-check-act">' + (r.lateIdx !== -1 ? p2CheckActs(r.v, months[r.lateIdx]) : "") + "</td></tr>";
    }).join("") + "</tbody></table></div>";
  }

  /* ---- 毎月一覧の保守（漏れ防止計画 P3・2026/09/13）----
     受領実績から ベンダーの周期・月あたりの件数 の見直しを提案する（適用は1クリック。
     「今は変えない」はこの端末の localStorage に覚えて出さない）。
       毎月にする     … スポット設定なのに 前々月・前月・当月すべてで受領
       スポットにする … 毎月設定で受領実績はあるのに 前月・前々月とも受領なし（停止・解約？）
       月N件にする    … 毎月設定で 前々月・前月とも同じ N件（≥2）受領しているのに件数設定が少ない
     未着の行には「メールを探す」（SYSLEA の Gmail 検索を開く）と「催促の下書き」（Gmail の下書きに保存・送信はしない）。 */
  var P2_SUGG_HIDE_KEY = "cp_p2_sugg_hide";
  function p2SuggHidden(){
    try { return JSON.parse(localStorage.getItem(P2_SUGG_HIDE_KEY) || "{}") || {}; } catch(e){ return {}; }
  }
  function p2MonthAdd(m, k){
    var y = +m.slice(0, 4), mm = +m.slice(5, 7) + k;
    while (mm < 1){ mm += 12; y--; }
    while (mm > 12){ mm -= 12; y++; }
    return y + "-" + ("0" + mm).slice(-2);
  }
  // 未着チェックの検索・絞り込み。検索は空白区切りの AND（社名・別名・担当者・メール・支払サイト・メモ）
  var P2_CHECK_FILTER_IDS = ["pay2-check-q", "pay2-check-fcat", "pay2-check-fm", "pay2-check-fcad"];
  function p2CheckFiltering(){
    return !!(String(p2.checkQ || "").trim() || p2.checkCat || p2.checkMethod || p2.checkCad);
  }
  function p2CheckMatch(v){
    if (p2.checkCat && (v.category || "その他") !== p2.checkCat) return false;
    if (p2.checkMethod && (v.defaultMethod || "その他") !== p2.checkMethod) return false;
    if (p2.checkCad){
      var c = p2CadenceOf(v);
      if (p2.checkCad === "n" ? (c < 2 || c === 12) : c !== Number(p2.checkCad)) return false;
    }
    var q = String(p2.checkQ || "").normalize("NFKC").trim().toLowerCase();
    if (!q) return true;
    var hay = [v.name, v.aliases, v.contact, v.emails, v.paymentTerms, v.note].join(" ").normalize("NFKC").toLowerCase();
    return q.split(/\s+/).every(function(w){ return hay.indexOf(w) !== -1; });
  }

  /* ---- 支払サイト → 支払期日（2026/09/14）----
     「何月分」＝締めの月として、ベンダーの支払サイト（自由記入）から期日を出す。
       月末締め翌月末       … 6月分 → 7/31
       月末締め20日         … 6月分 → 7/20（「当月」「翌々月」と書いていなければ翌月）
       月末締め翌々月10日   … 6月分 → 8/10
       請求書発行後30日 など … 請求日＋30日（請求日が無ければ出さない）
     読めない書き方は null。土日祝の前倒し・後ろ倒しはしない。 */
  // 「請求書発行後30日」「請求日から14日以内」のように請求日から数える書き方なら日数、それ以外は null
  function p2TermsDays(terms){
    var s = String(terms || "").normalize("NFKC").replace(/\s+/g, "");
    if (s.indexOf("締") !== -1) return null;
    var m = s.match(/(?:後|から)(\d{1,3})日|(\d{1,3})日(?:後|以内)/);
    return m ? Number(m[1] || m[2]) : null;
  }
  function p2DueFromTerms(terms, periodMonth, invoiceDate){
    var s = String(terms || "").normalize("NFKC").replace(/\s+/g, "");
    if (!s) return null;
    var days = p2TermsDays(s);
    if (days != null){
      if (!/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate || "")) return null;
      return new Date(Date.UTC(+invoiceDate.slice(0, 4), +invoiceDate.slice(5, 7) - 1, +invoiceDate.slice(8, 10) + days)).toISOString().slice(0, 10);
    }
    if (!/^\d{4}-\d{2}$/.test(periodMonth || "")) return null;
    var pay = s.replace(/^.*締め?/, "");   // 締めの後ろ＝払う日
    var ym = p2MonthAdd(periodMonth, /翌々月/.test(pay) ? 2 : /当月|同月/.test(pay) ? 0 : 1);
    var last = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).getUTCDate();
    if (pay.indexOf("末") !== -1) return ym + "-" + last;
    var d = pay.match(/(\d{1,2})日/);
    return d ? ym + "-" + ("0" + Math.min(Number(d[1]), last)).slice(-2) : null;
  }
  // "2026-07-31" → "7/31（金）"。土日は「銀行休業日」を添える
  function p2DueLabel(key){
    var wd = new Date(key + "T00:00:00Z").getUTCDay();
    return Number(key.slice(5, 7)) + "/" + Number(key.slice(8, 10)) + "（" + "日月火水木金土".charAt(wd) + "）" + (wd === 0 || wd === 6 ? " ※銀行休業日" : "");
  }
  function p2CheckSuggestions(){
    var m0 = p2CurMonth(), m1 = p2MonthAdd(m0, -1), m2 = p2MonthAdd(m0, -2);
    var hide = p2SuggHidden();
    var out = [];
    p2.vendors.forEach(function(v){
      if (v.excluded) return;
      var e = p2._recv[v.id];
      if (!e) return;
      var c = function(m){ return (e.count && e.count[m]) || 0; };
      var cm = p2CadenceOf(v);
      var s = null;
      if (cm === 0 && c(m0) && c(m1) && c(m2)){
        s = { type: "monthly", label: "毎月にする", done: "毎月にしました", why: +m2.slice(5) + "〜" + +m0.slice(5) + "月に毎月受領", patch: { cadenceMonths: 1 } };
      } else if (cm === 1 && e.last && e.last < m2){
        s = { type: "spot", label: "スポットにする", done: "スポットにしました", why: "最終受領 " + e.last + "・前月も前々月も受領なし（停止・解約？）", patch: { cadenceMonths: 0 } };
      } else if (cm >= 1 && c(m1) >= 2 && c(m1) <= 3 && c(m1) === c(m2) && p2ExpectCount(v) < c(m1)){ // 利用量で件数が変わる SaaS（月5件以上）は提案しない
        s = { type: "count", label: "月" + c(m1) + "件にする", done: "月" + c(m1) + "件にしました", why: +m2.slice(5) + "月・" + +m1.slice(5) + "月とも " + c(m1) + "件受領", patch: { expectCount: c(m1) } };
      }
      if (s && !hide[v.id + ":" + s.type + ":" + JSON.stringify(s.patch)]){ s.v = v; out.push(s); }
    });
    return out;
  }
  function p2SuggestHtml(list){
    if (!list.length) return "";
    return '<div class="pay2-sugg"><div class="pay2-sugg-head">ベンダー設定の見直し（受領実績から）</div>' +
      list.map(function(s, i){
        return '<div class="pay2-sugg-row">' +
          '<span class="pay2-sugg-name">' + escapeHtml(s.v.name || "") + "</span>" +
          '<span class="pay2-muted">' + escapeHtml(s.why) + "</span>" +
          '<button type="button" class="pay2-mini-btn pay2-mini-primary" data-sugg-apply="' + i + '">' + escapeHtml(s.label) + "</button>" +
          '<button type="button" class="pay2-mini-btn" data-sugg-hide="' + i + '">今は変えない</button>' +
          "</div>";
      }).join("") + "</div>";
  }
  function p2WireSuggestions(body, list){
    body.querySelectorAll("[data-sugg-apply]").forEach(function(b){
      b.addEventListener("click", function(){
        var s = list[+b.getAttribute("data-sugg-apply")];
        if (!s) return;
        b.disabled = true;
        apiFetch("/api/payables/vendors/" + encodeURIComponent(s.v.id), { method: "PUT", body: JSON.stringify(Object.assign({}, s.v, s.patch)) })
          .then(function(res){
            var saved = res && res.vendor;
            if (saved) p2.vendors = p2.vendors.map(function(x){ return x.id === s.v.id ? saved : x; });
            p2RenderAll();
            p2Status("「" + (s.v.name || "") + "」を" + s.done);
          })
          .catch(function(err){ b.disabled = false; p2Status(apiErrorMessage(err, "ベンダー"), "err"); });
      });
    });
    body.querySelectorAll("[data-sugg-hide]").forEach(function(b){
      b.addEventListener("click", function(){
        var s = list[+b.getAttribute("data-sugg-hide")];
        if (!s) return;
        var h = p2SuggHidden();
        h[s.v.id + ":" + s.type + ":" + JSON.stringify(s.patch)] = Date.now();
        try { localStorage.setItem(P2_SUGG_HIDE_KEY, JSON.stringify(h)); } catch(e){}
        p2RenderCheck();
      });
    });
  }
  function p2FindMail(vid){
    var v = p2ById(p2.vendors, vid);
    if (!v) return;
    var emails = p2VendorEmails(v);
    var q = (emails.length ? "from:(" + emails.join(" OR ") + ")" : '"' + String(v.name || "").replace(/"/g, "") + '"') + " newer_than:60d";
    window.open("https://mail.google.com/mail/u/?authuser=" + encodeURIComponent(SYSLEA_MAIL_ADDR) + "#search/" + encodeURIComponent(q), "_blank", "noopener");
  }
  function p2RemindDraft(vid, month, btn){
    var v = p2ById(p2.vendors, vid);
    if (!v) return;
    var to = p2VendorEmails(v)[0];
    if (!to) return;
    var mm = +String(month).slice(5, 7);
    var person = v.category === "業務委託" && !/株式会社|合同会社|有限会社|法人|事務所/.test(v.name || "");
    var head = person ? (v.name + " 様") : (v.name + " 御中\n" + (v.contact ? v.contact + " 様" : "ご担当者様"));
    var subject = "【株式会社SYSLEA】" + mm + "月お支払い分のご請求書につきまして";
    var text = head + "\n\nいつもお世話になっております。株式会社SYSLEA 経理担当です。\n\n" +
      mm + "月お支払い分のご請求書を、まだこちらで確認できておりませんでしたのでご連絡いたしました。\n" +
      "お手数ですが、payment@syslea.io 宛にご送付いただけますでしょうか。\n" +
      "すでにお送りいただいている場合は、行き違いにつきご容赦ください。\n\nよろしくお願いいたします。\n";
    if (!CP.openComposePreset){ // 本体が古いときだけ（従来どおり下書き保存）
      if (!window.confirm(to + " 宛の催促メールを SYSLEA の Gmail の下書きに保存します（送信はしません）。よろしいですか？")) return;
      btn.disabled = true;
      apiFetch(acctPath("/api/google/gmail/drafts", "syslea"), { method: "POST", body: JSON.stringify({ to: to, subject: subject, body: text }) })
        .then(function(){ btn.textContent = "下書き済み"; p2Status("「" + (v.name || "") + "」宛の催促メールを Gmail の下書きに保存しました（送信はしていません）"); })
        .catch(function(err){ btn.disabled = false; p2Status(apiErrorMessage(err, "下書き"), "err"); });
      return;
    }
    // ポータルの作成画面で開く（文面を直して送信、または下書き保存）。前回の請求書のスレッドがあればそこへの返信にする（先方が経緯を追える）。
    var preset = { account: "syslea", to: to, subject: subject, body: text, title: "催促メール（" + (v.name || "") + "）" };
    var last = p2.payables
      .filter(function(r){ return r.vendorId === v.id && r.threadId && !r.excluded; })
      .sort(function(a, b){ return String(b.receivedDate || "").localeCompare(String(a.receivedDate || "")); })[0];
    if (!last){ CP.openComposePreset(preset); return; }
    btn.disabled = true;
    apiFetch(acctPath("/api/google/gmail/threads/" + encodeURIComponent(last.threadId) + (last.messageId ? "?messageId=" + encodeURIComponent(last.messageId) : ""), "syslea"))
      .then(function(res){
        var m = res && res.reply;
        if (m && m.inReplyTo){
          Object.assign(preset, {
            threadId: last.threadId, inReplyTo: m.inReplyTo, references: m.references || "", subject: m.subject || subject,
            title: "催促メール（" + (v.name || "") + "・" + (last.receivedDate || "") + " の請求書への返信）"
          });
        }
      })
      .catch(function(){ /* スレッドを読めなければ新規メールで */ })
      .then(function(){ btn.disabled = false; CP.openComposePreset(preset); });
  }

  /* ---- 明細の突き合わせ（UPSIDER カード明細／GMO あおぞら 入出金明細）（漏れ防止計画 P4・2026/09/13〜14）----
     明細（CSV / xlsx）を取り込むと、GET /api/payables/statements?source= が台帳と突き合わせる。
       UPSIDER      … カード決済 ⇄ 台帳の UPSIDER 行（ベンダー照合キー×日付±5日）
       GMO あおぞら … 口座振替 ⇄ 台帳の口座振替行、個別振込 ⇄ 台帳の銀行振込行（照合キーはカナ。例: テクテク）。
                      総合振込は明細に内訳が出ないので合計だけ。振込資金返却は要確認として出す。
     取り込み元はファイルのヘッダで自動判別（「取引日・決済ID」＝UPSIDER／「日付・摘要・出金金額」＝GMO あおぞら）。
     xlsx は SheetJS を取り込み時だけ cdnjs から読み込む。 */
  var P2S_XLSX_SRC = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
  var P2S_HEAD = { date: "取引日", merchant: "利用先", txId: "決済ID", amountOut: "出金金額", amountIn: "入金金額", currency: "通貨", fxAmount: "外貨の金額", cardName: "カード名", holder: "カード保有者名", receiptCount: "証憑枚数" };
  var P2S_GMO_HEAD = { date: "日付", desc: "摘要", amountIn: "入金金額", amountOut: "出金金額", balance: "残高", memo: "メモ" };
  var P2S_CAT = { transfer: "個別振込", debit: "口座振替", bulk: "総合振込", returned: "振込資金返却", fee: "振込手数料", payeasy: "ペイジー", loan: "借入返済", atm: "ATM", remit: "海外送金" };
  var p2s = { open: false, source: "upsider", month: "", data: null, loading: false, xlsx: null };

  function p2StmtWire(){
    p2El("pay2-stmt-source").addEventListener("change", function(){
      p2s.source = this.value === "gmo" ? "gmo" : "upsider";
      p2s.month = "";
      p2s.data = null;
      p2StmtLoad();
    });
    p2El("pay2-stmt-month").addEventListener("change", function(){ p2s.month = this.value; p2StmtLoad(); });
    p2El("pay2-stmt-file").addEventListener("change", function(){
      var f = this.files && this.files[0];
      this.value = "";
      if (f) p2StmtImport(f);
    });
  }
  function p2StmtLoad(){
    if (p2s.loading) return;
    p2s.loading = true;
    p2El("pay2-stmt-sum").textContent = "読み込み中…";
    apiFetch("/api/payables/statements?source=" + p2s.source + (p2s.month ? "&month=" + encodeURIComponent(p2s.month) : "")).then(function(res){
      p2s.data = res || {};
      p2s.month = (res && res.month) || "";
      p2StmtRender();
    }).catch(function(err){
      p2El("pay2-stmt-sum").textContent = apiErrorMessage(err, "明細");
    }).finally(function(){ p2s.loading = false; });
  }
  function p2StmtTh(cols){ return "<thead><tr>" + cols.map(function(c){ return "<th>" + c + "</th>"; }).join("") + "</tr></thead>"; }
  function p2StmtRender(){
    var wrap = p2El("pay2-stmt");
    if (!wrap) return;
    wrap.hidden = (p2.tab !== "stmt");
    p2El("pay2-stmt-source").value = p2s.source;
    var d = p2s.data, sel = p2El("pay2-stmt-month"), sum = p2El("pay2-stmt-sum"), body = p2El("pay2-stmt-body");
    var months = (d && d.months) || [];
    // 読み込む前は「—」（以前は読み込む前から「未取り込み」と出て、取り込み済みでも取り込んでいないように見えた）
    sel.innerHTML = months.length
      ? months.slice().reverse().map(function(m){ return '<option value="' + m + '"' + (m === p2s.month ? " selected" : "") + ">" + m + "</option>"; }).join("")
      : '<option value="">' + (d ? "未取り込み" : "—") + "</option>";
    if (!d){
      sum.textContent = p2s.loading ? "読み込み中…" : "UPSIDER の利用明細か GMO あおぞらの入出金明細を取り込むと、台帳と突き合わせます。";
      body.hidden = true;
      return;
    }
    if (!(d.rows || []).length){
      sum.textContent = months.length ? "この月の明細はありません。" : "まだ明細を取り込んでいません。";
      body.hidden = true;
      return;
    }
    if (p2s.source === "gmo") p2StmtRenderGmo(d, sum, body); else p2StmtRenderUpsider(d, sum, body);
    if (body.hidden) return;
    body.querySelectorAll("tr[data-pid]").forEach(function(tr){
      tr.addEventListener("click", function(){
        var rec = p2ById(p2.payables, tr.getAttribute("data-pid"));
        if (rec) p2OpenEdit(rec);
      });
    });
    body.querySelectorAll("[data-stmt-add]").forEach(function(b){
      b.addEventListener("click", function(){ p2StmtAdd(b.getAttribute("data-stmt-add"), b); });
    });
    body.querySelectorAll("[data-stmt-none]").forEach(function(b){
      b.addEventListener("click", function(){ p2StmtMatch(b.getAttribute("data-stmt-none"), "none", b); });
    });
    var ap = p2El("pay2-stmt-apply");
    if (ap) ap.addEventListener("click", function(){ p2StmtApply(+ap.getAttribute("data-n"), ap); });
  }
  function p2StmtSec(title, inner){
    return '<div class="pay2-stmt-sec"><div class="pay2-stmt-title">' + title + "</div>" + inner + "</div>";
  }
  function p2StmtTable(cols, trs){
    return trs.length ? '<div class="pay2-tablewrap"><table class="pay2-table">' + p2StmtTh(cols) + "<tbody>" + trs.join("") + "</tbody></table></div>"
      : '<p class="pay2-muted pay2-stmt-empty">ありません。</p>';
  }
  function p2StmtActs(r){
    return '<td class="pay2-check-act"><button type="button" class="pay2-mini-btn pay2-mini-primary" data-stmt-add="' + escapeHtml(r.id) + '">台帳に追加</button>' +
      '<button type="button" class="pay2-mini-btn" data-stmt-none="' + escapeHtml(r.id) + '">対象外</button></td>';
  }
  // 「台帳なし」の表（ベンダー候補＋台帳に追加・対象外）。UPSIDER・GMO 共通
  function p2StmtNoLedgerTable(rows, cells){
    return p2StmtTable(cells.head.concat(["ベンダー候補", ""]), rows.map(function(r){
      return "<tr>" + cells.row(r) + "<td>" + escapeHtml(r.guess ? r.guess.vendorName || "" : "—") + "</td>" + p2StmtActs(r) + "</tr>";
    }));
  }
  // 「台帳にあるのに明細なし／引落なし」の表。UPSIDER・GMO 共通
  function p2StmtLedgerTable(up){
    return p2StmtTable(["受領日", "ベンダー", "税込", "備考"], up.map(function(p){
      return '<tr data-pid="' + escapeHtml(p.id) + '"><td>' + escapeHtml(String(p.receivedDate || "").slice(5)) + '</td><td class="strong">' + escapeHtml(p.vendorName || "") +
        '</td><td class="num">' + (p.amountIncl != null ? p2Money(p.amountIncl) : "—") + "</td><td>" + escapeHtml(p.note || "") + "</td></tr>";
    }));
  }
  // 折りたたみの「その他」。UPSIDER・GMO 共通
  function p2StmtOtherHtml(title, rows, cells){
    return '<div class="pay2-stmt-sec"><details class="pay2-stmt-more"><summary>' + title + " " + rows.length + " 件</summary>" +
      (rows.length ? '<div class="pay2-tablewrap"><table class="pay2-table">' + p2StmtTh(cells.head) + "<tbody>" + rows.map(function(r){ return "<tr>" + cells.row(r) + "</tr>"; }).join("") + "</tbody></table></div>" : "") +
      "</details></div>";
  }
  function p2StmtMatchedHtml(matched, pend, cells){
    var h = '<div class="pay2-stmt-sec"><div class="pay2-stmt-title">台帳と一致 ' + matched.length + " 件" +
      (pend ? '<button type="button" class="pay2-mini-btn pay2-mini-primary" id="pay2-stmt-apply" data-n="' + pend + '">金額（台帳が空欄のとき）と支払済を ' + pend + " 件に反映</button>" : "") + "</div>";
    if (matched.length){
      h += '<details class="pay2-stmt-more"><summary>一覧を表示</summary><div class="pay2-tablewrap"><table class="pay2-table">' +
        p2StmtTh(cells.head.concat(["台帳", "台帳の税込", "支払済"])) + "<tbody>" +
        matched.map(function(r){
          return '<tr data-pid="' + escapeHtml(r.match.payableId) + '">' + cells.row(r) +
            "<td>" + escapeHtml((r.match.vendorName || "") + " " + String(r.match.receivedDate || "").slice(5)) + (r.match.how === "manual" ? ' <span class="pay2-muted">手動</span>' : "") + "</td>" +
            '<td class="num">' + (r.match.amountIncl != null ? p2Money(r.match.amountIncl) : "—") + "</td>" +
            '<td class="center">' + (r.match.paid ? "✓" : "") + "</td></tr>";
        }).join("") + "</tbody></table></div></details>";
    }
    return h + "</div>";
  }
  function p2StmtRenderUpsider(d, sum, body){
    var rows = d.rows || [];
    var charges = rows.filter(function(r){ return r.amountOut > 0; });
    var matched = charges.filter(function(r){ return r.match; });
    var known = charges.filter(function(r){ return !r.match && r.guess && r.manualPayableId !== "none"; });
    var other = charges.filter(function(r){ return !r.match && (!r.guess || r.manualPayableId === "none"); });
    var noReceipt = charges.filter(function(r){ return r.receiptCount === 0; });
    var up = d.unmatchedPayables || [];
    var pend = matched.filter(function(r){ return r.match.amountIncl == null || !r.match.paid; }).length;
    var total = charges.reduce(function(a, r){ return a + r.amountOut; }, 0);
    sum.innerHTML = "決済 <b>" + charges.length + "</b> 件 " + p2Money(total) +
      ' ／ <span class="ok">台帳と一致 ' + matched.length + "</span>" +
      ' ／ <span class="warn">台帳なし（登録ベンダー） ' + known.length + "</span>" +
      " ／ 台帳にあるのに明細なし " + up.length + " ／ 証憑0枚 " + noReceipt.length;
    if (!p2s.open){ body.hidden = true; return; }
    body.hidden = false;
    var cells = {
      head: ["日付", "利用先", "金額(円)", "カード保有者", "証憑"],
      row: function(r){
        return "<td>" + escapeHtml(r.date.slice(5)) + "</td>" +
          '<td class="strong">' + escapeHtml(r.merchant || "") + "</td>" +
          '<td class="num">' + p2Money(r.amountOut) + (r.currency && r.currency !== "JPY" ? ' <span class="pay2-muted">' + escapeHtml(r.currency) + "</span>" : "") + "</td>" +
          "<td>" + escapeHtml(r.holder || "") + "</td>" +
          '<td class="center">' + (r.receiptCount === 0 ? '<span class="pay2-flag">0</span>' : escapeHtml(r.receiptCount == null ? "" : String(r.receiptCount))) + "</td>";
      }
    };
    var h = "";
    h += p2StmtSec("台帳なし（照合キーのあるベンダーの決済） " + known.length + " 件 — メールで請求書・領収書が来ていない可能性", p2StmtNoLedgerTable(known, cells));
    h += p2StmtSec("台帳にあるのに明細なし（UPSIDER 行） " + up.length + " 件 — 支払方式違い・前後の月の決済・別カードの可能性", p2StmtLedgerTable(up));
    h += p2StmtMatchedHtml(matched, pend, cells);
    h += p2StmtOtherHtml("その他の決済（照合キーのないベンダー・対象外にしたもの）", other, cells);
    body.innerHTML = h;
  }
  function p2StmtRenderGmo(d, sum, body){
    var rows = d.rows || [];
    var outs = rows.filter(function(r){ return r.amountOut > 0; });
    var target = outs.filter(function(r){ return r.category === "debit" || r.category === "transfer"; });
    var matched = target.filter(function(r){ return r.match; });
    var none = target.filter(function(r){ return !r.match && r.manualPayableId !== "none"; });
    var bulkRows = outs.filter(function(r){ return r.category === "bulk"; });
    var returned = rows.filter(function(r){ return r.category === "returned"; });
    var other = outs.filter(function(r){ return r.category !== "bulk" && ((r.category !== "debit" && r.category !== "transfer") || (!r.match && r.manualPayableId === "none")); });
    var up = d.unmatchedPayables || [];
    var bulk = d.bulk || {};
    var pend = matched.filter(function(r){ return r.match.amountIncl == null || !r.match.paid; }).length;
    var total = outs.reduce(function(a, r){ return a + r.amountOut; }, 0);
    sum.innerHTML = "出金 <b>" + outs.length + "</b> 件 " + p2Money(total) +
      ' ／ <span class="ok">台帳と一致 ' + matched.length + "</span>" +
      ' ／ <span class="warn">台帳なし（口座振替・個別振込） ' + none.length + "</span>" +
      " ／ 台帳にあるのに引落なし " + up.length + " ／ 総合振込 " + bulkRows.length + " 件" +
      (returned.length ? ' ／ <span class="warn">振込資金返却 ' + returned.length + "</span>" : "");
    if (!p2s.open){ body.hidden = true; return; }
    body.hidden = false;
    var cells = {
      head: ["日付", "区分", "摘要", "金額"],
      row: function(r){
        return "<td>" + escapeHtml(r.date.slice(5)) + "</td>" +
          "<td>" + escapeHtml(P2S_CAT[r.category] || r.category || "") + "</td>" +
          '<td class="strong">' + escapeHtml(r.merchant || "") + "</td>" +
          '<td class="num">' + p2Money(r.amountOut != null ? r.amountOut : r.amountIn) + "</td>";
      }
    };
    var h = "";
    if (returned.length){
      h += p2StmtSec('<span class="pay2-flag">振込資金返却 ' + returned.length + " 件</span> — 振込が戻っています（口座・名義の誤りなど）。再振込したか確認",
        p2StmtTable(["日付", "摘要", "戻った金額"], returned.map(function(r){
          return "<tr><td>" + escapeHtml(r.date.slice(5)) + '</td><td class="strong">' + escapeHtml(r.merchant || "") + '</td><td class="num">' + p2Money(r.amountIn) + "</td></tr>";
        })));
    }
    h += p2StmtSec("台帳なしの出金（口座振替・個別振込） " + none.length + " 件 — 請求書が台帳に無い支払い（payment@ 以外に届いた請求の可能性）", p2StmtNoLedgerTable(none, cells));
    h += p2StmtSec("台帳にあるのに引落なし（口座振替・前月〜当月受領） " + up.length + " 件", p2StmtLedgerTable(up));
    h += p2StmtSec("総合振込 " + bulkRows.length + " 件 " + p2Money(bulk.total || 0) + " — 内訳は銀行明細に出ないため個別には突き合わせていません（15日の給与分を含む）",
      '<p class="pay2-muted pay2-stmt-empty">台帳の銀行振込（前月〜当月受領・個別振込と未照合）: ' + (bulk.ledgerRows || 0) + " 件（税込入力済みの合計 " + p2Money(bulk.ledgerAmountSum || 0) + " ／ 税込未入力 " + (bulk.ledgerNoAmount || 0) + " 件）</p>" +
      p2StmtTable(["日付", "金額"], bulkRows.map(function(r){ return "<tr><td>" + escapeHtml(r.date.slice(5)) + '</td><td class="num">' + p2Money(r.amountOut) + "</td></tr>"; })));
    h += p2StmtMatchedHtml(matched, pend, cells);
    h += p2StmtOtherHtml("その他の出金（振込手数料・ペイジー・借入返済・ATM・対象外にしたもの）", other, cells);
    body.innerHTML = h;
  }
  function p2StmtRowById(id){
    return ((p2s.data && p2s.data.rows) || []).filter(function(r){ return r.id === id; })[0] || null;
  }
  function p2StmtAdd(id, btn){
    var r = p2StmtRowById(id);
    if (!r) return;
    var gmo = p2s.source === "gmo";
    var vendorName = r.guess ? r.guess.vendorName : "";
    if (!vendorName){
      vendorName = window.prompt("台帳に追加するベンダー名（ベンダーマスタと同じ名前にすると紐付きます）", gmo ? (r.payee || r.merchant || "") : (r.merchant || ""));
      if (!vendorName) return;
      vendorName = vendorName.trim();
    }
    var v = r.guess ? { id: r.guess.vendorId } : p2VendorByName(vendorName);
    btn.disabled = true;
    var doc = {
      vendorId: v ? v.id : "", vendorName: vendorName,
      method: gmo ? (r.category === "debit" ? "口座振替" : "銀行振込") : "UPSIDER",
      receivedDate: r.date, periodMonth: r.month, amountIncl: r.amountOut, paid: true,
      note: (gmo ? "銀行明細から追加（" : "カード明細から追加（") + (r.merchant || "") + "・メールなし）"
    };
    apiFetch("/api/payables/payables", { method: "POST", body: JSON.stringify(doc) }).then(function(res){
      var saved = res && res.payable;
      if (saved) p2.payables.unshift(saved);
      return saved ? apiFetch("/api/payables/statements/" + encodeURIComponent(id) + "/match", { method: "POST", body: JSON.stringify({ payableId: saved.id }) }) : null;
    }).then(function(){
      p2Status("「" + vendorName + "」の" + (gmo ? "出金" : "決済") + "を台帳に追加しました（" + doc.method + "・支払済）");
      p2RenderAll();
      p2StmtLoad();
    }).catch(function(err){ btn.disabled = false; p2Status(apiErrorMessage(err, "明細"), "err"); });
  }
  function p2StmtMatch(id, payableId, btn){
    if (btn) btn.disabled = true;
    apiFetch("/api/payables/statements/" + encodeURIComponent(id) + "/match", { method: "POST", body: JSON.stringify({ payableId: payableId }) })
      .then(function(){ p2StmtLoad(); })
      .catch(function(err){ if (btn) btn.disabled = false; p2Status(apiErrorMessage(err, "明細"), "err"); });
  }
  function p2StmtApply(n, btn){
    if (!window.confirm("台帳と一致した " + n + " 件に、明細の金額（台帳の税込が空欄のときだけ）と「支払済」を反映します。よろしいですか？")) return;
    btn.disabled = true;
    apiFetch("/api/payables/statements/apply", { method: "POST", body: JSON.stringify({ month: p2s.month, source: p2s.source }) }).then(function(res){
      p2Status("明細を台帳に反映しました：金額 " + ((res && res.amounts) || 0) + " 件 ／ 支払済 " + ((res && res.paid) || 0) + " 件");
      p2Load();
      p2StmtLoad();
    }).catch(function(err){ btn.disabled = false; p2Status(apiErrorMessage(err, "明細"), "err"); });
  }
  function p2StmtImport(file){
    var sum = p2El("pay2-stmt-sum");
    sum.textContent = "明細を読み込み中…";
    var reader = /\.xlsx?$/i.test(file.name) ? p2StmtReadXlsx(file) : p2StmtReadCsv(file);
    reader.then(function(parsed){
      var rows = parsed.rows;
      if (!parsed.source || !rows.length) throw new Error("UPSIDER の利用明細（取引日・決済ID）か GMO あおぞらの入出金明細（日付・摘要・出金金額）の列が見つかりませんでした。");
      var chunks = [];
      for (var i = 0; i < rows.length; i += 500) chunks.push(rows.slice(i, i + 500));
      var tot = { created: 0, updated: 0, skipped: 0, months: {} };
      sum.textContent = rows.length + " 行を取り込み中…";
      return chunks.reduce(function(p, ch){
        return p.then(function(){
          return apiFetch("/api/payables/statements/import", { method: "POST", body: JSON.stringify({ source: parsed.source, rows: ch }) }).then(function(r){
            tot.created += (r && r.created) || 0;
            tot.updated += (r && r.updated) || 0;
            tot.skipped += (r && r.skipped) || 0;
            ((r && r.months) || []).forEach(function(m){ tot.months[m] = 1; });
          });
        });
      }, Promise.resolve()).then(function(){ tot.source = parsed.source; return tot; });
    }).then(function(tot){
      var ms = Object.keys(tot.months).sort();
      p2Status((tot.source === "gmo" ? "銀行明細（GMO あおぞら）" : "カード明細（UPSIDER）") + "を取り込みました：新規 " + tot.created + " ／ 更新 " + tot.updated +
        (tot.skipped ? " ／ 取り込まない行 " + tot.skipped + "（入金など）" : "") + (ms.length ? "（" + ms[0] + " 〜 " + ms[ms.length - 1] + "）" : ""));
      p2s.open = true;
      p2s.source = tot.source;
      p2s.month = ms[ms.length - 1] || "";
      p2s.data = null;
      p2StmtLoad();
    }).catch(function(err){
      sum.textContent = (err && err.message && !err.code) ? err.message : apiErrorMessage(err, "明細");
    });
  }
  function p2StmtNum(v, frac){
    if (v === "" || v == null) return null;
    var n = Number(String(v).replace(/[,¥￥\s]/g, ""));
    if (!isFinite(n)) return null;
    return frac ? n : Math.round(n);
  }
  function p2StmtDate(v){
    var c = String(v == null ? "" : v).trim();
    if (/^\d{8}$/.test(c)) return c.slice(0, 4) + "-" + c.slice(4, 6) + "-" + c.slice(6, 8);
    if (typeof v === "number" || /^\d{5}(\.\d+)?$/.test(c)){
      var n = Number(v);
      return (n > 20000 && n < 80000) ? new Date(Math.round((n - 25569) * 864e5)).toISOString().slice(0, 10) : "";
    }
    var m = c.match(/(\d{4})[\/\-年.](\d{1,2})[\/\-月.](\d{1,2})/);
    return m ? m[1] + "-" + ("0" + m[2]).slice(-2) + "-" + ("0" + m[3]).slice(-2) : "";
  }
  // シート／CSV の行配列 → { source, rows }。ヘッダ行（UPSIDER か GMO あおぞら）を探してから読む。シートごとに探し直す。
  function p2StmtRowsFromGrid(grid, acc){
    acc = acc || { source: "", rows: [] };
    var col = null, src = "";
    (grid || []).forEach(function(row){
      var cells = (row || []).map(function(c){ return c == null ? "" : String(c).trim(); });
      if (cells.indexOf(P2S_HEAD.date) !== -1 && cells.indexOf(P2S_HEAD.txId) !== -1){
        src = "upsider"; col = {};
        Object.keys(P2S_HEAD).forEach(function(k){ col[k] = cells.indexOf(P2S_HEAD[k]); });
        return;
      }
      if (cells.indexOf(P2S_GMO_HEAD.date) !== -1 && cells.indexOf(P2S_GMO_HEAD.desc) !== -1 && cells.indexOf(P2S_GMO_HEAD.amountOut) !== -1){
        src = "gmo"; col = {};
        Object.keys(P2S_GMO_HEAD).forEach(function(k){ col[k] = cells.indexOf(P2S_GMO_HEAD[k]); });
        return;
      }
      if (!col) return;
      if (acc.source && acc.source !== src) return; // 1ファイルに2種類は混ぜない
      acc.source = src;
      var get = function(k){ return col[k] >= 0 ? row[col[k]] : ""; };
      var date = p2StmtDate(get("date"));
      if (!date) return;
      if (src === "gmo"){
        acc.rows.push({
          date: date, desc: String(get("desc") || "").trim(),
          amountIn: p2StmtNum(get("amountIn")), amountOut: p2StmtNum(get("amountOut")),
          balance: p2StmtNum(get("balance")), memo: String(get("memo") || "").trim()
        });
      } else {
        var txId = String(get("txId") == null ? "" : get("txId")).trim();
        if (!txId) return;
        acc.rows.push({
          date: date, merchant: String(get("merchant") || "").trim(), txId: txId,
          amountOut: p2StmtNum(get("amountOut")), amountIn: p2StmtNum(get("amountIn")),
          currency: String(get("currency") || "").trim(), fxAmount: p2StmtNum(get("fxAmount"), true),
          cardName: String(get("cardName") || "").trim(), holder: String(get("holder") || "").trim(),
          receiptCount: p2StmtNum(get("receiptCount"))
        });
      }
    });
    return acc;
  }
  function p2StmtLoadXlsx(){
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (!p2s.xlsx){
      p2s.xlsx = new Promise(function(resolve, reject){
        var s = document.createElement("script");
        s.src = P2S_XLSX_SRC;
        s.onload = function(){ if (window.XLSX) resolve(window.XLSX); else reject(new Error("xlsx を読み込めませんでした。")); };
        s.onerror = function(){ p2s.xlsx = null; reject(new Error("xlsx を読むライブラリを取得できませんでした（CSV で取り込んでください）。")); };
        document.head.appendChild(s);
      });
    }
    return p2s.xlsx;
  }
  function p2StmtReadXlsx(file){
    return Promise.all([p2StmtLoadXlsx(), file.arrayBuffer()]).then(function(res){
      var X = res[0];
      var wb = X.read(res[1], { type: "array" });
      var acc = { source: "", rows: [] };
      wb.SheetNames.forEach(function(name){
        p2StmtRowsFromGrid(X.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: "" }), acc);
      });
      return acc;
    });
  }
  function p2StmtReadCsv(file){
    return CP.csvReadFile(file).then(function(text){ // UTF-8 で読めなければ Shift_JIS（本体の CSV 取り込みと同じ）
      return p2StmtRowsFromGrid(p2StmtParseCsv(text.replace(/^﻿/, "")));
    });
  }
  function p2StmtParseCsv(text){
    var rows = [], row = [], cur = "", q = false;
    for (var i = 0; i < text.length; i++){
      var ch = text[i];
      if (q){
        if (ch === '"'){ if (text[i + 1] === '"'){ cur += '"'; i++; } else q = false; }
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ","){ row.push(cur); cur = ""; }
      else if (ch === "\n" || ch === "\r"){
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(cur); rows.push(row); row = []; cur = "";
      } else cur += ch;
    }
    if (cur !== "" || row.length){ row.push(cur); rows.push(row); }
    return rows;
  }

  /* ---- 明細モーダル ---- */
  function p2Field(id, label, type, val, wide){
    return '<div class="pay2-fld' + (wide ? " wide" : "") + '">' +
      "<label>" + label + "</label>" +
      '<input id="' + id + '" type="' + type + '" value="' + escapeHtml(val == null ? "" : String(val)) + '">' +
      "</div>";
  }
  function p2SelectField(id, label, list, cur, wide){
    return '<div class="pay2-fld' + (wide ? " wide" : "") + '">' +
      "<label>" + label + "</label>" +
      '<select id="' + id + '">' + p2Opt(list, cur) + "</select></div>";
  }
  // 振込先（構造化5項目＋振込名）。明細モーダル(pfx="p2f-")・ベンダーモーダル(pfx="p2v-")で共用。
  var PAY_ACCT_TYPES = ["", "普通", "当座", "その他"];
  function p2PayToFields(pfx, d){
    d = d || {};
    return p2Field(pfx + "payToBank", "銀行名", "text", d.payToBank) +
      p2Field(pfx + "payToBranch", "支店名", "text", d.payToBranch) +
      p2SelectField(pfx + "payToType", "種別", PAY_ACCT_TYPES, d.payToType || "") +
      p2Field(pfx + "payToNumber", "口座番号", "text", d.payToNumber) +
      p2Field(pfx + "payToName", "口座名義", "text", d.payToName, true) +
      p2Field(pfx + "remitName", "振込名（振込依頼人名の指定）", "text", d.remitName, true);
  }
  function p2PayToValues(pfx){
    return {
      payToBank: p2El(pfx + "payToBank").value.trim(),
      payToBranch: p2El(pfx + "payToBranch").value.trim(),
      payToType: p2El(pfx + "payToType").value,
      payToNumber: p2El(pfx + "payToNumber").value.trim(),
      payToName: p2El(pfx + "payToName").value.trim(),
      remitName: p2El(pfx + "remitName").value.trim()
    };
  }
  var P2_PAYTO_KEYS = ["payToBank", "payToBranch", "payToType", "payToNumber", "payToName", "remitName"];

  function p2OpenEdit(rec){
    p2.editId = rec ? rec.id : null;
    var r = rec || {};
    p2El("pay2-edit-title").textContent = rec ? "請求書の編集" : "請求書の登録";
    p2El("pay2-edit-del").hidden = !rec;
    var vendorNames = p2.vendors.map(function(v){ return v.name; });
    var body =
      '<div class="pay2-extract">' +
        '<button type="button" class="pay2-extract-btn" id="p2f-extract-mail"' + (r.threadId ? "" : " hidden") + ">📄 メールのPDF/本文から読み取り</button>" +
        '<label class="pay2-extract-file">📎 PDFを選んで読み取り<input type="file" id="p2f-extract-pdf" accept="application/pdf" hidden></label>' +
        '<div class="pay2-extract-note" id="p2f-extract-note" hidden></div>' +
      "</div>" +
      '<div class="pay2-form-grid">' +
      p2Field("p2f-receivedDate", "受領日", "date", r.receivedDate) +
      '<div class="pay2-fld"><label>ベンダー</label><input id="p2f-vendorName" list="p2f-vendorlist" value="' + escapeHtml(r.vendorName || "") + '"><datalist id="p2f-vendorlist">' +
        vendorNames.map(function(n){ return '<option value="' + escapeHtml(n) + '">'; }).join("") + "</datalist></div>" +
      p2Field("p2f-fromEmail", "メールアドレス（差出人）", "email", r.fromEmail, true) +
      p2Field("p2f-invoiceNo", "請求書番号", "text", r.invoiceNo) +
      p2Field("p2f-invoiceDate", "請求日", "date", r.invoiceDate) +
      '<div class="pay2-fld"><label>請求月（何月分）</label><input type="month" id="p2f-periodMonth" value="' +
        escapeHtml(p2Mkey(r.periodMonth) || p2Mkey(r.invoiceDate) || p2Mkey(r.receivedDate)) + '"></div>' +
      p2Field("p2f-dueDate", "支払期日", "date", r.dueDate) +
      p2Field("p2f-scheduledDate", "支払予定日", "date", r.scheduledDate) +
      '<div class="pay2-fld wide pay2-payto-note" id="p2f-due-auto" hidden></div>' +
      p2Field("p2f-amountExcl", "税抜", "number", r.amountExcl) +
      p2Field("p2f-tax", "消費税", "number", r.tax) +
      p2Field("p2f-amountIncl", "税込", "number", r.amountIncl) +
      '<div class="pay2-calc" id="p2f-calc"></div>' +
      p2Field("p2f-regNo", "インボイス登録番号", "text", r.regNo) +
      p2SelectField("p2f-qualified", "適格区分", PAY_QUALIFIED, r.qualified || "不明") +
      p2SelectField("p2f-method", "支払方式", PAY_METHODS, r.method || "その他") +
      '<div class="pay2-fld wide"><label>振込先</label><div class="pay2-payto-note" id="p2f-payto-auto" hidden></div></div>' +
      p2PayToFields("p2f-", r) +
      '<div class="pay2-fld wide" id="p2f-payto-check"></div>' +
      p2Field("p2f-sourceLink", "原本リンク", "text", r.sourceLink, true) +
      '<div class="pay2-fld wide"><label>備考</label><textarea id="p2f-note" rows="2">' + escapeHtml(r.note || "") + "</textarea></div>" +
      '<div class="pay2-fld-checks">' +
        '<label><input type="checkbox" id="p2f-paid"' + (r.paid ? " checked" : "") + "> 支払済</label>" +
        '<label><input type="checkbox" id="p2f-payToChecked"' + (r.payToChecked ? " checked" : "") + "> 口座を確認した</label>" +
        '<label><input type="checkbox" id="p2f-excluded"' + (r.excluded ? " checked" : "") + "> 支払対象外（請求書ではない）</label>" +
      "</div>" +
      "</div>";
    p2El("pay2-edit-body").innerHTML = body;
    p2OpenModal("pay2-edit");

    function recalc(){
      var ex = parseFloat(p2El("p2f-amountExcl").value);
      var tx = parseFloat(p2El("p2f-tax").value);
      var inc = parseFloat(p2El("p2f-amountIncl").value);
      var box = p2El("p2f-calc");
      if (isFinite(ex) && isFinite(tx)){
        var calc = Math.round(ex + tx);
        if (isFinite(inc) && Math.abs(calc - inc) > 1){
          box.textContent = "税抜＋消費税 = " + p2Money(calc) + "（税込欄と不一致）";
          box.classList.add("bad");
        } else {
          box.textContent = "税抜＋消費税 = " + p2Money(calc);
          box.classList.remove("bad");
        }
      } else { box.textContent = ""; box.classList.remove("bad"); }
    }
    ["p2f-amountExcl", "p2f-tax", "p2f-amountIncl"].forEach(function(id){
      p2El(id).addEventListener("input", recalc);
    });
    recalc();

    // ベンダーが決まったら 方式＋いつもの振込先 を反映する。
    // 書き換えるのは「空欄」か「前に自動で入れた値のまま」の欄だけ（手で直した値は触らない）。
    // ベンダーを選び直せば前のベンダーの口座と入れ替わり、方式が銀行振込でなければ口座は入れない。
    var autoFill = {};
    function p2SetAuto(key, val){
      var el = p2El("p2f-" + key);
      if (!el || (el.value && el.value !== autoFill[key])) return;
      el.value = val || "";
      if (val) autoFill[key] = val; else delete autoFill[key];
    }
    function p2ApplyVendorPayTo(v){
      var bank = p2El("p2f-method").value === "銀行振込";
      P2_PAYTO_KEYS.forEach(function(k){ p2SetAuto(k, bank && v ? v[k] : ""); });
      var shown = !!v && P2_PAYTO_KEYS.some(function(k){ return autoFill[k] && p2El("p2f-" + k).value === autoFill[k]; });
      var note = p2El("p2f-payto-auto");
      note.hidden = !shown;
      note.textContent = shown ? "「" + (v.name || "") + "」に登録の振込先を反映しました（保存で台帳に入ります）。請求書の記載と違えば書き換えてください。" : "";
      p2RenderPayToCheck();
    }
    // 支払期日＝ベンダーの支払サイト＋何月分（口座と同じく 空欄 か 自動で入れたままの欄だけ書き換える）。
    // fill=false は説明を出すだけ（支払済の行を開いたとき・期日を手で変えたとき）。UPSIDER はカードの決済日なので入れない。
    function p2ApplyVendorDue(v, fill){
      var terms = v ? String(v.paymentTerms || "").trim() : "";
      var upsider = p2El("p2f-method").value === "UPSIDER";
      var pm = p2El("p2f-periodMonth").value, inv = p2El("p2f-invoiceDate").value;
      var byInvoice = p2TermsDays(terms) != null;
      var due = terms && !upsider ? p2DueFromTerms(terms, pm, inv) : null;
      if (fill) p2SetAuto("dueDate", due || "");
      var cur = p2El("p2f-dueDate").value, msg = "";
      if (v && !upsider){
        if (!terms) msg = "「" + escapeHtml(v.name || "") + "」は支払サイトが未登録です（ベンダーに登録すると支払期日が自動で入ります）。";
        else if (!due) msg = "支払サイト「" + escapeHtml(terms) + "」からは支払期日を出せません" + (byInvoice ? "（請求日を入れてください）。" : "（書き方の例：月末締め翌月末／月末締め20日）。");
        else {
          msg = "支払サイト「" + escapeHtml(terms) + "」・" + (byInvoice ? "請求日 " + escapeHtml(p2DueLabel(inv)) : Number(pm.slice(5)) + "月分") + " → " + escapeHtml(p2DueLabel(due)) +
            (cur && cur !== due ? " " + p2Badge("入力中の期日と違います", "warn") : "");
          // 締めより前に発行された請求書＝「何月分」がずれている可能性（6月分なら 7月発行・6月末ごろ発行のはず）
          var closeLim = new Date(Date.UTC(+pm.slice(0, 4), +pm.slice(5, 7), -5)).toISOString().slice(0, 10);
          if (!byInvoice && inv && inv < closeLim) msg += "<br>" + p2Badge("何月分を確認", "warn") + " 請求日 " + escapeHtml(p2DueLabel(inv)) + " が " + Number(pm.slice(5)) + "月分の締めより前です。";
        }
      }
      var box = p2El("p2f-due-auto");
      box.hidden = !msg;
      box.innerHTML = msg;
    }
    function fillFromVendor(v){
      if (v){
        if (!p2El("p2f-vendorName").value.trim()) p2El("p2f-vendorName").value = v.name || "";
        var m = p2El("p2f-method");
        if (v.defaultMethod && (m.value === "その他" || m.value === autoFill.method)){ m.value = v.defaultMethod; autoFill.method = v.defaultMethod; }
      }
      p2ApplyVendorPayTo(v);
      p2ApplyVendorDue(v, true);
    }
    // 保存時の vendorId と同じ決め方（メールアドレス一致 → 名前一致）でベンダーを引く。
    // datalist で選んだ瞬間は input しか来ない（change はフォーカスが外れてから）ので両方で拾う。
    ["p2f-vendorName", "p2f-fromEmail"].forEach(function(id){
      ["input", "change"].forEach(function(ev){
        p2El(id).addEventListener(ev, function(){ fillFromVendor(p2CurVendor()); });
      });
    });
    p2El("p2f-method").addEventListener("change", function(){
      if (this.value !== autoFill.method) delete autoFill.method;   // 手で選んだ方式はベンダーを変えても保つ
      p2ApplyVendorPayTo(p2CurVendor());
      p2ApplyVendorDue(p2CurVendor(), true);
    });
    ["p2f-periodMonth", "p2f-invoiceDate"].forEach(function(id){
      ["input", "change"].forEach(function(ev){
        p2El(id).addEventListener(ev, function(){ p2ApplyVendorDue(p2CurVendor(), true); });
      });
    });
    p2El("p2f-dueDate").addEventListener("change", function(){ p2ApplyVendorDue(p2CurVendor(), false); });

    // 口座チェック（目標4）: 入力中の口座 vs ベンダー登録の口座を比べて表示。
    function p2CurVendor(){
      return p2VendorByEmail(p2El("p2f-fromEmail").value.trim()) || p2VendorByName(p2El("p2f-vendorName").value.trim());
    }
    function p2RenderPayToCheck(){
      var box = p2El("p2f-payto-check");
      if (!box) return;
      var v = p2CurVendor();
      var pv = p2PayToValues("p2f-");
      var pNum = String(pv.payToNumber).normalize("NFKC").replace(/\D+/g, "");
      var vNum = v ? String(v.payToNumber || "").normalize("NFKC").replace(/\D+/g, "") : "";
      box.className = "pay2-fld wide";
      if (!v){ box.innerHTML = ""; return; }
      if (!vNum){
        box.innerHTML = pNum
          ? '<div class="pay2-payto-note">この口座は「' + escapeHtml(v.name || "") + '」に未登録です。'
            + ' <button type="button" class="pay2-tool-btn" id="p2f-payto-register">この口座をベンダーに登録</button></div>'
          : "";
      } else if (!pNum){
        box.innerHTML = "";   // 口座が未入力なら「一致」とは言わない
      } else if (pNum !== vNum){
        box.innerHTML = '<div class="pay2-payto-warn">⚠ この請求書の口座は「' + escapeHtml(v.name || "") + '」の登録と違います。'
          + '<br>登録: ' + escapeHtml(v.payToBank || "") + " " + escapeHtml(v.payToBranch || "") + " " + escapeHtml(v.payToType || "") + " " + escapeHtml(v.payToNumber || "")
          + '<br>今回: ' + escapeHtml(pv.payToBank) + " " + escapeHtml(pv.payToBranch) + " " + escapeHtml(pv.payToType) + " " + escapeHtml(pv.payToNumber)
          + ' <button type="button" class="pay2-tool-btn" id="p2f-payto-update">ベンダーの口座を更新</button>'
          + ' <span class="pay2-muted">（正規の変更なら更新／怪しければ「口座を確認した」を外したまま保留）</span></div>';
      } else {
        box.innerHTML = '<div class="pay2-payto-ok">口座は「' + escapeHtml(v.name || "") + '」の登録と一致</div>';
      }
      var reg = p2El("p2f-payto-register");
      if (reg) reg.addEventListener("click", function(){ p2SavePayToToVendor(v.id); });
      var upd = p2El("p2f-payto-update");
      if (upd) upd.addEventListener("click", function(){ p2SavePayToToVendor(v.id); });
    }
    function p2SavePayToToVendor(vid){
      var vv = p2ById(p2.vendors, vid);
      if (!vv) return;
      var body = Object.assign({}, vv, p2PayToValues("p2f-"));
      p2Status("ベンダーの口座を更新中…");
      apiFetch("/api/payables/vendors/" + encodeURIComponent(vid), { method: "PUT", body: JSON.stringify(body) })
        .then(function(){ return p2Load(); })
        .then(function(){ p2Status("ベンダーの口座を更新しました。"); })
        .catch(function(err){ p2Status(apiErrorMessage(err, "ベンダー口座"), "err"); });
    }
    P2_PAYTO_KEYS.forEach(function(k){
      var el = p2El("p2f-" + k);
      if (el) el.addEventListener("input", p2RenderPayToCheck);
      if (el) el.addEventListener("change", p2RenderPayToCheck);
    });
    // 開いた時点でベンダーが分かっていて口座が空なら反映（支払済の行は当時の口座と違うかもしれないので入れない）
    if (r.paid) p2RenderPayToCheck(); else p2ApplyVendorPayTo(p2CurVendor());
    p2ApplyVendorDue(p2CurVendor(), !r.paid);

    // PDF/本文からの AI 抽出
    var extMailBtn = p2El("p2f-extract-mail");
    if (extMailBtn) extMailBtn.addEventListener("click", function(){
      p2ExtractFromMail(rec ? rec.threadId : "", rec ? (rec.note || "") : "");
    });
    p2El("p2f-extract-pdf").addEventListener("change", function(){
      var file = this.files && this.files[0];
      this.value = "";
      if (file) p2ExtractFromFile(file);
    });
  }
  function p2CloseEdit(){ p2CloseModal("pay2-edit"); }

  function p2NumOrNull(id){
    var v = p2El(id).value;
    if (v === "" || v == null) return null;
    var n = Math.round(Number(String(v).replace(/[,\s¥]/g, "")));
    return isFinite(n) ? n : null;
  }
  function p2EditValues(){
    // 確認済・済フォルダ移動・SYSLEA照合は画面から外した（2026/09/14・運用で使っていない）。PUT は全項目を送る前提なので既存値を保つ
    var cur = (p2.editId && p2ById(p2.payables, p2.editId)) || {};
    var name = p2El("p2f-vendorName").value.trim();
    var email = p2El("p2f-fromEmail").value.trim();
    // 該当ベンダーはメールアドレス一致を優先し、無ければ名前一致
    var v = p2VendorByEmail(email) || p2VendorByName(name);
    var vals = {
      receivedDate: p2El("p2f-receivedDate").value,
      vendorName: name,
      vendorId: v ? v.id : "",
      fromEmail: email,
      excluded: p2El("p2f-excluded").checked,
      invoiceNo: p2El("p2f-invoiceNo").value.trim(),
      invoiceDate: p2El("p2f-invoiceDate").value,
      periodMonth: p2El("p2f-periodMonth").value,
      dueDate: p2El("p2f-dueDate").value,
      scheduledDate: p2El("p2f-scheduledDate").value,
      amountExcl: p2NumOrNull("p2f-amountExcl"),
      tax: p2NumOrNull("p2f-tax"),
      amountIncl: p2NumOrNull("p2f-amountIncl"),
      regNo: p2El("p2f-regNo").value.trim(),
      qualified: p2El("p2f-qualified").value,
      method: p2El("p2f-method").value,
      reconciled: cur.reconciled || "未",
      sourceLink: p2El("p2f-sourceLink").value.trim(),
      note: p2El("p2f-note").value.trim(),
      checked: !!cur.checked,
      paid: p2El("p2f-paid").checked,
      filed: !!cur.filed,
      payToChecked: p2El("p2f-payToChecked") ? p2El("p2f-payToChecked").checked : false
    };
    var pt = p2PayToValues("p2f-");
    Object.assign(vals, pt);
    // 表示用の1行（構造化から生成）
    vals.payTo = [pt.payToBank, pt.payToBranch, pt.payToType, pt.payToNumber, pt.payToName].filter(Boolean).join(" ");
    return vals;
  }
  function p2SaveEdit(){
    var vals = p2EditValues();
    if (!vals.vendorName && !vals.invoiceNo) return p2FormErr("pay2-edit", "ベンダー名か請求書番号のどちらかは入力してください。");
    p2SaveDoc("payable", vals);
  }

  /* ---- 明細・ベンダーのモーダル共通（開く・閉じる・保存・削除・エラー表示） ---- */
  var P2_KINDS = {
    payable: { path: "/api/payables/payables", list: "payables", idKey: "editId", res: "payable", modal: "pay2-edit", addFront: true, delMsg: "この請求書を台帳から削除します。よろしいですか？" },
    vendor: { path: "/api/payables/vendors", list: "vendors", idKey: "vendId", res: "vendor", modal: "pay2-vendor", addFront: false, delMsg: "このベンダーを削除します。よろしいですか？" }
  };
  function p2FormErr(modal, msg){
    var e = p2El(modal + "-error");
    e.hidden = !msg;
    e.textContent = msg || "";
  }
  function p2OpenModal(modal){
    p2FormErr(modal, "");
    p2El(modal + "-modal").hidden = false;
    p2El(modal + "-form").scrollTop = 0;
    document.body.style.overflow = "hidden";
  }
  function p2CloseModal(modal){ p2El(modal + "-modal").hidden = true; document.body.style.overflow = ""; }
  function p2SaveDoc(kind, vals){
    var k = P2_KINDS[kind], id = p2[k.idKey];
    var btn = p2El(k.modal + "-save");
    btn.disabled = true; btn.textContent = "保存中…";
    apiFetch(k.path + (id ? "/" + encodeURIComponent(id) : ""), { method: id ? "PUT" : "POST", body: JSON.stringify(vals) }).then(function(res){
      var saved = res && res[k.res];
      if (id) p2[k.list] = p2[k.list].map(function(x){ return x.id === id ? saved : x; });
      else if (k.addFront) p2[k.list].unshift(saved);
      else p2[k.list].push(saved);
      p2CloseModal(k.modal);
      p2RenderAll();
      p2CountStatus();
    }).catch(function(err){
      p2FormErr(k.modal, apiErrorMessage(err, "請求書管理"));
    }).finally(function(){ btn.disabled = false; btn.textContent = "保存"; });
  }
  function p2DeleteDoc(kind){
    var k = P2_KINDS[kind], id = p2[k.idKey];
    if (!id || !window.confirm(k.delMsg)) return;
    apiFetch(k.path + "/" + encodeURIComponent(id), { method: "DELETE" }).then(function(){
      p2[k.list] = p2[k.list].filter(function(x){ return x.id !== id; });
      p2CloseModal(k.modal);
      p2RenderAll();
      p2CountStatus();
    }).catch(function(err){
      p2FormErr(k.modal, apiErrorMessage(err, "請求書管理"));
    });
  }

  /* ---- ベンダーモーダル ---- */
  function p2OpenVendor(v){
    p2.vendId = v ? v.id : null;
    var d = v || {};
    p2El("pay2-vendor-title").textContent = v ? "ベンダーの編集" : "ベンダーの登録";
    p2El("pay2-vendor-del").hidden = !v;
    var cm = p2CadenceOf(d);
    var cadSel = cm === 1 ? "monthly" : cm === 12 ? "yearly" : cm === 0 ? "spot" : "everyN";
    var nOn = cadSel === "everyN";
    p2El("pay2-vendor-body").innerHTML =
      '<div class="pay2-form-grid">' +
      p2Field("p2v-name", "ベンダー名（必須）", "text", d.name, true) +
      p2Field("p2v-contact", "担当者", "text", d.contact) +
      p2Field("p2v-emails", "メールアドレス（, 区切りで複数可・照合キー）", "text", d.emails, true) +
      p2Field("p2v-aliases", "別名・表記ゆれ（, 区切り・任意）", "text", d.aliases, true) +
      p2SelectField("p2v-defaultMethod", "支払方法", PAY_METHODS, d.defaultMethod || "その他") +
      p2SelectField("p2v-category", "区分", PAY_CATEGORIES, d.category || "その他") +
      p2Field("p2v-paymentTerms", "支払サイト（例：月末締め翌月末／月末締め20日）", "text", d.paymentTerms, true) +
      '<div class="pay2-fld wide pay2-payto-note" id="p2v-terms-hint"></div>' +
      '<div class="pay2-fld"><label>周期</label><div class="pay2-cad-row">' +
        '<select id="p2v-cadence">' +
          '<option value="monthly"' + (cadSel === "monthly" ? " selected" : "") + ">毎月</option>" +
          '<option value="everyN"' + (cadSel === "everyN" ? " selected" : "") + ">Nヶ月ごと</option>" +
          '<option value="yearly"' + (cadSel === "yearly" ? " selected" : "") + ">毎年</option>" +
          '<option value="spot"' + (cadSel === "spot" ? " selected" : "") + ">スポット</option>" +
        "</select>" +
        '<input type="number" id="p2v-cadence-n" min="2" max="60" value="' + (nOn ? cm : 3) + '"' + (nOn ? "" : " hidden") + ">" +
        '<span class="pay2-cad-unit" id="p2v-cadence-unit"' + (nOn ? "" : " hidden") + ">ヶ月ごと</span>" +
      "</div></div>" +
      p2Field("p2v-expectDay", "想定到着日（1〜28・未着判定に使用）", "number", d.expectDay == null ? 25 : d.expectDay) +
      p2Field("p2v-expectCount", "月あたりの件数（同じ月に届く請求書の数・既定1）", "number", d.expectCount == null ? 1 : d.expectCount) +
      p2Field("p2v-statementKeys", "カード明細の照合キー（UPSIDER 明細の利用先に含まれる語・, 区切り・社名の英字は自動）", "text", d.statementKeys, true) +
      '<div class="pay2-fld wide"><label>いつもの振込先（口座変更検知に使用）</label></div>' +
      p2PayToFields("p2v-", d) +
      '<div class="pay2-fld wide"><label>メモ</label><textarea id="p2v-note" rows="2">' + escapeHtml(d.note || "") + "</textarea></div>" +
      '<div class="pay2-fld-checks">' +
        '<label><input type="checkbox" id="p2v-excluded"' + (d.excluded ? " checked" : "") + "> 支払対象外（このベンダー宛メールは取り込み時に対象外扱い）</label>" +
      "</div>" +
      "</div>";
    // 支払サイトをどう読んだかを見せる（台帳・未処理キューの支払期日はここから自動で入る）
    function termsHint(){
      var terms = p2El("p2v-paymentTerms").value.trim();
      var pm = p2MonthAdd(p2CurMonth(), -1), inv = p2CurMonth() + "-01";
      var byInvoice = p2TermsDays(terms) != null;
      var due = p2DueFromTerms(terms, pm, inv);
      p2El("p2v-terms-hint").innerHTML = !terms ? "未登録だと、台帳の支払期日は自動で入りません。"
        : !due ? p2Badge("読み取れません", "warn") + " 書き方の例：月末締め翌月末／月末締め20日／月末締め翌々月10日／請求書発行後30日"
        : "読み取り：" + (byInvoice ? "請求日 " + p2DueLabel(inv) : Number(pm.slice(5)) + "月分") + " → " + p2DueLabel(due) + "（台帳・未処理キューの支払期日に自動で入ります）";
    }
    p2El("p2v-paymentTerms").addEventListener("input", termsHint);
    termsHint();
    var cadEl = p2El("p2v-cadence");
    cadEl.addEventListener("change", function(){
      var on = this.value === "everyN";
      p2El("p2v-cadence-n").hidden = !on;
      p2El("p2v-cadence-unit").hidden = !on;
    });
    p2OpenModal("pay2-vendor");
  }
  function p2CloseVendor(){ p2CloseModal("pay2-vendor"); }
  function p2SaveVendor(){
    var cad = p2El("p2v-cadence").value;
    var cadN = Math.max(2, Math.min(60, parseInt(p2El("p2v-cadence-n").value, 10) || 3));
    var cadenceMonths = cad === "monthly" ? 1 : cad === "yearly" ? 12 : cad === "spot" ? 0 : cadN;
    var expectDay = Math.max(1, Math.min(28, parseInt(p2El("p2v-expectDay").value, 10) || 25));
    var vals = {
      name: p2El("p2v-name").value.trim(),
      contact: p2El("p2v-contact").value.trim(),
      emails: p2El("p2v-emails").value.trim(),
      aliases: p2El("p2v-aliases").value.trim(),
      defaultMethod: p2El("p2v-defaultMethod").value,
      category: p2El("p2v-category").value,
      paymentTerms: p2El("p2v-paymentTerms").value.trim(),
      cadenceMonths: cadenceMonths,
      expectDay: expectDay,
      expectCount: Math.max(1, Math.min(10, parseInt(p2El("p2v-expectCount").value, 10) || 1)),
      statementKeys: p2El("p2v-statementKeys").value.trim(),
      note: p2El("p2v-note").value.trim(),
      excluded: p2El("p2v-excluded").checked
    };
    Object.assign(vals, p2PayToValues("p2v-"));
    if (!vals.name) return p2FormErr("pay2-vendor", "ベンダー名は必須です。");
    p2SaveDoc("vendor", vals);
  }

  /* ---- 未処理キュー（漏れ防止計画 P1・2026/09/13）----
     GET /api/payables/queue が「台帳に無いメール」を返す：
       parent＝親 01.payment（payment@ 宛はフィルタでここに入る）／labeled＝方式ラベルなのに台帳に無い／
       thread＝台帳にあるスレッドの新着（ラベル無し）／sweep＝入口外の請求書らしいメール（payment@ 以外宛）。
     1通ずつ 確定（台帳に追加）／既存の行に紐付け／変更通知／対象外／無視（入口外のみ）で閉じる。
     ラベルはサーバーがメール1通単位で付け替える（Gmail 画面の操作はスレッド全体に付くので使わない）。 */
  var P2Q_METHODS = ["銀行振込", "口座振替", "UPSIDER"];
  var P2Q_SRC = { parent: "01.payment（未処理）", labeled: "ラベルあり・台帳なし", thread: "台帳にあるスレッドの新着", sweep: "入口外（payment@ 以外に届いた請求書らしいメール）" };
  var P2Q_SUGGEST = {
    "new": "新しい請求書として確定",
    link: "既存の請求書の返信・重複（紐付け）",
    notice: "変更通知",
    exclude: "請求書ではなさそう（対象外）",
    dismiss: "請求書ではなさそう（無視）"
  };
  var P2Q_DONE = { "new": "台帳に追加", link: "既存の行に紐付け", notice: "変更通知へ", exclude: "対象外へ", dismiss: "入口外の候補から外しました" };
  var p2q = { items: [], days: 60, truncated: false, loading: false, dirty: false };

  function p2OpenImport(){
    p2El("pay2-import-modal").hidden = false;
    document.body.style.overflow = "hidden";
    p2QueueLoad();
  }
  function p2CloseImport(){
    p2El("pay2-import-modal").hidden = true;
    document.body.style.overflow = "";
    if (p2q.dirty){ p2q.dirty = false; p2Load(); } else p2QueueSummaryLoad();
  }
  // fresh=true（再読込）で突き合わせをやり直す。開いたときはサーバーが5分持っている結果を使う。
  function p2QueueLoad(fresh){
    if (p2q.loading) return;
    p2q.loading = true;
    p2El("pay2-import-error").hidden = true;
    p2El("pay2-queue-dismiss-junk").hidden = true;
    p2El("pay2-queue-sum").textContent = "Gmail と台帳を突き合わせ中…（数秒〜十数秒かかることがあります）";
    p2El("pay2-import-list").innerHTML = "";
    apiFetch("/api/payables/queue" + (fresh === true ? "?fresh=1" : "")).then(function(res){
      p2q.items = (res && res.items) || [];
      p2q.days = (res && res.days) || 60;
      p2q.truncated = !!(res && res.truncated);
      p2q.generatedAt = (res && res.generatedAt) || 0;
      p2q.cached = !!(res && res.cached);
      p2QueueRender();
    }).catch(function(err){
      p2El("pay2-queue-sum").textContent = "";
      var e = p2El("pay2-import-error");
      e.hidden = false; e.textContent = apiErrorMessage(err, "メール");
    }).finally(function(){ p2q.loading = false; });
  }
  function p2QueueSum(){
    var open = p2q.items.filter(function(it){ return !it.done; });
    var c = { parent: 0, labeled: 0, thread: 0, sweep: 0 };
    open.forEach(function(it){ c[it.source] = (c[it.source] || 0) + 1; });
    p2El("pay2-queue-sum").innerHTML = "未処理 <b>" + open.length + "</b> 件" +
      '<span class="pay2-sum-muted"> ／ 01.payment ' + c.parent + " ／ ラベルあり台帳なし " + c.labeled +
      " ／ スレッド新着 " + c.thread + " ／ 入口外 " + c.sweep +
      "（スレッド新着・入口外は直近" + p2q.days + "日" + (p2q.truncated ? "・件数が多いため先頭のみ" : "") + "）" +
      (p2q.generatedAt ? " ／ " + p2TimeLabel(p2q.generatedAt) + " 時点" + (p2q.cached ? "（最新にするには再読込）" : "") : "") + "</span>";
    var junk = open.filter(function(it){ return it.source === "sweep" && it.suggest === "dismiss"; }).length;
    var jb = p2El("pay2-queue-dismiss-junk");
    jb.hidden = !junk;
    jb.textContent = "「無視」提案の入口外 " + junk + " 件をまとめて無視";
  }
  function p2QueueRender(){
    var listEl = p2El("pay2-import-list");
    var dl = p2El("pay2-queue-vendors");
    if (dl) dl.innerHTML = p2.vendors.map(function(v){ return '<option value="' + escapeHtml(v.name || "") + '">'; }).join("");
    if (!p2q.items.length){
      listEl.innerHTML = '<p class="pay2-empty">未処理のメールはありません。</p>';
      p2QueueSum();
      return;
    }
    var html = "", last = "";
    p2q.items.forEach(function(it, i){
      if (it.source !== last){
        last = it.source;
        html += '<div class="pay2-q-group">' + escapeHtml(P2Q_SRC[it.source] || it.source) + "</div>";
      }
      html += p2QueueCard(it, i);
    });
    listEl.innerHTML = html;
    listEl.querySelectorAll(".pay2-q-item").forEach(p2QueueAutoDue);
    p2QueueSum();
  }
  function p2QueueCard(it, i){
    var sug = it.suggest || "new";
    var rows = it.threadRows || [];
    var btn = function(act, label, cls){
      return '<button type="button" class="pay2-tool-btn' + (cls ? " " + cls : "") + (act === sug ? " is-suggest" : "") +
        '" data-act="' + act + '">' + label + "</button>";
    };
    var labs = (it.labels || []).map(function(n){ return n === "01.payment" ? n : n.replace("01.payment/", ""); }).join(", ");
    var h = '<div class="pay2-q-item" data-idx="' + i + '">';
    h += '<div class="pay2-q-head">' +
      '<span class="pay2-import-date">' + escapeHtml(it.receivedDate || "") + "</span>" +
      (it.pdf ? '<span class="pay2-q-tag">PDF</span>' : "") +
      (labs ? '<span class="pay2-q-tag">' + escapeHtml(labs) + "</span>" : "") +
      '<span class="pay2-q-headacts">' +
        (it.threadId ? '<button type="button" class="pay2-mini-btn" data-qview="1">本文・添付を見る</button>' : "") +
        (it.sourceLink ? '<a class="pay2-q-open" href="' + escapeHtml(it.sourceLink) + '" target="_blank" rel="noopener">Gmail で開く ↗</a>' : "") +
      "</span></div>";
    h += '<div class="pay2-import-from">' + escapeHtml(it.from || "(差出人不明)") + "</div>";
    h += '<div class="pay2-q-subj">' + escapeHtml(it.subject || "(件名なし)") + "</div>";
    if (it.snippet) h += '<div class="pay2-q-snip">' + escapeHtml(it.snippet) + "</div>";
    if (rows.length){
      h += '<div class="pay2-q-thread">同じスレッドの台帳: ' + rows.map(function(r){
        return escapeHtml((r.vendorName || "?") + " " + (r.periodMonth || r.receivedDate || "") + " " + (r.method || ""));
      }).join(" ／ ") + "</div>";
    }
    h += '<div class="pay2-q-view" hidden></div>';
    h += '<div class="pay2-q-suggest">提案: ' + escapeHtml(P2Q_SUGGEST[sug] || sug) + "</div>";
    h += '<div class="pay2-q-form">' +
      '<input type="text" class="pay2-q-vendor" list="pay2-queue-vendors" placeholder="ベンダー" value="' + escapeHtml(it.vendorName || "") + '" aria-label="ベンダー">' +
      '<select class="pay2-q-method" aria-label="支払方式"><option value="">方式</option>' +
        P2Q_METHODS.map(function(m){ return '<option value="' + m + '"' + (m === it.method ? " selected" : "") + ">" + m + "</option>"; }).join("") +
      "</select>" +
      '<input type="month" class="pay2-q-month" value="' + escapeHtml(it.periodMonth || "") + '" aria-label="何月分" title="何月分">' +
      '<input type="text" class="pay2-q-amount" inputmode="numeric" placeholder="税込（任意）" aria-label="税込金額">' +
      '<input type="date" class="pay2-q-due" aria-label="支払期日" title="支払期日（任意）">' +
      "</div>" +
      (it.canAddEmail ? '<label class="pay2-q-addemail"><input type="checkbox" checked> 差出人 ' + escapeHtml(it.fromEmail || "") + " をベンダーのメールアドレスに追加（次から自動で照合）</label>" : "");
    h += '<div class="pay2-q-actions">' + btn("new", "確定（台帳に追加）", "pay2-tool-primary");
    if (rows.length){
      h += '<select class="pay2-q-link" aria-label="紐付け先の行">' + rows.map(function(r){
        return '<option value="' + escapeHtml(r.id) + '">' + escapeHtml((r.vendorName || "?") + " " + (r.periodMonth || r.receivedDate || "")) + "</option>";
      }).join("") + "</select>" + btn("link", "既存の行に紐付け");
    }
    h += btn("notice", "変更通知") + btn("exclude", "対象外");
    if (it.source === "sweep" || it.source === "thread") h += btn("dismiss", "無視");
    h += '</div><div class="pay2-q-msg" role="status"></div></div>';
    return h;
  }
  // キューのカード: 支払期日をベンダーの支払サイト＋何月分から入れる（空欄か、自動で入れた値のままのときだけ）
  function p2QueueAutoDue(card){
    var dueEl = card.querySelector(".pay2-q-due");
    var vEl = card.querySelector(".pay2-q-vendor"), mEl = card.querySelector(".pay2-q-method"), pmEl = card.querySelector(".pay2-q-month");
    if (!dueEl || !vEl || !mEl || !pmEl) return;
    var v = p2VendorByName(vEl.value);
    var due = v && v.paymentTerms && mEl.value !== "UPSIDER" ? p2DueFromTerms(v.paymentTerms, pmEl.value, "") : null;
    var auto = dueEl.getAttribute("data-auto") || "";
    if (dueEl.value && dueEl.value !== auto) return;
    dueEl.value = due || "";
    dueEl.setAttribute("data-auto", due || "");
    dueEl.title = due ? "支払期日（支払サイト「" + v.paymentTerms + "」から自動）" : "支払期日（任意）";
  }
  function p2QueueFormInput(e){
    var t = e.target;
    if (!t || !t.matches || !t.matches(".pay2-q-vendor, .pay2-q-method, .pay2-q-month")) return;
    var card = t.closest(".pay2-q-item");
    if (card) p2QueueAutoDue(card);
  }
  function p2QueueClick(e){
    var t = e.target;
    var card = t && t.closest ? t.closest(".pay2-q-item") : null;
    if (!card) return;
    var idx = Number(card.getAttribute("data-idx"));
    var v = t.closest("[data-qview]");
    if (v){ p2QueueView(idx, card, v); return; }
    var a = t.closest("[data-qatt]");
    if (a){ p2QueueOpenAtt(idx, card, Number(a.getAttribute("data-qatt"))); return; }
    var b = t.closest("button[data-act]");
    if (b) p2QueueAct(idx, b.getAttribute("data-act"));
  }
  // カードの中でメール本文と添付を見る（Gmail に移らずに確定できるように）。
  // 対象の1通の本文を出す（?messageId=。スレッドを使い回す請求書で別のメールの本文を出さない）。
  function p2QueueView(idx, card, btn){
    var it = p2q.items[idx];
    var box = card.querySelector(".pay2-q-view");
    if (!it || !box) return;
    if (!box.hidden){ box.hidden = true; btn.textContent = "本文・添付を見る"; return; }
    box.hidden = false;
    btn.textContent = "本文を閉じる";
    if (it._view) return;
    box.textContent = "読み込み中…";
    apiFetch(acctPath("/api/google/gmail/threads/" + encodeURIComponent(it.threadId) + "?messageId=" + encodeURIComponent(it.messageId), "syslea")).then(function(res){
      var atts = (res && res.attachments) || [];
      var mine = atts.filter(function(x){ return x.messageId === it.messageId; });
      it._atts = mine.length ? mine : atts;
      it._view = true;
      box.innerHTML = '<div class="pay2-q-body">' + escapeHtml((res && res.body) || "(本文がありません)") + "</div>" +
        (it._atts.length ? '<div class="pay2-q-atts">' + it._atts.map(function(x, j){
          return '<button type="button" class="pay2-mini-btn" data-qatt="' + j + '" title="新しいタブで開く">📎 ' + escapeHtml(x.filename || "添付") + "</button>";
        }).join("") + (mine.length ? "" : '<span class="pay2-muted">（このメールには添付が無いので、同じスレッドの添付）</span>') + "</div>" : "");
    }).catch(function(err){
      box.textContent = apiErrorMessage(err, "メール");
    });
  }
  function p2QueueOpenAtt(idx, card, j){
    var it = p2q.items[idx];
    var att = it && it._atts && it._atts[j];
    if (!att) return;
    var w = window.open("", "_blank"); // 取得を待ってから開くとポップアップとして止められるので、先にタブを開いておく
    mailAttachBytes(att).then(function(buf){
      var url = URL.createObjectURL(new Blob([buf], { type: att.mimeType || "application/octet-stream" }));
      if (w && !w.closed) w.location.href = url; else window.open(url, "_blank");
      setTimeout(function(){ URL.revokeObjectURL(url); }, 120000);
    }).catch(function(err){
      if (w) w.close();
      var msg = card.querySelector(".pay2-q-msg");
      if (msg){ msg.className = "pay2-q-msg err"; msg.textContent = apiErrorMessage(err, "添付") || "添付を開けませんでした。"; }
    });
  }
  function p2QueueAct(idx, act){
    var it = p2q.items[idx];
    if (!it || it.done || it.busy) return Promise.resolve();
    var card = p2El("pay2-import-list").querySelector('.pay2-q-item[data-idx="' + idx + '"]');
    if (!card) return Promise.resolve();
    var msg = card.querySelector(".pay2-q-msg");
    var body = { action: act, messageId: it.messageId, threadId: it.threadId, fromEmail: it.fromEmail || "" };
    var addEl = card.querySelector(".pay2-q-addemail input");
    body.addVendorEmail = !!(addEl && addEl.checked && (act === "new" || act === "link"));
    if (act === "new"){
      var vname = card.querySelector(".pay2-q-vendor").value.trim();
      var method = card.querySelector(".pay2-q-method").value;
      if (!vname || P2Q_METHODS.indexOf(method) === -1){
        msg.className = "pay2-q-msg err";
        msg.textContent = "ベンダーと支払方式を入れてください。";
        return Promise.resolve();
      }
      var v = p2VendorByName(vname);
      var amt = card.querySelector(".pay2-q-amount").value.replace(/[^\d]/g, "");
      body.payable = {
        vendorId: v ? v.id : "", vendorName: vname, method: method, fromEmail: it.fromEmail,
        receivedDate: it.receivedDate, periodMonth: card.querySelector(".pay2-q-month").value,
        dueDate: card.querySelector(".pay2-q-due").value, amountIncl: amt ? Number(amt) : null,
        note: it.subject, sourceLink: it.sourceLink
      };
    } else if (act === "link"){
      var sel = card.querySelector(".pay2-q-link");
      body.payableId = sel ? sel.value : "";
      if (!body.payableId) return Promise.resolve();
    }
    it.busy = true;
    var ctrls = card.querySelectorAll("button, input, select");
    Array.prototype.forEach.call(ctrls, function(x){ x.disabled = true; });
    msg.className = "pay2-q-msg";
    msg.textContent = "反映中…";
    return apiFetch("/api/payables/queue/resolve", { method: "POST", body: JSON.stringify(body) }).then(function(res){
      it.done = true;
      p2q.dirty = true;
      card.classList.add("is-done");
      var saved = res && res.payable;
      if (saved){
        var ix = -1;
        p2.payables.forEach(function(r, j){ if (r.id === saved.id) ix = j; });
        if (ix === -1) p2.payables.unshift(saved); else p2.payables[ix] = saved;
      }
      if (res && res.vendorEmailAdded && res.vendorId){
        // 次のカードの照合にもすぐ効くように手元のベンダーにも足しておく
        p2.vendors = p2.vendors.map(function(v){
          return v.id === res.vendorId ? Object.assign({}, v, { emails: p2VendorEmails(v).concat([it.fromEmail]).join(", ") }) : v;
        });
      }
      msg.textContent = "✓ " + (P2Q_DONE[act] || act) + (res && res.label ? "（" + res.label.replace("01.payment/", "") + "）" : "") +
        (res && res.vendorEmailAdded ? "・差出人アドレスをベンダーに追加" : "");
      p2QueueSum();
    }).catch(function(err){
      Array.prototype.forEach.call(ctrls, function(x){ x.disabled = false; });
      msg.className = "pay2-q-msg err";
      msg.textContent = apiErrorMessage(err, "未処理キュー");
    }).finally(function(){ it.busy = false; });
  }
  function p2QueueDismissJunk(){
    var targets = [];
    p2q.items.forEach(function(it, i){ if (!it.done && it.source === "sweep" && it.suggest === "dismiss") targets.push(i); });
    if (!targets.length) return;
    if (!window.confirm("入口外の候補のうち「無視」提案の " + targets.length + " 件を候補から外します（ラベル・台帳は変わりません）。よろしいですか？")) return;
    var jb = p2El("pay2-queue-dismiss-junk");
    jb.disabled = true;
    targets.reduce(function(p, i){ return p.then(function(){ return p2QueueAct(i, "dismiss"); }); }, Promise.resolve())
      .then(function(){ jb.disabled = false; p2QueueSum(); });
  }

  /* ---- Google スプレッドシートへ書き出し ---- */
  function p2SheetSync(){
    var btns = [p2El("pay2-sheet-btn"), p2El("pay2-vendor-sheet-btn")];
    btns.forEach(function(b){ if (b) b.disabled = true; });
    p2Status("スプレッドシートへ書き出し中…");
    apiFetch("/api/payables/sheet-sync", { method: "POST", body: JSON.stringify({ sheetId: PAY2_SHEET_ID }) })
      .then(function(res){
        p2Status("スプシへ書き出し完了：明細 " + ((res && res.payables) || 0) + " 件 ／ ベンダー " + ((res && res.vendors) || 0) + " 社（SYSLEA支払管理）");
      })
      .catch(function(err){
        p2Status(apiErrorMessage(err, "スプレッドシート"), "err");
      })
      .finally(function(){ btns.forEach(function(b){ if (b) b.disabled = false; }); });
  }

  /* ---- Google スプレッドシートから取り込み（↓スプシから取り込み） ---- */
  function p2SheetPullSummary(o){
    o = o || {};
    return "更新 " + (o.updated || 0) + " ／ 新規 " + (o.created || 0) + " ／ スキップ " + (o.skipped || 0);
  }
  function p2SheetPull(){
    if (!window.confirm("「SYSLEA支払管理」スプシの 支払明細／ベンダーマスタ タブの内容で、ポータルの台帳を更新します。\n\n※ 先に「↑ スプシ」で最新化してから編集してください（空セルはその項目のみ現状維持ですが、チェック列は空＝OFF になります）。\n\nまず件数プレビューを出します。よろしいですか？")) return;
    var btns = Array.prototype.slice.call(document.querySelectorAll(".pay2-sheetpull-btn"));
    btns.forEach(function(b){ b.disabled = true; });
    p2Status("スプシを読み込み中…");
    apiFetch("/api/payables/sheet-pull", { method: "POST", body: JSON.stringify({ sheetId: PAY2_SHEET_ID, dryRun: true }) })
      .then(function(res){
        var p = (res && res.payables) || {}, v = (res && res.vendors) || {};
        var errs = (p.errors || []).concat(v.errors || []);
        var msg = "プレビュー\n支払明細: " + p2SheetPullSummary(p) + "\nベンダー: " + p2SheetPullSummary(v);
        if (errs.length) msg += "\n\n注意:\n・" + errs.slice(0, 12).join("\n・");
        if (!window.confirm(msg + "\n\nこの内容で適用しますか？")){ p2Status("スプシ取り込みを中止しました。"); return; }
        p2Status("スプシから取り込み中…");
        return apiFetch("/api/payables/sheet-pull", { method: "POST", body: JSON.stringify({ sheetId: PAY2_SHEET_ID, dryRun: false }) })
          .then(function(r2){
            var p2r = (r2 && r2.payables) || {}, v2r = (r2 && r2.vendors) || {};
            return p2Load().then(function(){
              p2Status("スプシ取り込み完了 — 明細 " + p2SheetPullSummary(p2r) + "、ベンダー " + p2SheetPullSummary(v2r));
            });
          });
      })
      .catch(function(err){ p2Status(apiErrorMessage(err, "スプシ取り込み"), "err"); })
      .finally(function(){ document.querySelectorAll(".pay2-sheetpull-btn").forEach(function(b){ b.disabled = false; }); });
  }

  /* ---- CSV ダウンロード ---- */
  function p2Csv(collection){
    apiFetchBlob("/api/export/csv?collection=" + encodeURIComponent(collection)).then(function(blob){
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = collection + "-" + jstDateKey(new Date()) + ".csv";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function(){ URL.revokeObjectURL(url); }, 4000);
    }).catch(function(err){
      p2Status(apiErrorMessage(err, "CSV書き出し"), "err");
    });
  }

  /* ---- PDF/本文の AI 抽出（/api/payables/extract） ----
     pdf.js(extractPdfText) と Gmail 添付取得(mailAttachBytes)は
     「支払い仕分け」機能のものを再利用する。 */
  function p2ExtractBusy(on, msg){
    var b = p2El("p2f-extract-mail");
    var f = p2El("p2f-extract-pdf");
    if (b) b.disabled = on;
    if (f) f.disabled = on;
    if (on) p2ExtractMsg(msg || "処理中…", false);
  }
  function p2ExtractMsg(text, isErr, asHtml){
    var n = p2El("p2f-extract-note");
    if (!n) return;
    n.hidden = false;
    n.classList.toggle("is-err", !!isErr);
    if (asHtml) n.innerHTML = text; else n.textContent = text;
  }
  function p2FieldLabel(id){
    return ({
      "p2f-vendorName": "ベンダー", "p2f-invoiceNo": "請求書番号", "p2f-invoiceDate": "請求日",
      "p2f-dueDate": "支払期日", "p2f-amountExcl": "税抜", "p2f-tax": "消費税",
      "p2f-amountIncl": "税込", "p2f-regNo": "登録番号"
    })[id] || id;
  }

  async function p2ExtractFromMail(threadId, subjectHint){
    if (!threadId){
      p2ExtractMsg("このメールにはスレッド情報がありません。「PDFを選んで読み取り」をお使いください。", true);
      return;
    }
    p2ExtractBusy(true, "メールを取得中…");
    try {
      var th = await apiFetch(acctPath("/api/google/gmail/threads/" + encodeURIComponent(threadId), "syslea"));
      var bodyText = (th && th.body) || "";
      var pdfs = ((th && th.attachments) || []).filter(function(a){
        return a && ((a.mimeType === "application/pdf") || /\.pdf$/i.test(a.filename || ""));
      });
      var pdfText = "";
      if (pdfs.length){
        p2ExtractBusy(true, "PDF を読み取り中…（" + pdfs.length + " 件）");
        for (var i = 0; i < pdfs.length; i++){
          try {
            var buf = await mailAttachBytes(pdfs[i]);
            pdfText += (await extractPdfText(buf)) + "\n";
          } catch (e){ /* この添付は飛ばす */ }
        }
      }
      if (!pdfText && !bodyText){
        p2ExtractBusy(false);
        p2ExtractMsg("読み取れるテキストがありませんでした。", true);
        return;
      }
      await p2RunExtract(pdfText, bodyText, subjectHint);
    } catch (err){
      p2ExtractBusy(false);
      p2ExtractMsg(apiErrorMessage(err, "メール"), true);
    }
  }

  async function p2ExtractFromFile(file){
    p2ExtractBusy(true, "PDF を読み取り中…");
    try {
      var buf = await file.arrayBuffer();
      var pdfText = await extractPdfText(buf);
      if (!pdfText || !pdfText.trim()){
        p2ExtractBusy(false);
        p2ExtractMsg("PDF からテキストを取り出せませんでした（画像だけの PDF の可能性）。", true);
        return;
      }
      await p2RunExtract(pdfText, "", file.name || "");
    } catch (err){
      p2ExtractBusy(false);
      p2ExtractMsg("PDF の読み取りに失敗しました。", true);
    }
  }

  async function p2RunExtract(pdfText, bodyText, subject){
    p2ExtractBusy(true, "AI で抽出中…");
    try {
      var res = await apiFetch("/api/payables/extract", { method: "POST", body: JSON.stringify({
        pdfText: String(pdfText || "").slice(0, 14000),
        bodyText: String(bodyText || "").slice(0, 4000),
        subject: String(subject || "").slice(0, 300)
      }) });
      p2ApplyExtract(res);
    } catch (err){
      p2ExtractBusy(false);
      p2ExtractMsg(apiErrorMessage(err, "AI抽出"), true);
    }
  }

  function p2ApplyExtract(res){
    p2ExtractBusy(false);
    var f = (res && res.fields) || {};
    var map = {
      "p2f-vendorName": f.vendorName, "p2f-invoiceNo": f.invoiceNo,
      "p2f-invoiceDate": f.invoiceDate, "p2f-dueDate": f.dueDate,
      "p2f-amountExcl": f.amountExcl, "p2f-tax": f.tax, "p2f-amountIncl": f.amountIncl,
      "p2f-regNo": f.regNo
    };
    var filled = 0;
    var conflicts = [];
    Object.keys(map).forEach(function(id){
      var v = map[id];
      if (v == null || v === "") return;
      var el = p2El(id);
      if (!el) return;
      if (!el.value){ el.value = v; filled++; }
      else if (String(el.value) !== String(v)){
        conflicts.push(p2FieldLabel(id) + "：現在 " + el.value + " ／ 抽出 " + v);
      }
    });
    if (f.method){
      var mEl = p2El("p2f-method");
      if (mEl && (!mEl.value || mEl.value === "その他")) mEl.value = f.method;
    }
    if (f.qualified === "適格"){
      var qEl = p2El("p2f-qualified");
      if (qEl && qEl.value === "不明") qEl.value = "適格";
    }
    var ae = p2El("p2f-amountExcl");
    if (ae) ae.dispatchEvent(new Event("input"));

    var conf = (res && typeof res.confidence === "number") ? res.confidence : 0.5;
    var confLabel = conf >= 0.8 ? "高" : (conf >= 0.5 ? "中" : "低");
    var warns = (res && res.warnings) || [];
    var html = "<b>AI抽出：信頼度 " + confLabel + "</b>（空欄 " + filled + " 項目に反映）";
    if (conflicts.length) html += "<br>既存値と相違: " + conflicts.map(escapeHtml).join(" ／ ");
    // 振込先は抽出が1行の文字列で返る。フォームは銀行名/支店/種別/番号/名義の5項目なので自動では入れず、
    // 見える所に出す（以前は存在しない p2f-payTo に入れようとして黙って捨てていた）。
    if (f.payTo) html += "<br>振込先（抽出）: " + escapeHtml(f.payTo) + " ← 口座の欄に入れてください";
    if (warns.length) html += "<br>⚠ " + warns.map(escapeHtml).join("<br>⚠ ");
    html += '<br><span class="pay2-extract-hint">金額・日付・登録番号は必ず原本と突き合わせて確認してください。</span>';
    p2ExtractMsg(html, false, true);
  }

  // app.js の showView が初回ロード後に呼ぶエントリポイント。
  CP.initPayables = initPayables;
  // Esc で閉じる(app.js の Esc スタックへ登録)。
  if (CP.registerEscModal){
    CP.registerEscModal("pay2-edit-modal", p2CloseEdit);
    CP.registerEscModal("pay2-vendor-modal", p2CloseVendor);
    CP.registerEscModal("pay2-import-modal", p2CloseImport);
  }
})();
