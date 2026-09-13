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
  var PAY_RECONCILED = ["未", "一致", "不一致"];
  var SYSLEA_MAIL_ADDR = "haruka.masumitsu@syslea.io";
  // 書き出し先スプレッドシート（本人の「SYSLEA支払管理」。SYSLEA 側のものではない）
  var PAY2_SHEET_ID = "1ri3pOCzWgh_PVpRqIWYJotlqCvBWgWUCYU43vWPwEYU";
  var PAY2_SHEET_URL = "https://docs.google.com/spreadsheets/d/" + PAY2_SHEET_ID + "/edit";

  var p2 = {
    payables: [], vendors: [], receipts: [], receiptsUnattributed: 0, unlinked: [], unlinkedExcluded: [], tab: "detail",
    fMonth: "", fMethod: "", fUnpaid: false, fNeedInput: false, fQueue: false, fQ: "", fExcluded: false,
    vq: "", vFm: "", vFcat: "", vNoEmail: false, vOverdue: false, vFex: "hide",
    checkOpen: false, checkOverdueOnly: false, unlinkedOpen: false, _recv: {},
    wired: false, editId: null, vendId: null
  };

  function p2El(id){ return document.getElementById(id); }
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
    if (p2.receiptsUnattributed) msg += " ／ 仕分け済みで未紐づけ " + p2.receiptsUnattributed + " 件（差出人がベンダー未登録＝受領チェックに出ません）";
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
      var e = idx[r.vendorId] || (idx[r.vendorId] = { last: "", byMonth: {}, count: {} });
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
    if (cm === 1) return true;
    var e = p2._recv[v.id];
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
      // 対象月の受領チェック
      p2El("pay2-check-toggle").addEventListener("click", function(){
        p2.checkOpen = !p2.checkOpen;
        p2RenderCheck();
      });
      p2El("pay2-check-month").addEventListener("change", p2RenderCheck);
      p2El("pay2-check-overdue").addEventListener("change", function(){ p2.checkOverdueOnly = this.checked; p2RenderCheck(); });
      p2El("pay2-unlinked-toggle").addEventListener("click", function(){
        p2.unlinkedOpen = !p2.unlinkedOpen;
        p2RenderUnlinked();
      });
      // ボタン
      p2El("pay2-new-btn").addEventListener("click", function(){ p2OpenEdit(null); });
      p2El("pay2-import-btn").addEventListener("click", p2OpenImport);
      p2StmtWire();
      p2El("pay2-backfill-btn").addEventListener("click", p2BackfillEmails);
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
      p2El("pay2-edit-del").addEventListener("click", p2DeleteEdit);
      // ベンダーモーダル
      p2El("pay2-vendor-close").addEventListener("click", p2CloseVendor);
      p2El("pay2-vendor-cancel").addEventListener("click", p2CloseVendor);
      p2El("pay2-vendor-form").addEventListener("submit", function(e){ e.preventDefault(); p2SaveVendor(); });
      p2El("pay2-vendor-del").addEventListener("click", p2DeleteVendor);
      // 未処理キュー（旧 取り込みモーダル）
      p2El("pay2-import-close").addEventListener("click", p2CloseImport);
      p2El("pay2-import-cancel").addEventListener("click", p2CloseImport);
      p2El("pay2-queue-reload").addEventListener("click", p2QueueLoad);
      p2El("pay2-queue-dismiss-junk").addEventListener("click", p2QueueDismissJunk);
      p2El("pay2-import-list").addEventListener("click", p2QueueClick);
    }
    p2Load();
  }

  function p2Load(){
    p2Status("読み込み中…");
    apiFetch("/api/payables").then(function(res){
      p2.payables = (res && res.payables) || [];
      p2.vendors = (res && res.vendors) || [];
      p2.receipts = (res && res.receipts) || [];
      p2.receiptsUnattributed = (res && res.receiptsUnattributed) || 0;
      p2.unlinked = (res && res.receiptsUnattributedList) || [];
      p2.unlinkedExcluded = (res && res.receiptsExcludedList) || [];
      p2RenderAll();
      p2El("pay2-summary").hidden = (p2.tab !== "detail");
      p2CountStatus();
    }).catch(function(err){
      p2Status(apiErrorMessage(err, "請求書管理"), "err");
    });
  }

  function p2SwitchTab(tab){
    p2.tab = tab === "vendor" ? "vendor" : "detail";
    document.querySelectorAll("#pay2-tabs .acct-tab").forEach(function(b){
      b.classList.toggle("active", b.getAttribute("data-p2tab") === p2.tab);
    });
    var isDetail = p2.tab === "detail";
    p2El("pay2-detail-tools").hidden = !isDetail;
    p2El("pay2-vendor-tools").hidden = isDetail;
    p2El("pay2-detail-wrap").hidden = !isDetail;
    p2El("pay2-vendor-wrap").hidden = isDetail;
    p2El("pay2-summary").hidden = !isDetail;
    var chk = p2El("pay2-check");
    if (chk) chk.hidden = !isDetail;
    if (isDetail){ p2RenderCheck(); p2RenderUnlinked(); p2RenderDetail(); } else { p2RenderVendors(); p2RenderUnlinked(); }
    p2StmtRender();
  }

  function p2RenderAll(){
    p2._recv = p2RecvIndex();
    // 月セレクトの選択肢を受領日から作る
    var months = {};
    p2.payables.forEach(function(r){ var ym = p2Ym(r.receivedDate); if (ym) months[ym] = 1; });
    var keys = Object.keys(months).sort().reverse();
    var sel = p2El("pay2-month");
    var cur = p2.fMonth;
    sel.innerHTML = '<option value="">全期間</option>' + keys.map(function(k){
      return '<option value="' + k + '"' + (k === cur ? " selected" : "") + ">" + k + "</option>";
    }).join("");
    p2RenderCheck();
    p2RenderUnlinked();
    p2StmtRender();
    if (p2.tab === "vendor") p2RenderVendors(); else p2RenderDetail();
  }

  function p2Filtered(){
    var q = (p2.fQ || "").trim().toLowerCase();
    return p2.payables.filter(function(r){
      if (!p2.fExcluded && r.excluded) return false;
      if (p2.fMonth && p2Ym(r.receivedDate) !== p2.fMonth) return false;
      if (p2.fMethod && r.method !== p2.fMethod) return false;
      if (p2.fUnpaid && r.paid) return false;
      if (p2.fQueue && (r.paid || r.excluded)) return false;
      if (p2.fNeedInput && !(r.amountIncl == null || !r.dueDate)) return false;
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
    var isOverdue = function(r){ return !r.paid && r.dueDate && r.dueDate < today; };
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
      var sumIncl = 0, unpaidN = 0, unpaidSum = 0, needCheck = 0, exclN = 0;
      filtered.forEach(function(r){
        if (r.excluded){ exclN++; return; }
        if (r.amountIncl != null) sumIncl += Number(r.amountIncl);
        if (!r.paid){ unpaidN++; if (r.amountIncl != null) unpaidSum += Number(r.amountIncl); }
        if (!r.checked) needCheck++;
      });
      s.innerHTML =
        "対象 <b>" + (rows.length - exclN) + "</b> 件" +
        (exclN ? ' <span class="pay2-sum-muted">（対象外 ' + exclN + " 件）</span>" : "") +
        " ／ 税込合計 <b>" + p2Money(sumIncl) + "</b>" +
        ' ／ <span class="warn">未払い ' + unpaidN + " 件 " + p2Money(unpaidSum) + "</span>" +
        ' ／ <span class="warn">未確認 ' + needCheck + " 件</span>";
    }

    var table = p2El("pay2-detail-table");
    var empty = p2El("pay2-detail-empty");
    if (!rows.length){
      table.innerHTML = "";
      empty.hidden = false;
      empty.textContent = p2.fQueue ? "未払いの請求書はありません。"
        : p2.payables.length ? "この条件に合う請求書はありません。"
        : "まだ請求書がありません。「＋ 新規」か「✉ メール取り込み」で追加してください。";
      return;
    }
    empty.hidden = true;
    var head = "<thead><tr>" +
      ["済", "支払期日", "ベンダー", "請求書番号", "税込", "方式", "支払予定", "何月分", "状態", "備考"]
        .map(function(h){ return "<th>" + h + "</th>"; }).join("") +
      "</tr></thead>";
    var body = "<tbody>" + rows.map(function(r){
      var st = [];
      if (r.excluded) st.push('<span class="pay2-flag">対象外</span>');
      if (!r.checked && !r.excluded) st.push('<span class="pay2-flag">未確認</span>');
      if (r.reconciled === "不一致") st.push('<span class="pay2-flag">照合NG</span>');
      if (r.payToMismatch && !r.payToChecked && !r.excluded) st.push('<span class="pay2-flag">⚠口座変更</span>');
      var af = p2AmountFlag(r);
      if (af && !r.excluded) st.push(af);
      var cls = r.excluded ? "pay2-row-excluded" : isOverdue(r) ? "pay2-row-overdue" : r.paid ? "pay2-row-paid" : "";
      return '<tr data-id="' + escapeHtml(r.id) + '" class="' + cls + '">' +
        '<td class="center"><input type="checkbox" class="p2-paid-cb" data-id="' + escapeHtml(r.id) + '"' + (r.paid ? " checked" : "") + '></td>' +
        "<td>" + escapeHtml(r.dueDate || "—") + (isOverdue(r) ? ' <span class="pay2-flag">期限切れ</span>' : "") + "</td>" +
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
        var r = p2.payables.filter(function(x){ return x.id === id; })[0];
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
        var rec = p2.payables.filter(function(x){ return x.id === tr.getAttribute("data-id"); })[0];
        if (rec) p2OpenEdit(rec);
      });
    });
  }
  function p2TogglePaid(id, paid, alsoPayToChecked){
    var row = p2.payables.filter(function(x){ return x.id === id; })[0];
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
        var v = p2.vendors.filter(function(x){ return x.id === tr.getAttribute("data-id"); })[0];
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
     「未着のみ」で欠落だけに絞れる。行クリックで台帳行 or ベンダー編集。 */
  function p2RenderCheck(){
    var wrap = p2El("pay2-check");
    if (!wrap) return;
    wrap.hidden = (p2.tab !== "detail");
    var mEl = p2El("pay2-check-month");
    if (mEl && !mEl.value) mEl.value = p2CurMonth();
    var month = (mEl && mEl.value) || p2CurMonth();
    var toggle = p2El("pay2-check-toggle");
    if (toggle) toggle.setAttribute("aria-expanded", p2.checkOpen ? "true" : "false");

    var allRows = p2.vendors
      .filter(function(v){ return !v.excluded && p2ExpectedInMonth(v, month); })
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
        : "この支払月に払う予定の定期ベンダーはありません。";
    }

    var body = p2El("pay2-check-body");
    if (!body) return;
    if (!p2.checkOpen){ body.hidden = true; return; }
    body.hidden = false;
    var sugg = p2CheckSuggestions();
    if (!rows.length){
      body.innerHTML = p2SuggestHtml(sugg) + (p2.checkOverdueOnly && allRows.length ? '<p class="pay2-empty">未着はありません。</p>' : "");
      p2WireSuggestions(body, sugg);
      return;
    }
    body.innerHTML = p2SuggestHtml(sugg) +
      '<table class="pay2-table"><thead><tr><th>ベンダー</th><th>周期</th><th>支払サイト</th><th>想定</th><th>最終受領</th><th>状態</th><th>金額</th><th></th></tr></thead><tbody>' +
      rows.map(function(r){
        var e = p2._recv[r.v.id];
        var rec = (e && e.byMonth[month]) || null;
        var need = p2ExpectCount(r.v), got = p2RecvCount(r.v, month);
        var frac = need > 1 ? " " + got + "/" + need : "";
        var stHtml = r.st === "received" ? '<span class="pay2-flag ok">受領' + frac + "</span>"
          : r.st === "overdue" ? '<span class="pay2-flag">' + (got ? "一部未着" : "未着") + frac + "</span>"
          : '<span class="pay2-muted">待機' + frac + "</span>";
        var act = r.st !== "overdue" ? "" :
          '<button type="button" class="pay2-mini-btn" data-find="' + escapeHtml(r.v.id) + '">メールを探す</button>' +
          '<button type="button" class="pay2-mini-btn" data-remind="' + escapeHtml(r.v.id) + '"' +
            (p2VendorEmails(r.v).length ? "" : ' disabled title="ベンダーのメールアドレスが未登録です"') + ">催促の下書き</button>";
        return '<tr data-vid="' + escapeHtml(r.v.id) + '"' + (rec && rec.payableId ? ' data-pid="' + escapeHtml(rec.payableId) + '"' : "") + ">" +
          '<td class="strong">' + escapeHtml(r.v.name || "") + "</td>" +
          '<td class="center">' + escapeHtml(p2CadenceLabel(p2CadenceOf(r.v))) + "</td>" +
          "<td>" + escapeHtml(String(r.v.paymentTerms || "").slice(0, 18)) + "</td>" +
          '<td class="center">' + escapeHtml(String(p2ExpectDay(r.v)) + "日") + "</td>" +
          '<td class="center">' + escapeHtml((e && e.last) || "—") + "</td>" +
          "<td>" + stHtml + "</td>" +
          '<td class="num">' + (rec && rec.amountIncl != null ? p2Money(rec.amountIncl) : "") + "</td>" +
          '<td class="pay2-check-act">' + act + "</td>" +
          "</tr>";
      }).join("") + "</tbody></table>";
    body.querySelectorAll("tbody tr").forEach(function(tr){
      tr.addEventListener("click", function(){
        var pid = tr.getAttribute("data-pid");
        if (pid){
          var rec = p2.payables.filter(function(x){ return x.id === pid; })[0];
          if (rec){ p2OpenEdit(rec); return; }
        }
        var v = p2.vendors.filter(function(x){ return x.id === tr.getAttribute("data-vid"); })[0];
        if (v) p2OpenVendor(v);
      });
    });
    body.querySelectorAll("[data-find]").forEach(function(b){
      b.addEventListener("click", function(ev){ ev.stopPropagation(); p2FindMail(b.getAttribute("data-find")); });
    });
    body.querySelectorAll("[data-remind]").forEach(function(b){
      b.addEventListener("click", function(ev){ ev.stopPropagation(); p2RemindDraft(b.getAttribute("data-remind"), month, b); });
    });
    p2WireSuggestions(body, sugg);
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
    var v = p2.vendors.filter(function(x){ return x.id === vid; })[0];
    if (!v) return;
    var emails = p2VendorEmails(v);
    var q = (emails.length ? "from:(" + emails.join(" OR ") + ")" : '"' + String(v.name || "").replace(/"/g, "") + '"') + " newer_than:60d";
    window.open("https://mail.google.com/mail/u/?authuser=" + encodeURIComponent(SYSLEA_MAIL_ADDR) + "#search/" + encodeURIComponent(q), "_blank", "noopener");
  }
  function p2RemindDraft(vid, month, btn){
    var v = p2.vendors.filter(function(x){ return x.id === vid; })[0];
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
    if (!window.confirm(to + " 宛の催促メールを SYSLEA の Gmail の下書きに保存します（送信はしません）。よろしいですか？")) return;
    btn.disabled = true;
    apiFetch(acctPath("/api/google/gmail/drafts", "syslea"), { method: "POST", body: JSON.stringify({ to: to, subject: subject, body: text }) })
      .then(function(){
        btn.textContent = "下書き済み";
        p2Status("「" + (v.name || "") + "」宛の催促メールを Gmail の下書きに保存しました（送信はしていません）");
      })
      .catch(function(err){ btn.disabled = false; p2Status(apiErrorMessage(err, "下書き"), "err"); });
  }

  /* ---- カード明細（UPSIDER）の突き合わせ（漏れ防止計画 P4・2026/09/13）----
     UPSIDER の利用明細（CSV / xlsx。列: 取引日・利用先・決済ID・出金金額・通貨・カード保有者名・証憑枚数 …）を取り込み、
     GET /api/payables/statements が台帳の UPSIDER 行とベンダーの照合キー×日付±5日で突き合わせる。
       台帳なし（照合キーのあるベンダー）… メールで請求書・領収書が来ていない決済 →「台帳に追加」／「対象外」
       台帳にあるのに明細なし … 支払方式違い・翌月計上・別カードの可能性
       台帳と一致 … 「円建て金額と支払済を反映」（台帳の税込が空欄のときだけ金額を入れる）
     xlsx は SheetJS を開いたときだけ cdnjs から読み込む。 */
  var P2S_XLSX_SRC = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
  var P2S_HEAD = { date: "取引日", merchant: "利用先", txId: "決済ID", amountOut: "出金金額", amountIn: "入金金額", currency: "通貨", fxAmount: "外貨の金額", cardName: "カード名", holder: "カード保有者名", receiptCount: "証憑枚数" };
  var p2s = { open: false, month: "", data: null, loading: false, xlsx: null };

  function p2StmtWire(){
    p2El("pay2-stmt-toggle").addEventListener("click", function(){
      p2s.open = !p2s.open;
      p2StmtRender();
      if (p2s.open && !p2s.data) p2StmtLoad();
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
    apiFetch("/api/payables/statements" + (p2s.month ? "?month=" + encodeURIComponent(p2s.month) : "")).then(function(res){
      p2s.data = res || {};
      p2s.month = (res && res.month) || "";
      p2StmtRender();
    }).catch(function(err){
      p2El("pay2-stmt-sum").textContent = apiErrorMessage(err, "カード明細");
    }).finally(function(){ p2s.loading = false; });
  }
  function p2StmtRender(){
    var wrap = p2El("pay2-stmt");
    if (!wrap) return;
    wrap.hidden = (p2.tab !== "detail");
    p2El("pay2-stmt-toggle").setAttribute("aria-expanded", p2s.open ? "true" : "false");
    var d = p2s.data, sel = p2El("pay2-stmt-month"), sum = p2El("pay2-stmt-sum"), body = p2El("pay2-stmt-body");
    var months = (d && d.months) || [];
    sel.innerHTML = months.length
      ? months.slice().reverse().map(function(m){ return '<option value="' + m + '"' + (m === p2s.month ? " selected" : "") + ">" + m + "</option>"; }).join("")
      : '<option value="">未取り込み</option>';
    if (!d){
      sum.textContent = p2s.open ? "" : "UPSIDER の利用明細を取り込むと、台帳の UPSIDER 行と突き合わせます。";
      body.hidden = true;
      return;
    }
    var rows = d.rows || [];
    var charges = rows.filter(function(r){ return r.amountOut > 0; });
    var matched = charges.filter(function(r){ return r.match; });
    var known = charges.filter(function(r){ return !r.match && r.guess && r.manualPayableId !== "none"; });
    var other = charges.filter(function(r){ return !r.match && (!r.guess || r.manualPayableId === "none"); });
    var noReceipt = charges.filter(function(r){ return r.receiptCount === 0; });
    var up = d.unmatchedPayables || [];
    var pend = matched.filter(function(r){ return r.match.amountIncl == null || !r.match.paid; }).length;
    var total = charges.reduce(function(a, r){ return a + r.amountOut; }, 0);
    sum.innerHTML = rows.length
      ? ("決済 <b>" + charges.length + "</b> 件 " + p2Money(total) +
         ' ／ <span class="ok">台帳と一致 ' + matched.length + "</span>" +
         ' ／ <span class="warn">台帳なし（登録ベンダー） ' + known.length + "</span>" +
         " ／ 台帳にあるのに明細なし " + up.length + " ／ 証憑0枚 " + noReceipt.length)
      : (months.length ? "この月の明細はありません。" : "まだ明細を取り込んでいません。");
    if (!p2s.open){ body.hidden = true; return; }
    body.hidden = false;
    var th = function(cols){ return "<thead><tr>" + cols.map(function(c){ return "<th>" + c + "</th>"; }).join("") + "</tr></thead>"; };
    var base = function(r){
      return "<td>" + escapeHtml(r.date.slice(5)) + "</td>" +
        '<td class="strong">' + escapeHtml(r.merchant || "") + "</td>" +
        '<td class="num">' + p2Money(r.amountOut) + (r.currency && r.currency !== "JPY" ? ' <span class="pay2-muted">' + escapeHtml(r.currency) + "</span>" : "") + "</td>" +
        "<td>" + escapeHtml(r.holder || "") + "</td>" +
        '<td class="center">' + (r.receiptCount === 0 ? '<span class="pay2-flag">0</span>' : escapeHtml(r.receiptCount == null ? "" : String(r.receiptCount))) + "</td>";
    };
    var h = "";
    h += '<div class="pay2-stmt-sec"><div class="pay2-stmt-title">台帳なし（照合キーのあるベンダーの決済） ' + known.length + " 件 — メールで請求書・領収書が来ていない可能性</div>";
    h += known.length
      ? '<div class="pay2-tablewrap"><table class="pay2-table">' + th(["日付", "利用先", "金額(円)", "カード保有者", "証憑", "ベンダー候補", ""]) + "<tbody>" +
        known.map(function(r){
          return "<tr>" + base(r) + "<td>" + escapeHtml(r.guess.vendorName || "") + "</td>" +
            '<td class="pay2-check-act"><button type="button" class="pay2-mini-btn pay2-mini-primary" data-stmt-add="' + escapeHtml(r.id) + '">台帳に追加</button>' +
            '<button type="button" class="pay2-mini-btn" data-stmt-none="' + escapeHtml(r.id) + '">対象外</button></td></tr>';
        }).join("") + "</tbody></table></div>"
      : '<p class="pay2-muted pay2-stmt-empty">ありません。</p>';
    h += "</div>";
    h += '<div class="pay2-stmt-sec"><div class="pay2-stmt-title">台帳にあるのに明細なし（UPSIDER 行） ' + up.length + " 件 — 支払方式違い・前後の月の決済・別カードの可能性</div>";
    h += up.length
      ? '<div class="pay2-tablewrap"><table class="pay2-table">' + th(["受領日", "ベンダー", "税込", "備考"]) + "<tbody>" +
        up.map(function(p){
          return '<tr data-pid="' + escapeHtml(p.id) + '"><td>' + escapeHtml(String(p.receivedDate || "").slice(5)) + "</td>" +
            '<td class="strong">' + escapeHtml(p.vendorName || "") + "</td>" +
            '<td class="num">' + (p.amountIncl != null ? p2Money(p.amountIncl) : "—") + "</td>" +
            "<td>" + escapeHtml(p.note || "") + "</td></tr>";
        }).join("") + "</tbody></table></div>"
      : '<p class="pay2-muted pay2-stmt-empty">ありません。</p>';
    h += "</div>";
    h += '<div class="pay2-stmt-sec"><div class="pay2-stmt-title">台帳と一致 ' + matched.length + " 件" +
      (pend ? '<button type="button" class="pay2-mini-btn pay2-mini-primary" id="pay2-stmt-apply">円建て金額と支払済を ' + pend + " 件に反映</button>" : "") + "</div>";
    if (matched.length){
      h += '<details class="pay2-stmt-more"><summary>一覧を表示</summary><div class="pay2-tablewrap"><table class="pay2-table">' +
        th(["日付", "利用先", "金額(円)", "カード保有者", "証憑", "台帳", "台帳の税込", "支払済"]) + "<tbody>" +
        matched.map(function(r){
          return '<tr data-pid="' + escapeHtml(r.match.payableId) + '">' + base(r) +
            "<td>" + escapeHtml((r.match.vendorName || "") + " " + String(r.match.receivedDate || "").slice(5)) + (r.match.how === "manual" ? ' <span class="pay2-muted">手動</span>' : "") + "</td>" +
            '<td class="num">' + (r.match.amountIncl != null ? p2Money(r.match.amountIncl) : "—") + "</td>" +
            '<td class="center">' + (r.match.paid ? "✓" : "") + "</td></tr>";
        }).join("") + "</tbody></table></div></details>";
    }
    h += "</div>";
    h += '<div class="pay2-stmt-sec"><details class="pay2-stmt-more"><summary>その他の決済（照合キーのないベンダー・対象外にしたもの） ' + other.length + " 件</summary>" +
      (other.length ? '<div class="pay2-tablewrap"><table class="pay2-table">' + th(["日付", "利用先", "金額(円)", "カード保有者", "証憑"]) + "<tbody>" +
        other.map(function(r){ return "<tr>" + base(r) + "</tr>"; }).join("") + "</tbody></table></div>" : "") +
      "</details></div>";
    body.innerHTML = h;
    body.querySelectorAll("tr[data-pid]").forEach(function(tr){
      tr.addEventListener("click", function(){
        var rec = p2.payables.filter(function(x){ return x.id === tr.getAttribute("data-pid"); })[0];
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
    if (ap) ap.addEventListener("click", function(){ p2StmtApply(pend, ap); });
  }
  function p2StmtRowById(id){
    return ((p2s.data && p2s.data.rows) || []).filter(function(r){ return r.id === id; })[0] || null;
  }
  function p2StmtAdd(id, btn){
    var r = p2StmtRowById(id);
    if (!r || !r.guess) return;
    btn.disabled = true;
    var doc = {
      vendorId: r.guess.vendorId, vendorName: r.guess.vendorName, method: "UPSIDER", receivedDate: r.date,
      periodMonth: r.month, amountIncl: r.amountOut, paid: true,
      note: "カード明細から追加（" + (r.merchant || "") + "・メールなし）"
    };
    apiFetch("/api/payables/payables", { method: "POST", body: JSON.stringify(doc) }).then(function(res){
      var saved = res && res.payable;
      if (saved) p2.payables.unshift(saved);
      return saved ? apiFetch("/api/payables/statements/" + encodeURIComponent(id) + "/match", { method: "POST", body: JSON.stringify({ payableId: saved.id }) }) : null;
    }).then(function(){
      p2Status("「" + (r.guess.vendorName || "") + "」の決済を台帳に追加しました（UPSIDER・支払済）");
      p2RenderAll();
      p2StmtLoad();
    }).catch(function(err){ btn.disabled = false; p2Status(apiErrorMessage(err, "カード明細"), "err"); });
  }
  function p2StmtMatch(id, payableId, btn){
    if (btn) btn.disabled = true;
    apiFetch("/api/payables/statements/" + encodeURIComponent(id) + "/match", { method: "POST", body: JSON.stringify({ payableId: payableId }) })
      .then(function(){ p2StmtLoad(); })
      .catch(function(err){ if (btn) btn.disabled = false; p2Status(apiErrorMessage(err, "カード明細"), "err"); });
  }
  function p2StmtApply(n, btn){
    if (!window.confirm("台帳と一致した " + n + " 件に、明細の円建て金額（台帳の税込が空欄のときだけ）と「支払済」を反映します。よろしいですか？")) return;
    btn.disabled = true;
    apiFetch("/api/payables/statements/apply", { method: "POST", body: JSON.stringify({ month: p2s.month }) }).then(function(res){
      p2Status("カード明細を台帳に反映しました：金額 " + ((res && res.amounts) || 0) + " 件 ／ 支払済 " + ((res && res.paid) || 0) + " 件");
      p2Load();
      p2StmtLoad();
    }).catch(function(err){ btn.disabled = false; p2Status(apiErrorMessage(err, "カード明細"), "err"); });
  }
  function p2StmtImport(file){
    var sum = p2El("pay2-stmt-sum");
    sum.textContent = "明細を読み込み中…";
    var reader = /\.xlsx?$/i.test(file.name) ? p2StmtReadXlsx(file) : p2StmtReadCsv(file);
    reader.then(function(rows){
      if (!rows.length) throw new Error("「取引日」「決済ID」の列がある行が見つかりませんでした（UPSIDER の利用明細か確認してください）。");
      var chunks = [];
      for (var i = 0; i < rows.length; i += 500) chunks.push(rows.slice(i, i + 500));
      var tot = { created: 0, updated: 0, skipped: 0, months: {} };
      sum.textContent = rows.length + " 行を取り込み中…";
      return chunks.reduce(function(p, ch){
        return p.then(function(){
          return apiFetch("/api/payables/statements/import", { method: "POST", body: JSON.stringify({ source: "upsider", rows: ch }) }).then(function(r){
            tot.created += (r && r.created) || 0;
            tot.updated += (r && r.updated) || 0;
            tot.skipped += (r && r.skipped) || 0;
            ((r && r.months) || []).forEach(function(m){ tot.months[m] = 1; });
          });
        });
      }, Promise.resolve()).then(function(){ return tot; });
    }).then(function(tot){
      var ms = Object.keys(tot.months).sort();
      p2Status("カード明細を取り込みました：新規 " + tot.created + " ／ 更新 " + tot.updated + (tot.skipped ? " ／ 金額なし " + tot.skipped : "") + (ms.length ? "（" + ms[0] + " 〜 " + ms[ms.length - 1] + "）" : ""));
      p2s.open = true;
      p2s.month = ms[ms.length - 1] || p2s.month;
      p2s.data = null;
      p2StmtLoad();
    }).catch(function(err){
      sum.textContent = (err && err.message && !err.code) ? err.message : apiErrorMessage(err, "カード明細");
    });
  }
  function p2StmtNum(v, frac){
    if (v === "" || v == null) return null;
    var n = Number(String(v).replace(/[,¥￥\s]/g, ""));
    if (!isFinite(n)) return null;
    return frac ? n : Math.round(n);
  }
  function p2StmtDate(v){
    if (typeof v === "number" || /^\d{5}(\.\d+)?$/.test(String(v))){
      var n = Number(v);
      return (n > 20000 && n < 80000) ? new Date(Math.round((n - 25569) * 864e5)).toISOString().slice(0, 10) : "";
    }
    var m = String(v || "").match(/(\d{4})[\/\-年.](\d{1,2})[\/\-月.](\d{1,2})/);
    return m ? m[1] + "-" + ("0" + m[2]).slice(-2) + "-" + ("0" + m[3]).slice(-2) : "";
  }
  // シート／CSV の行配列（ヘッダ行を探してから読む。シートごとにヘッダを探し直す）
  function p2StmtRowsFromGrid(grid){
    var out = [], col = null;
    (grid || []).forEach(function(row){
      var cells = (row || []).map(function(c){ return c == null ? "" : String(c).trim(); });
      var isHead = cells.indexOf(P2S_HEAD.date) !== -1 && cells.indexOf(P2S_HEAD.txId) !== -1;
      if (isHead){
        col = {};
        Object.keys(P2S_HEAD).forEach(function(k){ col[k] = cells.indexOf(P2S_HEAD[k]); });
        return;
      }
      if (!col) return;
      var get = function(k){ return col[k] >= 0 ? row[col[k]] : ""; };
      var date = p2StmtDate(get("date"));
      var txId = String(get("txId") == null ? "" : get("txId")).trim();
      if (!date || !txId) return;
      out.push({
        date: date, merchant: String(get("merchant") || "").trim(), txId: txId,
        amountOut: p2StmtNum(get("amountOut")), amountIn: p2StmtNum(get("amountIn")),
        currency: String(get("currency") || "").trim(), fxAmount: p2StmtNum(get("fxAmount"), true),
        cardName: String(get("cardName") || "").trim(), holder: String(get("holder") || "").trim(),
        receiptCount: p2StmtNum(get("receiptCount"))
      });
    });
    return out;
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
      var rows = [];
      wb.SheetNames.forEach(function(name){
        rows = rows.concat(p2StmtRowsFromGrid(X.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: "" })));
      });
      return rows;
    });
  }
  function p2StmtReadCsv(file){
    return file.arrayBuffer().then(function(buf){
      var text;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); }
      catch(e){ text = new TextDecoder("shift_jis").decode(buf); }
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

  /* ---- 受領チェックに出ていない仕分け（差出人がベンダー未一致）の手当て ----
     payments/{threadId} に vendorId（＋任意で支払月）をセット＝ベンダーに紐づけ、
     または notPayable=true＝請求書ではないので受領チェックから外す（「戻す」で復帰）。 */
  function p2RenderUnlinked(){
    var wrap = p2El("pay2-unlinked");
    if (!wrap) return;
    var list = p2.unlinked || [];
    var exList = p2.unlinkedExcluded || [];
    wrap.hidden = (p2.tab !== "detail") || (!list.length && !exList.length);
    var sum = p2El("pay2-unlinked-sum");
    if (sum) sum.textContent = (list.length || exList.length)
      ? (list.length + " 件（差出人からベンダーを特定できず受領実績に出ていません。紐づけ／対象外にできます）"
         + (exList.length ? " ／ 対象外 " + exList.length + " 件" : ""))
      : "";
    var tgl = p2El("pay2-unlinked-toggle");
    if (tgl) tgl.setAttribute("aria-expanded", p2.unlinkedOpen ? "true" : "false");
    var dl = p2El("pay2-unlinked-vendorlist");
    if (dl) dl.innerHTML = p2.vendors.map(function(v){ return '<option value="' + escapeHtml(v.name || "") + '">'; }).join("");
    var body = p2El("pay2-unlinked-body");
    if (!body) return;
    if (!p2.unlinkedOpen || (!list.length && !exList.length)){ body.hidden = true; return; }
    body.hidden = false;

    var html = "";
    if (list.length){
      html +=
        '<table class="pay2-table"><thead><tr><th>件名 / 差出人</th><th>支払月</th><th>ベンダー</th><th></th></tr></thead><tbody>' +
        list.map(function(u){
          return '<tr data-thread="' + escapeHtml(u.threadId) + '">' +
            '<td><div class="strong">' + escapeHtml(String(u.subject || "(件名なし)").slice(0, 60)) + "</div>" +
              '<div class="pay2-muted">' + escapeHtml(String(u.from || "").slice(0, 44)) + "</div></td>" +
            '<td><input type="month" class="pay2-sel pay2-ul-month" value="' + escapeHtml(u.periodMonth || "") + '"></td>' +
            '<td><input class="pay2-q pay2-ul-vendor" list="pay2-unlinked-vendorlist" placeholder="ベンダー名" autocomplete="off"></td>' +
            '<td class="nowrap"><button type="button" class="pay2-tool-btn pay2-ul-go">紐づけ</button> ' +
              '<button type="button" class="pay2-tool-btn pay2-ul-skip">対象外</button></td>' +
            "</tr>";
        }).join("") + "</tbody></table>";
    }
    if (exList.length){
      html += '<div class="pay2-muted" style="padding:10px 4px 4px">対象外にしたメール（請求書ではない）</div>' +
        '<table class="pay2-table"><tbody>' +
        exList.map(function(u){
          return '<tr data-thread="' + escapeHtml(u.threadId) + '" class="pay2-row-excluded">' +
            '<td><div class="strong">' + escapeHtml(String(u.subject || "(件名なし)").slice(0, 60)) + "</div>" +
              '<div class="pay2-muted">' + escapeHtml(String(u.from || "").slice(0, 44)) + "</div></td>" +
            '<td class="nowrap"><button type="button" class="pay2-tool-btn pay2-ul-restore">戻す</button></td>' +
            "</tr>";
        }).join("") + "</tbody></table>";
    }
    body.innerHTML = html;

    body.querySelectorAll(".pay2-ul-go").forEach(function(btn){
      btn.addEventListener("click", function(){
        var tr = btn.closest("tr");
        var name = tr.querySelector(".pay2-ul-vendor").value.trim();
        var month = tr.querySelector(".pay2-ul-month").value;
        var v = p2VendorByName(name);
        if (!v){ p2Status("「" + name + "」に一致するベンダーがありません。先にベンダーマスタで登録してください。", "err"); return; }
        p2PostLink(tr.getAttribute("data-thread"), { vendorId: v.id, linkMonth: month || "" }, btn, "紐づけ");
      });
    });
    body.querySelectorAll(".pay2-ul-skip").forEach(function(btn){
      btn.addEventListener("click", function(){
        p2PostLink(btn.closest("tr").getAttribute("data-thread"), { notPayable: true }, btn, "対象外");
      });
    });
    body.querySelectorAll(".pay2-ul-restore").forEach(function(btn){
      btn.addEventListener("click", function(){
        p2PostLink(btn.closest("tr").getAttribute("data-thread"), { notPayable: false }, btn, "戻す");
      });
    });
  }
  function p2PostLink(threadId, payload, btn, label){
    if (btn){ btn.disabled = true; btn.textContent = "…"; }
    apiFetch("/api/payables/link", { method: "POST", body: JSON.stringify(Object.assign({ threadId: threadId }, payload)) })
      .then(function(){ p2Load(); })
      .catch(function(err){
        p2Status(apiErrorMessage(err, label || "紐づけ"), "err");
        if (btn){ btn.disabled = false; btn.textContent = label || "紐づけ"; }
      });
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
      p2Field("p2f-amountExcl", "税抜", "number", r.amountExcl) +
      p2Field("p2f-tax", "消費税", "number", r.tax) +
      p2Field("p2f-amountIncl", "税込", "number", r.amountIncl) +
      '<div class="pay2-calc" id="p2f-calc"></div>' +
      p2Field("p2f-regNo", "インボイス登録番号", "text", r.regNo) +
      p2SelectField("p2f-qualified", "適格区分", PAY_QUALIFIED, r.qualified || "不明") +
      p2SelectField("p2f-method", "支払方式", PAY_METHODS, r.method || "その他") +
      '<div class="pay2-fld wide"><label>振込先</label></div>' +
      p2PayToFields("p2f-", r) +
      '<div class="pay2-fld wide" id="p2f-payto-check"></div>' +
      p2SelectField("p2f-reconciled", "SYSLEA照合", PAY_RECONCILED, r.reconciled || "未") +
      p2Field("p2f-sourceLink", "原本リンク", "text", r.sourceLink, true) +
      '<div class="pay2-fld wide"><label>備考</label><textarea id="p2f-note" rows="2">' + escapeHtml(r.note || "") + "</textarea></div>" +
      '<div class="pay2-fld-checks">' +
        '<label><input type="checkbox" id="p2f-checked"' + (r.checked ? " checked" : "") + "> 確認済</label>" +
        '<label><input type="checkbox" id="p2f-paid"' + (r.paid ? " checked" : "") + "> 支払済</label>" +
        '<label><input type="checkbox" id="p2f-filed"' + (r.filed ? " checked" : "") + "> 済フォルダ移動</label>" +
        '<label><input type="checkbox" id="p2f-payToChecked"' + (r.payToChecked ? " checked" : "") + "> 口座を確認した</label>" +
        '<label><input type="checkbox" id="p2f-excluded"' + (r.excluded ? " checked" : "") + "> 支払対象外（請求書ではない）</label>" +
      "</div>" +
      "</div>";
    p2El("pay2-edit-body").innerHTML = body;
    p2El("pay2-edit-error").hidden = true;
    p2El("pay2-edit-modal").hidden = false;
    p2El("pay2-edit-form").scrollTop = 0;
    document.body.style.overflow = "hidden";

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

    // ベンダーが確定したら未入力欄を既定値で補完（方式＋いつもの振込先）
    function fillFromVendor(v){
      if (!v) return;
      if (!p2El("p2f-vendorName").value.trim()) p2El("p2f-vendorName").value = v.name || "";
      if (!p2El("p2f-method").value || p2El("p2f-method").value === "その他") p2El("p2f-method").value = v.defaultMethod || "その他";
      P2_PAYTO_KEYS.forEach(function(k){
        var el = p2El("p2f-" + k);
        if (el && !el.value && v[k]) el.value = v[k];
      });
      p2RenderPayToCheck();
    }
    p2El("p2f-vendorName").addEventListener("change", function(){
      fillFromVendor(p2VendorByName(this.value)); p2RenderPayToCheck();
    });
    // メールアドレス一致を優先（差出人アドレス → ベンダーマスタの emails）
    p2El("p2f-fromEmail").addEventListener("change", function(){
      fillFromVendor(p2VendorByEmail(this.value)); p2RenderPayToCheck();
    });

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
      } else if (pNum && pNum !== vNum){
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
      var vv = p2.vendors.filter(function(x){ return x.id === vid; })[0];
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
    p2RenderPayToCheck();

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
  function p2CloseEdit(){ p2El("pay2-edit-modal").hidden = true; document.body.style.overflow = ""; }

  function p2NumOrNull(id){
    var v = p2El(id).value;
    if (v === "" || v == null) return null;
    var n = Math.round(Number(String(v).replace(/[,\s¥]/g, "")));
    return isFinite(n) ? n : null;
  }
  function p2EditValues(){
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
      reconciled: p2El("p2f-reconciled").value,
      sourceLink: p2El("p2f-sourceLink").value.trim(),
      note: p2El("p2f-note").value.trim(),
      checked: p2El("p2f-checked").checked,
      paid: p2El("p2f-paid").checked,
      filed: p2El("p2f-filed").checked,
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
    if (!vals.vendorName && !vals.invoiceNo){
      var e = p2El("pay2-edit-error");
      e.hidden = false; e.textContent = "ベンダー名か請求書番号のどちらかは入力してください。";
      return;
    }
    var btn = p2El("pay2-edit-save");
    btn.disabled = true; btn.textContent = "保存中…";
    var path = p2.editId ? "/api/payables/payables/" + encodeURIComponent(p2.editId) : "/api/payables/payables";
    apiFetch(path, { method: p2.editId ? "PUT" : "POST", body: JSON.stringify(vals) }).then(function(res){
      var saved = res && res.payable;
      if (p2.editId){
        p2.payables = p2.payables.map(function(x){ return x.id === p2.editId ? saved : x; });
      } else {
        p2.payables.unshift(saved);
      }
      p2CloseEdit();
      p2RenderAll();
      p2CountStatus();
    }).catch(function(err){
      var e2 = p2El("pay2-edit-error");
      e2.hidden = false; e2.textContent = apiErrorMessage(err, "請求書管理");
    }).finally(function(){ btn.disabled = false; btn.textContent = "保存"; });
  }
  function p2DeleteEdit(){
    if (!p2.editId || !window.confirm("この請求書を台帳から削除します。よろしいですか？")) return;
    apiFetch("/api/payables/payables/" + encodeURIComponent(p2.editId), { method: "DELETE" }).then(function(){
      p2.payables = p2.payables.filter(function(x){ return x.id !== p2.editId; });
      p2CloseEdit();
      p2RenderAll();
      p2CountStatus();
    }).catch(function(err){
      var e = p2El("pay2-edit-error");
      e.hidden = false; e.textContent = apiErrorMessage(err, "請求書管理");
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
      p2Field("p2v-paymentTerms", "支払サイト（例：月末締め翌月末）", "text", d.paymentTerms, true) +
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
    var cadEl = p2El("p2v-cadence");
    cadEl.addEventListener("change", function(){
      var on = this.value === "everyN";
      p2El("p2v-cadence-n").hidden = !on;
      p2El("p2v-cadence-unit").hidden = !on;
    });
    p2El("pay2-vendor-error").hidden = true;
    p2El("pay2-vendor-modal").hidden = false;
    p2El("pay2-vendor-form").scrollTop = 0;
    document.body.style.overflow = "hidden";
  }
  function p2CloseVendor(){ p2El("pay2-vendor-modal").hidden = true; document.body.style.overflow = ""; }
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
    if (!vals.name){
      var e = p2El("pay2-vendor-error");
      e.hidden = false; e.textContent = "ベンダー名は必須です。";
      return;
    }
    var btn = p2El("pay2-vendor-save");
    btn.disabled = true; btn.textContent = "保存中…";
    var path = p2.vendId ? "/api/payables/vendors/" + encodeURIComponent(p2.vendId) : "/api/payables/vendors";
    apiFetch(path, { method: p2.vendId ? "PUT" : "POST", body: JSON.stringify(vals) }).then(function(res){
      var saved = res && res.vendor;
      if (p2.vendId){
        p2.vendors = p2.vendors.map(function(x){ return x.id === p2.vendId ? saved : x; });
      } else {
        p2.vendors.push(saved);
      }
      p2CloseVendor();
      p2RenderAll();
      p2CountStatus();
    }).catch(function(err){
      var e2 = p2El("pay2-vendor-error");
      e2.hidden = false; e2.textContent = apiErrorMessage(err, "請求書管理");
    }).finally(function(){ btn.disabled = false; btn.textContent = "保存"; });
  }
  function p2DeleteVendor(){
    if (!p2.vendId || !window.confirm("このベンダーを削除します。よろしいですか？")) return;
    apiFetch("/api/payables/vendors/" + encodeURIComponent(p2.vendId), { method: "DELETE" }).then(function(){
      p2.vendors = p2.vendors.filter(function(x){ return x.id !== p2.vendId; });
      p2CloseVendor();
      p2RenderAll();
      p2CountStatus();
    }).catch(function(err){
      var e = p2El("pay2-vendor-error");
      e.hidden = false; e.textContent = apiErrorMessage(err, "請求書管理");
    });
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
    if (p2q.dirty){ p2q.dirty = false; p2Load(); }
  }
  function p2QueueLoad(){
    if (p2q.loading) return;
    p2q.loading = true;
    p2El("pay2-import-error").hidden = true;
    p2El("pay2-queue-dismiss-junk").hidden = true;
    p2El("pay2-queue-sum").textContent = "Gmail と台帳を突き合わせ中…（数十秒かかることがあります）";
    p2El("pay2-import-list").innerHTML = "";
    apiFetch("/api/payables/queue").then(function(res){
      p2q.items = (res && res.items) || [];
      p2q.days = (res && res.days) || 60;
      p2q.truncated = !!(res && res.truncated);
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
      "（スレッド新着・入口外は直近" + p2q.days + "日" + (p2q.truncated ? "・件数が多いため先頭のみ" : "") + "）</span>";
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
      (it.sourceLink ? '<a class="pay2-q-open" href="' + escapeHtml(it.sourceLink) + '" target="_blank" rel="noopener">Gmail で開く ↗</a>' : "") +
      "</div>";
    h += '<div class="pay2-import-from">' + escapeHtml(it.from || "(差出人不明)") + "</div>";
    h += '<div class="pay2-q-subj">' + escapeHtml(it.subject || "(件名なし)") + "</div>";
    if (it.snippet) h += '<div class="pay2-q-snip">' + escapeHtml(it.snippet) + "</div>";
    if (rows.length){
      h += '<div class="pay2-q-thread">同じスレッドの台帳: ' + rows.map(function(r){
        return escapeHtml((r.vendorName || "?") + " " + (r.periodMonth || r.receivedDate || "") + " " + (r.method || ""));
      }).join(" ／ ") + "</div>";
    }
    h += '<div class="pay2-q-suggest">提案: ' + escapeHtml(P2Q_SUGGEST[sug] || sug) + "</div>";
    h += '<div class="pay2-q-form">' +
      '<input type="text" class="pay2-q-vendor" list="pay2-queue-vendors" placeholder="ベンダー" value="' + escapeHtml(it.vendorName || "") + '" aria-label="ベンダー">' +
      '<select class="pay2-q-method" aria-label="支払方式"><option value="">方式</option>' +
        P2Q_METHODS.map(function(m){ return '<option value="' + m + '"' + (m === it.method ? " selected" : "") + ">" + m + "</option>"; }).join("") +
      "</select>" +
      '<input type="month" class="pay2-q-month" value="' + escapeHtml(it.periodMonth || "") + '" aria-label="何月分" title="何月分">' +
      '<input type="text" class="pay2-q-amount" inputmode="numeric" placeholder="税込（任意）" aria-label="税込金額">' +
      '<input type="date" class="pay2-q-due" aria-label="支払期日" title="支払期日（任意）">' +
      "</div>";
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
  function p2QueueClick(e){
    var b = e.target && e.target.closest ? e.target.closest("button[data-act]") : null;
    if (!b) return;
    var card = b.closest(".pay2-q-item");
    if (card) p2QueueAct(Number(card.getAttribute("data-idx")), b.getAttribute("data-act"));
  }
  function p2QueueAct(idx, act){
    var it = p2q.items[idx];
    if (!it || it.done || it.busy) return Promise.resolve();
    var card = p2El("pay2-import-list").querySelector('.pay2-q-item[data-idx="' + idx + '"]');
    if (!card) return Promise.resolve();
    var msg = card.querySelector(".pay2-q-msg");
    var body = { action: act, messageId: it.messageId, threadId: it.threadId };
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
      msg.textContent = "✓ " + (P2Q_DONE[act] || act) + (res && res.label ? "（" + res.label.replace("01.payment/", "") + "）" : "");
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

  /* ---- 01.payment メールを走査してメールアドレスを補完 ----
     ①既存台帳行の空 fromEmail を補完 ②分類済み行のベンダー emails に追記
     ③台帳に無くても 差出人の表示名/ドメインがベンダー名に一致すれば emails に追記
     （1社に絞れたものだけ。フリーメール・曖昧は除外＝要目視）。冪等。 */
  function p2BackfillEmails(){
    if (!window.confirm("SYSLEA の 01.payment メールを全走査して、差出人メールアドレスをベンダーマスタ／既存の請求書行に追記します。\n\nベンダー名・エイリアス・ドメインで自動照合します（1社に絞れたものだけ・フリーメール／人名は対象外）。結果は必ずベンダーマスタの「メールアドレス」列を目視で確認してください。\n\n実行しますか？")) return;
    var btn = p2El("pay2-backfill-btn");
    btn.disabled = true; btn.textContent = "補完中…";
    p2Status("01.payment を走査中…（メール数によっては数十秒かかります）");
    apiFetch("/api/payables/backfill-emails", { method: "POST", body: "{}" }).then(function(res){
      res = res || {};
      var parts = [];
      if (res.emailsAdded) parts.push("ベンダー " + res.vendorsUpdated + " 社に " + res.emailsAdded + " アドレス追記");
      if (res.prunedEmails) parts.push("自社ドメイン " + res.prunedEmails + " 件を除去");
      if (res.filledPayables) parts.push("台帳 " + res.filledPayables + " 行に補完");
      if (!parts.length) parts.push("追記対象なし");
      var tail = [];
      if (res.ambiguousSenders) tail.push("複数社に一致 " + res.ambiguousSenders);
      if (res.unmatchedSenders) tail.push("未一致 " + res.unmatchedSenders);
      if (res.freeMailSkipped) tail.push("フリーメール/自社除外 " + res.freeMailSkipped);
      p2Status(
        "アドレス補完: " + parts.join(" ／ ") +
        "（差出人 " + (res.uniqueSenders || 0) + " 種 / 走査 " + (res.scannedMails || 0) + " 通" +
        (tail.length ? " ・ " + tail.join(" / ") : "") + "）。ベンダーマスタの「メールアドレス」列を目視確認してください。"
      );
      return apiFetch("/api/payables").then(function(r2){
        p2.payables = (r2 && r2.payables) || p2.payables;
        p2.vendors = (r2 && r2.vendors) || p2.vendors;
        p2.receipts = (r2 && r2.receipts) || p2.receipts;
        p2.receiptsUnattributed = (r2 && r2.receiptsUnattributed) || 0;
        p2.unlinked = (r2 && r2.receiptsUnattributedList) || p2.unlinked;
        p2.unlinkedExcluded = (r2 && r2.receiptsExcludedList) || p2.unlinkedExcluded;
        p2RenderAll();
      });
    }).catch(function(err){
      p2Status(apiErrorMessage(err, "アドレス補完"), "err");
    }).finally(function(){ btn.disabled = false; btn.textContent = "✉ アドレス補完"; });
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
      "p2f-amountIncl": "税込", "p2f-regNo": "登録番号", "p2f-payTo": "振込先"
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
      "p2f-regNo": f.regNo, "p2f-payTo": f.payTo
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
    if (warns.length) html += "<br>⚠ " + warns.map(escapeHtml).join("<br>⚠ ");
    html += '<br><span class="pay2-extract-hint">金額・日付・登録番号は必ず原本と突き合わせて確認してください。</span>';
    p2ExtractMsg(html, false, true);
  }

  // app.js の showView が初回ロード後に呼ぶエントリポイント。
  CP.initPayables = initPayables;
})();
