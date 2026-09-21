/* Cyber Portal — プライベート: サブスク管理(#view-subs) / 今月の収支(#view-finance)
   app.js 本体から分離したモジュール。どちらかの画面を初回に開いたときだけ app.js の
   loadMoneyModule() が <script> を注入してロードする(index.html にも sw.js の SHELL にも入れない)。
   データの正は家計簿スプレッドシート(/api/sheets/finance・/api/sheets/subscriptions)。
   計算だけの純関数(sub* / fin*)は app.js 側に残してあり(カレンダーのレイヤーとテストのミラーが使う)、
   ほかの本体ヘルパーと一緒に window.__CP から受け取る。 */
(function(){
  "use strict";
  var CP = window.__CP;
  if (!CP || !CP.apiFetch){
    console.error("[money] window.__CP 未初期化。app.money.js は app.js の後にのみロードされる想定です。");
    return;
  }
  var apiErrorMessage = CP.apiErrorMessage,
      apiFetch = CP.apiFetch,
      finCurrentMonth = CP.finCurrentMonth,
      finDayLabel = CP.finDayLabel,
      finMonthDaysLeft = CP.finMonthDaysLeft,
      finMonthLabel = CP.finMonthLabel,
      finShiftMonth = CP.finShiftMonth,
      finSignedYen = CP.finSignedYen,
      finYen = CP.finYen,
      jstDateKey = CP.jstDateKey,
      makeStatusSetter = CP.makeStatusSetter,
      startGoogleConnect = CP.startGoogleConnect,
      subCategoryOf = CP.subCategoryOf,
      subChargesInRange = CP.subChargesInRange,
      subDaysLabel = CP.subDaysLabel,
      subDaysUntil = CP.subDaysUntil,
      subEvery = CP.subEvery,
      subMonthlyAmount = CP.subMonthlyAmount,
      subNextDateLabel = CP.subNextDateLabel,
      subNextKey = CP.subNextKey,
      subNextParts = CP.subNextParts,
      subNorm = CP.subNorm,
      subTodayParts = CP.subTodayParts,
      subUnit = CP.subUnit,
      subWhenLabel = CP.subWhenLabel,
      subYen = CP.subYen,
      subYm = CP.subYm;

  /* ================= プライベート: サブスク管理 =================
     「今月の収支」と同じ家計簿スプレッドシートの「サブスク管理」タブが唯一の正。
     /api/sheets/subscriptions で全行の取得(GET)と全置換(PUT)を行う。
     モデル: { name, unit:"month"|"year", every, amount, day, month, note }
       ・unit×every で周期(月×1=毎月 / 月×3=四半期 / 月×6=半年 / 年×1=毎年 / 年×2=2年に1度)
       ・month は「毎年」または「2ヶ月以上おき」のときの基準月。毎月は day だけ。
     カードは次回課金日順に表示 + 月合計/年合計。管理モーダルは行エディタ。 */
  var subsState = [];
  var subsSetStatus = makeStatusSetter("pv-subs-status");
  var subsWired = false;
  var subsRows = [];            // 「まとめて編集」モーダルの作業コピー
  var subsFinanceRows = null;   // 家計簿との突合用（当月の明細。取れなければ null）
  var subRowEditIndex = -1;     // 1件編集モーダルが編集中の subsState インデックス（-1 = 新規）
  // 直前の読み込みが成功したか（2026/09/22）。保存はシートの全置換なので、読めていない（古い・空の）一覧で
  // 保存するとシートの行を消してしまう。失敗中は まとめて編集・＋追加・行の編集 を止め、保存も断る（contractsLoadOk と同じ考え方）
  var subsLoadOk = false;
  var SUBS_LOAD_NG_MSG = "読み込みに失敗しているため保存できません。再読み込みしてください。";

  // 一覧（次回課金日順）。行クリックで「その1件だけ」の編集モーダルを開く。
  function renderSubsList(active){
    var list = document.getElementById("pv-subs-list");
    if (!list) return;
    list.innerHTML = "";
    if (!active.length){
      list.innerHTML = '<div class="pv-habit-empty">「＋ 追加」からサブスクを登録してください。</div>';
      return;
    }
    var curYm = (function(){ var p = subTodayParts(); return subYm(p[0], p[1]); })();
    active.forEach(function(s){
      var days = subDaysUntil(s);
      var next = subNextParts(s);
      var row = document.createElement("div");
      row.className = "pv-sub-row" + (subYm(next.y, next.m) === curYm ? " is-thismonth" : "");
      row.tabIndex = 0; row.setAttribute("role", "button");

      var gut = document.createElement("span");
      gut.className = "pv-sub-gutter";
      var gd = document.createElement("span");
      gd.className = "pv-sub-date"; gd.textContent = subNextDateLabel(s);
      var gu = document.createElement("span");
      gu.className = "pv-sub-until" + (days <= 3 ? " is-soon" : "");
      gu.textContent = subDaysLabel(days);
      gut.appendChild(gd); gut.appendChild(gu);

      var main = document.createElement("span");
      main.className = "pv-sub-main";
      var line1 = document.createElement("span");
      line1.className = "pv-sub-line1";
      var name = document.createElement("span");
      name.className = "pv-sub-name"; name.textContent = s.name;
      line1.appendChild(name);
      var cat = subCategoryOf(s);
      if (cat){
        var chip = document.createElement("span");
        chip.className = "pv-sub-cat"; chip.textContent = cat;
        line1.appendChild(chip);
      }
      main.appendChild(line1);
      var meta = document.createElement("span");
      meta.className = "pv-sub-meta";
      meta.textContent = subWhenLabel(s) + (s.note ? " ・ " + s.note : "");
      meta.title = s.note || "";
      main.appendChild(meta);

      var amtWrap = document.createElement("span");
      amtWrap.className = "pv-sub-amtwrap";
      var amt = document.createElement("span");
      amt.className = "pv-sub-amount"; amt.textContent = subYen(s.amount);
      var per = document.createElement("span");
      per.className = "pv-sub-permonth";
      per.textContent = subEvery(s) === 1 && subUnit(s) === "month" ? "" : "月あたり " + subYen(subMonthlyAmount(s));
      amtWrap.appendChild(amt); amtWrap.appendChild(per);

      row.appendChild(gut); row.appendChild(main); row.appendChild(amtWrap);
      var open = function(){ openSubRowModal(subsState.indexOf(s)); };
      row.addEventListener("click", open);
      row.addEventListener("keydown", function(e){ if (e.key === "Enter" || e.key === " "){ e.preventDefault(); open(); } });
      list.appendChild(row);
    });
  }

  // 今月に来る課金（済み・これから を分けて表示）
  function renderSubsThisMonth(active){
    var listEl = document.getElementById("subs-month-list");
    var labelEl = document.getElementById("subs-month-label");
    if (!listEl) return { total: 0, count: 0, remaining: 0 };
    var p = subTodayParts();
    var ym = subYm(p[0], p[1]);
    if (labelEl) labelEl.textContent = p[1] + "月";
    var items = [];
    active.forEach(function(s){
      subChargesInRange(s, ym, 1).forEach(function(c){
        items.push({ sub: s, day: c.d, done: c.d < p[2] });
      });
    });
    items.sort(function(a, b){ return a.day - b.day; });
    listEl.innerHTML = "";
    if (!items.length){
      listEl.innerHTML = '<div class="pv-habit-empty">今月の課金はありません。</div>';
      return { total: 0, count: 0, remaining: 0, items: items };
    }
    var total = 0, remaining = 0;
    items.forEach(function(it){
      var amount = Number(it.sub.amount) || 0;
      total += amount;
      if (!it.done) remaining += amount;
      var row = document.createElement("div");
      row.className = "subs-month-row" + (it.done ? " is-done" : "");
      var d = document.createElement("span");
      d.className = "subs-month-day"; d.textContent = it.day + "日";
      var n = document.createElement("span");
      n.className = "subs-month-name"; n.textContent = it.sub.name;
      var a = document.createElement("span");
      a.className = "subs-month-amount"; a.textContent = subYen(amount);
      row.appendChild(d); row.appendChild(n); row.appendChild(a);
      listEl.appendChild(row);
    });
    var foot = document.createElement("div");
    foot.className = "subs-month-foot";
    foot.textContent = "合計 " + subYen(total) + (remaining > 0 ? " ・ 残り " + subYen(remaining) : " ・ 支払い済み");
    listEl.appendChild(foot);
    return { total: total, count: items.length, remaining: remaining, items: items };
  }

  // これから12ヶ月の課金額分布。年払いが重なる月が一目で分かるようにする。
  function renderSubsYear(active){
    var wrap = document.getElementById("subs-year-chart");
    if (!wrap) return;
    var p = subTodayParts();
    var fromYm = subYm(p[0], p[1]);
    var buckets = [];
    for (var i = 0; i < 12; i++){
      var idx = p[0] * 12 + (p[1] - 1) + i;
      buckets.push({ ym: subYm(Math.floor(idx / 12), (idx % 12) + 1), m: (idx % 12) + 1, total: 0 });
    }
    var byYm = Object.create(null);
    buckets.forEach(function(b){ byYm[b.ym] = b; });
    active.forEach(function(s){
      subChargesInRange(s, fromYm, 12).forEach(function(c){
        if (byYm[c.ym]) byYm[c.ym].total += Number(s.amount) || 0;
      });
    });
    var max = buckets.reduce(function(a, b){ return Math.max(a, b.total); }, 0);
    wrap.innerHTML = "";
    buckets.forEach(function(b, i){
      var col = document.createElement("div");
      col.className = "subs-year-col" + (i === 0 ? " is-current" : "");
      col.title = b.m + "月 " + subYen(b.total);
      var barWrap = document.createElement("span");
      barWrap.className = "subs-year-bar";
      var fill = document.createElement("span");
      fill.className = "subs-year-fill";
      fill.style.height = (max > 0 ? Math.max(2, (b.total / max) * 100) : 0) + "%";
      barWrap.appendChild(fill);
      var lbl = document.createElement("span");
      lbl.className = "subs-year-label"; lbl.textContent = b.m;
      col.appendChild(barWrap); col.appendChild(lbl);
      wrap.appendChild(col);
    });
    var peak = buckets.reduce(function(a, b){ return b.total > a.total ? b : a; }, buckets[0]);
    if (max > 0){
      var note = document.createElement("div");
      note.className = "subs-year-note";
      note.textContent = "最大は " + peak.m + "月 の " + subYen(peak.total);
      wrap.appendChild(note);
    }
  }

  /* 家計簿の「サブスク」カテゴリー実績と、この台帳の今月の請求を突き合わせる。
     ・台帳になさそうな支出 → 登録漏れ（or 備考にサービス名が無い）
     ・支払日を過ぎたのに実績が無い → 記帳漏れ（or 解約済みで台帳に残っている）
     家計簿が未設定・取得失敗のときはパネルごと隠す（ここは補助情報なので黙って落とす）。 */
  function renderSubsRecon(monthInfo){
    var card = document.getElementById("subs-recon-card");
    var body = document.getElementById("subs-recon");
    var note = document.getElementById("subs-recon-note");
    if (!card || !body) return;
    var rows = subsFinanceRows;
    if (!rows){ card.hidden = true; return; }
    var actual = rows.filter(function(r){ return r.type === "支出" && String(r.category || "").trim() === "サブスク"; });
    var actualTotal = actual.reduce(function(a, r){ return a + (Number(r.amount) || 0); }, 0);
    var p = subTodayParts();
    var items = (monthInfo && monthInfo.items) || [];

    // 家計簿の備考にサービス名が入っている / 逆に備考がサービス名の略のどちらでも拾う
    function matches(r, sub){
      var needle = subNorm(sub.name);
      var noteN = subNorm(r.note);
      if (!needle || !noteN) return false;
      return noteN.indexOf(needle) >= 0 || needle.indexOf(noteN) >= 0;
    }
    var unbooked = items.filter(function(it){
      if (it.day > p[2]) return false; // まだ支払日が来ていない
      return !actual.some(function(r){ return matches(r, it.sub); });
    });
    var unknown = actual.filter(function(r){
      return !items.some(function(it){ return matches(r, it.sub); });
    });

    card.hidden = false;
    if (note) note.textContent = p[1] + "月";
    body.innerHTML = "";
    var sum = document.createElement("div");
    sum.className = "subs-recon-sum";
    sum.textContent = "台帳の今月の請求 " + subYen(monthInfo ? monthInfo.total : 0)
      + " ／ 家計簿の「サブスク」実績 " + subYen(actualTotal) + "（" + actual.length + "件）";
    body.appendChild(sum);

    function block(title, list, render, emptyText){
      var b = document.createElement("div");
      b.className = "subs-recon-block";
      var h = document.createElement("div");
      h.className = "subs-recon-title";
      h.textContent = title + "（" + list.length + "）";
      b.appendChild(h);
      if (!list.length){
        var e = document.createElement("div");
        e.className = "subs-recon-ok"; e.textContent = emptyText;
        b.appendChild(e);
      } else {
        list.forEach(function(x){
          var r = document.createElement("div");
          r.className = "subs-recon-row";
          r.textContent = render(x);
          b.appendChild(r);
        });
      }
      body.appendChild(b);
    }
    block("家計簿に見当たらない", unbooked, function(it){
      return it.day + "日 ・ " + it.sub.name + " ・ " + subYen(it.sub.amount);
    }, "支払日を過ぎた課金はすべて記帳済みです。");
    block("台帳にないサブスク支出", unknown, function(r){
      return String(r.date).slice(5).replace("-", "/") + " ・ " + (r.note || "（備考なし）") + " ・ " + subYen(r.amount);
    }, "家計簿の「サブスク」支出はすべて台帳と対応しています。");

    var hint = document.createElement("p");
    hint.className = "fin-note";
    hint.textContent = "照合は家計簿の備考にサービス名が含まれているかで判定しています。";
    body.appendChild(hint);
  }

  function renderSubs(){
    var active = subsState.filter(function(s){ return (s.name || "").trim(); });
    active.sort(function(a, b){ return subNextKey(a) - subNextKey(b); });

    var kpis = document.getElementById("subs-kpis");
    var body = document.getElementById("subs-body");
    if (kpis) kpis.hidden = false;
    if (body) body.hidden = false;

    renderSubsList(active);
    var monthInfo = renderSubsThisMonth(active);
    renderSubsYear(active);

    var monthly = active.reduce(function(a, s){ return a + subMonthlyAmount(s); }, 0);
    var setTxt = function(id, v){ var el = document.getElementById(id); if (el) el.textContent = v; };
    setTxt("subs-kpi-month", subYen(monthly));
    setTxt("subs-kpi-year", subYen(monthly * 12));
    setTxt("subs-kpi-thismonth", subYen(monthInfo.total));
    setTxt("subs-kpi-thismonth-sub", monthInfo.count
      ? monthInfo.count + "件・残り " + subYen(monthInfo.remaining)
      : "課金なし");
    setTxt("subs-kpi-count", String(active.length));
    var cats = {};
    active.forEach(function(s){ var c = subCategoryOf(s); if (c) cats[c] = true; });
    var catKeys = Object.keys(cats);
    setTxt("subs-kpi-count-sub", catKeys.length ? catKeys.length + "カテゴリ" : "カテゴリ未設定");

    // 編集モーダルのカテゴリ候補
    var dl = document.getElementById("sub-category-options");
    if (dl){
      dl.innerHTML = "";
      catKeys.sort().forEach(function(c){
        var o = document.createElement("option"); o.value = c; dl.appendChild(o);
      });
    }
    renderSubsRecon(monthInfo);
  }

  async function loadSubs(){
    var mngBtn = document.getElementById("pv-subs-manage");
    var addBtn = document.getElementById("pv-subs-add");
    var kpis = document.getElementById("subs-kpis");
    var body = document.getElementById("subs-body");
    var recon = document.getElementById("subs-recon-card");
    subsSetStatus("読み込み中…");
    try {
      var res = await apiFetch("/api/sheets/subscriptions");
      if (!res || res.configured === false){
        subsLoadOk = false;
        subsState = [];
        if (kpis) kpis.hidden = true;
        if (body) body.hidden = true;
        if (recon) recon.hidden = true;
        if (mngBtn) mngBtn.hidden = true;
        if (addBtn) addBtn.hidden = true;
        subsSetStatus("設定 → 家計簿スプレッドシート に共有 URL を登録すると使えます。");
        return;
      }
      subsState = res.subscriptions || [];
      subsLoadOk = true;
      if (mngBtn) mngBtn.hidden = false;
      if (addBtn) addBtn.hidden = false;
      // 突合用に家計簿の当月明細も取る（失敗しても本体は出す）
      try {
        var fin = await apiFetch("/api/sheets/finance");
        subsFinanceRows = (fin && fin.configured !== false && Array.isArray(fin.rows)) ? fin.rows : null;
      } catch(e){ subsFinanceRows = null; }
      renderSubs();
      subsSetStatus("");
    } catch(err){
      // 以前はここで まとめて編集 を出していて、空・古い一覧のまま保存するとシートを消せた
      subsLoadOk = false;
      if (mngBtn) mngBtn.hidden = true;
      if (addBtn) addBtn.hidden = true;
      subsSetStatus(apiErrorMessage(err, "サブスク") || "取得に失敗しました", true);
    }
  }

  function newSubRow(){
    return { name: "", amount: "", unit: "month", every: 1, month: (new Date().getMonth() + 1), day: 1, note: "", category: "" };
  }
  // r.unit / r.every に応じて「月」入力の表示可否を切り替える(毎年 or 2ヶ月以上おき で表示)。
  function subsRowSyncMonth(r, moEl){
    var need = (r.unit === "year") || (Math.round(Number(r.every) || 1) > 1);
    moEl.hidden = !need;
  }
  function renderSubsRows(){
    var wrap = document.getElementById("subs-rows");
    if (!wrap) return;
    wrap.innerHTML = "";
    if (!subsRows.length){
      wrap.innerHTML = '<p class="pv-habit-empty">「＋ 追加」でサブスクを追加してください。</p>';
      return;
    }
    subsRows.forEach(function(r, idx){
      var box = document.createElement("div");
      box.className = "subs-row";
      // 1行目: 名前 + 削除
      var l1 = document.createElement("div"); l1.className = "subs-row-line";
      var nm = document.createElement("input");
      nm.type = "text"; nm.maxLength = 80; nm.placeholder = "サービス名"; nm.value = r.name || "";
      nm.className = "subs-in subs-in-name";
      nm.addEventListener("input", function(){ r.name = nm.value; });
      var del = document.createElement("button");
      del.type = "button"; del.className = "subs-row-del"; del.setAttribute("aria-label", "削除");
      del.textContent = "✕";
      del.addEventListener("click", function(){ subsRows.splice(idx, 1); renderSubsRows(); });
      l1.appendChild(nm); l1.appendChild(del);
      // 2行目: 金額 + 「N」ごとに「月/年」 + 基準月 + 支払日
      var l2 = document.createElement("div"); l2.className = "subs-row-line";
      var amt = document.createElement("input");
      amt.type = "number"; amt.min = "0"; amt.step = "1"; amt.placeholder = "金額"; amt.value = r.amount === "" ? "" : r.amount;
      amt.className = "subs-in subs-in-amt";
      amt.addEventListener("input", function(){ r.amount = amt.value; });
      var every = document.createElement("input");
      every.type = "number"; every.min = "1"; every.max = "120"; every.placeholder = "N"; every.value = r.every || 1;
      every.className = "subs-in subs-in-every";
      var unit = document.createElement("select");
      unit.className = "subs-in subs-in-unit";
      unit.innerHTML = '<option value="month">ヶ月ごと</option><option value="year">年ごと</option>';
      unit.value = r.unit === "year" ? "year" : "month";
      var mo = document.createElement("select");
      mo.className = "subs-in subs-in-mo";
      var moHtml = "";
      for (var mm = 1; mm <= 12; mm++) moHtml += '<option value="' + mm + '">' + mm + '月</option>';
      mo.innerHTML = moHtml;
      mo.value = String(Math.min(12, Math.max(1, Number(r.month) || (new Date().getMonth() + 1))));
      mo.addEventListener("change", function(){ r.month = mo.value; });
      var dy = document.createElement("input");
      dy.type = "number"; dy.min = "1"; dy.max = "31"; dy.placeholder = "日"; dy.value = r.day || 1;
      dy.className = "subs-in subs-in-dy";
      dy.addEventListener("input", function(){ r.day = dy.value; });
      var dTxt = document.createElement("span"); dTxt.className = "subs-unit-txt"; dTxt.textContent = "日";
      every.addEventListener("input", function(){ r.every = every.value; subsRowSyncMonth(r, mo); });
      unit.addEventListener("change", function(){ r.unit = unit.value; subsRowSyncMonth(r, mo); });
      subsRowSyncMonth(r, mo);
      l2.appendChild(amt); l2.appendChild(every); l2.appendChild(unit); l2.appendChild(mo); l2.appendChild(dy); l2.appendChild(dTxt);
      box.appendChild(l1); box.appendChild(l2);
      // 3行目: カテゴリ + 備考(どちらも任意)
      var l3 = document.createElement("div"); l3.className = "subs-row-line";
      var catIn = document.createElement("input");
      catIn.type = "text"; catIn.maxLength = 40; catIn.placeholder = "カテゴリ(任意)"; catIn.value = r.category || "";
      catIn.className = "subs-in subs-in-cat";
      catIn.setAttribute("list", "sub-category-options");
      catIn.addEventListener("input", function(){ r.category = catIn.value; });
      var note = document.createElement("input");
      note.type = "text"; note.maxLength = 500; note.placeholder = "備考(任意)"; note.value = r.note || "";
      note.className = "subs-in subs-in-note";
      note.addEventListener("input", function(){ r.note = note.value; });
      l3.appendChild(catIn); l3.appendChild(note);
      box.appendChild(l3);
      wrap.appendChild(box);
    });
  }
  function openSubsModal(){
    var modal = document.getElementById("subs-modal");
    if (!modal) return;
    if (!subsLoadOk){ subsSetStatus(SUBS_LOAD_NG_MSG, true); return; }
    subsRows = subsState.map(function(s){
      return {
        name: s.name || "",
        amount: (s.amount === 0 || s.amount) ? s.amount : "",
        unit: s.unit === "year" ? "year" : "month",
        every: Math.min(120, Math.max(1, Number(s.every) || 1)),
        month: Number(s.month) || (new Date().getMonth() + 1),
        day: Math.min(31, Math.max(1, Number(s.day) || 1)),
        note: s.note || "",
        category: s.category || ""
      };
    });
    if (!subsRows.length) subsRows.push(newSubRow());
    var err = document.getElementById("subs-form-error");
    if (err){ err.hidden = true; err.textContent = ""; }
    renderSubsRows();
    modal.hidden = false;
    document.body.style.overflow = "hidden";
  }
  function closeSubsModal(){
    var modal = document.getElementById("subs-modal");
    if (modal) modal.hidden = true;
    document.body.style.overflow = "";
  }
  // 1行ぶんを API に渡す形へ正規化する（まとめて編集・1件編集の両方で使う）
  function cleanSubRow(r){
    var unit = r.unit === "year" ? "year" : "month";
    var every = Math.min(120, Math.max(1, Math.round(Number(r.every) || 1)));
    var needMonth = (unit === "year") || (every > 1);
    return {
      name: String(r.name).trim().slice(0, 80),
      amount: Math.max(0, Math.round(Number(r.amount) || 0)),
      unit: unit,
      every: every,
      day: Math.min(31, Math.max(1, Number(r.day) || 1)),
      month: needMonth ? Math.min(12, Math.max(1, Number(r.month) || (new Date().getMonth() + 1))) : null,
      note: String(r.note || "").trim().slice(0, 500),   // サーバーの上限に合わせる（以前は 200 で切っていた）
      category: String(r.category || "").trim().slice(0, 40)
    };
  }
  // シートは全置換なので、1件編集でも常に全件を送る。
  // 読み込みに失敗している間は送らない。空の一覧はサーバーが 400 で断るので、
  // 利用者が最後の1件を消したとき（allowEmpty）だけ X-Allow-Empty: 1 を付ける
  async function putSubs(list, allowEmpty){
    if (!subsLoadOk) throw new Error(SUBS_LOAD_NG_MSG);
    await apiFetch("/api/sheets/subscriptions", {
      method: "PUT",
      headers: (!list.length && allowEmpty) ? { "X-Allow-Empty": "1" } : {},
      body: JSON.stringify({ subscriptions: list })
    });
    await loadSubs(); // シート(正)から取り直す
  }

  async function saveSubs(){
    var err = document.getElementById("subs-form-error");
    var cleaned = subsRows
      .filter(function(r){ return (r.name || "").trim(); })
      .map(cleanSubRow);
    if (!subsLoadOk){ if (err){ err.hidden = false; err.textContent = SUBS_LOAD_NG_MSG; } return; }
    // 全部の行を消して保存＝全件削除。元が空なら送るものは無い。元に行があるなら確かめてから空で送る
    if (!cleaned.length){
      if (!subsState.length){ closeSubsModal(); return; }
      if (!window.confirm("サブスクをすべて削除します（" + subsState.length + "件）。よろしいですか？")) return;
    }
    var saveBtn = document.getElementById("subs-save");
    if (saveBtn) saveBtn.disabled = true;
    try {
      await putSubs(cleaned, true);
      closeSubsModal();
    } catch(e){
      if (err){ err.hidden = false; err.textContent = apiErrorMessage(e, "サブスク") || "保存に失敗しました"; }
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  /* ---- 1件だけ編集するモーダル（一覧の行クリック / ＋追加） ---- */
  function subRowSyncForm(){
    var unit = document.getElementById("sub-row-unit");
    var every = document.getElementById("sub-row-every");
    var moWrap = document.getElementById("sub-row-month-wrap");
    var preview = document.getElementById("sub-row-preview");
    if (!unit || !every || !moWrap) return;
    var need = unit.value === "year" || Math.round(Number(every.value) || 1) > 1;
    moWrap.hidden = !need;
    if (preview){
      var draft = {
        unit: unit.value,
        every: every.value,
        month: document.getElementById("sub-row-month").value,
        day: document.getElementById("sub-row-day").value
      };
      var days = subDaysUntil(draft);
      preview.textContent = subWhenLabel(draft) + " ・ 次回 " + subNextDateLabel(draft) + "（" + subDaysLabel(days) + "）";
    }
  }
  function openSubRowModal(index){
    var modal = document.getElementById("sub-row-modal");
    if (!modal) return;
    if (!subsLoadOk){ subsSetStatus(SUBS_LOAD_NG_MSG, true); return; }   // 読み込み失敗中は行を押しても開かない
    subRowEditIndex = (index != null && index >= 0) ? index : -1;
    var noteEl = document.getElementById("sub-row-note");
    if (noteEl) noteEl.maxLength = 500;   // index.html の maxlength=200 をサーバーの上限に合わせる
    var s = subRowEditIndex >= 0 ? subsState[subRowEditIndex] : null;
    var nowMonth = subTodayParts()[1];
    var moSel = document.getElementById("sub-row-month");
    if (moSel && !moSel.options.length){
      var html = "";
      for (var m = 1; m <= 12; m++) html += '<option value="' + m + '">' + m + '月</option>';
      moSel.innerHTML = html;
    }
    document.getElementById("sub-row-modal-title").textContent = s ? "サブスクを編集" : "サブスクを追加";
    document.getElementById("sub-row-name").value = s ? (s.name || "") : "";
    document.getElementById("sub-row-amount").value = s && (s.amount === 0 || s.amount) ? s.amount : "";
    document.getElementById("sub-row-unit").value = s && s.unit === "year" ? "year" : "month";
    document.getElementById("sub-row-every").value = s ? subEvery(s) : 1;
    if (moSel) moSel.value = String(s && Number(s.month) ? Math.min(12, Math.max(1, Number(s.month))) : nowMonth);
    document.getElementById("sub-row-day").value = s ? Math.min(31, Math.max(1, Number(s.day) || 1)) : 1;
    document.getElementById("sub-row-category").value = s ? (s.category || "") : "";
    document.getElementById("sub-row-note").value = s ? (s.note || "") : "";
    var del = document.getElementById("sub-row-delete");
    if (del) del.hidden = !s;
    var err = document.getElementById("sub-row-error");
    if (err){ err.hidden = true; err.textContent = ""; }
    subRowSyncForm();
    modal.hidden = false;
    document.body.style.overflow = "hidden";
    document.getElementById("sub-row-name").focus();
  }
  function closeSubRowModal(){
    var modal = document.getElementById("sub-row-modal");
    if (modal) modal.hidden = true;
    document.body.style.overflow = "";
    subRowEditIndex = -1;
  }
  async function submitSubRow(remove){
    var err = document.getElementById("sub-row-error");
    var saveBtn = document.getElementById("sub-row-save");
    var delBtn = document.getElementById("sub-row-delete");
    function showErr(msg){ if (err){ err.hidden = false; err.textContent = msg; } }
    if (err){ err.hidden = true; err.textContent = ""; }
    if (!subsLoadOk){ showErr(SUBS_LOAD_NG_MSG); return; }

    var list = subsState.map(cleanSubRow);
    if (remove){
      if (subRowEditIndex < 0) return;
      list.splice(subRowEditIndex, 1);
    } else {
      var draft = cleanSubRow({
        name: document.getElementById("sub-row-name").value,
        amount: document.getElementById("sub-row-amount").value,
        unit: document.getElementById("sub-row-unit").value,
        every: document.getElementById("sub-row-every").value,
        month: document.getElementById("sub-row-month").value,
        day: document.getElementById("sub-row-day").value,
        category: document.getElementById("sub-row-category").value,
        note: document.getElementById("sub-row-note").value
      });
      if (!draft.name){ showErr("サービス名を入力してください。"); return; }
      if (subRowEditIndex >= 0) list[subRowEditIndex] = draft;
      else list.push(draft);
    }
    if (saveBtn) saveBtn.disabled = true;
    if (delBtn) delBtn.disabled = true;
    try {
      await putSubs(list, !!remove);   // 削除ボタンで最後の1件を消したときだけ空の一覧を送ってよい
      closeSubRowModal();
    } catch(e){
      showErr(apiErrorMessage(e, "サブスク") || "保存に失敗しました");
    } finally {
      if (saveBtn) saveBtn.disabled = false;
      if (delBtn) delBtn.disabled = false;
    }
  }
  function wireSubs(){
    if (subsWired) return;
    subsWired = true;
    var mng = document.getElementById("pv-subs-manage");
    if (mng) mng.addEventListener("click", openSubsModal);
    var add = document.getElementById("subs-add");
    if (add) add.addEventListener("click", function(){ subsRows.push(newSubRow()); renderSubsRows(); });
    var cancel = document.getElementById("subs-cancel");
    if (cancel) cancel.addEventListener("click", closeSubsModal);
    var close = document.getElementById("subs-modal-close");
    if (close) close.addEventListener("click", closeSubsModal);
    var modal = document.getElementById("subs-modal");
    if (modal) modal.addEventListener("click", function(e){ if (e.target === modal) closeSubsModal(); });
    var form = document.getElementById("subs-form");
    if (form) form.addEventListener("submit", function(e){ e.preventDefault(); saveSubs(); });

    // 1件編集モーダル
    var addOne = document.getElementById("pv-subs-add");
    if (addOne) addOne.addEventListener("click", function(){ openSubRowModal(-1); });
    var rModal = document.getElementById("sub-row-modal");
    if (rModal) rModal.addEventListener("click", function(e){ if (e.target === rModal) closeSubRowModal(); });
    var rClose = document.getElementById("sub-row-modal-close");
    if (rClose) rClose.addEventListener("click", closeSubRowModal);
    var rCancel = document.getElementById("sub-row-cancel");
    if (rCancel) rCancel.addEventListener("click", closeSubRowModal);
    var rForm = document.getElementById("sub-row-form");
    if (rForm) rForm.addEventListener("submit", function(e){ e.preventDefault(); submitSubRow(false); });
    var rDel = document.getElementById("sub-row-delete");
    if (rDel) rDel.addEventListener("click", function(){
      var s = subRowEditIndex >= 0 ? subsState[subRowEditIndex] : null;
      if (!s) return;
      if (window.confirm("「" + s.name + "」を削除します。よろしいですか？")) submitSubRow(true);
    });
    ["sub-row-unit", "sub-row-every", "sub-row-month", "sub-row-day"].forEach(function(id){
      var el = document.getElementById(id);
      if (el) el.addEventListener(el.tagName === "SELECT" ? "change" : "input", subRowSyncForm);
    });
  }

  /* ================= プライベート: 今月の収支 (v1b) =================
     バックエンド /api/sheets/finance が家計簿スプレッドシートの当月分(種別=収入/支出)を
     集計して返す。カテゴリーのカスケードは「家計簿マスタ」タブの内容(res.categories)を使い、
     取得できないときだけ下記フォールバックを使う。 */
  var FIN_FALLBACK_CATEGORIES = {
    "収入": ["給与", "利息", "配当"],
    "支出": ["飲食代", "サブスク", "医療費", "交通費", "保険料"],
    "貯蓄": ["生活防衛費", "車検"],
    "投資": ["日本株", "米国株", "iDeCo"]
  };
  var FIN_CIRC = 2 * Math.PI * 52; // ドーナツの円周 (r=52)
  var FIN_TYPES = ["収入", "支出", "貯蓄", "投資"];
  // 種別ごとの表示色。収入=アクセント / 支出=くすんだ茶 / 貯蓄・投資=薄アンバー。
  // 「色は意味があるときだけ」なので4色までに留め、カテゴリーの内訳は同色の濃淡で割る。
  var FIN_TYPE_COLOR = { "収入": "var(--accent)", "支出": "#a8836a", "貯蓄": "var(--violet)", "投資": "var(--violet)" };
  var FIN_TYPE_SLUG = { "収入": "income", "支出": "expense", "貯蓄": "save", "投資": "invest" };
  var financeCategories = null;
  var financeModalWired = false;
  var financeMonth = null;  // 表示中の月 "YYYY-MM"
  var financeData = null;   // 直近のレスポンス
  var financeCatType = "支出"; // 「カテゴリー別」で選択中の種別
  // 明細を編集中のときだけ入る { row, prev:{date,type,amount} }。
  // row はシートの実行番号、prev は書き込み前の照合用（行がずれていたら 409）。
  var financeEditRow = null;

  function finSetStatus(msg, showReconnect){
    var st = document.getElementById("pv-fin-status");
    var rc = document.getElementById("pv-fin-reconnect");
    if (st){ st.textContent = msg || ""; st.hidden = !msg; }
    if (rc) rc.hidden = !showReconnect;
  }

  function renderFinanceDonut(income, expense){
    var incArc = document.getElementById("pv-fin-arc-income");
    var expArc = document.getElementById("pv-fin-arc-expense");
    if (!incArc || !expArc) return;
    var total = income + expense;
    if (total <= 0){
      incArc.setAttribute("stroke-dasharray", "0 " + FIN_CIRC);
      expArc.setAttribute("stroke-dasharray", "0 " + FIN_CIRC);
      return;
    }
    var incLen = FIN_CIRC * (income / total);
    var expLen = FIN_CIRC * (expense / total);
    incArc.setAttribute("stroke-dasharray", incLen + " " + (FIN_CIRC - incLen));
    incArc.setAttribute("stroke-dashoffset", "0");
    expArc.setAttribute("stroke-dasharray", expLen + " " + (FIN_CIRC - expLen));
    expArc.setAttribute("stroke-dashoffset", String(-incLen));
  }

  /* 前月比のサブ行。当月を見ているときは前月の「同日まで」と比べる(月初に
     「前月比 −90%」と出るのを避けるため)。過去月は前月まるごとと比べる。 */
  function finDeltaLine(cur, prevVal, label, upIsGood){
    if (!(prevVal > 0)) return { text: label + " —", tone: "" };
    var d = cur - prevVal;
    var pct = Math.round((d / prevVal) * 100);
    var mark = d > 0 ? "▲" : (d < 0 ? "▼" : "±");
    var tone = "";
    if (d !== 0) tone = (d > 0) === !!upIsGood ? "is-good" : "is-bad";
    return {
      text: label + " " + finYen(prevVal) + " " + mark + Math.abs(pct) + "%",
      tone: tone
    };
  }
  function finSetSub(elId, info){
    var el = document.getElementById(elId);
    if (!el) return;
    el.textContent = info ? info.text : "";
    el.classList.remove("is-good", "is-bad");
    if (info && info.tone) el.classList.add(info.tone);
  }

  // 左カード: 4種別の金額バー(貯蓄・投資も出す。差引には入らない)
  function renderFinanceTypes(byType){
    var wrap = document.getElementById("fin-types");
    if (!wrap) return;
    wrap.innerHTML = "";
    var max = FIN_TYPES.reduce(function(a, t){ return Math.max(a, Number(byType[t]) || 0); }, 0);
    FIN_TYPES.forEach(function(t){
      var v = Number(byType[t]) || 0;
      var row = document.createElement("div");
      row.className = "fin-type-row is-" + FIN_TYPE_SLUG[t] + (v > 0 ? "" : " is-zero");
      var name = document.createElement("span");
      name.className = "fin-type-name"; name.textContent = t;
      var bar = document.createElement("span");
      bar.className = "fin-type-bar";
      var fill = document.createElement("span");
      fill.className = "fin-type-fill";
      fill.style.width = (max > 0 ? (v / max) * 100 : 0) + "%";
      fill.style.background = FIN_TYPE_COLOR[t];
      bar.appendChild(fill);
      var amt = document.createElement("span");
      amt.className = "fin-type-amount"; amt.textContent = finYen(v);
      row.appendChild(name); row.appendChild(bar); row.appendChild(amt);
      wrap.appendChild(row);
    });
  }

  // 右カード: 選択中の種別をカテゴリー別に割る。色は種別色の濃淡だけで足りる。
  function renderFinanceCats(){
    var tabsEl = document.getElementById("fin-cat-tabs");
    var barEl = document.getElementById("fin-catbar");
    var listEl = document.getElementById("fin-catlist");
    if (!tabsEl || !barEl || !listEl) return;
    var rows = (financeData && financeData.rows) || [];
    var byType = (financeData && financeData.byType) || {};

    // タブ: 金額のある種別だけ。選択中が空になったら金額の大きい方へ寄せる。
    var avail = FIN_TYPES.filter(function(t){ return (Number(byType[t]) || 0) > 0; });
    if (!avail.length) avail = ["支出"];
    if (avail.indexOf(financeCatType) < 0) financeCatType = avail[0];
    tabsEl.innerHTML = "";
    avail.forEach(function(t){
      var b = document.createElement("button");
      b.type = "button";
      b.className = "fin-cat-tab" + (t === financeCatType ? " is-active" : "");
      b.textContent = t;
      b.addEventListener("click", function(){ financeCatType = t; renderFinanceCats(); });
      tabsEl.appendChild(b);
    });

    var map = Object.create(null);
    var total = 0;
    rows.forEach(function(r){
      if (r.type !== financeCatType) return;
      var k = (r.category || "").trim() || "未分類";
      map[k] = (map[k] || 0) + (Number(r.amount) || 0);
      total += Number(r.amount) || 0;
    });
    var items = Object.keys(map).map(function(k){ return { name: k, amount: map[k] }; })
      .sort(function(a, b){ return b.amount - a.amount; });

    barEl.innerHTML = "";
    listEl.innerHTML = "";
    if (!items.length || total <= 0){
      listEl.innerHTML = '<div class="pv-habit-empty">' + financeCatType + 'の記録がありません。</div>';
      return;
    }
    var base = FIN_TYPE_COLOR[financeCatType];
    items.forEach(function(it, i){
      var pct = (it.amount / total) * 100;
      var op = Math.max(0.28, 1 - i * 0.16); // 大きい順に薄くしていく
      var seg = document.createElement("span");
      seg.className = "fin-catbar-seg";
      seg.style.width = pct + "%";
      seg.style.background = base;
      seg.style.opacity = String(op);
      seg.title = it.name + " " + finYen(it.amount);
      barEl.appendChild(seg);

      var row = document.createElement("div");
      row.className = "fin-cat-row";
      var dot = document.createElement("span");
      dot.className = "fin-cat-dot";
      dot.style.background = base; dot.style.opacity = String(op);
      var name = document.createElement("span");
      name.className = "fin-cat-name"; name.textContent = it.name;
      var pctEl = document.createElement("span");
      pctEl.className = "fin-cat-pct"; pctEl.textContent = (pct < 1 ? "<1" : Math.round(pct)) + "%";
      var amt = document.createElement("span");
      amt.className = "fin-cat-amount"; amt.textContent = finYen(it.amount);
      row.appendChild(dot); row.appendChild(name); row.appendChild(pctEl); row.appendChild(amt);
      listEl.appendChild(row);
    });
  }

  // 下: 当月の明細（新しい順）。追加した取引をその場で確認できるようにするのが主目的。
  function renderFinanceTx(){
    var listEl = document.getElementById("fin-tx-list");
    var countEl = document.getElementById("fin-tx-count");
    var card = document.getElementById("fin-tx-card");
    if (!listEl) return;
    var rows = (financeData && financeData.rows) || [];
    if (card) card.hidden = false;
    var editable = rows.length && rows[0].row;
    // サーバーは明細を 600 件で打ち切る(合計額は全件で計算済み)。切れたことを隠さない。
    var total = financeData && financeData.count != null ? financeData.count : rows.length;
    var cut = financeData && financeData.truncated;
    if (countEl) countEl.textContent = rows.length
      ? (cut ? total + "件中 " + rows.length + "件を表示" : rows.length + "件")
        + (editable ? " ・ 行をクリックで編集" : "")
      : "";
    listEl.innerHTML = "";
    if (!rows.length){
      listEl.innerHTML = '<div class="pv-habit-empty">この月の取引はまだありません。</div>';
      return;
    }
    rows.forEach(function(r){
      var row = document.createElement("div");
      row.className = "fin-tx-row";
      // 行番号(r.row)がある＝編集できる行。古いバックエンドのレスポンスには無いので
      // その場合は従来どおり読み取り専用のまま出す。
      if (r.row){
        row.classList.add("is-editable");
        row.tabIndex = 0;
        row.setAttribute("role", "button");
        row.title = "クリックで編集";
        var openEdit = function(){ openFinanceModal(r); };
        row.addEventListener("click", openEdit);
        row.addEventListener("keydown", function(e){
          if (e.key === "Enter" || e.key === " "){ e.preventDefault(); openEdit(); }
        });
      }
      var date = document.createElement("span");
      date.className = "fin-tx-date"; date.textContent = finDayLabel(r.date);
      var type = document.createElement("span");
      type.className = "fin-tx-type is-" + (FIN_TYPE_SLUG[r.type] || "expense");
      type.textContent = r.type;
      var cat = document.createElement("span");
      cat.className = "fin-tx-cat"; cat.textContent = (r.category || "").trim() || "未分類";
      var note = document.createElement("span");
      note.className = "fin-tx-note"; note.textContent = r.note || "";
      note.title = r.note || "";
      var amt = document.createElement("span");
      amt.className = "fin-tx-amount is-" + (FIN_TYPE_SLUG[r.type] || "expense");
      amt.textContent = finYen(r.amount);
      row.appendChild(date); row.appendChild(type); row.appendChild(cat);
      row.appendChild(note); row.appendChild(amt);
      listEl.appendChild(row);
    });
  }

  function renderFinanceMonthNav(){
    var label = document.getElementById("fin-month-label");
    var next = document.getElementById("fin-month-next");
    var today = document.getElementById("fin-month-today");
    var cur = finCurrentMonth();
    var shown = financeMonth || cur;
    if (label) label.textContent = finMonthLabel(shown);
    var isCurrent = shown === cur;
    // 未来日の取引を追加すると financeMonth が翌月以降になりうるので `>=` で止める
    if (next) next.disabled = shown >= cur;
    if (today) today.hidden = isCurrent;
    if (label) label.classList.toggle("is-past", !isCurrent);
  }

  function renderFinance(){
    if (!financeData) return;
    var res = financeData;
    var byType = res.byType || {};
    var income = Number(res.income) || 0;
    var expense = Number(res.expense) || 0;
    var diff = (res.diff != null) ? Number(res.diff) : (income - expense);
    var isCurrent = res.month === finCurrentMonth();
    var prev = res.prev || {};
    // 当月は「前月の同日まで」、過去月は前月まるごとと比べる
    var prevSrc = (isCurrent && prev.toDate) ? prev.toDate : (prev.byType || {});
    var prevLabel = isCurrent ? "前月同日" : "前月";

    document.getElementById("pv-fin-income").textContent = finYen(income);
    document.getElementById("pv-fin-expense").textContent = finYen(expense);
    var diffEl = document.getElementById("pv-fin-diff");
    diffEl.textContent = finSignedYen(diff);
    diffEl.classList.toggle("is-neg", diff < 0);
    diffEl.classList.toggle("is-pos", diff >= 0);

    finSetSub("fin-sub-income", finDeltaLine(income, Number(prevSrc["収入"]) || 0, prevLabel, true));
    finSetSub("fin-sub-expense", finDeltaLine(expense, Number(prevSrc["支出"]) || 0, prevLabel, false));
    var prevDiff = (Number(prevSrc["収入"]) || 0) - (Number(prevSrc["支出"]) || 0);
    finSetSub("fin-sub-diff", prevDiff === 0 ? { text: prevLabel + " —", tone: "" }
      : { text: prevLabel + " " + finSignedYen(prevDiff), tone: diff >= prevDiff ? "is-good" : "is-bad" });

    var k4Label = document.getElementById("fin-kpi4-label");
    var k4Value = document.getElementById("pv-fin-daysleft");
    var count = (res.rows || []).length;
    if (isCurrent){
      if (k4Label) k4Label.textContent = "当月の残り日数";
      if (k4Value) k4Value.textContent = finMonthDaysLeft() + "日";
      finSetSub("fin-sub-days", { text: "取引 " + count + "件", tone: "" });
    } else {
      if (k4Label) k4Label.textContent = "取引件数";
      if (k4Value) k4Value.textContent = count + "件";
      finSetSub("fin-sub-days", null);
    }

    var donutDiff = document.getElementById("pv-fin-donut-diff");
    if (donutDiff){
      donutDiff.textContent = finSignedYen(diff);
      donutDiff.classList.toggle("is-neg", diff < 0);
      donutDiff.classList.toggle("is-pos", diff >= 0);
    }
    renderFinanceDonut(income, expense);
    renderFinanceTypes(byType);
    renderFinanceCats();
    renderFinanceTx();
    renderFinanceMonthNav();
  }

  function finShowBody(show){
    ["fin-kpis", "fin-body", "fin-tx-card"].forEach(function(id){
      var el = document.getElementById(id);
      if (el) el.hidden = !show;
    });
  }

  async function loadFinance(){
    var addBtn = document.getElementById("pv-fin-add");
    if (!document.getElementById("pv-fin-main")) return;
    if (!financeMonth) financeMonth = finCurrentMonth();
    renderFinanceMonthNav();
    finSetStatus("読み込み中…", false);
    if (addBtn) addBtn.hidden = true;
    try {
      var res = await apiFetch("/api/sheets/finance?month=" + encodeURIComponent(financeMonth));
      if (!res || res.configured === false){
        financeData = null;
        finShowBody(false);
        finSetStatus("設定 → 家計簿スプレッドシート に共有 URL を登録してください。", false);
        return;
      }
      financeCategories = (res.categories && Object.keys(res.categories).length) ? res.categories : FIN_FALLBACK_CATEGORIES;
      // 古いバックエンド(rows/byType なし)でも KPI だけは出せるように埋めておく
      if (!res.byType) res.byType = { "収入": Number(res.income) || 0, "支出": Number(res.expense) || 0, "貯蓄": 0, "投資": 0 };
      if (!res.rows) res.rows = [];
      financeData = res;
      financeMonth = res.month || financeMonth;
      finShowBody(true);
      renderFinance();
      if (addBtn) addBtn.hidden = false;
      finSetStatus("", false);
    } catch (err){
      financeData = null;
      finShowBody(false);
      var code = err && err.code;
      if (code === "google_scope_missing" || code === "google_not_connected"){
        finSetStatus(apiErrorMessage(err, "家計簿"), true);
      } else {
        finSetStatus(apiErrorMessage(err, "家計簿"), false);
      }
    }
  }

  function finGoMonth(ym){
    var cur = finCurrentMonth();
    if (ym > cur) ym = cur;      // 未来には進めない
    financeMonth = ym;
    loadFinance();
  }

  // selected を渡すと、マスタに無いカテゴリーでも選択肢として残す
  // （既存の取引を編集するとき、マスタから消えたカテゴリーを勝手に空にしないため）。
  function finPopulateCategories(type, selected){
    var sel = document.getElementById("fin-category");
    if (!sel) return;
    var list = ((financeCategories && financeCategories[type]) || FIN_FALLBACK_CATEGORIES[type] || []).slice();
    var want = String(selected || "").trim();
    if (want && list.indexOf(want) < 0) list.push(want);
    sel.innerHTML = "";
    var blank = document.createElement("option");
    blank.value = ""; blank.textContent = "（未選択）";
    sel.appendChild(blank);
    list.forEach(function(c){
      var o = document.createElement("option");
      o.value = c; o.textContent = c;
      sel.appendChild(o);
    });
    sel.value = want && list.indexOf(want) >= 0 ? want : "";
  }

  // item を渡すと編集モード（明細の行クリック）。省略すると新規追加。
  function openFinanceModal(item){
    var modal = document.getElementById("finance-modal");
    if (!modal) return;
    var errEl = document.getElementById("finance-form-error");
    if (errEl){ errEl.hidden = true; errEl.textContent = ""; }
    var editing = !!(item && item.row);
    financeEditRow = editing
      ? { row: item.row, prev: { date: item.date, type: item.type, amount: item.amount } }
      : null;

    var titleEl = document.getElementById("finance-modal-title");
    if (titleEl) titleEl.textContent = editing ? "取引を編集" : "取引を追加";
    var delBtn = document.getElementById("fin-delete");
    if (delBtn){ delBtn.hidden = !editing; delBtn.disabled = false; }

    var dateEl = document.getElementById("fin-date");
    // 新規で過去月を見ているときは、その月の1日を既定にする(見ている月に足すのが自然)
    var today = jstDateKey(new Date());
    if (dateEl){
      dateEl.value = editing ? item.date
        : ((financeMonth && financeMonth !== today.slice(0, 7)) ? (financeMonth + "-01") : today);
    }
    var typeEl = document.getElementById("fin-type");
    if (typeEl) typeEl.value = editing ? item.type : "支出";
    var amtEl = document.getElementById("fin-amount");
    if (amtEl) amtEl.value = editing ? Math.round(Number(item.amount) || 0) : "";
    var noteEl = document.getElementById("fin-note");
    if (noteEl) noteEl.value = editing ? (item.note || "") : "";
    finPopulateCategories(typeEl ? typeEl.value : "支出", editing ? item.category : "");
    modal.hidden = false;
    if (amtEl) amtEl.focus();
  }
  function closeFinanceModal(){
    var modal = document.getElementById("finance-modal");
    if (modal) modal.hidden = true;
    financeEditRow = null;
  }

  // シート側で行がずれていた（409 row_changed）ときは、黙って直さず読み直させる。
  function finIsStale(err){ return err && err.code === "row_changed"; }

  async function deleteFinanceRow(){
    if (!financeEditRow) return;
    var errEl = document.getElementById("finance-form-error");
    var delBtn = document.getElementById("fin-delete");
    var saveBtn = document.getElementById("fin-save");
    if (!window.confirm("この取引を家計簿から削除します。よろしいですか？")) return;
    if (delBtn){ delBtn.disabled = true; delBtn.textContent = "削除中…"; }
    if (saveBtn) saveBtn.disabled = true;
    try {
      await apiFetch("/api/sheets/finance/" + financeEditRow.row, {
        method: "DELETE",
        body: JSON.stringify({ prev: financeEditRow.prev })
      });
      closeFinanceModal();
      loadFinance();
    } catch (err){
      if (errEl){ errEl.textContent = apiErrorMessage(err, "家計簿"); errEl.hidden = false; }
      if (finIsStale(err)){ closeFinanceModal(); loadFinance(); }
    } finally {
      if (delBtn){ delBtn.disabled = false; delBtn.textContent = "削除"; }
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  function wireFinanceModal(){
    if (financeModalWired) return;
    financeModalWired = true;
    var addBtn = document.getElementById("pv-fin-add");
    var modal = document.getElementById("finance-modal");
    var closeBtn = document.getElementById("finance-modal-close");
    var cancelBtn = document.getElementById("fin-cancel");
    var form = document.getElementById("finance-form");
    var typeEl = document.getElementById("fin-type");
    var reconnectBtn = document.getElementById("pv-fin-reconnect");
    if (addBtn) addBtn.addEventListener("click", function(){ openFinanceModal(); });
    if (closeBtn) closeBtn.addEventListener("click", closeFinanceModal);
    if (cancelBtn) cancelBtn.addEventListener("click", closeFinanceModal);
    if (modal) modal.addEventListener("click", function(e){ if (e.target === modal) closeFinanceModal(); });
    if (typeEl) typeEl.addEventListener("change", function(){ finPopulateCategories(typeEl.value); });
    var delBtn = document.getElementById("fin-delete");
    if (delBtn) delBtn.addEventListener("click", deleteFinanceRow);
    if (reconnectBtn) reconnectBtn.addEventListener("click", function(){ startGoogleConnect("haruka"); });
    // 月ナビ（未来には進めない。TODAY'S PLAN の日付ナビと同じ考え方）
    var mPrev = document.getElementById("fin-month-prev");
    var mNext = document.getElementById("fin-month-next");
    var mToday = document.getElementById("fin-month-today");
    if (mPrev) mPrev.addEventListener("click", function(){ finGoMonth(finShiftMonth(financeMonth || finCurrentMonth(), -1)); });
    if (mNext) mNext.addEventListener("click", function(){ finGoMonth(finShiftMonth(financeMonth || finCurrentMonth(), 1)); });
    if (mToday) mToday.addEventListener("click", function(){ finGoMonth(finCurrentMonth()); });
    if (form) form.addEventListener("submit", async function(e){
      e.preventDefault();
      var errEl = document.getElementById("finance-form-error");
      var saveBtn = document.getElementById("fin-save");
      var payload = {
        date: document.getElementById("fin-date").value,
        type: document.getElementById("fin-type").value,
        amount: Number(document.getElementById("fin-amount").value),
        category: document.getElementById("fin-category").value,
        note: (document.getElementById("fin-note").value || "").trim()
      };
      function showErr(msg){ if (errEl){ errEl.textContent = msg; errEl.hidden = false; } }
      if (errEl){ errEl.hidden = true; errEl.textContent = ""; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.date)){ showErr("日付を入力してください。"); return; }
      if (!(payload.amount > 0)){ showErr("金額はプラスの数値で入力してください。"); return; }
      if (saveBtn){ saveBtn.disabled = true; saveBtn.textContent = "保存中…"; }
      var editing = financeEditRow;
      try {
        if (editing){
          payload.prev = editing.prev; // シート側で行がずれていないかの照合用
          await apiFetch("/api/sheets/finance/" + editing.row, { method: "PUT", body: JSON.stringify(payload) });
        } else {
          await apiFetch("/api/sheets/finance", { method: "POST", body: JSON.stringify(payload) });
        }
        var goMonth = payload.date.slice(0, 7);
        closeFinanceModal();
        // 保存した取引が見えるよう、その取引の月へ移動してから読み直す
        financeMonth = goMonth;
        loadFinance();
      } catch (err){
        showErr(apiErrorMessage(err, "家計簿"));
        if (finIsStale(err)){ closeFinanceModal(); loadFinance(); }
      } finally {
        if (saveBtn){ saveBtn.disabled = false; saveBtn.textContent = "保存"; }
      }
    });
  }

  /* ---- app.js の showView から呼ばれる入口 ----
     配線は初回だけ。データはシート(正)が外で変わりうるので開くたびに取り直す。 */
  var subsPageWired = false, financePageWired = false;
  CP.showSubsPage = function(){
    if (!subsPageWired){ subsPageWired = true; wireSubs(); }
    loadSubs();
  };
  // 収支は月ナビで過去へ行けるので、入り直したら当月に戻す。
  CP.showFinancePage = function(){
    if (!financePageWired){ financePageWired = true; wireFinanceModal(); }
    financeMonth = finCurrentMonth();
    loadFinance();
  };
  // 設定で家計簿シートを差し替えたときに取り直す(モジュールがロード済みのときだけ app.js から呼ばれる)。
  CP.loadFinance = loadFinance;
  // Esc で閉じる(app.js の Esc スタックへ登録)。
  if (CP.registerEscModal){
    CP.registerEscModal("finance-modal", closeFinanceModal);
    CP.registerEscModal("sub-row-modal", closeSubRowModal);
    CP.registerEscModal("subs-modal", closeSubsModal);
  }
})();
