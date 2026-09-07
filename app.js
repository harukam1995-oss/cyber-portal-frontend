(function(){
  "use strict";

  var JP_TZ = "Asia/Tokyo";
  var DOW_JA = ["日","月","火","水","木","金","土"];
  var ACCOUNTS = {
    haruka: { label: "はるか", calendarId: "haruka.m.1995@gmail.com" },
    syslea: { label: "SYSLEA", calendarId: "haruka.masumitsu@syslea.io" }
  };

  /* ================= shared date/time helpers (all JST-anchored) ================= */

  function jstDateKey(d){
    return new Intl.DateTimeFormat("en-CA", { timeZone: JP_TZ, year:"numeric", month:"2-digit", day:"2-digit" }).format(d);
  }
  function keyParts(key){
    var p = key.split("-").map(Number);
    return { y: p[0], m: p[1], d: p[2] };
  }
  // "YYYY-MM-DD" → "M/D"(月日ラベル)。habit/contract/カレンダーで同じ実装だったものを1本化。
  function mdLabel(key){ var p = keyParts(key); return p.m + "/" + p.d; }
  function addDaysKey(key, n){
    var p = keyParts(key);
    var d = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
    return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
  }
  function keyWeekday(key){
    var p = keyParts(key);
    return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
  }
  function startOfWeekKey(key){ return addDaysKey(key, -keyWeekday(key)); }
  function startOfMonthKey(key){ var p = keyParts(key); return p.y + "-" + String(p.m).padStart(2, "0") + "-01"; }
  function daysInMonth(y, m){ return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

  function jstKeyTimeToUTCISO(key, hh, mm){
    var p = keyParts(key);
    return new Date(Date.UTC(p.y, p.m - 1, p.d, hh - 9, mm || 0, 0)).toISOString();
  }
  function jstRangeForKeys(startKey, endKeyExclusive){
    return { start: jstKeyTimeToUTCISO(startKey, 0, 0), end: jstKeyTimeToUTCISO(endKeyExclusive, 0, 0) };
  }

  function fmtEventTime(edge){
    if (!edge) return "終日";
    if (edge.dateTime){
      return new Intl.DateTimeFormat("ja-JP", { timeZone: JP_TZ, hour:"2-digit", minute:"2-digit", hour12:false }).format(new Date(edge.dateTime));
    }
    return "終日";
  }
  function jstTimeHHMM(dtStr){
    return new Intl.DateTimeFormat("en-GB", { timeZone: JP_TZ, hour:"2-digit", minute:"2-digit", hour12:false }).format(new Date(dtStr));
  }
  function minutesToHHMM(m){
    var h = Math.floor(m / 60), mm = m % 60;
    return String(h).padStart(2, "0") + ":" + String(mm).padStart(2, "0");
  }

  function escapeHtml(str){
    return String(str).replace(/[&<>"']/g, function(ch){
      return { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch];
    });
  }

  // Shared wiring for the はるか/SYSLEA account-tab groups (calendar / mail /
  // home schedule). getCurrent() reports the active account; onChange(acct)
  // applies the switch. Keeps the click→active-class→callback pattern in one
  // place instead of copy-pasted per tab group.
  function wireAcctTabs(containerId, getCurrent, onChange){
    document.querySelectorAll("#" + containerId + " .acct-tab").forEach(function(btn){
      btn.addEventListener("click", function(){
        var acct = btn.getAttribute("data-account");
        if (acct === getCurrent()) return;
        document.querySelectorAll("#" + containerId + " .acct-tab").forEach(function(b){
          b.classList.toggle("active", b === btn);
        });
        onChange(acct);
      });
    });
  }

  // ---- バックエンドAPI(Render) + Firebase Authentication ----
  var API_BASE = "https://cyber-portal-backend.onrender.com";

  function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }

  // Render Free はアイドルでスピンダウンし、次のリクエストで ~50秒 のコールドスタートが
  // 起きる。ログイン処理(Firebase SDK ロード + Google 往復)の裏で先に叩いておくと、
  // その待ち時間にサーバー起動が重なって体感が縮む。認証不要の /healthz を使う。
  var warmPingAt = 0;
  function warmBackend(){
    var now = Date.now();
    if (now - warmPingAt < 60000) return;   // 1分に1回まで
    warmPingAt = now;
    try { fetch(API_BASE + "/healthz", { cache: "no-store", mode: "cors" }).catch(function(){}); } catch(e){}
  }
  warmBackend();
  document.addEventListener("visibilitychange", function(){
    if (document.visibilityState === "visible") warmBackend();
  });

  // コールドスタート中は 502/503/504 やネットワークエラーが返ることがある。
  // その場合だけ短いバックオフで数回リトライする。リトライ中のリクエストが1本でも
  // ある間だけ「起動中」トーストを出す(同時に多数のリクエストが飛ぶので、
  // 成功したものが即トーストを消さないよう本数で管理する)。
  var warmToastEl = null;
  var warmingCount = 0;
  function setWarming(delta){
    warmingCount = Math.max(0, warmingCount + delta);
    var on = warmingCount > 0;
    if (on && !warmToastEl){
      warmToastEl = document.createElement("div");
      warmToastEl.className = "server-warming-toast";
      warmToastEl.textContent = "サーバーを起動しています…(最大1分ほど)";
      document.body.appendChild(warmToastEl);
    }
    if (warmToastEl) warmToastEl.hidden = !on;
  }

  async function rawFetchWithRetry(url, init){
    var delays = [0, 2500, 5000];
    var lastErr = null;
    var counted = false;
    try {
      for (var i = 0; i < delays.length; i++){
        if (delays[i]) await sleep(delays[i]);
        try {
          var res = await fetch(url, init);
          if (res.status === 502 || res.status === 503 || res.status === 504){
            lastErr = new Error("APIエラー: " + res.status);
            lastErr.code = "http_" + res.status;
            if (!counted){ counted = true; setWarming(1); }
            continue;
          }
          return res;
        } catch(netErr){
          lastErr = netErr;
          if (!counted){ counted = true; setWarming(1); }
        }
      }
      throw lastErr || new Error("ネットワークエラー");
    } finally {
      if (counted) setWarming(-1);
    }
  }

  async function getIdToken(){
    var auth = window.__cyberPortalAuth;
    if (!auth || !auth.currentUser) return null;
    return auth.currentUser.getIdToken();
  }

  async function apiFetch(path, options){
    options = options || {};
    var token = await getIdToken();
    if (!token){
      var authErr = new Error("未ログインです。");
      authErr.code = "unauthenticated";
      throw authErr;
    }
    var headers = Object.assign(
      { "Content-Type": "application/json", "Authorization": "Bearer " + token },
      options.headers || {}
    );
    var res = await rawFetchWithRetry(API_BASE + path, Object.assign({}, options, { headers: headers }));
    if (!res.ok){
      var body = null;
      try { body = await res.json(); } catch(e){}
      var err = new Error((body && body.message) || ("APIエラー: " + res.status));
      err.code = (body && body.error) || ("http_" + res.status);
      throw err;
    }
    if (res.status === 204) return null;
    return res.json();
  }

  // apiFetch のバイナリ版。CSV 書き出し(/api/export/csv)のように
  // Content-Disposition 付きのファイルを取ってくる用。JSON 化せず Blob を返す。
  async function apiFetchBlob(path){
    var token = await getIdToken();
    if (!token){ var e = new Error("未ログインです。"); e.code = "unauthenticated"; throw e; }
    var res = await rawFetchWithRetry(API_BASE + path, { headers: { "Authorization": "Bearer " + token } });
    if (!res.ok){
      var body = null;
      try { body = await res.json(); } catch(err){}
      var er = new Error((body && body.message) || ("APIエラー: " + res.status));
      er.code = (body && body.error) || ("http_" + res.status);
      throw er;
    }
    return res.blob();
  }

  // Google連携APIのパスに ?account=haruka|syslea を付ける
  function acctPath(path, account){
    var sep = path.indexOf("?") === -1 ? "?" : "&";
    return path + sep + "account=" + encodeURIComponent(account || "haruka");
  }

  var API_ERROR_MESSAGES = {
    unauthenticated: "ログインが必要です。画面を再読み込みしてください。",
    invalid_token: "認証の有効期限が切れました。再ログインしてください。",
    google_not_connected: "{service}の Google 連携が必要です(未連携、または有効期限切れ)。連携ボタンから再連携してください。",
    upstream_error: "{service}の取得に失敗しました。しばらくしてから再度お試しください。",
    rate_limited: "リクエストが多すぎます。少し待ってから再度お試しください。",
    http_502: "サーバーが起動中か一時的に応答していません。少し待って再読み込みしてください。",
    http_503: "サーバーが起動中か一時的に応答していません。少し待って再読み込みしてください。",
    http_504: "サーバーの応答がありませんでした。少し待って再読み込みしてください。",
    empty_replace_blocked: "読み込みに失敗している可能性があるため保存を中止しました。再読み込みしてください。"
  };
  function apiErrorMessage(err, service){
    var code = err && err.code;
    var label = service || "連携先";
    var tmpl = API_ERROR_MESSAGES[code];
    if (tmpl) return tmpl.replace(/\{service\}/g, label);
    return (err && err.message) || "情報を取得できませんでした。";
  }
  // 保存(タスク/メモ)専用のエラーメッセージ。artifactErrorMessage という関数名は
  // 旧Artifact版からの呼び出し箇所をそのまま活かすために維持している。
  function artifactErrorMessage(err){
    return apiErrorMessage(err, "保存");
  }
  function fmtSavedAt(ms){
    return new Intl.DateTimeFormat("ja-JP", { timeZone: JP_TZ, hour:"2-digit", minute:"2-digit" }).format(new Date(ms));
  }
  function uid(){
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /* ================= skeleton loading placeholders =================
     読み込み中に「読み込み中…」テキストの代わりに、実際のレイアウトに近い
     シマー付きのプレースホルダを出す。CSS 側の .skeleton がアニメーション担当。 */
  function skelRepeat(row, n){
    var out = ""; for (var i = 0; i < n; i++) out += row; return out;
  }
  function mailSkeletonHtml(n){
    return skelRepeat(
      '<li class="mail-skel-item">' +
      '<div class="mail-skel-avatar skeleton"></div>' +
      '<div class="mail-skel-lines">' +
      '<div class="mail-skel-line skeleton" style="width:58%"></div>' +
      '<div class="mail-skel-line skeleton" style="width:88%"></div>' +
      '<div class="mail-skel-line skeleton" style="width:44%"></div>' +
      '</div></li>', n || 6);
  }
  function schedSkeletonHtml(n){
    return skelRepeat(
      '<li class="sched-skel-row">' +
      '<span class="sched-skel-time skeleton"></span>' +
      '<span class="sched-skel-title skeleton"></span></li>', n || 4);
  }
  function calSkeletonHtml(){
    return '<div class="cal-skel">' +
      skelRepeat('<div class="cal-skel-row skeleton"></div>', 6) + '</div>';
  }

  /* ================= live clock (always JST) ================= */
  var timeFmt = new Intl.DateTimeFormat("ja-JP", { timeZone: JP_TZ, hour: "2-digit", minute: "2-digit", hour12: false });
  var secFmt  = new Intl.DateTimeFormat("ja-JP", { timeZone: JP_TZ, second: "2-digit" });
  var dateFmt = new Intl.DateTimeFormat("ja-JP", { timeZone: JP_TZ, month: "2-digit", day: "2-digit" });
  var yearFmt = new Intl.DateTimeFormat("ja-JP", { timeZone: JP_TZ, year: "numeric" });
  var dowFmt  = new Intl.DateTimeFormat("ja-JP", { timeZone: JP_TZ, weekday: "short" }); // 月/火/…
  // jstParts() が毎秒呼ばれるので、フォーマッタはここで一度だけ生成する。
  var jstPartsFmt = new Intl.DateTimeFormat("en-US", { timeZone: JP_TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

  var elTime = document.getElementById("hud-time");
  var elSec  = document.getElementById("hud-sec");
  var elMd   = document.getElementById("hud-md");
  var elYr   = document.getElementById("hud-yr");
  var elDow  = document.getElementById("hud-dow");
  var elRing = document.getElementById("ring-progress");
  var elSync = document.getElementById("last-sync");
  var elProgressPct = document.getElementById("progress-pct");
  var elProgressFill = document.getElementById("progress-fill");
  var elQuote = document.getElementById("hud-quote");
  // プライベート画面の TODAY カード(存在すれば tick で同時更新)
  var pvTime = document.getElementById("pv-time");
  var pvSec  = document.getElementById("pv-sec");
  var pvMd   = document.getElementById("pv-md");
  var pvYr   = document.getElementById("pv-yr");
  var pvDow  = document.getElementById("pv-dow");
  // ビジネス画面の TODAY カード(存在すれば tick で同時更新)
  var bizTime = document.getElementById("biz-time");
  var bizSec  = document.getElementById("biz-sec");
  var bizMd   = document.getElementById("biz-md");
  var bizYr   = document.getElementById("biz-yr");
  var bizDow  = document.getElementById("biz-dow");

  var RING_LEN = 603; // 2*pi*96

  // Time-of-day HUD message. Sorted ascending by minutes-from-midnight (JST); the
  // active entry is the latest one whose time has passed. Edit freely to change the
  // rhythm/wording — this is plain data, not tied to anything else in the page.
  var TIME_MESSAGES = [
    { t: 0 * 60,        text: "0:00 そろそろ布団に入る時間だよ。" },
    { t: 2 * 60,        text: "夜更かし注意。明日の自分を助けてあげよう。" },
    { t: 6 * 60,        text: "おはよう。今日も一日よろしくね。" },
    { t: 9 * 60,        text: "集中タイム、いってらっしゃい。" },
    { t: 12 * 60,       text: "12:00 お昼休憩してね。" },
    { t: 13 * 60,       text: "午後もぼちぼちいこう。" },
    { t: 15 * 60,       text: "小休憩をはさむと捗るよ。" },
    { t: 18 * 60,       text: "そろそろ切り上げどきかも。" },
    { t: 20 * 60,       text: "今日もお疲れさま。" },
    { t: 22 * 60 + 30,  text: "そろそろ画面から離れる準備を。" }
  ];
  function timeMessageFor(minutesFromMidnight){
    var chosen = TIME_MESSAGES[TIME_MESSAGES.length - 1].text;
    for (var i = 0; i < TIME_MESSAGES.length; i++){
      if (TIME_MESSAGES[i].t <= minutesFromMidnight) chosen = TIME_MESSAGES[i].text;
      else break;
    }
    return chosen;
  }

  function jstParts(d){
    var parts = jstPartsFmt.formatToParts(d).reduce(function(acc,p){ acc[p.type]=p.value; return acc; }, {});
    var h = parseInt(parts.hour === "24" ? "0" : parts.hour, 10);
    return { h: h, m: parseInt(parts.minute,10), s: parseInt(parts.second,10) };
  }

  function tick(){
    var now = new Date();
    var tStr = timeFmt.format(now), sStr = secFmt.format(now);
    var mdStr = dateFmt.format(now), yrStr = yearFmt.format(now);
    var dowStr = dowFmt.format(now);
    elTime.textContent = tStr;
    elSec.textContent = sStr;
    elMd.textContent = mdStr;
    elYr.textContent = yrStr;
    elDow.textContent = dowStr;
    if (pvTime){
      pvTime.textContent = tStr; pvSec.textContent = sStr;
      pvMd.textContent = mdStr; pvYr.textContent = yrStr; pvDow.textContent = dowStr;
    }
    if (bizTime){
      bizTime.textContent = tStr; bizSec.textContent = sStr;
      bizMd.textContent = mdStr; bizYr.textContent = yrStr; bizDow.textContent = dowStr;
    }

    var p = jstParts(now);
    var secondsToday = p.h * 3600 + p.m * 60 + p.s;
    var frac = secondsToday / 86400;
    elRing.setAttribute("stroke-dashoffset", String(RING_LEN * (1 - frac)));
    elQuote.textContent = timeMessageFor(p.h * 60 + p.m);

    var pct = Math.round(frac * 100);
    elProgressPct.textContent = pct + "%";
    elProgressFill.style.width = pct + "%";

    elSync.textContent = "LAST SYNC " + timeFmt.format(now);
  }
  tick();
  setInterval(tick, 1000);

  /* ================= weather (Open-Meteo 経由・バックエンド) =================
     APIキー不要の無料天気API。既定は柏市。バックエンド /api/weather が
     現在の気温・今日の最高/最低・降水確率などを返す。 */
  // 天気の表示先。HOMEのヒーロー内 と プライベート画面のカード の両方を更新する。
  function paintWeather(summary, range, note){
    ["weather-summary", "pv-weather-summary"].forEach(function(id){
      var el = document.getElementById(id); if (el) el.textContent = summary;
    });
    ["weather-range", "pv-weather-range"].forEach(function(id){
      var el = document.getElementById(id); if (el && range != null) el.textContent = range;
    });
    ["weather-note", "pv-weather-note"].forEach(function(id){
      var el = document.getElementById(id); if (el) el.textContent = note;
    });
  }

  // 天気ペイロード(/api/weather、または /api/bootstrap/home の weather セクション)を
  // HOME/プライベートのカードへ反映する。
  function applyWeatherResponse(w){
    w = w || {};
    var c = w.current || {};
    var t = w.today || {};
    var notes = [];
    if (c.feelsLike != null) notes.push("体感 " + c.feelsLike + "°");
    if (c.humidity != null) notes.push("湿度 " + c.humidity + "%");
    if (t.pop != null) notes.push("降水 " + t.pop + "%");
    paintWeather(
      (w.place || "") + " " + (c.temp != null ? c.temp + "° " : "") + (c.label || ""),
      (t.max != null ? t.max + "° / " + t.min + "°" : "--° / --°"),
      notes.join(" ・ ") || "Open-Meteo"
    );
  }

  // WMO weather interpretation code → 日本語ラベル(表示に必要なぶんだけ)。
  var WMO_JA = {
    0:"快晴",1:"晴れ",2:"晴れ時々曇り",3:"曇り",45:"霧",48:"霧氷",
    51:"弱い霧雨",53:"霧雨",55:"強い霧雨",56:"着氷性の霧雨",57:"着氷性の霧雨",
    61:"小雨",63:"雨",65:"大雨",66:"着氷性の雨",67:"着氷性の雨",
    71:"小雪",73:"雪",75:"大雪",77:"霧雪",
    80:"にわか雨",81:"にわか雨",82:"激しいにわか雨",85:"にわか雪",86:"にわか雪",
    95:"雷雨",96:"雷雨(ひょう)",99:"激しい雷雨(ひょう)"
  };
  // Open-Meteo の生レスポンス → applyWeatherResponse が期待する形。
  function normalizeOpenMeteo(d, place){
    var cur = (d && d.current) || {};
    var dy = (d && d.daily) || {};
    var hasDaily = Array.isArray(dy.time) && dy.time.length &&
      Array.isArray(dy.temperature_2m_max) && Array.isArray(dy.temperature_2m_min);
    return {
      place: place,
      current: {
        temp: cur.temperature_2m != null ? Math.round(cur.temperature_2m) : null,
        feelsLike: cur.apparent_temperature != null ? Math.round(cur.apparent_temperature) : null,
        humidity: cur.relative_humidity_2m != null ? Math.round(cur.relative_humidity_2m) : null,
        label: WMO_JA[cur.weather_code] || ""
      },
      today: hasDaily ? {
        max: Math.round(dy.temperature_2m_max[0]),
        min: Math.round(dy.temperature_2m_min[0]),
        pop: (Array.isArray(dy.precipitation_probability_max) && dy.precipitation_probability_max[0] != null)
          ? dy.precipitation_probability_max[0] : null
      } : null
    };
  }

  var weatherRetryTimer = null;
  var weatherRetriesLeft = 0;
  async function loadWeather(isRetry){
    if (!isRetry) weatherRetriesLeft = 4; // 通常呼び出し(ログイン時 / 30分間隔 / 手動)で再試行枠を補充
    var wp = settingsState && settingsState.weather;
    var lat = (wp && wp.lat != null) ? wp.lat : 35.8676;   // 既定=柏市
    var lon = (wp && wp.lon != null) ? wp.lon : 139.9758;
    var place = (wp && wp.place) ? wp.place : "柏市";
    var ok = false;
    // 1) Open-Meteo(キー不要・CORS許可)をブラウザから直接取得する。
    //    バックエンド(Render)経由だと Render→Open-Meteo が届かず 502 になるため。
    try {
      var omUrl = "https://api.open-meteo.com/v1/forecast?latitude=" + encodeURIComponent(lat) +
        "&longitude=" + encodeURIComponent(lon) +
        "&current=temperature_2m,weather_code,relative_humidity_2m,apparent_temperature" +
        "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
        "&forecast_days=2&timezone=Asia%2FTokyo";
      var r = await fetch(omUrl, { cache: "no-store" });
      if (!r.ok) throw new Error("open-meteo " + r.status);
      var d = await r.json();
      if (!d || !d.current || d.current.temperature_2m == null) throw new Error("open-meteo incomplete");
      applyWeatherResponse(normalizeOpenMeteo(d, place));
      ok = true;
    } catch (omErr) {
      // 2) フォールバック: バックエンド経由(ブラウザ側が Open-Meteo をブロックされる環境向け)。
      try {
        var qs = (wp && wp.lat != null && wp.lon != null)
          ? "?lat=" + encodeURIComponent(wp.lat) + "&lon=" + encodeURIComponent(wp.lon) + "&place=" + encodeURIComponent(wp.place || "")
          : "";
        applyWeatherResponse(await apiFetch("/api/weather" + qs));
        ok = true;
      } catch (beErr) { /* 下でエラー表示 */ }
    }
    if (ok) {
      weatherRetriesLeft = 0;
      if (weatherRetryTimer){ clearTimeout(weatherRetryTimer); weatherRetryTimer = null; }
      return;
    }
    paintWeather(place + " --", null, "天気を取得できませんでした");
    // 更新ボタンが無いので、15秒間隔で数回だけ自動再試行(その後は30分間隔に任せる)。
    if (weatherRetriesLeft > 0 && !weatherRetryTimer){
      weatherRetriesLeft--;
      weatherRetryTimer = setTimeout(function(){ weatherRetryTimer = null; loadWeather(true); }, 15000);
    }
  }
  // 30分ごとに更新
  setInterval(function(){ if (document.visibilityState === "visible") loadWeather(); }, 30 * 60 * 1000);

  /* ================= generative skyline (original artwork, canvas) ================= */
  var canvas = document.getElementById("skyline");
  var ctx = canvas.getContext("2d");
  var DPR = Math.min(window.devicePixelRatio || 1, 2);

  function seededRandom(seed){
    return function(){
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
  }
  var rand = seededRandom(42);

  function resize(){
    var w = canvas.clientWidth, h = canvas.clientHeight;
    // ヒーロー非表示(設定OFF)やスマホ(CSSで .scene を非表示)では canvas に
    // レイアウトサイズが無いので、重い drawScene を丸ごとスキップする。
    if (!w || !h) return;
    canvas.width = w * DPR; canvas.height = h * DPR;
    ctx.setTransform(DPR,0,0,DPR,0,0);
    drawScene(w,h);
  }

  function drawScene(w,h){
    ctx.clearRect(0,0,w,h);

    var sky = ctx.createLinearGradient(0,0,0,h);
    sky.addColorStop(0, "#180a35");
    sky.addColorStop(0.55, "#2a0f4a");
    sky.addColorStop(1, "#3a1450");
    ctx.fillStyle = sky;
    ctx.fillRect(0,0,w,h);

    // Star field — scattered fixed points in the upper sky, before the moon/skyline
    // so the moon glow and buildings sit in front of them.
    var starCount = Math.min(140, Math.round((w*h)/8500));
    for (var st=0; st<starCount; st++){
      var stx = rand()*w, sty = rand()*h*0.62;
      var srad = 0.5 + rand()*1.4;
      var sop = 0.25 + rand()*0.55;
      ctx.fillStyle = "rgba(230,225,255," + sop.toFixed(2) + ")";
      ctx.beginPath(); ctx.arc(stx, sty, srad, 0, Math.PI*2); ctx.fill();
    }

    var mx = w*0.78, my = h*0.28, mr = Math.min(w,h)*0.16;
    var moonGrad = ctx.createRadialGradient(mx,my,mr*0.1,mx,my,mr);
    moonGrad.addColorStop(0, "rgba(255,225,245,0.9)");
    moonGrad.addColorStop(0.5, "rgba(210,160,255,0.35)");
    moonGrad.addColorStop(1, "rgba(210,160,255,0)");
    ctx.fillStyle = moonGrad;
    ctx.beginPath(); ctx.arc(mx,my,mr,0,Math.PI*2); ctx.fill();
    ctx.fillStyle = "rgba(255,240,250,0.85)";
    ctx.beginPath(); ctx.arc(mx,my,mr*0.32,0,Math.PI*2); ctx.fill();

    // Distant light-trails (drones/flyers) — a few static streaks crossing the
    // upper-mid sky, suggesting motion without any continuous animation.
    var trailColors = ["rgba(44,227,255,0.55)", "rgba(255,47,146,0.5)"];
    for (var tr=0; tr<3; tr++){
      var trY = h*(0.14 + tr*0.09) + rand()*h*0.05;
      var trX = w*0.1 + rand()*w*0.6;
      var trLen = 50 + rand()*70;
      var trAngle = -0.12 + rand()*0.08;
      var tgrad = ctx.createLinearGradient(trX, trY, trX + trLen*Math.cos(trAngle), trY + trLen*Math.sin(trAngle));
      tgrad.addColorStop(0, "rgba(255,255,255,0)");
      tgrad.addColorStop(0.85, trailColors[tr % trailColors.length]);
      tgrad.addColorStop(1, "rgba(255,255,255,0.9)");
      ctx.strokeStyle = tgrad;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(trX, trY);
      ctx.lineTo(trX + trLen*Math.cos(trAngle), trY + trLen*Math.sin(trAngle));
      ctx.stroke();
      ctx.fillStyle = trailColors[tr % trailColors.length];
      ctx.beginPath(); ctx.arc(trX + trLen*Math.cos(trAngle), trY + trLen*Math.sin(trAngle), 1.6, 0, Math.PI*2); ctx.fill();
    }

    var layers = [
      { y: h*0.55, hMin: h*0.10, hMax: h*0.22, color: "rgba(70,30,110,0.55)" },
      { y: h*0.62, hMin: h*0.16, hMax: h*0.34, color: "rgba(50,18,90,0.7)" },
      { y: h*0.70, hMin: h*0.22, hMax: h*0.48, color: "rgba(20,8,45,0.92)" }
    ];

    layers.forEach(function(layer, li){
      var x = -20;
      while (x < w + 20){
        var bw = 30 + rand()*46;
        var bh = layer.hMin + rand()*(layer.hMax-layer.hMin);
        var roofY = layer.y - bh;
        ctx.fillStyle = layer.color;
        ctx.fillRect(x, roofY, bw, h - roofY);

        if (li >= 1){
          var rows = Math.floor(bh/14), cols = Math.max(1, Math.floor(bw/10));
          for (var r=0;r<rows;r++){
            for (var c=0;c<cols;c++){
              if (rand() > 0.62){
                var wx = x + 4 + c*10;
                var wy = roofY + 6 + r*14;
                var lit = rand();
                ctx.fillStyle = lit > 0.5 ? "rgba(255,120,190,0.85)" : "rgba(110,230,255,0.8)";
                ctx.fillRect(wx, wy, 3.5, 6);
              }
            }
          }
        }

        // Rooftop silhouettes on the frontmost layer only — antennas with a
        // glowing tip, or a water-tank block — for skyline texture up close.
        if (li === 2 && bw > 34){
          if (rand() > 0.55){
            var antX = x + bw*0.5;
            var antH = 14 + rand()*20;
            ctx.strokeStyle = "rgba(15,6,30,0.9)";
            ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.moveTo(antX, roofY); ctx.lineTo(antX, roofY - antH); ctx.stroke();
            ctx.fillStyle = rand() > 0.5 ? "rgba(255,80,150,0.9)" : "rgba(120,220,255,0.9)";
            ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 6;
            ctx.beginPath(); ctx.arc(antX, roofY - antH, 1.8, 0, Math.PI*2); ctx.fill();
            ctx.shadowBlur = 0;
          } else {
            var tankW = bw*0.28, tankX = x + bw*0.14 + rand()*bw*0.4;
            ctx.fillStyle = "rgba(12,5,26,0.95)";
            ctx.fillRect(tankX, roofY - 12, tankW, 12);
            ctx.beginPath(); ctx.ellipse(tankX + tankW/2, roofY - 12, tankW/2, 3, 0, 0, Math.PI*2); ctx.fill();
          }
        }
        x += bw + 6 + rand()*10;
      }
    });

    // Neon signage — a wider, more varied strip: bars, glowing rings, and
    // blocky glyph clusters, spread further across the width than before.
    var signColors = ["#ff2f92", "#2ce3ff", "#8b5cf6"];
    for (var s=0; s<8; s++){
      var sx = w*0.03 + s*(w*0.125) + rand()*18;
      var sy = h*0.72 + rand()*h*0.13;
      var col = signColors[s % signColors.length];
      ctx.fillStyle = col; ctx.strokeStyle = col;
      ctx.globalAlpha = 0.85;
      ctx.shadowColor = col; ctx.shadowBlur = 12;
      var kind = s % 3;
      if (kind === 0){
        var sw = 8 + rand()*10, sh = 30 + rand()*70;
        ctx.fillRect(sx, sy, sw, sh);
      } else if (kind === 1){
        var ringR = 9 + rand()*8;
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(sx, sy, ringR, 0, Math.PI*2); ctx.stroke();
      } else {
        var cell = 5 + rand()*2;
        for (var gy=0; gy<3; gy++){
          for (var gx=0; gx<2; gx++){
            if (rand() > 0.4) ctx.fillRect(sx + gx*(cell+2), sy + gy*(cell+2), cell, cell);
          }
        }
      }
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    }

    var haze = ctx.createLinearGradient(0,h*0.82,0,h);
    haze.addColorStop(0, "rgba(10,4,25,0)");
    haze.addColorStop(1, "rgba(6,3,15,0.9)");
    ctx.fillStyle = haze;
    ctx.fillRect(0,h*0.82,w,h*0.18);

    // Wet-street reflection — soft vertical smears of the sign colors along
    // the very bottom edge, as if the ground were reflecting the neon above.
    for (var rf=0; rf<6; rf++){
      var rx = w*0.05 + rand()*w*0.9;
      var rcol = signColors[rf % signColors.length];
      var rgrad = ctx.createLinearGradient(0, h*0.94, 0, h);
      rgrad.addColorStop(0, "rgba(0,0,0,0)");
      rgrad.addColorStop(1, rcol);
      ctx.fillStyle = rgrad;
      ctx.globalAlpha = 0.16;
      ctx.fillRect(rx, h*0.94, 3 + rand()*4, h*0.06);
      ctx.globalAlpha = 1;
    }
  }

  // resize は drawScene(数百描画命令)を伴うので、連続する resize イベントは
  // 150ms デバウンスして最後の1回だけ再描画する。
  var resizeTimer = null;
  window.addEventListener("resize", function(){
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 150);
  });
  resize();

  /* ================= hero illustrations (user-supplied artwork, one shown at random per load) ================= */
  var HERO_ILLUSTRATIONS = [
    "hero1.webp",
    "hero2.webp"
  ];
  (function(){
    var img = document.getElementById("scene-illustration");
    var scene = document.getElementById("hero-scene");
    if (!img || !scene || !HERO_ILLUSTRATIONS.length) return;
    // 設定でヒーローのイラストをOFFにしている場合(localStorageに前回値をキャッシュ)、
    // シーンを隠して画像も読み込まない。認証後に applySettings が最新値で上書きする。
    try {
      if (localStorage.getItem("pref_heroIllustration") === "false"){ scene.style.display = "none"; return; }
    } catch(e){}
    // スマホ(<=640px)ではヒーローのシーンをCSSで非表示にしているので、画像も読み込まない。
    if (window.matchMedia && window.matchMedia("(max-width: 640px)").matches) return;
    var pick = HERO_ILLUSTRATIONS[Math.floor(Math.random() * HERO_ILLUSTRATIONS.length)];
    img.addEventListener("load", function(){ scene.classList.add("has-illustration"); });
    img.src = pick;
  })();


  /* ================= Google Calendar → TODAY'S SCHEDULE (home page, live watch) ================= */
  var schedList = document.getElementById("sched-list");
  var schedSourceLabel = document.getElementById("sched-source-label");
  var schedUpdated = document.getElementById("sched-updated");
  // カレンダーのイベント色。虹色をやめて暖色(アンバー)系の弱いバリエーションだけにする。
  var dotColors = ["#ff8f3f", "#e8954f", "#d98a4a", "#f0a45f", "#c98a5b"];
  var schedAccount = "haruka";
  var schedRefreshBtn = document.getElementById("sched-refresh");
  var schedEventsToday = []; // 通知センターが「本日の残り予定」を出すのに参照

  function renderEvents(events){
    schedEventsToday = events || [];
    if (typeof refreshNotifCenter === "function") refreshNotifCenter();
    schedList.innerHTML = "";
    if (!events || events.length === 0){
      schedList.innerHTML = '<li class="sched-empty">本日の予定はありません</li>';
      return;
    }
    events
      .slice()
      .sort(function(a,b){
        var ta = a.start && (a.start.dateTime || a.start.date) || "";
        var tb = b.start && (b.start.dateTime || b.start.date) || "";
        return ta < tb ? -1 : ta > tb ? 1 : 0;
      })
      .forEach(function(ev, idx){
        var li = document.createElement("li");
        var dot = document.createElement("span");
        dot.className = "sched-dot"; // 色は CSS(--accent)で統一。予定ごとの色分けはしない
        var time = document.createElement("span");
        time.className = "sched-time";
        time.textContent = fmtEventTime(ev.start);
        var title = document.createElement("span");
        title.className = "sched-title";
        title.textContent = ev.summary || "(タイトルなし)";
        li.appendChild(dot); li.appendChild(time); li.appendChild(title);
        schedList.appendChild(li);
      });
  }

  // カレンダー今日ぶんの取得結果(/api/google/calendar/today、または
  // /api/bootstrap/home の calendarToday.haruka)をスケジュールカードへ反映する。
  function applyCalendarToday(events, acct){
    var label = acct === "syslea" ? "SYSLEA" : "はるか";
    renderEvents(events || []);
    schedSourceLabel.innerHTML = '<span class="live">●</span> Google Calendar 連携中 (' + label + ')';
    schedUpdated.textContent = new Intl.DateTimeFormat("ja-JP", { timeZone: JP_TZ, hour:"2-digit", minute:"2-digit" }).format(new Date()) + " 時点";
  }

  // ホームの TODAY'S SCHEDULE。バックエンド(/api/google/calendar/today)から取得する。
  // 旧MCPのwatchTool方式は廃止し、読み込み時と更新ボタン押下時に単発フェッチする。
  // initCalendarWatch は authready / タブ表示 / 更新ボタン等 複数箇所から呼ばれるので、
  // 同じアカウントの取得が進行中なら相乗りして二重フェッチを防ぐ。
  var schedInFlight = null;
  var schedInFlightAcct = null;
  function initCalendarWatch(){
    if (schedInFlight && schedInFlightAcct === schedAccount) return schedInFlight;
    schedInFlightAcct = schedAccount;
    schedInFlight = runCalendarWatch();
    var done = function(){ schedInFlight = null; schedInFlightAcct = null; };
    schedInFlight.then(done, done);
    return schedInFlight;
  }
  async function runCalendarWatch(){
    var acct = schedAccount;
    var label = acct === "syslea" ? "SYSLEA" : "はるか";
    if (schedRefreshBtn){ schedRefreshBtn.classList.remove("spinning"); }
    schedList.innerHTML = schedSkeletonHtml(4);
    try{
      var res = await apiFetch(acctPath("/api/google/calendar/today", acct));
      if (acct !== schedAccount) return;
      applyCalendarToday(res.events || [], acct);
    } catch(err){
      if (acct !== schedAccount) return;
      if (err && err.code === "google_not_connected"){
        schedSourceLabel.textContent = "カレンダー連携: " + label + " 要再連携";
        schedList.innerHTML = "";
        schedList.appendChild(buildConnectPrompt(acct, label));
      } else {
        schedSourceLabel.textContent = "カレンダー取得エラー";
        schedList.innerHTML = '<li class="sched-error">' + escapeHtml(apiErrorMessage(err, "Google Calendar")) + '</li>';
      }
    } finally {
      if (acct === schedAccount && schedRefreshBtn){
        schedRefreshBtn.classList.remove("spinning");
        schedRefreshBtn.disabled = false;
      }
    }
  }
  // 初回ロードは末尾の authready ハンドラ(またはログイン済みフォールバック)から呼ぶ。

  wireAcctTabs("sched-acct-tabs", function(){ return schedAccount; }, function(acct){
    schedAccount = acct;
    initCalendarWatch();
  });

  if (schedRefreshBtn){
    schedRefreshBtn.addEventListener("click", function(){
      if (schedRefreshBtn.disabled) return;
      schedRefreshBtn.classList.add("spinning");
      schedRefreshBtn.disabled = true;
      initCalendarWatch();
    });
  }

  /* ================= view routing =================
     ダッシュボード3種(HOME / プライベート / ビジネス)＋サブ画面(カレンダー等)。
     共有ヘッダー(#app-topbar)と再連携バナーは、表示中のダッシュボードframeの先頭へ
     移動させる(3回複製すると #notif-btn 等のIDが重複するため、実体は1つ)。 */
  var viewHome = document.getElementById("view-home");
  var viewPrivate = document.getElementById("view-private");
  var viewBusiness = document.getElementById("view-business");
  var viewCalendar = document.getElementById("view-calendar");
  var viewMail = document.getElementById("view-mail");
  var viewTasks = document.getElementById("view-tasks");
  var viewNotes = document.getElementById("view-notes");
  var viewIdeas = document.getElementById("view-ideas");
  var appTopbar = document.getElementById("app-topbar");
  var navHome = document.getElementById("nav-home");
  var navPrivate = document.getElementById("nav-private");
  var navBusiness = document.getElementById("nav-business");
  var currentDashboard = "home"; // サブ画面の「← 戻る」で戻る先
  var calInitialized = false;
  var mailInitialized = false;
  var tasksInitialized = false;
  var notesInitialized = false;
  var ideasInitialized = false;
  var privateInitialized = false;
  var businessInitialized = false;

  function showView(name){
    var isDash = name === "home" || name === "private" || name === "business";
    viewHome.hidden = name !== "home";
    if (viewPrivate) viewPrivate.hidden = name !== "private";
    if (viewBusiness) viewBusiness.hidden = name !== "business";
    viewCalendar.hidden = name !== "calendar";
    viewMail.hidden = name !== "mail";
    viewTasks.hidden = name !== "tasks";
    viewNotes.hidden = name !== "notes";
    viewIdeas.hidden = name !== "ideas";

    if (isDash){
      currentDashboard = name;
      var frame = name === "private" ? viewPrivate : name === "business" ? viewBusiness : viewHome;
      if (appTopbar && frame){
        frame.insertBefore(appTopbar, frame.firstChild);
        var banner = document.getElementById("reauth-banner");
        if (banner) appTopbar.after(banner);
      }
      navHome.classList.toggle("active", name === "home");
      if (navPrivate) navPrivate.classList.toggle("active", name === "private");
      if (navBusiness) navBusiness.classList.toggle("active", name === "business");
    }

    if (name === "private" && !privateInitialized){
      privateInitialized = true;
      initPrivate();
    }
    if (name === "business" && !businessInitialized){
      businessInitialized = true;
      initBusiness();
    }
    if (name === "calendar"){
      if (!calInitialized){
        calInitialized = true;
        loadAndRenderCalendar();
      } else if (calState.loadOk){
        // ログイン時に非表示のまま先読み済み。表示された今、レイアウトを描き直す(再取得なし)。
        renderCalendarView();
      }
    }
    if (name === "mail" && !mailInitialized){
      mailInitialized = true;
      loadHarukaMail();
      loadMailLabels();
    }
    if (name === "tasks" && !tasksInitialized){
      tasksInitialized = true;
      initTasks();
    }
    if (name === "notes" && !notesInitialized){
      notesInitialized = true;
      initNotes();
    }
    if (name === "ideas" && !ideasInitialized){
      ideasInitialized = true;
      ideasStack = [{ id: null, name: "Obsidian" }];
      ideasOpenFolder(null, "Obsidian", true);
    }
    window.scrollTo(0, 0);
  }

  document.getElementById("quick-calendar").addEventListener("click", function(){ showView("calendar"); });
  document.getElementById("quick-mail").addEventListener("click", function(){ showView("mail"); });
  document.getElementById("quick-tasks").addEventListener("click", function(){ showView("tasks"); });
  document.getElementById("quick-notes").addEventListener("click", function(){ showView("notes"); });
  document.getElementById("quick-ideas").addEventListener("click", function(){ showView("ideas"); });
  navHome.addEventListener("click", function(e){ e.preventDefault(); showView("home"); });
  if (navPrivate) navPrivate.addEventListener("click", function(e){ e.preventDefault(); showView("private"); });
  if (navBusiness) navBusiness.addEventListener("click", function(e){ e.preventDefault(); showView("business"); });
  // サブ画面の「← 戻る」は、来たダッシュボード(HOME/プライベート/ビジネス)へ戻す
  ["cal-back", "mail-back", "tasks-back", "notes-back", "ideas-back"].forEach(function(id){
    var b = document.getElementById(id);
    if (b) b.addEventListener("click", function(){ showView(currentDashboard); });
  });
  // プライベートのクイックアクセス: はるかを選択済みにしてサブ画面を開く
  [["pv-quick-tasks", "tasks"], ["pv-quick-calendar", "calendar"], ["pv-quick-notes", "notes"],
   ["pv-quick-mail", "mail"], ["pv-quick-ideas", "ideas"]].forEach(function(pair){
    var b = document.getElementById(pair[0]);
    if (b) b.addEventListener("click", function(){
      if (typeof setDefaultAccount === "function") setDefaultAccount("haruka");
      showView(pair[1]);
    });
  });
  // ビジネスのクイックアクセス: SYSLEA を選択済みにしてサブ画面を開く
  [["biz-quick-tasks", "tasks"], ["biz-quick-calendar", "calendar"], ["biz-quick-notes", "notes"],
   ["biz-quick-mail", "mail"], ["biz-quick-ideas", "ideas"]].forEach(function(pair){
    var b = document.getElementById(pair[0]);
    if (b) b.addEventListener("click", function(){
      if (typeof setDefaultAccount === "function") setDefaultAccount("syslea");
      showView(pair[1]);
    });
  });

  /* ================= プライベート画面 (v1a / v1b) =================
     TODAY / WEATHER は共通ロジック(tick / loadWeather)が pv 要素も更新する。
     ここでは UPCOMING EVENTS(はるかカレンダー) と 装飾ヒーロー、
     今月の収支(v1b: 家計簿スプレッドシート連携)を担当。
     TODAY'S PLAN は次の段階で実装(HTMLは「準備中」枠)。 */
  function initPrivate(){
    var img = document.getElementById("pv-hero-img");
    if (img && !img.getAttribute("src") && HERO_ILLUSTRATIONS.length){
      img.src = HERO_ILLUSTRATIONS[Math.floor(Math.random() * HERO_ILLUSTRATIONS.length)];
    }
    loadWeather();          // 即時反映(通常は30分間隔)
    loadPrivateUpcoming();
    wireFinanceModal();
    loadFinance();
    wireHabitTracker();
    loadHabits();
    wirePlan();
    loadPlan();
    wireSubs();
    loadSubs();
  }

  async function loadPrivateUpcoming(){
    var el = document.getElementById("pv-upcoming");
    if (!el) return;
    el.innerHTML = schedSkeletonHtml(4);
    try{
      var now = new Date();
      var startKey = jstDateKey(now);
      var bounds = jstRangeForKeys(startKey, addDaysKey(startKey, 45));
      var res = await apiFetch(acctPath(
        "/api/google/calendar/events?start=" + encodeURIComponent(bounds.start) +
        "&end=" + encodeURIComponent(bounds.end), "haruka"));
      var events = (res.events || []).filter(function(ev){
        var iso = ev.start && (ev.start.dateTime || (ev.start.date ? ev.start.date + "T23:59:59+09:00" : null));
        return iso && new Date(iso).getTime() >= now.getTime() - 3600000;
      }).slice(0, 5);
      if (!events.length){ el.innerHTML = '<li class="sched-empty">直近の予定はありません</li>'; return; }
      el.innerHTML = "";
      events.forEach(function(ev){
        var d = ev.start.dateTime ? new Date(ev.start.dateTime) : new Date(ev.start.date + "T00:00:00+09:00");
        var dateStr = new Intl.DateTimeFormat("ja-JP", { timeZone: JP_TZ, month: "2-digit", day: "2-digit" }).format(d);
        var dow = new Intl.DateTimeFormat("ja-JP", { timeZone: JP_TZ, weekday: "short" }).format(d);
        var li = document.createElement("li");
        li.className = "pv-up-item";
        var dot = document.createElement("span"); dot.className = "pv-up-dot";
        var dt = document.createElement("span"); dt.className = "pv-up-date"; dt.textContent = dateStr + " " + dow;
        var ti = document.createElement("span"); ti.className = "pv-up-title"; ti.textContent = ev.summary || "(タイトルなし)";
        li.appendChild(dot); li.appendChild(dt); li.appendChild(ti);
        el.appendChild(li);
      });
    } catch(err){
      el.innerHTML = '<li class="sched-error">' + escapeHtml(apiErrorMessage(err, "Google Calendar")) + '</li>';
    }
  }

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
  var subsRows = []; // 管理モーダルの作業コピー

  function subYen(n){ return "¥" + (Math.round(Number(n) || 0)).toLocaleString("ja-JP"); }
  function subUnit(s){ return s.unit === "year" ? "year" : "month"; }
  function subEvery(s){ return Math.min(120, Math.max(1, Math.round(Number(s.every) || 1))); }
  function subNeedsMonth(s){ return subUnit(s) === "year" || subEvery(s) > 1; }
  // 1ヶ月あたりに均した金額(月合計の算出用)。半年払い→/6、年払い→/12。
  function subMonthlyAmount(s){
    var a = Number(s.amount) || 0;
    var months = subEvery(s) * (subUnit(s) === "year" ? 12 : 1);
    return a / months;
  }
  // 次回課金日を { y, m, d } で返す。基準月(アンカー)から周期ぶんずつ前進して、
  // 今日以降で最初に来る日を求める。毎月(周期1ヶ月)は当月を基準にできる。
  function subNextParts(s){
    var p = new Intl.DateTimeFormat("en-CA", { timeZone: JP_TZ, year: "numeric", month: "2-digit", day: "2-digit" })
      .format(new Date()).split("-").map(Number);
    var todayNum = p[0] * 10000 + p[1] * 100 + p[2];
    var step = subEvery(s) * (subUnit(s) === "year" ? 12 : 1); // ヶ月単位
    var day = Math.min(31, Math.max(1, Math.round(Number(s.day) || 1)));
    var anchorM = step === 1 ? p[1] : Math.min(12, Math.max(1, Math.round(Number(s.month) || p[1])));
    var cy = p[0] - 2, cm = anchorM; // 2年前のアンカー月から前進
    for (var i = 0; i < 400; i++){
      var cd = Math.min(day, new Date(cy, cm, 0).getDate()); // その月の実日数へ丸め
      if (cy * 10000 + cm * 100 + cd >= todayNum) return { y: cy, m: cm, d: cd };
      cm += step;
      while (cm > 12){ cm -= 12; cy += 1; }
    }
    return { y: cy, m: cm, d: Math.min(day, new Date(cy, cm, 0).getDate()) };
  }
  function subNextKey(s){ var n = subNextParts(s); return n.y * 10000 + n.m * 100 + n.d; }
  function subCadenceWord(s){
    var n = subEvery(s);
    if (subUnit(s) === "year") return n === 1 ? "毎年" : n + "年ごと";
    if (n === 1) return "毎月";
    if (n === 2) return "隔月";
    if (n === 6) return "半年ごと";
    return n + "ヶ月ごと";
  }
  function subWhenLabel(s){
    var day = Math.min(31, Math.max(1, Number(s.day) || 1));
    if (!subNeedsMonth(s)) return "毎月" + day + "日";
    var mo = Math.min(12, Math.max(1, Number(s.month) || (new Date().getMonth() + 1)));
    return subCadenceWord(s) + " " + mo + "/" + day;
  }

  function renderSubs(){
    var list = document.getElementById("pv-subs-list");
    var totalEl = document.getElementById("pv-subs-total");
    if (!list) return;
    var active = subsState.filter(function(s){ return (s.name || "").trim(); });
    if (!active.length){
      list.innerHTML = '<div class="pv-habit-empty">「管理」からサブスクを登録してください。</div>';
      if (totalEl) totalEl.hidden = true;
      return;
    }
    active.sort(function(a, b){ return subNextKey(a) - subNextKey(b); });
    list.innerHTML = "";
    active.forEach(function(s){
      var row = document.createElement("div");
      row.className = "pv-sub-row";
      row.tabIndex = 0; row.setAttribute("role", "button");
      var name = document.createElement("span");
      name.className = "pv-sub-name"; name.textContent = s.name;
      var when = document.createElement("span");
      when.className = "pv-sub-when"; when.textContent = subWhenLabel(s);
      var amt = document.createElement("span");
      amt.className = "pv-sub-amount";
      amt.textContent = subYen(s.amount);
      row.appendChild(name); row.appendChild(when); row.appendChild(amt);
      var open = function(){ openSubsModal(); };
      row.addEventListener("click", open);
      row.addEventListener("keydown", function(e){ if (e.key === "Enter" || e.key === " "){ e.preventDefault(); open(); } });
      list.appendChild(row);
    });
    var monthly = active.reduce(function(a, s){ return a + subMonthlyAmount(s); }, 0);
    if (totalEl){
      totalEl.hidden = false;
      totalEl.textContent = "月合計 " + subYen(monthly) + " ・ 年 " + subYen(monthly * 12);
    }
  }

  async function loadSubs(){
    var mngBtn = document.getElementById("pv-subs-manage");
    var listEl = document.getElementById("pv-subs-list");
    var totalEl = document.getElementById("pv-subs-total");
    subsSetStatus("読み込み中…");
    try {
      var res = await apiFetch("/api/sheets/subscriptions");
      if (!res || res.configured === false){
        subsState = [];
        if (listEl) listEl.innerHTML = "";
        if (totalEl) totalEl.hidden = true;
        if (mngBtn) mngBtn.hidden = true;
        subsSetStatus("設定 → 家計簿スプレッドシート に共有 URL を登録すると使えます。");
        return;
      }
      if (mngBtn) mngBtn.hidden = false;
      subsState = res.subscriptions || [];
      renderSubs();
      subsSetStatus("");
    } catch(err){
      if (mngBtn) mngBtn.hidden = false;
      subsSetStatus(apiErrorMessage(err, "サブスク") || "取得に失敗しました", true);
    }
  }

  function newSubRow(){
    return { name: "", amount: "", unit: "month", every: 1, month: (new Date().getMonth() + 1), day: 1, note: "" };
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
      // 3行目: 備考(任意)
      var l3 = document.createElement("div"); l3.className = "subs-row-line";
      var note = document.createElement("input");
      note.type = "text"; note.maxLength = 200; note.placeholder = "備考(任意)"; note.value = r.note || "";
      note.className = "subs-in subs-in-note";
      note.addEventListener("input", function(){ r.note = note.value; });
      l3.appendChild(note);
      box.appendChild(l3);
      wrap.appendChild(box);
    });
  }
  function openSubsModal(){
    var modal = document.getElementById("subs-modal");
    if (!modal) return;
    subsRows = subsState.map(function(s){
      return {
        name: s.name || "",
        amount: (s.amount === 0 || s.amount) ? s.amount : "",
        unit: s.unit === "year" ? "year" : "month",
        every: Math.min(120, Math.max(1, Number(s.every) || 1)),
        month: Number(s.month) || (new Date().getMonth() + 1),
        day: Math.min(31, Math.max(1, Number(s.day) || 1)),
        note: s.note || ""
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
  async function saveSubs(){
    var err = document.getElementById("subs-form-error");
    var cleaned = subsRows
      .filter(function(r){ return (r.name || "").trim(); })
      .map(function(r){
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
          note: String(r.note || "").trim().slice(0, 200)
        };
      });
    var saveBtn = document.getElementById("subs-save");
    if (saveBtn) saveBtn.disabled = true;
    try {
      await apiFetch("/api/sheets/subscriptions", {
        method: "PUT",
        body: JSON.stringify({ subscriptions: cleaned })
      });
      await loadSubs(); // シート(正)から取り直す
      closeSubsModal();
    } catch(e){
      if (err){ err.hidden = false; err.textContent = apiErrorMessage(e, "サブスク") || "保存に失敗しました"; }
    } finally {
      if (saveBtn) saveBtn.disabled = false;
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
  var financeCategories = null;
  var financeModalWired = false;

  function finYen(n){
    return "¥" + (Math.round(Number(n) || 0)).toLocaleString("ja-JP");
  }
  function finSignedYen(n){
    var v = Math.round(Number(n) || 0);
    return (v < 0 ? "−" : "") + "¥" + Math.abs(v).toLocaleString("ja-JP");
  }
  // 当月の残り日数(JST、当日を含む)
  function finMonthDaysLeft(){
    var p = jstDateKey(new Date()).split("-").map(Number);
    var daysInMonth = new Date(p[0], p[1], 0).getDate(); // p[1] は 1-12
    return daysInMonth - p[2] + 1;
  }

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

  async function loadFinance(){
    var main = document.getElementById("pv-fin-main");
    var addBtn = document.getElementById("pv-fin-add");
    if (!main) return;
    finSetStatus("読み込み中…", false);
    if (addBtn) addBtn.hidden = true;
    try {
      var res = await apiFetch("/api/sheets/finance");
      if (!res || res.configured === false){
        main.hidden = true;
        finSetStatus("設定 → 家計簿スプレッドシート に共有 URL を登録してください。", false);
        return;
      }
      financeCategories = (res.categories && Object.keys(res.categories).length) ? res.categories : FIN_FALLBACK_CATEGORIES;
      var income = Number(res.income) || 0;
      var expense = Number(res.expense) || 0;
      var diff = (res.diff != null) ? Number(res.diff) : (income - expense);
      document.getElementById("pv-fin-income").textContent = finYen(income);
      document.getElementById("pv-fin-expense").textContent = finYen(expense);
      var diffEl = document.getElementById("pv-fin-diff");
      diffEl.textContent = finSignedYen(diff);
      diffEl.classList.toggle("is-neg", diff < 0);
      diffEl.classList.toggle("is-pos", diff >= 0);
      document.getElementById("pv-fin-daysleft").textContent = finMonthDaysLeft() + "日";
      renderFinanceDonut(income, expense);
      main.hidden = false;
      if (addBtn) addBtn.hidden = false;
      finSetStatus("", false);
    } catch (err){
      main.hidden = true;
      var code = err && err.code;
      if (code === "google_scope_missing" || code === "google_not_connected"){
        finSetStatus(apiErrorMessage(err, "家計簿"), true);
      } else {
        finSetStatus(apiErrorMessage(err, "家計簿"), false);
      }
    }
  }

  function finPopulateCategories(type){
    var sel = document.getElementById("fin-category");
    if (!sel) return;
    var list = (financeCategories && financeCategories[type]) || FIN_FALLBACK_CATEGORIES[type] || [];
    sel.innerHTML = "";
    var blank = document.createElement("option");
    blank.value = ""; blank.textContent = "（未選択）";
    sel.appendChild(blank);
    list.forEach(function(c){
      var o = document.createElement("option");
      o.value = c; o.textContent = c;
      sel.appendChild(o);
    });
  }

  function openFinanceModal(){
    var modal = document.getElementById("finance-modal");
    if (!modal) return;
    var errEl = document.getElementById("finance-form-error");
    if (errEl){ errEl.hidden = true; errEl.textContent = ""; }
    var dateEl = document.getElementById("fin-date");
    if (dateEl) dateEl.value = jstDateKey(new Date());
    var typeEl = document.getElementById("fin-type");
    if (typeEl) typeEl.value = "支出";
    var amtEl = document.getElementById("fin-amount");
    if (amtEl) amtEl.value = "";
    var noteEl = document.getElementById("fin-note");
    if (noteEl) noteEl.value = "";
    finPopulateCategories(typeEl ? typeEl.value : "支出");
    modal.hidden = false;
    if (amtEl) amtEl.focus();
  }
  function closeFinanceModal(){
    var modal = document.getElementById("finance-modal");
    if (modal) modal.hidden = true;
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
    if (addBtn) addBtn.addEventListener("click", openFinanceModal);
    if (closeBtn) closeBtn.addEventListener("click", closeFinanceModal);
    if (cancelBtn) cancelBtn.addEventListener("click", closeFinanceModal);
    if (modal) modal.addEventListener("click", function(e){ if (e.target === modal) closeFinanceModal(); });
    if (typeEl) typeEl.addEventListener("change", function(){ finPopulateCategories(typeEl.value); });
    if (reconnectBtn) reconnectBtn.addEventListener("click", function(){ startGoogleConnect("haruka"); });
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
      try {
        await apiFetch("/api/sheets/finance", { method: "POST", body: JSON.stringify(payload) });
        closeFinanceModal();
        loadFinance();
      } catch (err){
        showErr(apiErrorMessage(err, "家計簿"));
      } finally {
        if (saveBtn){ saveBtn.disabled = false; saveBtn.textContent = "保存"; }
      }
    });
  }

  /* ================= プライベート: 習慣トラッカー (v1c / v1c+) =================
     Firestore に習慣定義(habits)と日次ログ(habit_log)を持つ。週は日曜始まり。
     binary(やった/やってない) は 0↔1 トグル、count(回数系) はセルのステッパーで入力。
     周期 daily は分母7、days(曜日指定)は分母=その週の対象曜日数。
     単位 / 一時停止(active) / 色分け(color) / ストリーク(backend が streak を返す) に対応。 */
  var HABIT_COLOR_CSS = {
    cyan: "var(--cyan)", magenta: "var(--magenta)", green: "var(--ok)",
    amber: "var(--warn)", violet: "var(--violet)", pink: "#ff8fc7"
  };
  var HABIT_COLOR_KEYS = ["cyan", "magenta", "green", "amber", "violet", "pink"];
  var HABIT_WD_JA = ["日", "月", "火", "水", "木", "金", "土"];
  var habitWeekKey = startOfWeekKey(jstDateKey(new Date()));
  var habitsState = [];     // [{id,name,type,target,unit,cadence,days,active,color,order,streak}]
  var habitLog = {};        // { habitId: { "YYYY-MM-DD": value } }
  var habitDays = [];       // 表示中の週の7つの dateKey
  var habitLogTimers = {};  // "habitId|date" -> debounce timeout
  var habitTrackerWired = false;
  var habitEditRows = [];   // 管理モーダルの作業コピー
  var habitPopHabitId = null, habitPopDate = null;

  function habitMdLabel(key){ return mdLabel(key); }
  function buildWeekDays(sundayKey){
    var a = []; for (var i = 0; i < 7; i++) a.push(addDaysKey(sundayKey, i)); return a;
  }
  // カード下の1行ステータス表示。habit / plan / cases / contracts / slack で
  // 要素 id 以外は同一だったのでファクトリに集約。(msg, isErr) 呼び出しは従来どおり。
  function makeStatusSetter(elId){
    return function(msg, isErr){
      var el = document.getElementById(elId);
      if (!el) return;
      el.textContent = msg || "";
      el.hidden = !msg;
      el.classList.toggle("is-err", !!isErr);
    };
  }
  var setHabitStatus = makeStatusSetter("pv-habit-status");

  async function loadHabits(){
    var list = document.getElementById("pv-habit-list");
    if (!list) return;
    // 週を切り替えるたびに「読み込み中…」テキストを出すとカード高が伸縮し、
    // 右列(ひいてはページ全体)の高さがガタつく。既存の行は残したまま薄く
    // ディム表示するだけにして、レイアウトを動かさない。
    list.classList.add("is-loading");
    try {
      var res = await apiFetch("/api/habits?week=" + encodeURIComponent(habitWeekKey));
      habitsState = (res.habits || []).slice();
      habitLog = res.log || {};
      habitDays = (res.days && res.days.length === 7) ? res.days : buildWeekDays(habitWeekKey);
      if (res.weekStart) habitWeekKey = res.weekStart;
      renderHabits();
      setHabitStatus("");
    } catch (err){
      habitsState = []; habitLog = {};
      renderHabits();
      setHabitStatus(apiErrorMessage(err, "習慣トラッカー"), true);
    } finally {
      list.classList.remove("is-loading");
    }
  }

  function renderHabits(){
    var list = document.getElementById("pv-habit-list");
    if (!list) return;
    var wk = document.getElementById("pv-habit-week");
    if (wk && habitDays.length === 7) wk.textContent = habitMdLabel(habitDays[0]) + " – " + habitMdLabel(habitDays[6]);
    list.innerHTML = "";

    var active = habitsState.filter(function(h){ return h.active !== false; });
    var paused = habitsState.filter(function(h){ return h.active === false; });

    if (!active.length && !paused.length){
      list.innerHTML = '<div class="pv-habit-empty">「管理」から習慣を追加してください。</div>';
      return;
    }
    if (!active.length){
      list.innerHTML = '<div class="pv-habit-empty">有効な習慣がありません（一時停止中 ' + paused.length + ' 件）。「管理」から再開できます。</div>';
      return;
    }

    var todayKey = jstDateKey(new Date());
    active.forEach(function(h){
      var log = habitLog[h.id] || {};
      var goal = h.type === "count" ? Math.max(1, h.target || 1) : 1;
      var byDays = h.cadence === "days" && Array.isArray(h.days) && h.days.length;
      var scheduled = {};
      habitDays.forEach(function(dk){
        scheduled[dk] = byDays ? (h.days.indexOf(keyWeekday(dk)) !== -1) : true;
      });
      var denom = byDays ? habitDays.filter(function(dk){ return scheduled[dk]; }).length : 7;
      var met = 0;

      var row = document.createElement("div");
      row.className = "pv-habit-row";
      row.setAttribute("data-habit-id", h.id);
      if (h.color && HABIT_COLOR_CSS[h.color]) row.style.setProperty("--habit-accent", HABIT_COLOR_CSS[h.color]);

      var nameEl = document.createElement("div");
      nameEl.className = "pv-habit-name";
      nameEl.textContent = h.name || "(名称未設定)";
      if (h.type === "count"){
        var tgt = document.createElement("span");
        tgt.className = "pv-habit-target";
        tgt.textContent = "×" + goal + (h.unit || "");
        nameEl.appendChild(tgt);
      }
      if (byDays){
        var cad = document.createElement("span");
        cad.className = "pv-habit-cad";
        cad.textContent = h.days.slice().sort(function(a,b){return a-b;}).map(function(d){ return HABIT_WD_JA[d]; }).join("");
        nameEl.appendChild(cad);
      }
      row.appendChild(nameEl);

      var cells = document.createElement("div");
      cells.className = "pv-habit-cells";
      habitDays.forEach(function(dk){
        var v = Number(log[dk]) || 0;
        var isMet = v >= goal;
        var counts = scheduled[dk];
        if (isMet && counts) met++;
        var cell = document.createElement("button");
        cell.type = "button";
        cell.className = "pv-habit-cell " + (h.type === "count" ? "count" : "binary")
          + (isMet ? " met" : "") + (v > 0 && !isMet ? " partial" : "")
          + (dk === todayKey ? " today" : "") + (counts ? "" : " off");
        cell.setAttribute("data-date", dk);
        cell.setAttribute("aria-label", habitMdLabel(dk) + " " + (h.name || ""));
        if (h.type === "count"){
          cell.textContent = v ? String(v) : "";
        } else {
          cell.innerHTML = isMet
            ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M4 12l6 6L20 6"/></svg>'
            : "";
        }
        cell.addEventListener("click", function(){ onHabitCellClick(h, dk, cell); });
        cells.appendChild(cell);
      });
      row.appendChild(cells);

      var meta = document.createElement("div");
      meta.className = "pv-habit-meta";
      var bar = document.createElement("div");
      bar.className = "pv-habit-bar";
      var fill = document.createElement("span");
      fill.style.width = (denom ? Math.round((met / denom) * 100) : 0) + "%";
      bar.appendChild(fill);
      var frac = document.createElement("span");
      frac.className = "pv-habit-frac";
      frac.textContent = met + "/" + denom;
      meta.appendChild(bar);
      if (Number(h.streak) >= 2){
        var st = document.createElement("span");
        st.className = "pv-habit-streak";
        st.textContent = "🔥" + h.streak;
        meta.appendChild(st);
      }
      meta.appendChild(frac);
      row.appendChild(meta);

      list.appendChild(row);
    });

    if (paused.length){
      var note = document.createElement("div");
      note.className = "pv-habit-paused-note";
      note.textContent = "一時停止中 " + paused.length + " 件（「管理」から再開）";
      list.appendChild(note);
    }
  }

  function onHabitCellClick(habit, dateKey, cellEl){
    var cur = Number((habitLog[habit.id] || {})[dateKey]) || 0;
    if (habit.type === "count"){
      openHabitCountPop(habit, dateKey, cellEl);
    } else {
      setHabitValue(habit.id, dateKey, cur >= 1 ? 0 : 1);
    }
  }

  function setHabitValue(habitId, dateKey, value){
    value = Math.max(0, Math.min(1000, Math.round(Number(value) || 0)));
    if (!habitLog[habitId]) habitLog[habitId] = {};
    habitLog[habitId][dateKey] = value;
    renderHabits();
    var tkey = habitId + "|" + dateKey;
    if (habitLogTimers[tkey]) clearTimeout(habitLogTimers[tkey]);
    habitLogTimers[tkey] = setTimeout(function(){
      delete habitLogTimers[tkey];
      apiFetch("/api/habits/log", {
        method: "PUT",
        body: JSON.stringify({ habitId: habitId, date: dateKey, value: value })
      }).catch(function(err){ setHabitStatus(apiErrorMessage(err, "習慣トラッカー"), true); });
    }, 500);
  }

  /* ---- 回数系セルのステッパー(共有ポップオーバー) ---- */
  function openHabitCountPop(habit, dateKey, cellEl){
    var pop = document.getElementById("habit-count-pop");
    var input = document.getElementById("habit-count-input");
    if (!pop || !input) return;
    habitPopHabitId = habit.id; habitPopDate = dateKey;
    input.value = String(Number((habitLog[habit.id] || {})[dateKey]) || 0);
    pop.hidden = false;
    var r = cellEl.getBoundingClientRect();
    var popW = pop.offsetWidth || 136, popH = pop.offsetHeight || 40;
    var left = Math.min(Math.max(8, r.left + r.width / 2 - popW / 2), window.innerWidth - popW - 8);
    var top = r.bottom + 6;
    if (top + popH > window.innerHeight - 8) top = r.top - popH - 6;
    pop.style.left = left + "px";
    pop.style.top = top + "px";
    input.focus(); input.select();
  }
  function closeHabitCountPop(commit){
    var pop = document.getElementById("habit-count-pop");
    if (!pop || pop.hidden) return;
    if (commit && habitPopHabitId && habitPopDate){
      var input = document.getElementById("habit-count-input");
      setHabitValue(habitPopHabitId, habitPopDate, input ? input.value : 0);
    }
    pop.hidden = true;
    habitPopHabitId = null; habitPopDate = null;
  }
  function wireHabitCountPop(){
    var minus = document.getElementById("habit-count-minus");
    var plus = document.getElementById("habit-count-plus");
    var input = document.getElementById("habit-count-input");
    if (minus) minus.addEventListener("click", function(){ input.value = String(Math.max(0, (Number(input.value) || 0) - 1)); input.focus(); });
    if (plus) plus.addEventListener("click", function(){ input.value = String(Math.min(1000, (Number(input.value) || 0) + 1)); input.focus(); });
    if (input) input.addEventListener("keydown", function(e){
      if (e.key === "Enter"){ e.preventDefault(); closeHabitCountPop(true); }
      else if (e.key === "Escape"){ e.preventDefault(); closeHabitCountPop(false); }
    });
    // ポップオーバー外のクリックで確定して閉じる(開いた瞬間の同一クリックは hidden 判定で無視される)
    document.addEventListener("click", function(e){
      var pop = document.getElementById("habit-count-pop");
      if (!pop || pop.hidden) return;
      if (pop.contains(e.target)) return;
      closeHabitCountPop(true);
    }, true);
  }

  /* ---- 管理モーダル (一覧 → タイトルを押して詳細設定 / 新規作成) ---- */
  var habitDetailIdx = null; // null = 一覧ビュー、数値 = その習慣の詳細ビュー

  function openHabitModal(){
    var modal = document.getElementById("habit-modal");
    if (!modal) return;
    var errEl = document.getElementById("habit-form-error");
    if (errEl){ errEl.hidden = true; errEl.textContent = ""; }
    habitEditRows = habitsState.map(function(h){
      return {
        id: h.id,
        name: h.name,
        type: h.type === "count" ? "count" : "binary",
        target: h.target || 1,
        unit: h.unit || "",
        cadence: h.cadence === "days" ? "days" : "daily",
        days: Array.isArray(h.days) ? h.days.slice() : [],
        active: h.active !== false,
        color: HABIT_COLOR_KEYS.indexOf(h.color) !== -1 ? h.color : null
      };
    });
    habitDetailIdx = null;
    renderHabitModal();
    modal.hidden = false;
  }
  function closeHabitModal(){
    var modal = document.getElementById("habit-modal");
    if (modal) modal.hidden = true;
  }
  // Esc / 戻る: 詳細ビューなら一覧へ、一覧ビューならモーダルを閉じる
  function habitModalBack(){
    if (habitDetailIdx != null){ habitDetailIdx = null; renderHabitModal(); }
    else closeHabitModal();
  }
  function mkHabitIconBtn(label, aria, cls, fn){
    var b = document.createElement("button");
    b.type = "button";
    b.className = "habit-edit-btn" + (cls ? " " + cls : "");
    b.textContent = label;
    b.setAttribute("aria-label", aria);
    b.addEventListener("click", fn);
    return b;
  }
  function habitNewRow(){
    return { id: uid(), name: "", type: "binary", target: 1, unit: "", cadence: "daily", days: [], active: true, color: null };
  }
  function habitHint(r){
    var t = r.type === "count" ? ("回数 ×" + (r.target || 1) + (r.unit || "")) : "チェック";
    var c = (r.cadence === "days" && r.days && r.days.length)
      ? r.days.slice().sort(function(a,b){ return a - b; }).map(function(d){ return HABIT_WD_JA[d]; }).join("")
      : "毎日";
    return t + " ・ " + c + (r.active === false ? " ・ 停止中" : "");
  }

  function renderHabitModal(){
    var listView = document.getElementById("habit-list-view");
    var detailView = document.getElementById("habit-detail-view");
    var title = document.getElementById("habit-modal-title");
    var inDetail = habitDetailIdx != null && !!habitEditRows[habitDetailIdx];
    if (!inDetail) habitDetailIdx = null;
    if (listView) listView.hidden = inDetail;
    if (detailView) detailView.hidden = !inDetail;
    if (title) title.textContent = inDetail ? "習慣の設定" : "習慣の管理";
    if (inDetail) renderHabitDetailView(habitDetailIdx);
    else renderHabitListView();
  }

  function renderHabitListView(){
    var wrap = document.getElementById("habit-rows");
    if (!wrap) return;
    wrap.innerHTML = "";
    if (!habitEditRows.length){
      wrap.innerHTML = '<div class="habit-edit-empty">習慣がありません。「＋ 新規作成」から追加してください。</div>';
      return;
    }
    var single = habitEditRows.length <= 1;
    habitEditRows.forEach(function(r, idx){
      var row = document.createElement("div");
      row.className = "habit-list-row" + (r.active === false ? " is-paused" : "");
      row.tabIndex = 0;
      row.setAttribute("role", "button");

      var dot = document.createElement("span");
      dot.className = "habit-list-dot";
      if (r.color && HABIT_COLOR_CSS[r.color]) dot.style.background = HABIT_COLOR_CSS[r.color];
      else dot.classList.add("none");

      var txt = document.createElement("div");
      txt.className = "habit-list-txt";
      var nm = document.createElement("div");
      nm.className = "habit-list-name";
      nm.textContent = (r.name || "").trim() || "（名称未設定）";
      var hint = document.createElement("div");
      hint.className = "habit-list-hint";
      hint.textContent = habitHint(r);
      txt.appendChild(nm); txt.appendChild(hint);

      var up = mkHabitIconBtn("↑", "上へ", "", function(e){
        e.stopPropagation();
        if (idx > 0){ var t = habitEditRows[idx - 1]; habitEditRows[idx - 1] = r; habitEditRows[idx] = t; renderHabitListView(); }
      });
      var down = mkHabitIconBtn("↓", "下へ", "", function(e){
        e.stopPropagation();
        if (idx < habitEditRows.length - 1){ var t = habitEditRows[idx + 1]; habitEditRows[idx + 1] = r; habitEditRows[idx] = t; renderHabitListView(); }
      });
      up.hidden = down.hidden = single;
      up.disabled = idx === 0;
      down.disabled = idx === habitEditRows.length - 1;

      var chev = document.createElement("span");
      chev.className = "habit-list-chev";
      chev.textContent = "›";

      row.appendChild(dot); row.appendChild(txt); row.appendChild(up); row.appendChild(down); row.appendChild(chev);
      function open(){ habitDetailIdx = idx; renderHabitModal(); }
      row.addEventListener("click", open);
      row.addEventListener("keydown", function(e){ if (e.key === "Enter" || e.key === " "){ e.preventDefault(); open(); } });
      wrap.appendChild(row);
    });
  }

  function renderHabitDetailView(idx){
    var body = document.getElementById("habit-detail-body");
    var r = habitEditRows[idx];
    if (!body || !r) return;
    body.innerHTML = "";

    // --- 名前 ---
    var name = document.createElement("input");
    name.type = "text"; name.className = "habit-edit-name"; name.maxLength = 60;
    name.placeholder = "習慣名"; name.value = r.name || "";
    name.addEventListener("input", function(){ r.name = name.value; });
    body.appendChild(name);

    // --- 種別 + 目標 + 単位 ---
    var lineType = document.createElement("div");
    lineType.className = "habit-block-line";
    var type = document.createElement("select");
    type.className = "habit-edit-type";
    type.innerHTML = '<option value="binary">チェック</option><option value="count">回数</option>';
    type.value = r.type;
    var target = document.createElement("input");
    target.type = "number"; target.className = "habit-edit-target";
    target.min = "1"; target.max = "1000"; target.value = String(r.target || 1);
    target.setAttribute("aria-label", "1日の目標回数");
    target.addEventListener("input", function(){ r.target = Math.max(1, Math.round(Number(target.value) || 1)); });
    var unit = document.createElement("input");
    unit.type = "text"; unit.className = "habit-edit-unit"; unit.maxLength = 8;
    unit.placeholder = "単位"; unit.value = r.unit || "";
    unit.setAttribute("aria-label", "単位");
    unit.addEventListener("input", function(){ r.unit = unit.value; });
    function syncTypeUI(){ var c = r.type === "count"; target.hidden = !c; unit.hidden = !c; }
    type.addEventListener("change", function(){ r.type = type.value; syncTypeUI(); });
    syncTypeUI();
    lineType.appendChild(type); lineType.appendChild(target); lineType.appendChild(unit);
    body.appendChild(lineType);

    // --- 周期 ---
    var lineCad = document.createElement("div");
    lineCad.className = "habit-block-line";
    var cad = document.createElement("select");
    cad.className = "habit-edit-cadence";
    cad.innerHTML = '<option value="daily">毎日</option><option value="days">曜日を指定</option>';
    cad.value = r.cadence;
    var daysWrap = document.createElement("div");
    daysWrap.className = "habit-days";
    HABIT_WD_JA.forEach(function(wd, di){
      var b = document.createElement("button");
      b.type = "button"; b.className = "weekday-btn" + (r.days.indexOf(di) !== -1 ? " active" : "");
      b.textContent = wd;
      b.addEventListener("click", function(){
        var p = r.days.indexOf(di);
        if (p === -1) r.days.push(di); else r.days.splice(p, 1);
        b.classList.toggle("active", p === -1);
      });
      daysWrap.appendChild(b);
    });
    function syncCadUI(){ daysWrap.hidden = r.cadence !== "days"; }
    cad.addEventListener("change", function(){ r.cadence = cad.value; syncCadUI(); });
    syncCadUI();
    lineCad.appendChild(cad); lineCad.appendChild(daysWrap);
    body.appendChild(lineCad);

    // --- 色 + 一時停止 ---
    var lineMisc = document.createElement("div");
    lineMisc.className = "habit-block-line habit-block-misc";
    var sw = document.createElement("div");
    sw.className = "habit-swatches";
    function selectSwatch(val){
      r.color = val;
      sw.querySelectorAll(".habit-swatch").forEach(function(el){
        el.classList.toggle("sel", (el.getAttribute("data-color") || null) === (val || null));
      });
    }
    var none = document.createElement("button");
    none.type = "button"; none.className = "habit-swatch none" + (r.color ? "" : " sel");
    none.title = "色なし"; none.setAttribute("aria-label", "色なし");
    none.addEventListener("click", function(){ selectSwatch(null); });
    sw.appendChild(none);
    HABIT_COLOR_KEYS.forEach(function(ck){
      var b = document.createElement("button");
      b.type = "button"; b.className = "habit-swatch" + (r.color === ck ? " sel" : "");
      b.setAttribute("data-color", ck);
      b.style.background = HABIT_COLOR_CSS[ck];
      b.setAttribute("aria-label", "色 " + ck);
      b.addEventListener("click", function(){ selectSwatch(ck); });
      sw.appendChild(b);
    });
    var pause = document.createElement("label");
    pause.className = "habit-pause";
    var pcb = document.createElement("input");
    pcb.type = "checkbox"; pcb.checked = r.active === false;
    pcb.addEventListener("change", function(){ r.active = !pcb.checked; });
    pause.appendChild(pcb);
    pause.appendChild(document.createTextNode(" 一時停止"));
    lineMisc.appendChild(sw); lineMisc.appendChild(pause);
    body.appendChild(lineMisc);
  }

  async function onHabitModalSubmit(e){
    e.preventDefault();
    var errEl = document.getElementById("habit-form-error");
    var saveBtn = document.getElementById("habit-save");
    if (errEl){ errEl.hidden = true; errEl.textContent = ""; }
    function showErr(msg){ if (errEl){ errEl.textContent = msg; errEl.hidden = false; } }
    function failAt(i, msg){ habitDetailIdx = i; renderHabitModal(); showErr(msg); }
    var cleaned = [];
    for (var i = 0; i < habitEditRows.length; i++){
      var r = habitEditRows[i];
      var nm = (r.name || "").trim();
      if (!nm){ failAt(i, "習慣名を入力してください。"); return; }
      var cadence = r.cadence === "days" ? "days" : "daily";
      var days = cadence === "days" ? (r.days || []).filter(function(d){ return d >= 0 && d <= 6; }) : [];
      if (cadence === "days" && !days.length){ failAt(i, "「" + nm + "」の曜日を1つ以上選んでください。"); return; }
      cleaned.push({
        id: r.id,
        name: nm,
        type: r.type === "count" ? "count" : "binary",
        target: r.type === "count" ? Math.max(1, Math.round(Number(r.target) || 1)) : 1,
        unit: r.type === "count" ? String(r.unit || "").trim().slice(0, 8) : "",
        cadence: cadence,
        days: days,
        active: r.active !== false,
        color: HABIT_COLOR_KEYS.indexOf(r.color) !== -1 ? r.color : null
      });
    }
    if (saveBtn){ saveBtn.disabled = true; saveBtn.textContent = "保存中…"; }
    try {
      await apiFetch("/api/habits/bulk", { method: "PUT", body: JSON.stringify({ habits: cleaned }) });
      closeHabitModal();
      loadHabits();
    } catch (err){
      if (errEl){ errEl.textContent = apiErrorMessage(err, "習慣トラッカー"); errEl.hidden = false; }
    } finally {
      if (saveBtn){ saveBtn.disabled = false; saveBtn.textContent = "保存"; }
    }
  }

  function wireHabitTracker(){
    if (habitTrackerWired) return;
    habitTrackerWired = true;
    var prev = document.getElementById("pv-habit-prev");
    var next = document.getElementById("pv-habit-next");
    var manage = document.getElementById("pv-habit-manage");
    if (prev) prev.addEventListener("click", function(){ habitWeekKey = addDaysKey(habitWeekKey, -7); loadHabits(); });
    if (next) next.addEventListener("click", function(){ habitWeekKey = addDaysKey(habitWeekKey, 7); loadHabits(); });
    if (manage) manage.addEventListener("click", openHabitModal);

    var modal = document.getElementById("habit-modal");
    var closeBtn = document.getElementById("habit-modal-close");
    var cancelBtn = document.getElementById("habit-cancel");
    var newBtn = document.getElementById("habit-new");
    var backBtn = document.getElementById("habit-detail-back");
    var delBtn = document.getElementById("habit-detail-del");
    var form = document.getElementById("habit-form");
    if (closeBtn) closeBtn.addEventListener("click", closeHabitModal);
    if (cancelBtn) cancelBtn.addEventListener("click", closeHabitModal);
    if (modal) modal.addEventListener("click", function(e){ if (e.target === modal) closeHabitModal(); });
    if (newBtn) newBtn.addEventListener("click", function(){
      habitEditRows.push(habitNewRow());
      habitDetailIdx = habitEditRows.length - 1; // 新規はそのまま詳細を開く
      renderHabitModal();
    });
    if (backBtn) backBtn.addEventListener("click", function(){ habitDetailIdx = null; renderHabitModal(); });
    if (delBtn) delBtn.addEventListener("click", async function(){
      if (habitDetailIdx == null) return;
      var r = habitEditRows[habitDetailIdx];
      if (r && r.name && !(await askConfirm('「' + r.name + '」を削除しますか?'))) return;
      habitEditRows.splice(habitDetailIdx, 1);
      habitDetailIdx = null;
      renderHabitModal();
    });
    if (form) form.addEventListener("submit", onHabitModalSubmit);

    wireHabitCountPop();
  }

  /* ================= プライベート: TODAY'S PLAN (v1d) =================
     Firestore にその日のチェックリスト(plan/{YYYY-MM-DD})とテンプレート(plan_templates)を持つ。
     カレンダー非連動。時刻は任意で、バックエンドが時刻順にソートして返す。
     今日ぶんが無いときはバックエンドが曜日の既定テンプレ(設定)を複製して生成する。
     繰り越しなし。テンプレ適用時に既存項目があれば「追記/置き換え/キャンセル」を聞く。 */
  var planDateKey = jstDateKey(new Date());
  var planItems = [];           // [{id,text,time,done}]
  var planTemplates = [];       // [{id,name,items:[{id,text,time}],order}]
  var planSaveTimer = null;
  var planWired = false;
  var planTplRows = [];         // テンプレ管理モーダルの作業コピー
  var planTplDetailIdx = null;  // null = 一覧ビュー、数値 = そのテンプレの詳細ビュー
  var planApplyResolve = null;

  var planSetStatus = makeStatusSetter("pv-plan-status");

  // "HH:MM" として妥当なら 0 詰めして返す。それ以外は ""。
  function planNormTime(v){
    var s = String(v == null ? "" : v).trim();
    var m = s.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return "";
    var h = Number(m[1]), mm = Number(m[2]);
    if (h < 0 || h > 23 || mm < 0 || mm > 59) return "";
    return String(h).padStart(2, "0") + ":" + m[2];
  }

  // 時刻付き → 昇順で先、時刻なし → その後ろ(元の配列順を保持)。サーバーと同じ規則。
  function sortPlanItems(items){
    return items.map(function(it, i){ return { it: it, i: i }; }).sort(function(a, b){
      var ta = a.it.time || "", tb = b.it.time || "";
      if (ta && tb) return ta < tb ? -1 : ta > tb ? 1 : a.i - b.i;
      if (ta) return -1;
      if (tb) return 1;
      return a.i - b.i;
    }).map(function(x){ return x.it; });
  }

  function planDateLabel(key){
    var p = keyParts(key);
    return p.m + "月" + p.d + "日(" + DOW_JA[keyWeekday(key)] + ")";
  }

  async function loadPlan(){
    var list = document.getElementById("pv-plan-list");
    if (!list) return;
    // 習慣トラッカーと同じ理由でローディングテキストは出さない(日付を送るたびに
    // カード高が伸縮するのを防ぐ)。既存行を残して薄くディムするだけにする。
    list.classList.add("is-loading");
    try {
      var res = await apiFetch("/api/plan?date=" + encodeURIComponent(planDateKey));
      planItems = (res.items || []).slice();
      planTemplates = res.templates || [];
      if (res.date) planDateKey = res.date;
      renderPlan();
      planSetStatus("");
    } catch (err){
      planItems = []; planTemplates = [];
      renderPlan();
      planSetStatus(apiErrorMessage(err, "TODAY'S PLAN"), true);
    } finally {
      list.classList.remove("is-loading");
    }
  }

  function renderPlan(){
    var list = document.getElementById("pv-plan-list");
    if (!list) return;
    var dateEl = document.getElementById("pv-plan-date");
    if (dateEl) dateEl.textContent = planDateLabel(planDateKey);

    // 日付ナビの状態。今日以外を見ているときは「今日へ」を出し、日付を強調。
    // 未来には進めない(過去の記録を見返す用途なので next は今日で頭打ち)。
    var todayKey = jstDateKey(new Date());
    var isToday = planDateKey === todayKey;
    if (dateEl) dateEl.classList.toggle("is-other", !isToday);
    var todayBtn = document.getElementById("pv-plan-today");
    if (todayBtn) todayBtn.hidden = isToday;
    var nextBtn = document.getElementById("pv-plan-next");
    if (nextBtn) nextBtn.disabled = planDateKey >= todayKey;

    planItems = sortPlanItems(planItems);
    var total = planItems.length;
    var done = planItems.filter(function(it){ return it.done; }).length;
    var fill = document.getElementById("pv-plan-fill");
    var frac = document.getElementById("pv-plan-frac");
    if (fill) fill.style.width = (total ? Math.round((done / total) * 100) : 0) + "%";
    if (frac) frac.textContent = done + "/" + total;

    list.innerHTML = "";
    if (!total){
      list.innerHTML = '<div class="pv-plan-empty">項目を追加、または「テンプレ」から適用してください。</div>';
      return;
    }
    planItems.forEach(function(it){
      var row = document.createElement("div");
      row.className = "pv-plan-item" + (it.done ? " is-done" : "");

      var cb = document.createElement("button");
      cb.type = "button";
      cb.className = "pv-plan-check";
      cb.setAttribute("aria-label", it.done ? "未完了に戻す" : "完了にする");
      cb.innerHTML = it.done
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M4 12l6 6L20 6"/></svg>'
        : "";
      cb.addEventListener("click", function(){ togglePlanItem(it.id); });

      var tm = document.createElement("span");
      tm.className = "pv-plan-time";
      tm.textContent = it.time || "";

      var tx = document.createElement("span");
      tx.className = "pv-plan-text";
      tx.textContent = it.text;
      tx.title = "タップで編集";
      tx.addEventListener("click", function(){ editPlanItem(it.id, tx); });

      var del = document.createElement("button");
      del.type = "button";
      del.className = "pv-plan-del";
      del.setAttribute("aria-label", "削除");
      del.textContent = "×";
      del.addEventListener("click", function(){ removePlanItem(it.id); });

      row.appendChild(cb); row.appendChild(tm); row.appendChild(tx); row.appendChild(del);
      list.appendChild(row);
    });
  }

  function schedulePlanSave(){
    if (planSaveTimer) clearTimeout(planSaveTimer);
    planSaveTimer = setTimeout(function(){
      planSaveTimer = null;
      apiFetch("/api/plan/day", {
        method: "PUT",
        body: JSON.stringify({ date: planDateKey, items: planItems })
      }).catch(function(err){ planSetStatus(apiErrorMessage(err, "TODAY'S PLAN"), true); });
    }, 500);
  }

  function togglePlanItem(id){
    var it = planItems.find(function(x){ return x.id === id; });
    if (!it) return;
    it.done = !it.done;
    renderPlan();
    schedulePlanSave();
  }
  function removePlanItem(id){
    planItems = planItems.filter(function(x){ return x.id !== id; });
    renderPlan();
    schedulePlanSave();
  }
  // テキスト span をその場でインライン編集にする。空にして確定したら削除。
  function editPlanItem(id, textEl){
    var it = planItems.find(function(x){ return x.id === id; });
    if (!it || textEl.querySelector("input")) return;
    var inp = document.createElement("input");
    inp.type = "text"; inp.className = "pv-plan-edit"; inp.maxLength = 120; inp.value = it.text;
    textEl.textContent = "";
    textEl.appendChild(inp);
    inp.focus(); inp.select();
    var closed = false;
    function commit(save){
      if (closed) return;
      closed = true;
      var v = inp.value.trim().slice(0, 120);
      if (save && !v){ removePlanItem(id); return; }
      if (save && v && v !== it.text){ it.text = v; schedulePlanSave(); }
      renderPlan();
    }
    inp.addEventListener("keydown", function(e){
      if (e.key === "Enter"){ e.preventDefault(); commit(true); }
      else if (e.key === "Escape"){ e.preventDefault(); commit(false); }
    });
    inp.addEventListener("blur", function(){ commit(true); });
  }

  function wirePlanAdd(){
    var form = document.getElementById("pv-plan-add-form");
    var text = document.getElementById("pv-plan-add-text");
    var time = document.getElementById("pv-plan-add-time");
    if (!form) return;
    form.addEventListener("submit", function(e){
      e.preventDefault();
      var t = (text.value || "").trim().slice(0, 120);
      if (!t) return;
      planItems.push({ id: uid(), text: t, time: planNormTime(time.value), done: false });
      text.value = ""; time.value = "";
      text.focus();
      renderPlan();
      schedulePlanSave();
    });
  }

  /* ---- テンプレ適用の3択ダイアログ ---- */
  function planApplyChoice(msg){
    return new Promise(function(resolve){
      var modal = document.getElementById("plan-apply-modal");
      var msgEl = document.getElementById("plan-apply-msg");
      if (!modal){ resolve("cancel"); return; }
      if (msgEl) msgEl.textContent = msg;
      modal.hidden = false;
      planApplyResolve = resolve;
    });
  }
  function closePlanApply(choice){
    var modal = document.getElementById("plan-apply-modal");
    if (modal) modal.hidden = true;
    var r = planApplyResolve;
    planApplyResolve = null;
    if (r) r(choice || "cancel");
  }

  async function applyPlanTemplateItems(items){
    var copy = (items || []).filter(function(it){ return (it.text || "").trim(); }).map(function(it){
      return { id: uid(), text: String(it.text).trim().slice(0, 120), time: planNormTime(it.time), done: false };
    });
    if (!copy.length){ planSetStatus("このテンプレには項目がありません。", true); return; }
    var mode = "replace";
    if (planItems.length){
      mode = await planApplyChoice("今日のリストにはすでに " + planItems.length + " 件あります。どうしますか？");
      if (mode === "cancel") return;
    }
    planItems = (mode === "append") ? planItems.concat(copy) : copy;
    closePlanModal();
    renderPlan();
    schedulePlanSave();
    planSetStatus("");
  }

  /* ---- テンプレ管理モーダル (一覧 → タイトルを押して詳細 / 新規作成) ---- */
  function openPlanModal(){
    var modal = document.getElementById("plan-modal");
    if (!modal) return;
    var errEl = document.getElementById("plan-form-error");
    if (errEl){ errEl.hidden = true; errEl.textContent = ""; }
    planTplRows = planTemplates.map(function(t){
      return {
        id: t.id,
        name: t.name,
        items: (t.items || []).map(function(it){ return { id: it.id || uid(), text: it.text, time: it.time || "" }; }),
        cadence: t.cadence === "daily" ? "daily" : (t.cadence === "days" ? "days" : "manual"),
        days: Array.isArray(t.days) ? t.days.slice() : []
      };
    });
    planTplDetailIdx = null;
    renderPlanModal();
    modal.hidden = false;
  }
  function closePlanModal(){
    var modal = document.getElementById("plan-modal");
    if (modal) modal.hidden = true;
  }
  function planModalBack(){
    if (planTplDetailIdx != null){ planTplDetailIdx = null; renderPlanModal(); }
    else closePlanModal();
  }
  function planTplHint(r){
    var n = (r.items || []).filter(function(it){ return (it.text || "").trim(); }).length;
    var base = n ? (n + " 項目") : "項目なし";
    var timed = r.items.filter(function(it){ return it.time; }).length;
    if (n && timed) base += " ・ 時刻付き " + timed;
    var cad = r.cadence === "daily" ? "毎日自動"
      : (r.cadence === "days" && r.days && r.days.length)
        ? r.days.slice().sort(function(a,b){ return a - b; }).map(function(d){ return HABIT_WD_JA[d]; }).join("") + "に自動"
        : "手動のみ";
    return base + " ・ " + cad;
  }
  function renderPlanModal(){
    var listView = document.getElementById("plan-list-view");
    var detailView = document.getElementById("plan-detail-view");
    var title = document.getElementById("plan-modal-title");
    var inDetail = planTplDetailIdx != null && !!planTplRows[planTplDetailIdx];
    if (!inDetail) planTplDetailIdx = null;
    if (listView) listView.hidden = inDetail;
    if (detailView) detailView.hidden = !inDetail;
    if (title) title.textContent = inDetail ? "テンプレートの設定" : "テンプレートの管理";
    if (inDetail) renderPlanTplDetail(planTplDetailIdx);
    else renderPlanTplList();
  }
  function renderPlanTplList(){
    var wrap = document.getElementById("plan-rows");
    if (!wrap) return;
    wrap.innerHTML = "";
    if (!planTplRows.length){
      wrap.innerHTML = '<div class="habit-edit-empty">テンプレートがありません。「＋ 新規作成」から追加してください。</div>';
      return;
    }
    var single = planTplRows.length <= 1;
    planTplRows.forEach(function(r, idx){
      var row = document.createElement("div");
      row.className = "habit-list-row";
      row.tabIndex = 0;
      row.setAttribute("role", "button");

      var txt = document.createElement("div");
      txt.className = "habit-list-txt";
      var nm = document.createElement("div");
      nm.className = "habit-list-name";
      nm.textContent = (r.name || "").trim() || "（名称未設定）";
      var hint = document.createElement("div");
      hint.className = "habit-list-hint";
      hint.textContent = planTplHint(r);
      txt.appendChild(nm); txt.appendChild(hint);

      var up = mkHabitIconBtn("↑", "上へ", "", function(e){
        e.stopPropagation();
        if (idx > 0){ var t = planTplRows[idx - 1]; planTplRows[idx - 1] = r; planTplRows[idx] = t; renderPlanTplList(); }
      });
      var down = mkHabitIconBtn("↓", "下へ", "", function(e){
        e.stopPropagation();
        if (idx < planTplRows.length - 1){ var t = planTplRows[idx + 1]; planTplRows[idx + 1] = r; planTplRows[idx] = t; renderPlanTplList(); }
      });
      up.hidden = down.hidden = single;
      up.disabled = idx === 0;
      down.disabled = idx === planTplRows.length - 1;

      var chev = document.createElement("span");
      chev.className = "habit-list-chev";
      chev.textContent = "›";

      row.appendChild(txt); row.appendChild(up); row.appendChild(down); row.appendChild(chev);
      function open(){ planTplDetailIdx = idx; renderPlanModal(); }
      row.addEventListener("click", open);
      row.addEventListener("keydown", function(e){ if (e.key === "Enter" || e.key === " "){ e.preventDefault(); open(); } });
      wrap.appendChild(row);
    });
  }
  function renderPlanTplDetail(idx){
    var body = document.getElementById("plan-detail-body");
    var r = planTplRows[idx];
    if (!body || !r) return;
    body.innerHTML = "";

    var name = document.createElement("input");
    name.type = "text"; name.className = "habit-edit-name"; name.maxLength = 40;
    name.placeholder = "テンプレ名（例：平日）"; name.value = r.name || "";
    name.addEventListener("input", function(){ r.name = name.value; });
    body.appendChild(name);

    // --- 周期(自動適用の条件) ---
    var lineCad = document.createElement("div");
    lineCad.className = "habit-block-line";
    var cad = document.createElement("select");
    cad.className = "habit-edit-cadence plan-tpl-cadence";
    cad.innerHTML = '<option value="manual">手動のみ</option><option value="daily">毎日自動適用</option><option value="days">曜日を指定して自動適用</option>';
    cad.value = r.cadence || "manual";
    var daysWrap = document.createElement("div");
    daysWrap.className = "habit-days";
    HABIT_WD_JA.forEach(function(wd, di){
      var b = document.createElement("button");
      b.type = "button"; b.className = "weekday-btn" + (r.days.indexOf(di) !== -1 ? " active" : "");
      b.textContent = wd;
      b.addEventListener("click", function(){
        var p = r.days.indexOf(di);
        if (p === -1) r.days.push(di); else r.days.splice(p, 1);
        b.classList.toggle("active", p === -1);
      });
      daysWrap.appendChild(b);
    });
    function syncCadUI(){ daysWrap.hidden = r.cadence !== "days"; }
    cad.addEventListener("change", function(){ r.cadence = cad.value; syncCadUI(); });
    syncCadUI();
    lineCad.appendChild(cad); lineCad.appendChild(daysWrap);
    body.appendChild(lineCad);
    var cadHint = document.createElement("p");
    cadHint.className = "plan-tpl-cad-hint";
    cadHint.textContent = "自動適用は、その日のプランが空のときだけ働きます（既存の項目は消しません）。";
    body.appendChild(cadHint);

    var itemsWrap = document.createElement("div");
    itemsWrap.className = "plan-tpl-items";
    body.appendChild(itemsWrap);

    function renderItems(){
      itemsWrap.innerHTML = "";
      r.items.forEach(function(it, i){
        var line = document.createElement("div");
        line.className = "plan-tpl-line";
        var tx = document.createElement("input");
        tx.type = "text"; tx.className = "plan-tpl-text"; tx.maxLength = 120;
        tx.placeholder = "やること"; tx.value = it.text || "";
        tx.addEventListener("input", function(){ it.text = tx.value; });
        var tm = document.createElement("input");
        tm.type = "time"; tm.className = "plan-tpl-time";
        tm.value = it.time || "";
        tm.setAttribute("aria-label", "時刻（任意）");
        tm.addEventListener("input", function(){ it.time = planNormTime(tm.value); });
        var del = mkHabitIconBtn("×", "削除", "habit-edit-del", function(){
          r.items.splice(i, 1); renderItems();
        });
        line.appendChild(tx); line.appendChild(tm); line.appendChild(del);
        itemsWrap.appendChild(line);
      });
      var add = document.createElement("button");
      add.type = "button"; add.className = "ev-btn plan-tpl-additem";
      add.textContent = "＋ 項目を追加";
      add.addEventListener("click", function(){ r.items.push({ id: uid(), text: "", time: "" }); renderItems(); });
      itemsWrap.appendChild(add);
    }
    renderItems();
  }

  async function onPlanModalSubmit(e){
    e.preventDefault();
    var errEl = document.getElementById("plan-form-error");
    var saveBtn = document.getElementById("plan-save");
    if (errEl){ errEl.hidden = true; errEl.textContent = ""; }
    function showErr(msg){ if (errEl){ errEl.textContent = msg; errEl.hidden = false; } }
    function failAt(i, msg){ planTplDetailIdx = i; renderPlanModal(); showErr(msg); }
    var cleaned = [];
    for (var i = 0; i < planTplRows.length; i++){
      var r = planTplRows[i];
      var nm = (r.name || "").trim();
      if (!nm){ failAt(i, "テンプレ名を入力してください。"); return; }
      var cadence = r.cadence === "daily" ? "daily" : (r.cadence === "days" ? "days" : "manual");
      var days = cadence === "days" ? (r.days || []).filter(function(d){ return d >= 0 && d <= 6; }) : [];
      if (cadence === "days" && !days.length){ failAt(i, "「" + nm + "」の曜日を1つ以上選んでください。"); return; }
      var items = (r.items || []).map(function(it){
        return { id: it.id || uid(), text: String(it.text || "").trim().slice(0, 120), time: planNormTime(it.time) };
      }).filter(function(it){ return it.text; });
      cleaned.push({ id: r.id, name: nm.slice(0, 40), items: items, cadence: cadence, days: days });
    }
    if (saveBtn){ saveBtn.disabled = true; saveBtn.textContent = "保存中…"; }
    try {
      await apiFetch("/api/plan/templates", { method: "PUT", body: JSON.stringify({ templates: cleaned }) });
      closePlanModal();
      loadPlan();
    } catch (err){
      if (errEl){ errEl.textContent = apiErrorMessage(err, "TODAY'S PLAN"); errEl.hidden = false; }
    } finally {
      if (saveBtn){ saveBtn.disabled = false; saveBtn.textContent = "保存"; }
    }
  }

  function wirePlan(){
    if (planWired) return;
    planWired = true;
    wirePlanAdd();

    // 日付ナビ(前日 / 翌日 / 今日へ)。過去の TODAY'S PLAN を見返せるようにする。
    var prevDay = document.getElementById("pv-plan-prev");
    var nextDay = document.getElementById("pv-plan-next");
    var todayDay = document.getElementById("pv-plan-today");
    if (prevDay) prevDay.addEventListener("click", function(){
      planDateKey = addDaysKey(planDateKey, -1); loadPlan();
    });
    if (nextDay) nextDay.addEventListener("click", function(){
      if (planDateKey >= jstDateKey(new Date())) return;
      planDateKey = addDaysKey(planDateKey, 1); loadPlan();
    });
    if (todayDay) todayDay.addEventListener("click", function(){
      planDateKey = jstDateKey(new Date()); loadPlan();
    });

    var tplBtn = document.getElementById("pv-plan-templates");
    if (tplBtn) tplBtn.addEventListener("click", openPlanModal);

    var modal = document.getElementById("plan-modal");
    var closeBtn = document.getElementById("plan-modal-close");
    var cancelBtn = document.getElementById("plan-cancel");
    var newBtn = document.getElementById("plan-new");
    var backBtn = document.getElementById("plan-detail-back");
    var delBtn = document.getElementById("plan-detail-del");
    var applyBtn = document.getElementById("plan-detail-apply");
    var form = document.getElementById("plan-form");
    if (closeBtn) closeBtn.addEventListener("click", closePlanModal);
    if (cancelBtn) cancelBtn.addEventListener("click", closePlanModal);
    if (modal) modal.addEventListener("click", function(e){ if (e.target === modal) closePlanModal(); });
    if (newBtn) newBtn.addEventListener("click", function(){
      planTplRows.push({ id: uid(), name: "", items: [], cadence: "manual", days: [] });
      planTplDetailIdx = planTplRows.length - 1;
      renderPlanModal();
    });
    if (backBtn) backBtn.addEventListener("click", function(){ planTplDetailIdx = null; renderPlanModal(); });
    if (delBtn) delBtn.addEventListener("click", async function(){
      if (planTplDetailIdx == null) return;
      var r = planTplRows[planTplDetailIdx];
      if (r && r.name && !(await askConfirm('「' + r.name + '」を削除しますか?'))) return;
      planTplRows.splice(planTplDetailIdx, 1);
      planTplDetailIdx = null;
      renderPlanModal();
    });
    if (applyBtn) applyBtn.addEventListener("click", function(){
      if (planTplDetailIdx == null) return;
      applyPlanTemplateItems(planTplRows[planTplDetailIdx].items);
    });
    if (form) form.addEventListener("submit", onPlanModalSubmit);

    var aAppend = document.getElementById("plan-apply-append");
    var aReplace = document.getElementById("plan-apply-replace");
    var aCancel = document.getElementById("plan-apply-cancel");
    var aModal = document.getElementById("plan-apply-modal");
    if (aAppend) aAppend.addEventListener("click", function(){ closePlanApply("append"); });
    if (aReplace) aReplace.addEventListener("click", function(){ closePlanApply("replace"); });
    if (aCancel) aCancel.addEventListener("click", function(){ closePlanApply("cancel"); });
    if (aModal) aModal.addEventListener("click", function(e){ if (e.target === aModal) closePlanApply("cancel"); });
  }

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

  var contractSetStatus = makeStatusSetter("pv-contracts-status");

  function applyContracts(list){
    contractsState = list || [];
    contractsLoadOk = true;
    renderContracts();
    contractSetStatus("");
  }
  function failContracts(err){
    contractsState = [];
    renderContracts();
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

  function renderContracts(){
    var list = document.getElementById("pv-contracts-list");
    if (!list) return;
    renderContractsTabs();
    list.innerHTML = "";
    if (!contractsState.length){
      list.innerHTML = '<div class="pv-habit-empty">「管理」から契約書を追加してください。</div>';
      return;
    }

    var q = contractsQuery.trim().toLowerCase();
    var filtered = contractsState.filter(function(c){
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

    if (!filtered.length){
      list.innerHTML = '<div class="pv-habit-empty">該当する契約書がありません。</div>';
      return;
    }
    // カードは2件まで。残りは「…ほか N件」で示し、全件は「管理」モーダルで見る。
    var CONTRACTS_CARD_MAX = 2;
    filtered.slice(0, CONTRACTS_CARD_MAX).forEach(function(c){
      var alerts = contractAlertLabels(c);
      var pending = c.status !== "締結済み" && c.status !== "報告済み";
      var overdue = alerts.indexOf("⚠ 期限超過") !== -1;
      var row = document.createElement("div");
      row.className = "pv-contract-row" + (pending ? " is-pending" : "") + (alerts.length ? " is-alert" : "") + (overdue ? " is-overdue" : "");
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
      row.appendChild(head);

      // 契約書名が会社名と別なら、小さくサブ行に出す。
      if (c.title && c.title !== c.client){
        var sub = document.createElement("div");
        sub.className = "pv-contract-subtitle";
        sub.textContent = c.title;
        row.appendChild(sub);
      }

      var metaLine = [];
      if (c.requestedDate) metaLine.push("依頼 " + contractMD(c.requestedDate));
      if (c.sentDate) metaLine.push("送付 " + contractMD(c.sentDate));
      if (c.signedDate) metaLine.push("締結 " + contractMD(c.signedDate));
      if (c.requestedBy) metaLine.push(c.requestedBy + " 依頼");
      if (c.dueDate) metaLine.push("期限 " + contractMD(c.dueDate) + " まで");
      if (metaLine.length){
        var meta = document.createElement("div");
        meta.className = "pv-case-client";
        meta.textContent = metaLine.join(" ・ ");
        row.appendChild(meta);
      }

      // 一覧のカードを直接タップ → 管理モーダルを開いてその契約書の詳細ビューへ直行。
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      (function(id){
        function open(){ openContractModal(id); }
        row.addEventListener("click", open);
        row.addEventListener("keydown", function(e){
          if (e.key === "Enter" || e.key === " "){ e.preventDefault(); open(); }
        });
      })(c.id);

      list.appendChild(row);
    });
    if (filtered.length > CONTRACTS_CARD_MAX){
      var more = document.createElement("button");
      more.type = "button";
      more.className = "pv-list-more";
      more.textContent = "…ほか " + (filtered.length - CONTRACTS_CARD_MAX) + " 件（「管理」で全件）";
      more.addEventListener("click", function(){ openContractModal(); });
      list.appendChild(more);
    }
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
    return { id: uid(), title: "", client: "", requestedBy: "", status: "依頼受領", requestedDate: "", sentDate: "", signedDate: "", dueDate: "", confidential: false, source: "manual" };
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
      renderContracts();
    });
    var qInput = document.getElementById("pv-contracts-q");
    if (qInput) qInput.addEventListener("input", function(){ contractsQuery = qInput.value; renderContracts(); });
    var reqSel = document.getElementById("pv-contracts-requester");
    if (reqSel) reqSel.addEventListener("change", function(){ contractsRequester = reqSel.value; renderContracts(); });

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
        renderContracts();
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

  function applyEventTrackers(list, templates){
    eventTrackersState = list || [];
    if (templates !== undefined) eventTemplatesState = templates || [];
    eventTrackersLoadOk = true;
    renderEventTrackers();
    eventSetStatus("");
  }
  function failEventTrackers(err){
    eventTrackersState = [];
    renderEventTrackers();
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

  function renderEventTrackers(){
    var list = document.getElementById("pv-events-list");
    if (!list) return;
    list.innerHTML = "";
    var active = eventTrackersState.filter(function(t){ return !t.archived; });
    if (!active.length){
      list.innerHTML = '<div class="pv-habit-empty">「管理」からプロジェクトを追加してください。</div>';
      return;
    }
    var today = jstDateKey(new Date());
    active.forEach(function(t){
      var pct = eventProgress(t);
      var done = t.status === "完了" || pct >= 100;
      var overdue = t.dueDate && t.dueDate < today && !done;
      var overdueItems = eventOverdueItems(t);
      var row = document.createElement("div");
      row.className = "pv-event-row" + (done ? " is-done" : "") + (overdue ? " is-overdue" : "");
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
      st.textContent = t.status;
      head.appendChild(st);
      if (t.autoIngest === false){
        var ao = document.createElement("span"); ao.className = "pv-event-autooff"; ao.textContent = "自動オフ"; ao.title = "event-digest の対象外"; head.appendChild(ao);
      } else if (t.digest && t.digest.length){
        var ab = document.createElement("span"); ab.className = "pv-contract-slack-badge"; ab.textContent = "自動反映"; ab.title = "メール／Slackから自動入力された進捗があります"; head.appendChild(ab);
      }
      row.appendChild(head);

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
        dg.textContent = "💬 " + t.digest[0];
        row.appendChild(dg);
      }

      (function(id){
        function open(){ openEventModal(id); }
        row.addEventListener("click", open);
        row.addEventListener("keydown", function(e){ if (e.key === "Enter" || e.key === " "){ e.preventDefault(); open(); } });
      })(t.id);
      list.appendChild(row);
    });
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
        });
        var del = mkHabitIconBtn("×", "削除", "habit-edit-del", function(){ r.items.splice(i, 1); renderItems(); });
        line.appendChild(cb); line.appendChild(tx); line.appendChild(del);
        var sub = document.createElement("div");
        sub.className = "pv-event-item-sub";
        var note = document.createElement("input");
        note.type = "text"; note.className = "pv-event-item-note"; note.maxLength = 400;
        note.placeholder = "メモ（任意）"; note.value = it.note || "";
        note.addEventListener("input", function(){ it.note = note.value; it.source = "manual"; });
        sub.appendChild(dd); sub.appendChild(note);
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
        var del = mkHabitIconBtn("×", "削除", "habit-edit-del", function(){ r.items.splice(i, 1); renderItems(); });
        line.appendChild(tx); line.appendChild(del);
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

  /* ================= ビジネス画面 =================
     TODAY は共通ロジック(tick)が biz 要素も更新する。ここではヒーロー画像・
     プロジェクトボード(event_trackers)・最近のメモ(SYSLEA タグ)を担当。 */
  function initBusiness(){
    var img = document.getElementById("biz-hero-img");
    if (img && !img.getAttribute("src") && HERO_ILLUSTRATIONS.length){
      img.src = HERO_ILLUSTRATIONS[Math.floor(Math.random() * HERO_ILLUSTRATIONS.length)];
    }
    wireContracts();
    wireEventTrackers();
    loadBusinessBootstrap();
    var noteNewBtn = document.getElementById("biz-note-new");
    if (noteNewBtn) noteNewBtn.addEventListener("click", function(){ openNewNote("syslea"); });
    if (!notesInitialized){
      notesInitialized = true;
      initNotes();
    } else {
      renderBizNotes();
    }
    var taskNewBtn = document.getElementById("biz-task-new");
    if (taskNewBtn) taskNewBtn.addEventListener("click", function(){ openNewTask("syslea"); });
    if (!tasksInitialized){
      tasksInitialized = true;
      initTasks();
    } else {
      renderBizTasks();
    }
  }

  /* ================= calendar page: state ================= */
  var HOUR_PX = 48;
  var calState = { view: "day", account: "haruka", anchor: jstDateKey(new Date()), events: [] };
  var calLoadToken = 0;

  var calRangeLabel = document.getElementById("cal-range-label");
  var calStatusBar = document.getElementById("cal-status-bar");
  var calGridContainer = document.getElementById("cal-grid-container");

  function formatDateLabelLong(key){
    var p = keyParts(key);
    return p.y + "年" + p.m + "月" + p.d + "日(" + DOW_JA[keyWeekday(key)] + ")";
  }
  function formatDateLabelShort(key){ return mdLabel(key); }
  function formatColHeader(key){
    var p = keyParts(key);
    var today = key === jstDateKey(new Date());
    return p.m + "/" + p.d + "(" + DOW_JA[keyWeekday(key)] + ")" + (today ? " ・TODAY" : "");
  }
  function formatRangeLabel(){
    if (calState.view === "day") return formatDateLabelLong(calState.anchor);
    if (calState.view === "week"){
      var s = startOfWeekKey(calState.anchor), e = addDaysKey(s, 6);
      return formatDateLabelShort(s) + " – " + formatDateLabelShort(e);
    }
    var p = keyParts(calState.anchor);
    return p.y + "年" + p.m + "月";
  }
  function updateViewButtons(){
    document.querySelectorAll(".cal-view-btn").forEach(function(btn){
      btn.classList.toggle("active", btn.getAttribute("data-view") === calState.view);
    });
    calRangeLabel.textContent = formatRangeLabel();
  }

  function calGoToday(){ calState.anchor = jstDateKey(new Date()); loadAndRenderCalendar(); }
  function calShift(dir){
    if (calState.view === "day") calState.anchor = addDaysKey(calState.anchor, dir);
    else if (calState.view === "week") calState.anchor = addDaysKey(calState.anchor, dir * 7);
    else {
      var p = keyParts(calState.anchor);
      var m = p.m + dir, y = p.y;
      if (m < 1){ m = 12; y--; } if (m > 12){ m = 1; y++; }
      var dim = daysInMonth(y, m);
      calState.anchor = y + "-" + String(m).padStart(2,"0") + "-" + String(Math.min(p.d, dim)).padStart(2,"0");
    }
    loadAndRenderCalendar();
  }
  function calSetView(v){ calState.view = v; loadAndRenderCalendar(); }

  document.getElementById("cal-today").addEventListener("click", calGoToday);
  document.getElementById("cal-prev").addEventListener("click", function(){ calShift(-1); });
  document.getElementById("cal-next").addEventListener("click", function(){ calShift(1); });
  document.querySelectorAll(".cal-view-btn").forEach(function(btn){
    btn.addEventListener("click", function(){ calSetView(btn.getAttribute("data-view")); });
  });
  wireAcctTabs("cal-acct-tabs", function(){ return calState.account; }, function(acct){
    calState.account = acct;
    loadAndRenderCalendar();
  });
  document.getElementById("cal-new").addEventListener("click", function(){ openCreateForm(calState.anchor, 9 * 60); });

  function getFetchRange(){
    if (calState.view === "day") return { start: calState.anchor, endExclusive: addDaysKey(calState.anchor, 1) };
    if (calState.view === "week"){
      var s = startOfWeekKey(calState.anchor);
      return { start: s, endExclusive: addDaysKey(s, 7) };
    }
    var monthStart = startOfMonthKey(calState.anchor);
    var gridStart = addDaysKey(monthStart, -keyWeekday(monthStart));
    var p = keyParts(calState.anchor);
    var monthEndExclusive = addDaysKey(monthStart, daysInMonth(p.y, p.m));
    var gridEnd = monthEndExclusive;
    while (keyWeekday(gridEnd) !== 0) gridEnd = addDaysKey(gridEnd, 1);
    return { start: gridStart, endExclusive: gridEnd };
  }

  function setCalStatus(html, cls){
    calStatusBar.className = "panel cal-status-bar" + (cls ? " " + cls : "");
    calStatusBar.innerHTML = html;
  }

  function calAccountLabel(){ return calState.account === "syslea" ? "SYSLEA" : "はるか"; }

  async function loadAndRenderCalendar(){
    updateViewButtons();
    var token = ++calLoadToken;
    var range = getFetchRange();
    var bounds = jstRangeForKeys(range.start, range.endExclusive);
    setCalStatus("読み込み中…", "");
    if (!calState.loadOk) calGridContainer.innerHTML = calSkeletonHtml();
    var acct = calState.account;
    try{
      var res = await apiFetch(acctPath("/api/google/calendar/events?start=" + encodeURIComponent(bounds.start) + "&end=" + encodeURIComponent(bounds.end), acct));
      if (token !== calLoadToken) return;
      calState.events = res.events || [];
      calState.loadedCalendarId = "primary";
      calState.loadOk = true;
      renderCalendarView();
      setCalStatus('<span class="live">●</span> Google Calendar 連携中 (' + escapeHtml(calAccountLabel()) + ')', "");
    } catch(err){
      if (token !== calLoadToken) return;
      calState.loadOk = false;
      if (err && err.code === "google_not_connected"){
        setCalStatus(escapeHtml(calAccountLabel() + " の Google 連携が必要です"), "");
        calGridContainer.innerHTML = '';
        calGridContainer.appendChild((function(){
          var wrap = document.createElement("div");
          wrap.style.cssText = "padding:32px 8px; text-align:center;";
          var p = document.createElement("div");
          p.textContent = calAccountLabel() + " の Google 連携が必要です(未連携、または有効期限切れ)。";
          p.style.marginBottom = "12px";
          var btn = document.createElement("button");
          btn.type = "button"; btn.className = "inbox-reconnect"; btn.style.display = "inline-block";
          btn.textContent = calAccountLabel() + " を Google 連携";
          btn.addEventListener("click", function(){ startGoogleConnect(acct); });
          wrap.appendChild(p); wrap.appendChild(btn);
          return wrap;
        })());
        return;
      }
      var msg = apiErrorMessage(err, "Google Calendar");
      setCalStatus(escapeHtml(msg), "err");
      calGridContainer.innerHTML = '<div class="sched-error" style="padding:24px 4px;">' + escapeHtml(msg) + '</div>';
    }
  }

  function colorForEvent(ev){
    var id = String((ev && (ev.id || ev.summary)) || "x");
    var hash = 0;
    for (var i = 0; i < id.length; i++){ hash = (hash * 31 + id.charCodeAt(i)) % 997; }
    return dotColors[Math.abs(hash) % dotColors.length];
  }
  function colorBg(hex){
    var r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
    return "rgba(" + r + "," + g + "," + b + ",0.22)";
  }

  function classifyEvents(dayKey){
    var allDay = [], timed = [];
    calState.events.forEach(function(ev){
      var s = ev.start || {}, e = ev.end || {};
      if (s.date){
        var startKey = s.date, endKeyExclusive = e.date || addDaysKey(s.date, 1);
        if (dayKey >= startKey && dayKey < endKeyExclusive) allDay.push(ev);
      } else if (s.dateTime){
        var sKey = jstDateKey(new Date(s.dateTime));
        var eKey = e.dateTime ? jstDateKey(new Date(e.dateTime)) : sKey;
        if (dayKey >= sKey && dayKey <= eKey) timed.push(ev);
      }
    });
    return { allDay: allDay, timed: timed };
  }

  function minutesInDay(dateTimeStr, dayKey){
    var d = new Date(dateTimeStr);
    var key = jstDateKey(d);
    if (key < dayKey) return 0;
    if (key > dayKey) return 1440;
    var parts = new Intl.DateTimeFormat("en-US", { timeZone: JP_TZ, hour:"2-digit", minute:"2-digit", hour12:false }).formatToParts(d).reduce(function(a,p){ a[p.type]=p.value; return a; }, {});
    var h = parseInt(parts.hour === "24" ? "0" : parts.hour, 10), m = parseInt(parts.minute, 10);
    return h * 60 + m;
  }

  function layoutTimed(events, dayKey){
    var items = events.map(function(ev){
      var startMin = minutesInDay(ev.start.dateTime, dayKey);
      var endMin = Math.max(startMin + 20, minutesInDay(ev.end && ev.end.dateTime ? ev.end.dateTime : ev.start.dateTime, dayKey));
      return { ev: ev, startMin: startMin, endMin: endMin };
    }).sort(function(a,b){ return a.startMin - b.startMin; });

    var columns = [];
    items.forEach(function(item){
      var placed = false;
      for (var i = 0; i < columns.length; i++){
        if (columns[i] <= item.startMin){ item.col = i; columns[i] = item.endMin; placed = true; break; }
      }
      if (!placed){ item.col = columns.length; columns.push(item.endMin); }
    });
    var colCount = Math.max(1, columns.length);
    items.forEach(function(item){ item.colCount = colCount; });
    return items;
  }

  function renderCalendarView(){
    if (calState.view === "day") renderDayOrWeek([calState.anchor]);
    else if (calState.view === "week"){
      var s = startOfWeekKey(calState.anchor);
      var keys = []; for (var i = 0; i < 7; i++) keys.push(addDaysKey(s, i));
      renderDayOrWeek(keys);
    } else renderMonth();
  }

  function renderDayOrWeek(dayKeys){
    var isWeek = dayKeys.length > 1;
    var todayKey = jstDateKey(new Date());
    var html = "";

    if (isWeek){
      html += '<div class="cal-week-headers"><div style="width:46px;flex:none;"></div><div style="flex:1;display:grid;grid-template-columns:repeat(' + dayKeys.length + ',1fr);">';
      dayKeys.forEach(function(k){
        var today = k === todayKey;
        html += '<div class="cal-col-header' + (today ? ' today' : '') + '">' + escapeHtml(formatColHeader(k)) + '</div>';
      });
      html += '</div></div>';
    }

    html += '<div class="cal-allday-row"><div class="cal-allday-gutter">終日</div><div class="cal-allday-cols" style="grid-template-columns:repeat(' + dayKeys.length + ',1fr);">';
    dayKeys.forEach(function(k){
      var cls = classifyEvents(k);
      html += '<div>';
      cls.allDay.forEach(function(ev){
        var col = colorForEvent(ev);
        html += '<div class="cal-allday-chip" tabindex="0" data-event-id="' + escapeHtml(ev.id) + '" style="background:' + colorBg(col) + ';border-color:' + col + ';">' + escapeHtml(ev.summary || "(タイトルなし)") + '</div>';
      });
      html += '</div>';
    });
    html += '</div></div>';

    html += '<div class="cal-timeline-scroll" id="cal-timeline-scroll"><div class="cal-timeline" style="height:' + (24*HOUR_PX) + 'px;">';
    html += '<div class="cal-hour-gutter">';
    for (var h = 0; h < 24; h++){ html += '<div class="cal-hour-label" style="top:' + (h*HOUR_PX) + 'px;">' + String(h).padStart(2,"0") + ':00</div>'; }
    html += '</div>';
    html += '<div class="cal-day-cols" style="grid-template-columns:repeat(' + dayKeys.length + ',1fr); height:' + (24*HOUR_PX) + 'px;">';
    dayKeys.forEach(function(k){
      html += '<div class="cal-day-col" data-day-key="' + k + '">';
      for (var h2 = 0; h2 < 24; h2++){ html += '<div class="cal-hour-line" style="top:' + (h2*HOUR_PX) + 'px;"></div>'; }
      if (k === todayKey){
        var nowMin = minutesInDay(new Date().toISOString(), k);
        html += '<div class="cal-now-line" style="top:' + (nowMin/60*HOUR_PX) + 'px;"></div>';
      }
      var cls2 = classifyEvents(k);
      var laid = layoutTimed(cls2.timed, k);
      laid.forEach(function(item){
        var col = colorForEvent(item.ev);
        var top = item.startMin/60*HOUR_PX;
        var height = Math.max(18, (item.endMin-item.startMin)/60*HOUR_PX);
        var widthPct = 100/item.colCount;
        var leftPct = item.col*widthPct;
        var fullLabel = fmtEventTime(item.ev.start) + " " + (item.ev.summary || "(タイトルなし)");
        html += '<div class="cal-event-block" tabindex="0" data-event-id="' + escapeHtml(item.ev.id) + '" title="' + escapeHtml(fullLabel) + '" style="top:' + top + 'px;height:' + height + 'px;left:calc(' + leftPct + '% + 2px);width:calc(' + widthPct + '% - 4px);background:' + colorBg(col) + ';border-color:' + col + ';">'
          + '<span class="t">' + escapeHtml(fmtEventTime(item.ev.start)) + '</span>' + escapeHtml(item.ev.summary || "(タイトルなし)") + '</div>';
      });
      html += '</div>';
    });
    html += '</div></div></div>';

    calGridContainer.innerHTML = html;

    calGridContainer.querySelectorAll(".cal-day-col").forEach(function(col){
      col.addEventListener("click", function(e){
        if (e.target.closest("[data-event-id]")) return;
        var rect = col.getBoundingClientRect();
        var offsetY = e.clientY - rect.top;
        var minutes = Math.round(offsetY / HOUR_PX * 60 / 15) * 15;
        minutes = Math.max(0, Math.min(1425, minutes));
        openCreateForm(col.getAttribute("data-day-key"), minutes);
      });
    });
    calGridContainer.querySelectorAll("[data-event-id]").forEach(function(el){
      el.addEventListener("click", function(e){
        e.stopPropagation();
        openEventPopover(el.getAttribute("data-event-id"), el);
      });
    });

    var scrollEl = document.getElementById("cal-timeline-scroll");
    if (scrollEl) scrollEl.scrollTop = 7 * HOUR_PX;
  }

  function renderMonth(){
    var p = keyParts(calState.anchor);
    var monthStart = startOfMonthKey(calState.anchor);
    var gridStart = addDaysKey(monthStart, -keyWeekday(monthStart));
    var dim = daysInMonth(p.y, p.m);
    var monthEndExclusive = addDaysKey(monthStart, dim);
    var gridEnd = monthEndExclusive;
    while (keyWeekday(gridEnd) !== 0) gridEnd = addDaysKey(gridEnd, 1);

    var keys = []; var k = gridStart;
    while (k < gridEnd){ keys.push(k); k = addDaysKey(k, 1); }

    var todayKey = jstDateKey(new Date());
    var html = '<div class="cal-month-grid">';
    DOW_JA.forEach(function(l){ html += '<div class="cal-month-dow">' + l + '</div>'; });

    keys.forEach(function(dayKey){
      var pk = keyParts(dayKey);
      var outside = pk.m !== p.m;
      var isToday = dayKey === todayKey;
      var cls2 = classifyEvents(dayKey);
      var allItems = cls2.allDay.concat(cls2.timed.slice().sort(function(a,b){
        var ta = a.start.dateTime || "", tb = b.start.dateTime || "";
        return ta < tb ? -1 : ta > tb ? 1 : 0;
      }));
      html += '<div class="cal-month-cell' + (outside ? ' outside' : '') + (isToday ? ' today' : '') + '" data-day-key="' + dayKey + '">';
      html += '<div class="cal-month-date">' + pk.d + '</div>';
      allItems.slice(0, 3).forEach(function(ev){
        var col = colorForEvent(ev);
        var timePrefix = ev.start.date ? "" : escapeHtml(fmtEventTime(ev.start)) + " ";
        var monthFullLabel = (ev.start.date ? "終日" : fmtEventTime(ev.start)) + " " + (ev.summary || "(タイトルなし)");
        html += '<div class="cal-month-chip" data-event-id="' + escapeHtml(ev.id) + '" title="' + escapeHtml(monthFullLabel) + '" style="background:' + colorBg(col) + ';border-color:' + col + ';">' + timePrefix + escapeHtml(ev.summary || "(タイトルなし)") + '</div>';
      });
      if (allItems.length > 3){ html += '<div class="cal-month-more">+' + (allItems.length - 3) + '件</div>'; }
      html += '</div>';
    });
    html += '</div>';
    calGridContainer.innerHTML = html;

    calGridContainer.querySelectorAll(".cal-month-cell").forEach(function(cell){
      cell.addEventListener("click", function(e){
        if (e.target.closest("[data-event-id]")) return;
        calState.anchor = cell.getAttribute("data-day-key");
        calState.view = "day";
        loadAndRenderCalendar();
      });
    });
    calGridContainer.querySelectorAll("[data-event-id]").forEach(function(el){
      el.addEventListener("click", function(e){
        e.stopPropagation();
        openEventPopover(el.getAttribute("data-event-id"), el);
      });
    });
  }

  /* ================= 予定の詳細ポップオーバー =================
     予定クリックで、いきなり編集フォームではなく読み取り用の小カードを
     クリック位置の近くに出す。編集/削除はそこから。 */
  var evPop = document.getElementById("event-popover");
  var evPopTitle = document.getElementById("event-popover-title");
  var evPopSwatch = document.getElementById("event-popover-swatch");
  var evPopTime = document.getElementById("event-popover-time");
  var evPopLoc = document.getElementById("event-popover-loc");
  var evPopDesc = document.getElementById("event-popover-desc");
  var evPopErr = document.getElementById("event-popover-err");
  var evPopEdit = document.getElementById("event-popover-edit");
  var evPopDelete = document.getElementById("event-popover-delete");
  var evPopEvent = null;

  function fmtEventRange(ev){
    if (ev.start && ev.start.date){
      var endEx = ev.end && ev.end.date ? ev.end.date : addDaysKey(ev.start.date, 1);
      var lastDay = addDaysKey(endEx, -1);
      if (lastDay <= ev.start.date) return formatDateLabelLong(ev.start.date) + " ・ 終日";
      return formatDateLabelLong(ev.start.date) + " 〜 " + formatDateLabelLong(lastDay) + " ・ 終日";
    }
    var sKey = jstDateKey(new Date(ev.start.dateTime));
    var eKey = ev.end && ev.end.dateTime ? jstDateKey(new Date(ev.end.dateTime)) : sKey;
    var sT = jstTimeHHMM(ev.start.dateTime);
    var eT = ev.end && ev.end.dateTime ? jstTimeHHMM(ev.end.dateTime) : sT;
    if (sKey === eKey) return formatDateLabelLong(sKey) + "  " + sT + " 〜 " + eT;
    return formatDateLabelLong(sKey) + " " + sT + " 〜 " + formatDateLabelLong(eKey) + " " + eT;
  }

  function positionPopover(anchorEl){
    evPop.style.left = "-9999px"; evPop.style.top = "0px";
    evPop.hidden = false;
    var pr = evPop.getBoundingClientRect();
    var vw = window.innerWidth, vh = window.innerHeight, m = 8;
    var left, top;
    if (anchorEl && anchorEl.getBoundingClientRect){
      var r = anchorEl.getBoundingClientRect();
      left = r.right + m;
      if (left + pr.width > vw - m) left = r.left - pr.width - m; // 右に入らなければ左へ
      if (left < m) left = Math.max(m, (vw - pr.width) / 2);
      top = r.top;
    } else {
      left = (vw - pr.width) / 2; top = (vh - pr.height) / 2;
    }
    if (top + pr.height > vh - m) top = vh - pr.height - m;
    if (top < m) top = m;
    evPop.style.left = Math.round(left) + "px";
    evPop.style.top = Math.round(top) + "px";
  }

  function openEventPopover(id, anchorEl){
    var ev = calState.events.find(function(x){ return x.id === id; });
    if (!ev || !evPop) return;
    evPopEvent = ev;
    if (evPopErr) evPopErr.hidden = true;
    if (evPopDelete) evPopDelete.disabled = false;
    var col = colorForEvent(ev);
    evPopSwatch.style.background = col;
    evPopTitle.textContent = ev.summary || "(タイトルなし)";
    evPopTime.textContent = fmtEventRange(ev);
    if (ev.location){ evPopLoc.hidden = false; evPopLoc.textContent = "📍 " + ev.location; }
    else evPopLoc.hidden = true;
    var descPlain = ev.description ? htmlDescriptionToPlainText(ev.description) : "";
    if (descPlain){
      evPopDesc.hidden = false;
      evPopDesc.textContent = descPlain.length > 240 ? descPlain.slice(0, 240) + "…" : descPlain;
    } else evPopDesc.hidden = true;
    positionPopover(anchorEl);
    document.addEventListener("mousedown", onPopOutside, true);
    document.addEventListener("keydown", onPopEsc, true);
  }
  function closeEventPopover(){
    if (!evPop) return;
    evPop.hidden = true;
    evPopEvent = null;
    document.removeEventListener("mousedown", onPopOutside, true);
    document.removeEventListener("keydown", onPopEsc, true);
  }
  function onPopOutside(e){
    if (!evPop || evPop.contains(e.target)) return;
    // 削除確認モーダルへのクリックでポップオーバーを閉じない
    var cm = document.getElementById("confirm-modal");
    if (cm && !cm.hidden && cm.contains(e.target)) return;
    closeEventPopover();
  }
  function onPopEsc(e){ if (e.key === "Escape") closeEventPopover(); }

  if (evPop){
    document.getElementById("event-popover-close").addEventListener("click", closeEventPopover);
    evPopEdit.addEventListener("click", function(){
      var ev = evPopEvent; closeEventPopover();
      if (ev) openEditForm(ev);
    });
    evPopDelete.addEventListener("click", async function(){
      var ev = evPopEvent;
      if (!ev) return;
      if (!(await askConfirm('「' + (ev.summary || "この予定") + '」を削除しますか?'))) return;
      evPopDelete.disabled = true;
      if (evPopErr) evPopErr.hidden = true;
      try{
        await apiFetch(acctPath("/api/google/calendar/events/" + encodeURIComponent(ev.id), calState.account), { method: "DELETE" });
        closeEventPopover();
        loadAndRenderCalendar();
        initCalendarWatch();
      } catch(err){
        if (evPopErr){ evPopErr.hidden = false; evPopErr.textContent = apiErrorMessage(err, "Google Calendar"); }
        evPopDelete.disabled = false;
      }
    });
  }

  /* ================= event create/edit/delete modal ================= */
  var eventModal = document.getElementById("event-modal");
  var eventModalTitle = document.getElementById("event-modal-title");
  var eventForm = document.getElementById("event-form");
  var evTitle = document.getElementById("ev-title");
  var evAllday = document.getElementById("ev-allday");
  var evStartDate = document.getElementById("ev-start-date");
  var evStartTime = document.getElementById("ev-start-time");
  var evEndDate = document.getElementById("ev-end-date");
  var evEndTime = document.getElementById("ev-end-time");
  var evLocation = document.getElementById("ev-location");
  var evDesc = document.getElementById("ev-desc");
  var evError = document.getElementById("event-form-error");
  var evDelete = document.getElementById("ev-delete");
  var evCancel = document.getElementById("ev-cancel");
  var evSave = document.getElementById("ev-save");

  var editingEvent = null;
  var editingEventCalendarId = null;
  var editingOriginalDescription = null;
  var editingOriginalDescriptionPlain = null;

  // Google Calendar descriptions "can contain HTML" (e.g. pasted event listings with
  // <a href="...">links</a>). A plain <textarea> can't render that markup, so show the
  // raw tags to the user unreadable-as-is. Convert to readable plain text for display,
  // keeping link targets visible as "text (url)" rather than silently dropping them.
  function htmlDescriptionToPlainText(html){
    if (!html) return "";
    if (html.indexOf("<") === -1) return html; // already plain text, nothing to strip
    var container = document.createElement("div");
    container.innerHTML = html;
    container.querySelectorAll("a").forEach(function(a){
      var href = a.getAttribute("href") || "";
      var text = a.textContent || "";
      var replacement = (href && href !== text) ? (text + " (" + href + ")") : text;
      a.replaceWith(document.createTextNode(replacement));
    });
    container.querySelectorAll("br").forEach(function(br){ br.replaceWith(document.createTextNode("\n")); });
    container.querySelectorAll("p, div, li").forEach(function(el){ el.append(document.createTextNode("\n")); });
    return (container.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
  }

  function toggleAllDayInputs(){
    var isAllDay = evAllday.checked;
    evStartTime.style.display = isAllDay ? "none" : "";
    evEndTime.style.display = isAllDay ? "none" : "";
    evStartTime.required = !isAllDay;
    evEndTime.required = !isAllDay;
  }
  evAllday.addEventListener("change", toggleAllDayInputs);

  function openCreateForm(dayKey, minutesFromMidnight){
    editingEvent = null;
    editingEventCalendarId = null;
    editingOriginalDescription = null;
    editingOriginalDescriptionPlain = null;
    eventModalTitle.textContent = "新規予定";
    evDelete.hidden = true;
    evError.hidden = true;
    evTitle.value = "";
    evLocation.value = "";
    evDesc.value = "";
    evAllday.checked = false;
    toggleAllDayInputs();
    var startMin = minutesFromMidnight != null ? minutesFromMidnight : 9 * 60;
    var endMin = Math.min(1440, startMin + 60);
    evStartDate.value = dayKey;
    evEndDate.value = dayKey;
    evStartTime.value = minutesToHHMM(startMin);
    evEndTime.value = minutesToHHMM(endMin);
    showEventModal();
  }

  function openEditForm(ev){
    editingEvent = ev;
    editingEventCalendarId = calState.loadedCalendarId || ACCOUNTS[calState.account].calendarId;
    eventModalTitle.textContent = "予定を編集";
    evDelete.hidden = false;
    evError.hidden = true;
    evTitle.value = ev.summary || "";
    evLocation.value = ev.location || "";
    editingOriginalDescription = ev.description || "";
    editingOriginalDescriptionPlain = htmlDescriptionToPlainText(editingOriginalDescription);
    evDesc.value = editingOriginalDescriptionPlain;
    var isAllDay = !!(ev.start && ev.start.date);
    evAllday.checked = isAllDay;
    toggleAllDayInputs();
    if (isAllDay){
      evStartDate.value = ev.start.date;
      var endExclusive = ev.end && ev.end.date ? ev.end.date : addDaysKey(ev.start.date, 1);
      evEndDate.value = addDaysKey(endExclusive, -1);
      evStartTime.value = "00:00"; evEndTime.value = "00:00";
    } else {
      var sKey = jstDateKey(new Date(ev.start.dateTime));
      var eKey = ev.end && ev.end.dateTime ? jstDateKey(new Date(ev.end.dateTime)) : sKey;
      evStartDate.value = sKey; evEndDate.value = eKey;
      evStartTime.value = jstTimeHHMM(ev.start.dateTime);
      evEndTime.value = ev.end && ev.end.dateTime ? jstTimeHHMM(ev.end.dateTime) : jstTimeHHMM(ev.start.dateTime);
    }
    showEventModal();
  }

  function showEventModal(){ eventModal.hidden = false; document.body.style.overflow = "hidden"; evTitle.focus(); }
  function closeEventModal(){ eventModal.hidden = true; document.body.style.overflow = ""; }
  function showFormError(msg){ evError.hidden = false; evError.textContent = msg; }
  function resetSaveBtn(){ evSave.disabled = false; evSave.textContent = "保存"; }

  eventForm.addEventListener("submit", async function(e){
    e.preventDefault();
    evError.hidden = true;

    var title = evTitle.value.trim();
    if (!title){ showFormError("タイトルを入力してください"); return; }

    var isAllDay = evAllday.checked;
    var startTime, endTime;
    if (isAllDay){
      if (!evStartDate.value || !evEndDate.value){ showFormError("開始日と終了日を入力してください"); return; }
      if (evEndDate.value < evStartDate.value){ showFormError("終了日は開始日以降にしてください"); return; }
      startTime = jstKeyTimeToUTCISO(evStartDate.value, 0, 0);
      endTime = jstKeyTimeToUTCISO(addDaysKey(evEndDate.value, 1), 0, 0);
    } else {
      if (!evStartDate.value || !evStartTime.value || !evEndDate.value || !evEndTime.value){ showFormError("開始・終了の日時を入力してください"); return; }
      var sParts = evStartTime.value.split(":").map(Number);
      var eParts = evEndTime.value.split(":").map(Number);
      startTime = jstKeyTimeToUTCISO(evStartDate.value, sParts[0], sParts[1]);
      endTime = jstKeyTimeToUTCISO(evEndDate.value, eParts[0], eParts[1]);
      if (new Date(endTime) <= new Date(startTime)){ showFormError("終了時刻は開始時刻より後にしてください"); return; }
    }

    evSave.disabled = true; evSave.textContent = "保存中…";

    // If the memo textarea still matches what we showed at open time (converted from the
    // original, possibly-HTML description), send the original back untouched so we don't
    // clobber formatting/links the user never actually edited. Otherwise send exactly what
    // they typed, as plain text.
    var descValue = evDesc.value.trim();
    if (editingEvent && evDesc.value === editingOriginalDescriptionPlain){
      descValue = editingOriginalDescription;
    }

    var input = {
      summary: title,
      startTime: startTime,
      endTime: endTime,
      allDay: isAllDay,
      timeZone: JP_TZ,
      location: evLocation.value.trim(),
      description: descValue
    };

    try{
      if (editingEvent){
        await apiFetch(acctPath("/api/google/calendar/events/" + encodeURIComponent(editingEvent.id), calState.account), {
          method: "PATCH", body: JSON.stringify(input)
        });
      } else {
        await apiFetch(acctPath("/api/google/calendar/events", calState.account), {
          method: "POST", body: JSON.stringify(input)
        });
      }
      closeEventModal();
      loadAndRenderCalendar();
      initCalendarWatch();
    } catch(err){
      showFormError(apiErrorMessage(err, "Google Calendar"));
    } finally {
      resetSaveBtn();
    }
  });

  evDelete.addEventListener("click", async function(){
    if (!editingEvent) return;
    if (!(await askConfirm('「' + (editingEvent.summary || "この予定") + '」を削除しますか?'))) return;
    evDelete.disabled = true;
    try{
      await apiFetch(acctPath("/api/google/calendar/events/" + encodeURIComponent(editingEvent.id), calState.account), { method: "DELETE" });
      editingEvent = null;
      editingEventCalendarId = null;
      closeEventModal();
      loadAndRenderCalendar();
      initCalendarWatch();
    } catch(err){
      showFormError(apiErrorMessage(err, "Google Calendar"));
    } finally {
      evDelete.disabled = false;
    }
  });

  evCancel.addEventListener("click", closeEventModal);
  document.getElementById("event-modal-close").addEventListener("click", closeEventModal);
  eventModal.addEventListener("click", function(e){ if (e.target === eventModal) closeEventModal(); });

  /* ================= MAIL page =================
     はるか個人のGmail(haruka.m.1995@gmail.com)に接続済み。SYSLEA側(@syslea.io)は同じ
     Gmailコネクタでは1アカウントしか繋げず、2つ目を繋ぐと1つ目が上書きされることを
     実際に確認済み(2026-08-28)。代替のSuperhuman Mailコネクタは有料登録が必要になる
     可能性があるため見送り、SYSLEA側はダミー表示のまま運用する方針。
     一覧の日時・件名はスレッド内の最も古いメッセージ基準(Gmail連携ツールの仕様上の制約)。
     返信で伸びたスレッドは表示上わずかに古い時刻になることがあるが、詳細を開くと
     get_thread でスレッド全体を取得するのでそちらは正確。 */
  var mailState = { account: "haruka", filter: "all", pageIndex: 0, query: "", labelId: "INBOX", labelName: "受信トレイ" };
  var MAIL_PAGE_SIZE = 20;
  var mailLabels = null;          // 現在アカウントのラベル一覧(null = 未取得)
  var mailLabelsLoading = false;
  var mailList = document.getElementById("mail-list");
  var mailLabelListEl = document.getElementById("mail-label-list");
  var mailPager = document.getElementById("mail-pager");
  var mailPagerInfo = document.getElementById("mail-pager-info");
  var mailPrevBtn = document.getElementById("mail-prev");
  var mailNextBtn = document.getElementById("mail-next");
  var mailModal = document.getElementById("mail-modal");
  var mailModalTitle = document.getElementById("mail-modal-title");
  var mailDetailBody = document.getElementById("mail-detail-body");
  var mailObjectUrls = [];        // モーダルを閉じるときに revoke する添付の blob URL
  var MAIL_INLINE_IMG_MAX = 12 * 1024 * 1024;  // これ以上の画像はインライン展開せずボタンのみ
  var mailActionsEl = document.getElementById("mail-actions");
  var mailActMsg = document.getElementById("mail-act-msg");
  var currentMailThread = null;
  var mailTag = document.getElementById("mail-tag");
  var mailStatusBar = document.getElementById("mail-status-bar");
  var homeInboxTag = document.getElementById("home-inbox-tag");
  var homeInboxCountBtn = document.getElementById("home-inbox-count-btn");
  var homeInboxCountNum = document.getElementById("home-inbox-count-num");
  var homeInboxCountLabel = document.getElementById("home-inbox-count-label");
  var homeInboxCountBtnSyslea = document.getElementById("home-inbox-count-btn-syslea");
  var homeInboxCountNumSyslea = document.getElementById("home-inbox-count-num-syslea");
  var homeInboxCountLabelSyslea = document.getElementById("home-inbox-count-label-syslea");
  var homeGoogleConnectBtn = document.getElementById("home-google-connect-btn");

  // Gmail/Calendar/DriveへのアクセスはFirebase Authenticationのログインとは別に、
  // 追加のGoogle同意(googleAuth.js)が必要。未連携時はもちろん、連携済みでも
  // トークン失効やスコープ変更に備えて「再連携」ボタンを常時出しておく。
  // 押すとバックエンドから認可URLを取得して遷移する。
  var googleConnecting = false;
  // account = "haruka" | "syslea"。指定した枠のGoogle同意フローへ遷移する。
  async function startGoogleConnect(account){
    var acct = account === "syslea" ? "syslea" : "haruka";
    googleConnecting = true;
    if (acct === "haruka"){
      homeGoogleConnectBtn.disabled = true;
      homeGoogleConnectBtn.textContent = "連携ページへ移動中…";
    }
    try {
      var res = await apiFetch(acctPath("/api/google/oauth/start", acct));
      if (res && res.url){
        window.location.href = res.url;
      } else {
        throw new Error("認可URLを取得できませんでした。");
      }
    } catch (err) {
      console.error("[google] oauth start failed:", err);
      googleConnecting = false;
      if (acct === "haruka"){
        homeGoogleConnectBtn.disabled = false;
        homeGoogleConnectBtn.textContent = "連携に失敗。もう一度";
      }
    }
  }
  homeGoogleConnectBtn.addEventListener("click", function(){ startGoogleConnect("haruka"); });

  // 未連携 / 連携失効アカウント向けの「連携する」プロンプト(<li>を返す)
  function buildConnectPrompt(account, label){
    var li = document.createElement("li");
    li.className = "sched-empty";
    li.style.textAlign = "center";
    li.style.padding = "26px 8px";
    var p = document.createElement("div");
    p.textContent = label + " の Google 連携が必要です(未連携、または有効期限切れ)。";
    p.style.marginBottom = "12px";
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "inbox-reconnect";
    btn.style.display = "inline-block";
    btn.textContent = label + " を Google 連携";
    btn.addEventListener("click", function(){ startGoogleConnect(account); });
    li.appendChild(p); li.appendChild(btn);
    return li;
  }

  /* ================= Google 再連携リマインダー =================
     テストユーザー運用の Google OAuth トークンは連携から7日で失効する。失効してから
     気づくと丸1日メール/カレンダーが死ぬので、バックエンドの /api/google/status が返す
     各枠の { connected, expiresAt } を見て、失効まで2日を切った枠があれば上部にバナーを出す。
     × で閉じたら、その expiresAt の間は再表示しない(再連携すると expiresAt が変わって再度出る)。 */
  var reauthBanner = document.getElementById("reauth-banner");
  var reauthBannerText = document.getElementById("reauth-banner-text");
  var reauthBannerBtn = document.getElementById("reauth-banner-btn");
  var reauthBannerClose = document.getElementById("reauth-banner-close");
  var REAUTH_WARN_MS = 2 * 24 * 60 * 60 * 1000;
  var ACCOUNT_LABELS = { haruka: "はるか", syslea: "SYSLEA" };
  var reauthBannerAccount = null;
  var reauthBannerExpiresAt = null;

  function reauthDismissKey(account){ return "reauthDismiss_" + account; }
  function isReauthDismissed(account, expiresAt){
    try { return localStorage.getItem(reauthDismissKey(account)) === String(expiresAt); }
    catch(e){ return false; }
  }
  function markReauthDismissed(account, expiresAt){
    try { localStorage.setItem(reauthDismissKey(account), String(expiresAt)); } catch(e){}
  }

  if (reauthBannerBtn){
    reauthBannerBtn.addEventListener("click", function(){
      if (reauthBannerAccount) startGoogleConnect(reauthBannerAccount);
    });
  }
  if (reauthBannerClose){
    reauthBannerClose.addEventListener("click", function(){
      reauthBanner.hidden = true;
      if (reauthBannerAccount && reauthBannerExpiresAt){
        markReauthDismissed(reauthBannerAccount, reauthBannerExpiresAt);
      }
    });
  }

  async function checkReauthReminder(){
    if (!reauthBanner) return;
    var data;
    try { data = await apiFetch("/api/google/status"); }
    catch(e){ return; } // 状態が取れなくてもバナー無しで続行(既存の再連携導線に任せる)
    applyReauthStatus(data);
  }

  // /api/google/status(または /api/bootstrap/home の googleStatus)の結果から
  // 再連携リマインダーバナーの表示/非表示を更新する。
  function applyReauthStatus(data){
    if (!reauthBanner) return;
    var accounts = (data && data.accounts) || {};
    var now = Date.now();
    var soonest = null;
    Object.keys(accounts).forEach(function(acct){
      var s = accounts[acct] || {};
      if (!s.connected || !s.expiresAt) return;
      var left = s.expiresAt - now;
      if (left <= 0 || left > REAUTH_WARN_MS) return;     // 既に失効 / まだ余裕がある
      if (isReauthDismissed(acct, s.expiresAt)) return;   // ×で閉じ済み
      if (!soonest || s.expiresAt < soonest.expiresAt){
        soonest = { account: acct, expiresAt: s.expiresAt, left: left };
      }
    });
    if (!soonest){
      reauthBanner.hidden = true;
      reauthBannerAccount = null;
      reauthBannerExpiresAt = null;
      if (typeof refreshNotifCenter === "function") refreshNotifCenter();
      return;
    }
    var days = Math.max(1, Math.ceil(soonest.left / (24 * 60 * 60 * 1000)));
    var label = ACCOUNT_LABELS[soonest.account] || soonest.account;
    reauthBannerAccount = soonest.account;
    reauthBannerExpiresAt = soonest.expiresAt;
    reauthBannerText.textContent =
      label + " の Google 連携はあと約" + days + "日で期限切れです。今のうちに再連携してください。";
    reauthBanner.hidden = false;
    if (typeof refreshNotifCenter === "function") refreshNotifCenter();
  }

  var harukaMailItems = null; // null = 未取得; [] = 取得済み(空)
  var harukaMailError = null;
  var harukaMailLoading = false;
  var mailPageTokens = [null]; // mailPageTokens[i] = ページ i を取得する pageToken(先頭ページは null)
  var harukaMailNextToken = null;

  // Home画面の「未読件数」表示は、メールページの一覧取得(loadHarukaMail、まだMCP依存で
  // 次の増分まで保留)とは切り離し、バックエンドの軽量な未読件数APIだけを呼ぶ。
  var harukaUnreadCount = null; // null = 未取得
  var harukaUnreadError = null;
  var sysleaUnreadCount = null;
  var sysleaUnreadError = null;
  async function loadGmailUnreadCount(){
    // はるか・SYSLEA の未読件数を並行取得する。
    apiFetch(acctPath("/api/google/gmail/unread-count", "haruka")).then(function(res){
      harukaUnreadCount = res.unreadCount; harukaUnreadError = null;
    }).catch(function(err){ harukaUnreadError = err; }).then(renderHomeInbox);

    apiFetch(acctPath("/api/google/gmail/unread-count", "syslea")).then(function(res){
      sysleaUnreadCount = res.unreadCount; sysleaUnreadError = null;
    }).catch(function(err){ sysleaUnreadError = err; }).then(renderHomeInbox);
  }

  function formatMailTime(iso){
    if (!iso) return "";
    var d = new Date(iso);
    var todayKey = jstDateKey(new Date());
    var dKey = jstDateKey(d);
    if (dKey === todayKey) return jstTimeHHMM(iso);
    if (dKey === addDaysKey(todayKey, -1)) return "昨日";
    var p = keyParts(dKey);
    return p.m + "/" + p.d;
  }

  function fetchMailPage(){
    harukaMailLoading = true;
    harukaMailError = null;
    renderMailList();
    var params = "?maxResults=" + MAIL_PAGE_SIZE;
    var tok = mailPageTokens[mailState.pageIndex];
    if (tok) params += "&pageToken=" + encodeURIComponent(tok);
    if (mailState.filter === "unread") params += "&unreadOnly=1";
    if (mailState.labelId && mailState.labelId !== "INBOX") params += "&labelId=" + encodeURIComponent(mailState.labelId);
    if (mailState.query) params += "&q=" + encodeURIComponent(mailState.query);
    apiFetch(acctPath("/api/google/gmail/messages" + params, mailState.account)).then(function(res){
      var messages = res.messages || [];
      harukaMailItems = messages.map(function(m){
        return {
          threadId: m.threadId,
          from: m.from || "(不明な送信者)",
          fromAddress: m.fromAddress || m.from || "",
          initial: (m.from || "?").charAt(0).toUpperCase(),
          subject: m.subject || "(件名なし)",
          snippet: m.snippet || "",
          time: formatMailTime(m.date),
          unread: !!m.unread
        };
      });
      harukaMailNextToken = res.nextPageToken || null;
      // 次ページのトークンは未登録のときだけ覚える(戻ってきた時の重複pushを防ぐ)
      if (harukaMailNextToken && mailPageTokens.length === mailState.pageIndex + 1){
        mailPageTokens.push(harukaMailNextToken);
      }
      harukaMailError = null;
    }).catch(function(err){
      harukaMailError = err;
    }).then(function(){
      harukaMailLoading = false;
      renderMailList();
    });
  }

  // フィルタ変更時などに、ページ状態を初期化して1ページ目から読み直す。
  function reloadMailFromFirstPage(){
    mailState.pageIndex = 0;
    mailPageTokens = [null];
    harukaMailNextToken = null;
    paySortResults = null;
    payHistCache = null;
    paySortRunning = false;
    fetchMailPage();
  }

  function loadHarukaMail(){
    if (harukaMailLoading) return;
    if (harukaMailItems !== null && !harukaMailError){ renderMailList(); return; }
    reloadMailFromFirstPage();
  }

  /* ---- ラベルサイドバー(受信トレイ以外も見られるように) ---- */
  function renderMailLabels(){
    if (!mailLabelListEl) return;
    mailLabelListEl.innerHTML = "";
    if (mailLabelsLoading && !mailLabels){
      mailLabelListEl.innerHTML = '<li class="mail-label-loading">読み込み中…</li>';
      return;
    }
    if (!mailLabels || !mailLabels.length){
      // 取得失敗時も最低限「受信トレイ」だけは選べるように
      mailLabels = [{ id: "INBOX", name: "受信トレイ", unread: 0 }];
    }
    mailLabels.forEach(function(lb){
      var li = document.createElement("li");
      li.className = "mail-label-item" + (lb.id === mailState.labelId ? " is-active" : "");
      li.tabIndex = 0; li.setAttribute("role", "button");
      var nm = document.createElement("span");
      nm.className = "mail-label-name";
      nm.textContent = lb.name;
      li.appendChild(nm);
      if (lb.unread){
        var bd = document.createElement("span");
        bd.className = "mail-label-badge";
        bd.textContent = lb.unread > 999 ? "999+" : lb.unread;
        li.appendChild(bd);
      }
      function pick(){
        if (lb.id === mailState.labelId) return;
        mailState.labelId = lb.id;
        mailState.labelName = lb.name;
        renderMailLabels();
        reloadMailFromFirstPage();
      }
      li.addEventListener("click", pick);
      li.addEventListener("keydown", function(e){ if (e.key === "Enter" || e.key === " "){ e.preventDefault(); pick(); } });
      mailLabelListEl.appendChild(li);
    });
  }
  function loadMailLabels(){
    if (!mailLabelListEl || mailLabelsLoading) return;
    mailLabelsLoading = true;
    renderMailLabels();
    apiFetch(acctPath("/api/google/gmail/labels", mailState.account)).then(function(res){
      mailLabels = res.labels || [];
      // 選択中ラベルがこのアカウントに無ければ受信トレイへ戻す
      if (!mailLabels.some(function(l){ return l.id === mailState.labelId; })){
        mailState.labelId = "INBOX"; mailState.labelName = "受信トレイ";
      }
    }).catch(function(){
      mailLabels = null; // renderMailLabels がフォールバックで INBOX のみ出す
    }).then(function(){
      mailLabelsLoading = false;
      renderMailLabels();
    });
  }

  function setMailStatus(html, cls){
    mailStatusBar.innerHTML = html;
    mailStatusBar.className = "panel cal-status-bar" + (cls ? " " + cls : "");
  }

  function mailAccountLabel(){
    return mailState.account === "syslea" ? "SYSLEA" : "はるか個人";
  }
  function updateMailHeaderUI(){
    mailTag.hidden = true;
    var label = mailAccountLabel();
    if (harukaMailError){
      if (harukaMailError.code === "google_not_connected"){
        setMailStatus(escapeHtml(label + " の Google 連携が必要です(未連携 / 期限切れ)"), "");
      } else {
        setMailStatus(escapeHtml(apiErrorMessage(harukaMailError, "Gmail")), "err");
      }
    } else if (!harukaMailItems){
      setMailStatus("接続確認中…", "");
    } else {
      var lbl = mailState.labelId === "INBOX" ? "" : " / " + escapeHtml(mailState.labelName || "");
      setMailStatus('<span class="live">●</span> Gmail 連携中(' + escapeHtml(label) + ')' + lbl, "");
    }
  }

  function buildMailListItem(mail, onClick){
    var li = document.createElement("li");
    li.className = "mail-item" + (mail.unread ? " unread" : "");

    var avatar = document.createElement("div");
    avatar.className = "mail-avatar";
    avatar.textContent = mail.initial;

    var main = document.createElement("div");
    main.className = "mail-main";
    var topRow = document.createElement("div");
    topRow.className = "mail-top-row";
    var from = document.createElement("span");
    from.className = "mail-from";
    from.textContent = mail.from;
    var time = document.createElement("span");
    time.className = "mail-time";
    time.textContent = mail.time;
    topRow.appendChild(from); topRow.appendChild(time);

    var subject = document.createElement("div");
    subject.className = "mail-subject";
    subject.textContent = mail.subject;
    var snippet = document.createElement("div");
    snippet.className = "mail-snippet";
    var snip = mail.snippet || "";
    snippet.textContent = snip.length > 30 ? snip.slice(0, 30) + "…" : snip;

    main.appendChild(topRow); main.appendChild(subject); main.appendChild(snippet);
    li.appendChild(avatar); li.appendChild(main);
    if (mail.unread){
      var dot = document.createElement("span");
      dot.className = "mail-unread-dot";
      li.appendChild(dot);
    }
    li.addEventListener("click", onClick);
    return li;
  }

  function updateMailPager(){
    if (harukaMailError || !harukaMailItems){
      mailPager.hidden = true;
      return;
    }
    var hasPrev = mailState.pageIndex > 0;
    var hasNext = !!harukaMailNextToken;
    if (!hasPrev && !hasNext){
      mailPager.hidden = true;
      return;
    }
    mailPager.hidden = false;
    mailPrevBtn.disabled = !hasPrev || harukaMailLoading;
    mailNextBtn.disabled = !hasNext || harukaMailLoading;
    mailPagerInfo.textContent =
      (mailState.query ? "検索: " : mailState.filter === "unread" ? "未読 " : "") +
      (mailState.pageIndex + 1) + " ページ目";
  }

  function renderMailList(){
    updateMailHeaderUI();
    updateMailSortBtn();
    // 仕分けパネルが開いていない通常表示に戻す
    if (!paySortRunning && !paySortResults && !payHistCache){
      var sp = document.getElementById("mail-sort-panel");
      if (sp && !sp.hidden){ sp.hidden = true; }
      if (mailList.hidden) mailList.hidden = false;
    }
    mailList.innerHTML = "";

    if (harukaMailError){
      if (harukaMailError.code === "google_not_connected"){
        mailList.appendChild(buildConnectPrompt(mailState.account, mailAccountLabel()));
      } else {
        mailList.innerHTML = '<li class="sched-error">' + escapeHtml(apiErrorMessage(harukaMailError, "Gmail")) + '</li>';
      }
      updateMailPager();
      return;
    }
    if (!harukaMailItems || harukaMailLoading){
      mailList.innerHTML = mailSkeletonHtml(6);
      updateMailPager();
      return;
    }
    if (!harukaMailItems.length){
      var where = mailState.labelId === "INBOX" ? "" : "「" + (mailState.labelName || "このラベル") + "」に";
      var emptyMsg = mailState.query
        ? "「" + mailState.query + "」に一致するメールはありません"
        : (mailState.filter === "unread" ? where + "未読メールはありません" : where + "メールはありません");
      mailList.innerHTML = '<li class="sched-empty">' + escapeHtml(emptyMsg) + '</li>';
      updateMailPager();
      return;
    }
    harukaMailItems.forEach(function(mail){
      mailList.appendChild(buildMailListItem(mail, function(){ openMailDetail(mail); }));
    });
    updateMailPager();
  }

  function buildMailFromRow(mail, addrText){
    var fromRow = document.createElement("div");
    fromRow.className = "from-row";
    var avatar = document.createElement("div");
    avatar.className = "mail-avatar";
    avatar.textContent = mail.initial;
    var meta = document.createElement("div");
    meta.className = "from-meta";
    var name = document.createElement("div");
    name.className = "name";
    name.textContent = mail.from;
    var addr = document.createElement("div");
    addr.className = "addr";
    addr.textContent = addrText;
    meta.appendChild(name); meta.appendChild(addr);
    fromRow.appendChild(avatar); fromRow.appendChild(meta);
    return fromRow;
  }

  async function openMailDetail(mail){
    mail.unread = false;
    mailModalTitle.textContent = mail.subject;
    mailDetailBody.innerHTML = "";
    if (mailActMsg){ mailActMsg.textContent = ""; }
    currentMailThread = mail.threadId || null;
    if (mailActionsEl){
      mailActionsEl.hidden = !mail.threadId;   // 仮データ(threadId無し)には操作を出さない
      mailActionsEl.querySelectorAll(".mail-act-btn").forEach(function(b){ b.disabled = false; });
    }

    if (mail.threadId){
      mailDetailBody.appendChild(buildMailFromRow(mail, mail.time));
      var bodyEl = document.createElement("div");
      bodyEl.className = "body";
      bodyEl.textContent = "読み込み中…";
      mailDetailBody.appendChild(bodyEl);
      mailModal.hidden = false;
      document.body.style.overflow = "hidden";
      renderMailList(); // refresh unread dot state
      try{
        var res = await apiFetch(acctPath("/api/google/gmail/threads/" + encodeURIComponent(mail.threadId), mailState.account));
        bodyEl.textContent = res.body || mail.snippet || "(本文がありません)";
        renderMailAttachments(res.attachments || []);
      } catch(err){
        bodyEl.textContent = apiErrorMessage(err, "Gmail") || "本文の取得に失敗しました。";
      }
      return;
    }

    mailDetailBody.appendChild(buildMailFromRow(mail, mail.time + " ・ 仮データ"));
    var body = document.createElement("div");
    body.className = "body";
    body.textContent = mail.body;
    mailDetailBody.appendChild(body);

    mailModal.hidden = false;
    document.body.style.overflow = "hidden";
    renderMailList(); // refresh unread dot state
  }
  function mailFormatBytes(n){
    n = Number(n) || 0;
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / (1024 * 1024)).toFixed(1) + " MB";
  }

  // 添付1件を取得して blob URL を返す。revoke はモーダルを閉じるときにまとめて行う。
  async function mailAttachFetch(att){
    var token = await getIdToken();
    if (!token) throw new Error("未ログインです。");
    var path = "/api/google/gmail/messages/" + encodeURIComponent(att.messageId) +
      "/attachments/" + encodeURIComponent(att.attachmentId) +
      "?name=" + encodeURIComponent(att.filename || "attachment") +
      "&mime=" + encodeURIComponent(att.mimeType || "application/octet-stream");
    var res = await fetch(API_BASE + acctPath(path, mailState.account), {
      headers: { "Authorization": "Bearer " + token },
    });
    if (!res.ok) throw new Error("添付の取得に失敗しました (" + res.status + ")");
    var blob = await res.blob();
    var url = URL.createObjectURL(blob);
    mailObjectUrls.push(url);
    return url;
  }

  // スレッドの添付ファイル一覧を本文の下に描画する。
  // 画像はインライン展開、それ以外は「開く / 保存」ボタンのみ。
  function renderMailAttachments(atts){
    if (!Array.isArray(atts) || !atts.length) return;
    var wrap = document.createElement("div");
    wrap.className = "mail-attachments";
    var head = document.createElement("div");
    head.className = "mail-attachments-head";
    head.textContent = "添付ファイル (" + atts.length + ")";
    wrap.appendChild(head);

    atts.forEach(function(att){
      var row = document.createElement("div");
      row.className = "mail-attach-item";

      var meta = document.createElement("div");
      meta.className = "mail-attach-meta";
      var nameEl = document.createElement("span");
      nameEl.className = "mail-attach-name";
      nameEl.textContent = att.filename || "(名称なし)";
      var sizeEl = document.createElement("span");
      sizeEl.className = "mail-attach-size";
      sizeEl.textContent = mailFormatBytes(att.size);
      meta.appendChild(nameEl);
      meta.appendChild(sizeEl);
      row.appendChild(meta);

      var isImg = (att.mimeType || "").indexOf("image/") === 0;
      if (isImg && (Number(att.size) || 0) <= MAIL_INLINE_IMG_MAX){
        var img = document.createElement("img");
        img.className = "mail-attach-img";
        img.alt = att.filename || "";
        img.textContent = "";
        row.appendChild(img);
        mailAttachFetch(att).then(function(url){
          img.src = url;
        }).catch(function(err){
          var e = document.createElement("div");
          e.className = "mail-attach-err";
          e.textContent = (err && err.message) || "画像の読み込みに失敗しました。";
          row.appendChild(e);
        });
      } else {
        var btns = document.createElement("div");
        btns.className = "mail-attach-btns";
        var openBtn = document.createElement("button");
        openBtn.type = "button";
        openBtn.className = "mail-attach-btn";
        openBtn.textContent = "開く";
        var saveBtn = document.createElement("button");
        saveBtn.type = "button";
        saveBtn.className = "mail-attach-btn";
        saveBtn.textContent = "保存";
        var errEl = document.createElement("div");
        errEl.className = "mail-attach-err";
        errEl.hidden = true;

        function withFetch(fn){
          openBtn.disabled = true; saveBtn.disabled = true;
          errEl.hidden = true;
          mailAttachFetch(att).then(function(url){
            fn(url);
          }).catch(function(err){
            errEl.textContent = (err && err.message) || "取得に失敗しました。";
            errEl.hidden = false;
          }).then(function(){
            openBtn.disabled = false; saveBtn.disabled = false;
          });
        }
        openBtn.addEventListener("click", function(){
          withFetch(function(url){ window.open(url, "_blank", "noopener"); });
        });
        saveBtn.addEventListener("click", function(){
          withFetch(function(url){
            var a = document.createElement("a");
            a.href = url;
            a.download = att.filename || "attachment";
            document.body.appendChild(a);
            a.click();
            a.remove();
          });
        });
        btns.appendChild(openBtn);
        btns.appendChild(saveBtn);
        row.appendChild(btns);
        row.appendChild(errEl);
      }
      wrap.appendChild(row);
    });

    mailDetailBody.appendChild(wrap);
  }

  function closeMailModal(){
    mailModal.hidden = true;
    document.body.style.overflow = "";
    mailObjectUrls.forEach(function(u){ try { URL.revokeObjectURL(u); } catch(e){} });
    mailObjectUrls = [];
    // 未読タブでメールを開くと既読になるので、現在ページを取り直して一覧から消す。
    if (mailState.filter === "unread" && !harukaMailLoading && !harukaMailError){
      fetchMailPage();
    }
  }

  document.getElementById("mail-modal-close").addEventListener("click", closeMailModal);
  mailModal.addEventListener("click", function(e){ if (e.target === mailModal) closeMailModal(); });

  // スレッド操作(アーカイブ / 未読にする / ゴミ箱)。gmail.modify スコープで実行。
  async function runMailAction(action){
    if (!currentMailThread) return;
    var btns = mailActionsEl ? mailActionsEl.querySelectorAll(".mail-act-btn") : [];
    btns.forEach(function(b){ b.disabled = true; });
    if (mailActMsg) mailActMsg.textContent = "実行中…";
    try{
      await apiFetch(
        acctPath("/api/google/gmail/threads/" + encodeURIComponent(currentMailThread) + "/action", mailState.account),
        { method: "POST", body: JSON.stringify({ action: action }) }
      );
      // 一覧から取り除く / 未読を反映するため現在ページを取り直してからモーダルを閉じる。
      mailModal.hidden = true;
      document.body.style.overflow = "";
      mailObjectUrls.forEach(function(u){ try { URL.revokeObjectURL(u); } catch(e){} });
      mailObjectUrls = [];
      currentMailThread = null;
      fetchMailPage();
      loadGmailUnreadCount();
    } catch(err){
      btns.forEach(function(b){ b.disabled = false; });
      if (mailActMsg) mailActMsg.textContent = apiErrorMessage(err, "Gmail") || "操作に失敗しました";
    }
  }
  if (mailActionsEl){
    mailActionsEl.querySelectorAll(".mail-act-btn").forEach(function(btn){
      btn.addEventListener("click", function(){ runMailAction(btn.getAttribute("data-mail-action")); });
    });
  }

  /* ================= 支払い仕分け(SYSLEA 01.payment 専用) =================
     01.payment に溜まった請求書メールを、本文＋添付PDFのテキストから
     銀行振込 / UPSIDER / 口座振替 / その他 に自動分類し、ワンクリックで
     Gmail のサブラベルへ振り分ける。PDF のテキスト抽出は pdf.js(CDN)。
     判定はバックエンド /api/payments/classify(ベンダー表＋ルール＋AI)。 */
  var mailSortBtn = document.getElementById("mail-sort-btn");
  var mailSortPanel = document.getElementById("mail-sort-panel");
  var mailPagerEl = document.getElementById("mail-pager");
  var PAY_METHODS = ["銀行振込", "UPSIDER", "口座振替", "その他"];
  var PAY_METHOD_LABEL = {
    "銀行振込": "01.payment/01.銀行振込",
    "UPSIDER": "01.payment/02.UPSIDER",
    "口座振替": "01.payment/03.口座振替",
    "その他": "01.payment/99.その他"
  };
  var PDFJS_VER = "4.0.379";
  var _pdfjs = null;
  var paySortRunning = false;
  var paySortResults = null;
  var payHistCache = null;   // GET /list の結果(履歴表示用、パネルを閉じるまで保持)

  function payInSortableView(){
    return mailState.account === "syslea" && mailState.labelName === "01.payment";
  }
  function updateMailSortBtn(){
    if (!mailSortBtn) return;
    var show = payInSortableView();
    mailSortBtn.hidden = !show;
    // 未仕分けが 0 でも履歴は見られるので、01.payment 表示中は常に押せる
    if (show && !paySortRunning) mailSortBtn.disabled = false;
  }

  // PDF/本文テキストから請求金額を推定(取れなければ null)。
  function payParseAmount(text){
    if (!text) return null;
    var t = String(text).replace(/[，]/g, ",");
    var pats = [
      /(?:ご請求金額|ご請求額|請求金額|お支払金額|お支払い金額|お振込金額|合計金額|請求合計|合計|総額|Amount\s*(?:paid|due)?)[^\d¥￥$]{0,10}[¥￥$]?\s*([0-9][0-9,]{2,})/,
      /[¥￥]\s*([0-9]{1,3}(?:,[0-9]{3})+)/
    ];
    for (var i = 0; i < pats.length; i++){
      var m = t.match(pats[i]);
      if (m){ var n = Number(m[1].replace(/,/g, "")); if (n >= 100 && n < 1e9) return n; }
    }
    return null;
  }
  // 件名/本文から請求対象月(YYYY-MM)を推定。
  function payParsePeriodMonth(subject, body){
    var s = (subject || "") + " " + String(body || "").slice(0, 300);
    var m = s.match(/(20\d{2})\s*[年\/\-.]\s*(1[0-2]|0?[1-9])\s*月?/);
    if (m) return m[1] + "-" + ("0" + m[2]).slice(-2);
    m = s.match(/(1[0-2]|0?[1-9])\s*月分/);
    if (m){
      var now = new Date(); var mm = Number(m[1]);
      var y = (now.getMonth() + 1) >= mm ? now.getFullYear() : now.getFullYear() - 1;
      return y + "-" + ("0" + mm).slice(-2);
    }
    return null;
  }
  // 済_2026/09 のようなラベル名から請求月を取り出す。
  function payMonthFromLabel(name){
    var m = String(name || "").match(/(20\d{2})[\/年-](1[0-2]|0[1-9])/);
    return m ? m[1] + "-" + m[2] : null;
  }
  function payYmFromMs(ms){
    if (!ms) return null;
    var d = new Date(ms);
    return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2);
  }
  function payYen(n){
    return (n == null) ? "" : "¥" + Number(n).toLocaleString("ja-JP");
  }
  // 分類/仕分け結果を台帳(users/{uid}/payments)へ保存。失敗しても致命的でない。
  function paySaveRecords(records){
    if (!records || !records.length) return Promise.resolve();
    return apiFetch("/api/payments/records", { method: "POST", body: JSON.stringify({ records: records }) })
      .catch(function(){});
  }

  async function ensurePdfJs(){
    if (_pdfjs) return _pdfjs;
    var base = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/" + PDFJS_VER + "/";
    var mod = await import(base + "pdf.min.mjs");
    var lib = (mod && mod.getDocument) ? mod : (mod && mod.default && mod.default.getDocument ? mod.default : null);
    if (!lib) throw new Error("pdf.js 読み込み不可");
    try { lib.GlobalWorkerOptions.workerSrc = base + "pdf.worker.min.mjs"; } catch (e) {}
    _pdfjs = lib;
    return lib;
  }
  async function extractPdfText(arrayBuf){
    var lib = await ensurePdfJs();
    // doc.destroy() は共有ワーカーを巻き込んで壊し、直後の getDocument を失敗させる
    // (連続処理で2件目以降が空になる)。破棄せず GC に任せる。
    var doc = await lib.getDocument({ data: new Uint8Array(arrayBuf) }).promise;
    var pages = [];
    var max = Math.min(doc.numPages, 8);
    for (var p = 1; p <= max; p++){
      var pg = await doc.getPage(p);
      var tc = await pg.getTextContent();
      pages.push(tc.items.map(function(i){ return i.str; }).join(""));
    }
    return pages.join("\n");
  }
  async function mailAttachBytes(att){
    var token = await getIdToken();
    if (!token) throw new Error("未ログインです。");
    var path = "/api/google/gmail/messages/" + encodeURIComponent(att.messageId) +
      "/attachments/" + encodeURIComponent(att.attachmentId) +
      "?name=" + encodeURIComponent(att.filename || "a") +
      "&mime=" + encodeURIComponent(att.mimeType || "application/pdf");
    var res = await fetch(API_BASE + acctPath(path, "syslea"), { headers: { "Authorization": "Bearer " + token } });
    if (!res.ok) throw new Error("添付取得失敗 " + res.status);
    return res.arrayBuffer();
  }

  function payMethodClass(m){
    return m === "銀行振込" ? "is-furikomi" : m === "UPSIDER" ? "is-upsider" : m === "口座振替" ? "is-furikae" : "is-other";
  }
  function labelIdByName(name){
    var hit = (mailLabels || []).filter(function(l){ return l.name === name; })[0];
    return hit ? hit.id : null;
  }
  function openSortPanel(){
    if (!mailSortPanel) return;
    mailList.hidden = true;
    if (mailPagerEl) mailPagerEl.hidden = true;
    mailSortPanel.hidden = false;
  }
  function closeSortPanel(){
    paySortResults = null;
    payHistCache = null;
    paySortRunning = false;
    if (mailSortPanel) mailSortPanel.hidden = true;
    mailList.hidden = false;
    renderMailList();
  }

  async function runPaymentSort(){
    if (paySortRunning || !payInSortableView()) return;
    var mails = (harukaMailItems || []).slice();
    paySortRunning = true;
    if (mailSortBtn) mailSortBtn.disabled = true;
    openSortPanel();

    // 未仕分けメールが無ければ、そのまま履歴表示へ
    if (!mails.length){
      paySortRunning = false;
      if (mailSortBtn) mailSortBtn.disabled = false;
      renderPayHistory();
      return;
    }

    mailSortPanel.innerHTML =
      '<div class="pay-sort-head"><strong>支払い仕分け</strong>' +
      '<button type="button" class="pay-sort-close" id="pay-sort-close0">閉じる</button></div>' +
      '<div class="pay-sort-progress" id="pay-sort-progress">台帳を確認中…</div>';
    document.getElementById("pay-sort-close0").addEventListener("click", closeSortPanel);
    var progEl = document.getElementById("pay-sort-progress");

    // 1. 台帳に既にあるものは再取得・再分類しない
    var known = {};
    try {
      var kr = await apiFetch("/api/payments/known", {
        method: "POST", body: JSON.stringify({ threadIds: mails.map(function(m){ return m.threadId; }) })
      });
      known = (kr && kr.known) || {};
    } catch (e) { /* 台帳照会に失敗しても新規扱いで続行 */ }

    var todo = mails.filter(function(m){ return !known[m.threadId]; });
    var meta = {};   // threadId -> { amount, periodMonth, attachmentNames }
    var items = [];
    for (var i = 0; i < todo.length; i++){
      var mail = todo[i];
      var pdfText = "";
      var atts = [];
      var body = "";
      try {
        var thr = await apiFetch(acctPath("/api/google/gmail/threads/" + encodeURIComponent(mail.threadId), "syslea"));
        body = thr.body || "";
        atts = thr.attachments || [];
        var pdfs = atts.filter(function(a){ return /pdf/i.test(a.mimeType || "") || /\.pdf$/i.test(a.filename || ""); }).slice(0, 3);
        for (var k = 0; k < pdfs.length; k++){
          try {
            var buf = await mailAttachBytes(pdfs[k]);
            pdfText += "\n" + await extractPdfText(buf);
          } catch (e) { /* パスワード付き・画像PDF等は本文だけで判定 */ }
          if (pdfText.length > 9000) break;
        }
      } catch (e) { /* スレッド取得失敗でも空で分類に回す */ }
      meta[mail.threadId] = {
        amount: payParseAmount(pdfText + "\n" + body),
        periodMonth: payParsePeriodMonth(mail.subject, body),
        attachmentNames: atts.map(function(a){ return a.filename; })
      };
      items.push({
        threadId: mail.threadId,
        subject: mail.subject,
        fromAddress: mail.fromAddress || mail.from,
        bodyText: body.slice(0, 4000),
        pdfText: pdfText.slice(0, 9000),
        attachmentNames: meta[mail.threadId].attachmentNames
      });
      if (progEl) progEl.textContent = "メールと添付PDFを解析中… " + (i + 1) + " / " + todo.length;
    }

    var res = { results: [], llm: false };
    if (items.length){
      try {
        res = await apiFetch("/api/payments/classify", { method: "POST", body: JSON.stringify({ items: items }) });
      } catch (e) {
        mailSortPanel.innerHTML =
          '<div class="pay-sort-head"><strong>支払い仕分け</strong>' +
          '<button type="button" class="pay-sort-close" id="pay-sort-closeE">閉じる</button></div>' +
          '<div class="pay-sort-progress">分類に失敗しました: ' + escapeHtml(apiErrorMessage(e, "分類") || e.message || "") + '</div>';
        document.getElementById("pay-sort-closeE").addEventListener("click", closeSortPanel);
        paySortRunning = false;
        if (mailSortBtn) mailSortBtn.disabled = false;
        return;
      }
    }

    var byId = {};
    (res.results || []).forEach(function(r){ byId[r.threadId] = r; });

    var now = Date.now();
    paySortResults = mails.map(function(m){
      var k = known[m.threadId];
      if (k){
        return {
          mail: m, method: k.method, confidence: k.confidence, reasons: k.reasons || [],
          vendorKey: "", source: k.source, amount: k.amount, periodMonth: k.periodMonth,
          attachmentNames: [], cached: true, savedStatus: k.status, applied: false
        };
      }
      var r = byId[m.threadId] || { method: "その他", confidence: 0, reasons: ["結果なし"], vendorKey: "" };
      var mt = meta[m.threadId] || {};
      return {
        mail: m, method: r.method, confidence: r.confidence, reasons: r.reasons || [],
        vendorKey: r.vendorKey || "", source: r.source, amount: mt.amount, periodMonth: mt.periodMonth,
        attachmentNames: mt.attachmentNames || [], cached: false, savedStatus: "classified", applied: false
      };
    });

    // 2. 新規分類分は台帳へ即保存(status: classified) — 次に開いたとき再計算しない
    var fresh = paySortResults.filter(function(x){ return !x.cached; });
    if (fresh.length){
      paySaveRecords(fresh.map(function(x){
        return {
          threadId: x.mail.threadId, subject: x.mail.subject, from: x.mail.from,
          fromAddress: x.mail.fromAddress || x.mail.from, vendorKey: x.vendorKey,
          method: x.method, confidence: x.confidence, reasons: x.reasons,
          source: "auto", status: "classified", amount: x.amount || null,
          periodMonth: x.periodMonth || null, attachmentNames: x.attachmentNames || [],
          classifiedAt: now
        };
      }));
    }

    paySortRunning = false;
    if (mailSortBtn) mailSortBtn.disabled = false;
    renderSortResults(res.llm);
  }

  function renderSortResults(llmUsed){
    if (!mailSortPanel || !paySortResults) return;
    var pending = paySortResults.filter(function(x){ return !x.applied; });
    var cachedN = pending.filter(function(x){ return x.cached; }).length;

    var head = document.createElement("div");
    head.className = "pay-sort-head";
    head.innerHTML = '<strong>支払い仕分け</strong> <span class="pay-sort-sub">' +
      pending.length + ' 件' + (cachedN ? '（うち保存済 ' + cachedN + '）' : '') +
      (llmUsed ? ' ・ AI併用' : ' ・ ルール判定') + '</span>';
    var right = document.createElement("div");
    right.className = "pay-sort-head-actions";
    var bulkBtn = document.createElement("button");
    bulkBtn.type = "button"; bulkBtn.className = "pay-sort-bulk";
    bulkBtn.textContent = "高確信(85%+)をまとめて適用";
    bulkBtn.addEventListener("click", applyHighConfidence);
    var histBtn = document.createElement("button");
    histBtn.type = "button"; histBtn.className = "pay-sort-learn";
    histBtn.textContent = "履歴";
    histBtn.addEventListener("click", function(){ renderPayHistory(); });
    var learnBtn = document.createElement("button");
    learnBtn.type = "button"; learnBtn.className = "pay-sort-learn";
    learnBtn.textContent = "既存ラベルを取り込む";
    learnBtn.addEventListener("click", function(){ seedVendorMap(learnBtn); });
    var closeBtn = document.createElement("button");
    closeBtn.type = "button"; closeBtn.className = "pay-sort-close";
    closeBtn.textContent = "閉じる";
    closeBtn.addEventListener("click", closeSortPanel);
    right.appendChild(bulkBtn); right.appendChild(histBtn); right.appendChild(learnBtn); right.appendChild(closeBtn);
    head.appendChild(right);

    var list = document.createElement("div");
    list.className = "pay-sort-list";
    paySortResults.forEach(function(row){ list.appendChild(buildSortRow(row)); });

    mailSortPanel.innerHTML = "";
    mailSortPanel.appendChild(head);
    mailSortPanel.appendChild(list);
  }

  function buildSortRow(row){
    var el = document.createElement("div");
    el.className = "pay-sort-row" + (row.applied ? " is-applied" : "");
    var top = document.createElement("div");
    top.className = "pay-sort-row-top";
    var who = document.createElement("div");
    who.className = "pay-sort-who";
    who.innerHTML = '<span class="pay-sort-from">' + escapeHtml(row.mail.from) + '</span>' +
      '<span class="pay-sort-subj">' + escapeHtml(row.mail.subject) + '</span>';
    top.appendChild(who);

    if (row.applied){
      var done = document.createElement("span");
      done.className = "pay-sort-done";
      done.textContent = "✓ " + row.method;
      top.appendChild(done);
      el.appendChild(top);
      return el;
    }

    var badge = document.createElement("span");
    badge.className = "pay-badge " + payMethodClass(row.method);
    badge.textContent = row.method + " " + Math.round((row.confidence || 0) * 100) + "%";
    top.appendChild(badge);
    if (row.cached){
      var cb = document.createElement("span");
      cb.className = "pay-cached-tag";
      cb.textContent = row.savedStatus === "applied" ? "仕分け済" : "保存済";
      top.appendChild(cb);
    }
    el.appendChild(top);

    var meta = [];
    if (row.amount != null) meta.push(payYen(row.amount));
    if (row.periodMonth) meta.push(row.periodMonth.replace("-", "/") + " 分");
    var why = document.createElement("div");
    why.className = "pay-sort-why";
    why.textContent = (meta.length ? meta.join(" ・ ") + "  —  " : "") + (row.reasons || []).join(" / ");
    el.appendChild(why);

    var ctrl = document.createElement("div");
    ctrl.className = "pay-sort-ctrl";
    var sel = document.createElement("select");
    sel.className = "pay-sort-select";
    PAY_METHODS.forEach(function(m){
      var o = document.createElement("option");
      o.value = m; o.textContent = m;
      if (m === row.method) o.selected = true;
      sel.appendChild(o);
    });
    var apply = document.createElement("button");
    apply.type = "button"; apply.className = "pay-sort-apply"; apply.textContent = "適用";
    apply.addEventListener("click", function(){
      apply.disabled = true; sel.disabled = true;
      applySortRow(row, sel.value, apply, sel);
    });
    var open = document.createElement("button");
    open.type = "button"; open.className = "pay-sort-openmail"; open.textContent = "中身";
    open.addEventListener("click", function(){ openMailDetail(row.mail); });
    ctrl.appendChild(sel); ctrl.appendChild(apply); ctrl.appendChild(open);
    el.appendChild(ctrl);
    return el;
  }

  async function applySortRow(row, method, applyBtn, sel){
    var subName = PAY_METHOD_LABEL[method];
    var subId = labelIdByName(subName);
    var parentId = mailState.labelId;
    if (!subId){
      alert("ラベル「" + subName + "」が見つかりませんでした。SYSLEA 側で作成してください。");
      if (applyBtn) applyBtn.disabled = false;
      if (sel) sel.disabled = false;
      return;
    }
    try {
      await apiFetch(acctPath("/api/google/gmail/threads/" + encodeURIComponent(row.mail.threadId) + "/labels", "syslea"), {
        method: "POST",
        body: JSON.stringify({ addLabelIds: [subId], removeLabelIds: parentId ? [parentId] : [] })
      });
      apiFetch("/api/payments/vendor-map", {
        method: "PUT",
        body: JSON.stringify({ pairs: [{ fromAddress: row.mail.fromAddress || row.mail.from, subject: row.mail.subject, method: method }] })
      }).catch(function(){});
      // 台帳へ「仕分け済み」で保存(方式を変えていれば source=manual)
      var now = Date.now();
      paySaveRecords([{
        threadId: row.mail.threadId, subject: row.mail.subject, from: row.mail.from,
        fromAddress: row.mail.fromAddress || row.mail.from, vendorKey: row.vendorKey || "",
        method: method, confidence: row.confidence, reasons: row.reasons || [],
        source: (method === row.method ? "auto" : "manual"), status: "applied",
        amount: row.amount || null, periodMonth: row.periodMonth || null,
        attachmentNames: row.attachmentNames || [],
        classifiedAt: now, appliedAt: now
      }]);
      row.applied = true; row.method = method;
      harukaMailItems = (harukaMailItems || []).filter(function(m){ return m.threadId !== row.mail.threadId; });
      renderSortResults();
    } catch (e) {
      if (applyBtn) applyBtn.disabled = false;
      if (sel) sel.disabled = false;
      alert("適用に失敗しました: " + (apiErrorMessage(e, "ラベル") || e.message || ""));
    }
  }

  async function applyHighConfidence(){
    var targets = (paySortResults || []).filter(function(x){
      return !x.applied && !x.cached && (x.confidence || 0) >= 0.85 && x.method !== "その他";
    });
    for (var i = 0; i < targets.length; i++){
      await applySortRow(targets[i], targets[i].method);
    }
  }

  /* ---- 支払い履歴(台帳の蓄積を月別に表示) ---- */
  var payHistMethodFilter = "";

  async function renderPayHistory(){
    if (!mailSortPanel) return;
    openSortPanel();
    if (!payHistCache){
      mailSortPanel.innerHTML =
        '<div class="pay-sort-head"><strong>支払い履歴</strong>' +
        '<button type="button" class="pay-sort-close" id="pay-hist-close0">閉じる</button></div>' +
        '<div class="pay-sort-progress">読み込み中…</div>';
      document.getElementById("pay-hist-close0").addEventListener("click", closeSortPanel);
      try {
        var r = await apiFetch("/api/payments/list?limit=1500");
        payHistCache = (r && r.records) || [];
      } catch (e) {
        mailSortPanel.innerHTML =
          '<div class="pay-sort-head"><strong>支払い履歴</strong>' +
          '<button type="button" class="pay-sort-close" id="pay-hist-closeE">閉じる</button></div>' +
          '<div class="pay-sort-progress">履歴の取得に失敗しました: ' + escapeHtml(apiErrorMessage(e, "履歴") || e.message || "") + '</div>';
        document.getElementById("pay-hist-closeE").addEventListener("click", closeSortPanel);
        return;
      }
    }

    var all = payHistCache.slice();
    var recs = payHistMethodFilter ? all.filter(function(x){ return x.method === payHistMethodFilter; }) : all;

    // 月キーでグループ化(periodMonth 優先、無ければ分類日時の月)
    var groups = {};
    recs.forEach(function(x){
      var key = x.periodMonth || payYmFromMs(x.classifiedAt) || "不明";
      (groups[key] = groups[key] || []).push(x);
    });
    var monthKeys = Object.keys(groups).sort(function(a, b){ return a < b ? 1 : a > b ? -1 : 0; });

    var head = document.createElement("div");
    head.className = "pay-sort-head";
    head.innerHTML = '<strong>支払い履歴</strong> <span class="pay-sort-sub">' + all.length + ' 件</span>';
    var right = document.createElement("div");
    right.className = "pay-sort-head-actions";
    if (paySortResults){
      var backBtn = document.createElement("button");
      backBtn.type = "button"; backBtn.className = "pay-sort-learn";
      backBtn.textContent = "仕分けに戻る";
      backBtn.addEventListener("click", function(){ renderSortResults(false); });
      right.appendChild(backBtn);
    }
    var refreshBtn = document.createElement("button");
    refreshBtn.type = "button"; refreshBtn.className = "pay-sort-learn";
    refreshBtn.textContent = "再読込";
    refreshBtn.addEventListener("click", function(){ payHistCache = null; renderPayHistory(); });
    var closeBtn = document.createElement("button");
    closeBtn.type = "button"; closeBtn.className = "pay-sort-close";
    closeBtn.textContent = "閉じる";
    closeBtn.addEventListener("click", closeSortPanel);
    right.appendChild(refreshBtn); right.appendChild(closeBtn);
    head.appendChild(right);

    // 方式フィルタのチップ
    var chips = document.createElement("div");
    chips.className = "pay-hist-chips";
    [["", "すべて"]].concat(PAY_METHODS.map(function(m){ return [m, m]; })).forEach(function(pair){
      var b = document.createElement("button");
      b.type = "button";
      b.className = "pay-hist-chip" + (payHistMethodFilter === pair[0] ? " is-on" : "");
      b.textContent = pair[1];
      b.addEventListener("click", function(){ payHistMethodFilter = pair[0]; renderPayHistory(); });
      chips.appendChild(b);
    });

    var body = document.createElement("div");
    body.className = "pay-hist-body";
    if (!recs.length){
      body.innerHTML = '<div class="pay-sort-progress">まだ記録がありません。「支払い仕分け」で仕分けるか「既存ラベルを取り込む」で過去分を取り込めます。</div>';
    }
    monthKeys.forEach(function(mk){
      var rows = groups[mk];
      var byM = {};
      var sum = 0;
      rows.forEach(function(x){
        byM[x.method] = (byM[x.method] || 0) + 1;
        if (x.amount) sum += x.amount;
      });
      var g = document.createElement("div");
      g.className = "pay-hist-group";
      var gh = document.createElement("div");
      gh.className = "pay-hist-month";
      var tally = PAY_METHODS.filter(function(m){ return byM[m]; })
        .map(function(m){ return m + " " + byM[m]; }).join(" ・ ");
      gh.innerHTML = '<span class="pay-hist-mk">' + escapeHtml(mk === "不明" ? "月不明" : mk) + '</span>' +
        '<span class="pay-hist-tally">' + escapeHtml(tally) + (sum ? '　計 ' + payYen(sum) : '') + '</span>';
      g.appendChild(gh);
      rows.sort(function(a, b){ return (b.classifiedAt || 0) - (a.classifiedAt || 0); });
      var HIST_ROW_CAP = 60;
      var shown = rows.slice(0, HIST_ROW_CAP);
      if (rows.length > HIST_ROW_CAP){
        var more = document.createElement("div");
        more.className = "pay-hist-row pay-hist-more";
        more.textContent = "…ほか " + (rows.length - HIST_ROW_CAP) + " 件";
        g.appendChild(more);
      }
      shown.forEach(function(x){
        var rr = document.createElement("div");
        rr.className = "pay-hist-row";
        rr.innerHTML =
          '<span class="pay-badge ' + payMethodClass(x.method) + '">' + escapeHtml(x.method) + '</span>' +
          '<span class="pay-hist-subj">' + escapeHtml(x.subject || "(件名なし)") + '</span>' +
          '<span class="pay-hist-amt">' + (x.amount != null ? payYen(x.amount) : "") + '</span>' +
          '<span class="pay-hist-src">' + escapeHtml(x.status === "applied" ? "仕分け済" : "分類") +
          (x.source === "backfill" ? "・取込" : x.source === "manual" ? "・手動" : "") + '</span>';
        g.appendChild(rr);
      });
      body.appendChild(g);
    });

    mailSortPanel.innerHTML = "";
    mailSortPanel.appendChild(head);
    mailSortPanel.appendChild(chips);
    mailSortPanel.appendChild(body);
  }

  async function seedVendorMap(btn){
    if (btn){ btn.disabled = true; btn.textContent = "取り込み中…"; }
    try {
      var cats = [
        { re: /^01\.payment\/01\.銀行振込(\/|$)/, method: "銀行振込" },
        { re: /^01\.payment\/02\.UPSIDER(\/|$)/, method: "UPSIDER" },
        { re: /^01\.payment\/03\.口座振替(\/|$)/, method: "口座振替" },
        { re: /^01\.payment\/99\.その他(\/|$)/, method: "その他" }
      ];
      var pairs = [];
      var records = [];
      var seen = {};
      var now = Date.now();
      var labs = (mailLabels || []);
      for (var c = 0; c < cats.length; c++){
        var method = cats[c].method;
        var re = cats[c].re;
        var catLabels = labs.filter(function(l){ return re.test(l.name); });
        for (var li = 0; li < catLabels.length; li++){
          var lblName = catLabels[li].name;
          var lblMonth = payMonthFromLabel(lblName);
          try {
            var r = await apiFetch(acctPath("/api/google/gmail/messages?maxResults=50&labelId=" + encodeURIComponent(catLabels[li].id), "syslea"));
            (r.messages || []).forEach(function(m){
              // その他 はベンダー表には入れない(方式が定まらないため)。台帳には残す。
              if (method !== "その他"){
                pairs.push({ fromAddress: m.fromAddress || m.from, subject: m.subject, method: method });
              }
              if (seen[m.threadId]) return;
              seen[m.threadId] = 1;
              records.push({
                threadId: m.threadId, subject: m.subject, from: m.from,
                fromAddress: m.fromAddress || m.from, vendorKey: "",
                method: method, confidence: 1, reasons: ["既存ラベル取込"],
                source: "backfill", status: "applied",
                periodMonth: lblMonth || payParsePeriodMonth(m.subject, ""),
                amount: null,
                classifiedAt: m.date ? (Date.parse(m.date) || now) : now,
                appliedAt: now
              });
            });
          } catch (e) {}
        }
      }
      if (!records.length){
        if (btn){ btn.disabled = false; btn.textContent = "既存ラベルを取り込む"; }
        alert("取り込めるメールが見つかりませんでした。");
        return;
      }
      var vres = pairs.length
        ? await apiFetch("/api/payments/vendor-map", { method: "PUT", body: JSON.stringify({ pairs: pairs }) })
        : { count: 0 };
      // 台帳へ(400件ずつ)
      var saved = 0;
      for (var s = 0; s < records.length; s += 400){
        try {
          var pr = await apiFetch("/api/payments/records", { method: "POST", body: JSON.stringify({ records: records.slice(s, s + 400) }) });
          saved += (pr && pr.count) || 0;
        } catch (e) {}
      }
      payHistCache = null; // 次に履歴を開いたら取り込み分が出る
      if (btn){ btn.disabled = false; btn.textContent = "取込済 (" + (vres.count || 0) + "社 / " + saved + "件)"; }
    } catch (e) {
      if (btn){ btn.disabled = false; btn.textContent = "既存ラベルを取り込む"; }
      alert("取り込みに失敗しました: " + (apiErrorMessage(e, "取込") || e.message || ""));
    }
  }

  if (mailSortBtn) mailSortBtn.addEventListener("click", runPaymentSort);

  var mailSearchInput = document.getElementById("mail-search");

  wireAcctTabs("mail-acct-tabs", function(){ return mailState.account; }, function(acct){
    mailState.account = acct;
    mailState.filter = "all";
    mailState.query = "";
    mailState.labelId = "INBOX";
    mailState.labelName = "受信トレイ";
    mailLabels = null;
    if (mailSearchInput) mailSearchInput.value = "";
    document.querySelectorAll("#mail-filter-tabs .acct-tab").forEach(function(b){
      b.classList.toggle("active", b.getAttribute("data-filter") === "all");
    });
    reloadMailFromFirstPage();
    loadMailLabels();
  });

  // すべて / 未読 タブ。はるか側はサーバーで絞り込むため1ページ目から取り直す。
  document.querySelectorAll("#mail-filter-tabs .acct-tab").forEach(function(btn){
    btn.addEventListener("click", function(){
      var f = btn.getAttribute("data-filter");
      if (f === mailState.filter) return;
      document.querySelectorAll("#mail-filter-tabs .acct-tab").forEach(function(b){
        b.classList.toggle("active", b === btn);
      });
      mailState.filter = f;
      reloadMailFromFirstPage();
    });
  });

  // メール検索。入力が落ち着いてから(デバウンス)1ページ目を取り直す。Enter で即時。
  if (mailSearchInput){
    var mailSearchTimer = null;
    var runMailSearch = function(){
      var q = mailSearchInput.value.trim();
      if (q === mailState.query) return;
      mailState.query = q;
      reloadMailFromFirstPage();
    };
    mailSearchInput.addEventListener("input", function(){
      clearTimeout(mailSearchTimer);
      mailSearchTimer = setTimeout(runMailSearch, 350);
    });
    mailSearchInput.addEventListener("keydown", function(e){
      if (e.key === "Enter"){ e.preventDefault(); clearTimeout(mailSearchTimer); runMailSearch(); }
    });
    // ネイティブのクリア(×)やEscでの空化にも対応
    mailSearchInput.addEventListener("search", function(){
      clearTimeout(mailSearchTimer); runMailSearch();
    });
  }

  mailPrevBtn.addEventListener("click", function(){
    if (mailState.pageIndex > 0 && !harukaMailLoading){
      mailState.pageIndex--;
      fetchMailPage();
    }
  });
  mailNextBtn.addEventListener("click", function(){
    if (harukaMailNextToken && !harukaMailLoading){
      mailState.pageIndex++;
      fetchMailPage();
    }
  });

  function renderInboxRow(numEl, labelEl, count, err){
    if (err){
      if (err.code === "google_not_connected"){
        numEl.textContent = "–";
        labelEl.textContent = "要再連携";
      } else {
        numEl.textContent = "!";
        labelEl.textContent = apiErrorMessage(err, "Gmail");
      }
      return;
    }
    if (count === null){
      numEl.textContent = "--";
      labelEl.textContent = "読み込み中…";
      return;
    }
    numEl.textContent = String(count);
    labelEl.textContent = count ? "件の新着メール" : "新着メールなし";
  }

  function renderHomeInbox(){
    homeInboxTag.hidden = true;
    // 連携ボタンは常時表示。未連携なら「連携する」、連携済みなら「再連携」。
    homeGoogleConnectBtn.hidden = false;
    if (!googleConnecting){
      var notConnected = harukaUnreadError && harukaUnreadError.code === "google_not_connected";
      homeGoogleConnectBtn.textContent = notConnected ? "Googleサービスと連携する" : "Google再連携";
    }
    renderInboxRow(homeInboxCountNum, homeInboxCountLabel, harukaUnreadCount, harukaUnreadError);
    renderInboxRow(homeInboxCountNumSyslea, homeInboxCountLabelSyslea, sysleaUnreadCount, sysleaUnreadError);
    if (typeof refreshNotifCenter === "function") refreshNotifCenter();
    if (typeof maybeNotifyNewMail === "function") maybeNotifyNewMail();
  }

  function openMailForAccount(acct){
    var tab = document.querySelector('#mail-acct-tabs .acct-tab[data-account="' + acct + '"]');
    if (tab && acct !== mailState.account) tab.click();
    showView("mail");
  }
  homeInboxCountBtn.addEventListener("click", function(){ openMailForAccount("haruka"); });
  homeInboxCountBtnSyslea.addEventListener("click", function(){ openMailForAccount("syslea"); });
  document.getElementById("home-inbox-more").addEventListener("click", function(){ showView("mail"); });

  /* ================= shared: in-page confirm modal =================
     window.confirm() is silently blocked inside the published artifact's
     sandboxed frame (it returns false immediately without showing anything),
     which is why delete buttons appeared unresponsive. This in-page modal
     replaces every window.confirm() call in the app. */
  var confirmModal = document.getElementById("confirm-modal");
  var confirmModalBody = document.getElementById("confirm-modal-body");
  var confirmModalOk = document.getElementById("confirm-modal-ok");
  var confirmModalCancel = document.getElementById("confirm-modal-cancel");
  var confirmResolve = null;
  function askConfirm(message, okLabel){
    return new Promise(function(resolve){
      confirmResolve = resolve;
      confirmModalBody.textContent = message;
      confirmModalOk.textContent = okLabel || "削除する";
      confirmModal.hidden = false;
      document.body.style.overflow = "hidden";
    });
  }
  function closeConfirmModal(result){
    confirmModal.hidden = true;
    document.body.style.overflow = "";
    var resolve = confirmResolve;
    confirmResolve = null;
    if (resolve) resolve(result);
  }
  confirmModalOk.addEventListener("click", function(){ closeConfirmModal(true); });
  confirmModalCancel.addEventListener("click", function(){ closeConfirmModal(false); });
  confirmModal.addEventListener("click", function(e){ if (e.target === confirmModal) closeConfirmModal(false); });

  function setActiveTab(containerId, value){
    document.querySelectorAll("#" + containerId + " .acct-tab").forEach(function(b){
      b.classList.toggle("active", b.getAttribute("data-account") === value);
    });
  }

  var TASK_TAG_LABEL = { haruka: "はるか", syslea: "SYSLEA" };
  var TASK_REPEAT_LABEL = { daily: "毎日", weekly: "毎週", monthly: "毎月" };
  var WEEKDAY_JA = ["日","月","火","水","木","金","土"];
  var REPEAT_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 4v5h-5"/></svg>';

  function repeatSummary(task){
    if (!task.repeat || task.repeat === "none") return "";
    if (task.repeat === "weekly" && task.repeatDays && task.repeatDays.length){
      return "毎週 " + task.repeatDays.slice().sort().map(function(d){ return WEEKDAY_JA[d]; }).join("・");
    }
    if (task.repeat === "monthly" && task.repeatDayOfMonth){
      return "毎月" + task.repeatDayOfMonth + "日";
    }
    return TASK_REPEAT_LABEL[task.repeat] || task.repeat;
  }

  // Computes the next occurrence's due-date key (YYYY-MM-DD) for a repeating task,
  // counting forward from `fromKey`. Used so that checking off a repeating task
  // rolls it to its next occurrence instead of just marking it permanently done.
  function nextRepeatDueKey(task, fromKey){
    if (task.repeat === "daily"){
      return addDaysKey(fromKey, 1);
    }
    if (task.repeat === "weekly"){
      var days = (task.repeatDays && task.repeatDays.length) ? task.repeatDays.slice().sort(function(a,b){ return a - b; }) : [keyWeekday(fromKey)];
      for (var i = 1; i <= 7; i++){
        var candidate = addDaysKey(fromKey, i);
        if (days.indexOf(keyWeekday(candidate)) !== -1) return candidate;
      }
      return addDaysKey(fromKey, 7);
    }
    if (task.repeat === "monthly"){
      var p = keyParts(fromKey);
      var dom = task.repeatDayOfMonth || p.d;
      var y = p.y, m = p.m + 1;
      if (m > 12){ m = 1; y += 1; }
      var lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      var day = Math.min(dom, lastDay);
      return y + "-" + String(m).padStart(2, "0") + "-" + String(day).padStart(2, "0");
    }
    return null;
  }

  /* ================= TASKS (self-persisted in the portal via the artifact capability) ================= */
  // Stored as a sibling data file (data/tasks.json), not inside index.html —
  // publishing just that file leaves the page itself untouched and this view
  // keeps running after a save (see the `artifact` capability's files form).
  var TASKS_PATH = "data/tasks.json";
  var tasksState = [];
  var tasksStatusBar = document.getElementById("tasks-status-bar");
  var taskList = document.getElementById("task-list");
  var taskSaveTimer = null;
  var taskFilterTag = "all";
  var taskTagFilter = "";   // 自由タグでの絞り込み("" = なし)
  var editingTaskId = null; // null = creating a new task
  var taskFormTag = "haruka";

  // 自由タグ入力("月次決算, 経理  経理" 等) → 一意な配列。各24字・最大12個。
  function parseFreeTags(str){
    var seen = {};
    var out = [];
    String(str == null ? "" : str).split(/[,、\s]+/).forEach(function(s){
      s = s.trim().slice(0, 24);
      if (!s || seen[s]) return;
      seen[s] = 1;
      out.push(s);
    });
    return out.slice(0, 12);
  }
  function taskFreeTagChip(label, onRemove, on){
    var chip = document.createElement("span");
    chip.className = "task-freetag" + (on ? " is-on" : "");
    chip.appendChild(document.createTextNode(label));
    if (onRemove){
      var x = document.createElement("button");
      x.type = "button"; x.textContent = "×"; x.setAttribute("aria-label", label + " を外す");
      x.addEventListener("click", function(e){ e.stopPropagation(); onRemove(); });
      chip.appendChild(x);
    }
    return chip;
  }
  // モーダルの「タグ（自由）」入力の下に、現在の入力内容をチップでプレビュー(× で削除)
  function renderTaskTagChips(){
    var input = document.getElementById("task-tags-input");
    var wrap = document.getElementById("task-tags-chips");
    if (!input || !wrap) return;
    var tags = parseFreeTags(input.value);
    wrap.innerHTML = "";
    wrap.hidden = !tags.length;
    tags.forEach(function(t){
      wrap.appendChild(taskFreeTagChip(t, function(){
        input.value = tags.filter(function(x){ return x !== t; }).join(", ");
        renderTaskTagChips();
      }));
    });
  }
  // タスク一覧の上の「タグで絞り込み」チップ行
  function renderTaskTagFilter(){
    var bar = document.getElementById("task-tag-filter");
    if (!bar) return;
    var all = {};
    tasksState.forEach(function(t){ (t.tags || []).forEach(function(x){ if (x) all[x] = 1; }); });
    var tags = Object.keys(all).sort(function(a, b){ return a.localeCompare(b, "ja"); });
    bar.innerHTML = "";
    if (!tags.length){ bar.hidden = true; taskTagFilter = ""; return; }
    bar.hidden = false;
    if (taskTagFilter && tags.indexOf(taskTagFilter) === -1) taskTagFilter = "";
    tags.forEach(function(t){
      bar.appendChild(taskFreeTagChip(t, null, t === taskTagFilter)).addEventListener("click", function(){
        taskTagFilter = (taskTagFilter === t) ? "" : t;
        renderTasks();
      });
    });
  }
  var taskFormRepeatDays = []; // selected weekdays (0=Sun..6=Sat) while the weekly picker is open
  var taskExpandedIds = {}; // id -> true while a task row's detail is expanded
  var taskSectionCollapsed = { pending: false, done: true }; // 完了 collapsed by default to keep the list short

  var taskModal = document.getElementById("task-modal");
  var taskModalTitle = document.getElementById("task-modal-title");
  var taskForm = document.getElementById("task-form");
  var taskTitleInput = document.getElementById("task-title-input");
  var taskDueInput = document.getElementById("task-due-input");
  var taskRepeatInput = document.getElementById("task-repeat-input");
  var taskRepeatWeekly = document.getElementById("task-repeat-weekly");
  var taskRepeatMonthly = document.getElementById("task-repeat-monthly");
  var taskWeekdayPicker = document.getElementById("task-weekday-picker");
  var taskMonthdayInput = document.getElementById("task-monthday-input");
  var taskUrlInput = document.getElementById("task-url-input");
  var taskRemarksInput = document.getElementById("task-remarks-input");
  var taskFormError = document.getElementById("task-form-error");
  var taskDeleteBtn = document.getElementById("task-delete");

  function updateRepeatDetailVisibility(){
    var v = taskRepeatInput.value;
    taskRepeatWeekly.hidden = v !== "weekly";
    taskRepeatMonthly.hidden = v !== "monthly";
  }
  taskRepeatInput.addEventListener("change", updateRepeatDetailVisibility);
  var taskTagsInputEl = document.getElementById("task-tags-input");
  if (taskTagsInputEl){
    taskTagsInputEl.addEventListener("input", renderTaskTagChips);
    taskTagsInputEl.addEventListener("blur", function(){ taskTagsInputEl.value = parseFreeTags(taskTagsInputEl.value).join(", "); renderTaskTagChips(); });
  }
  taskWeekdayPicker.querySelectorAll(".weekday-btn").forEach(function(btn){
    btn.addEventListener("click", function(){
      var d = Number(btn.getAttribute("data-day"));
      var idx = taskFormRepeatDays.indexOf(d);
      if (idx === -1) taskFormRepeatDays.push(d); else taskFormRepeatDays.splice(idx, 1);
      btn.classList.toggle("active", idx === -1);
    });
  });

  function setTasksStatus(text, cls){
    tasksStatusBar.textContent = text;
    tasksStatusBar.className = "panel cal-status-bar" + (cls ? " " + cls : "");
  }

  async function initTasks(){
    setTasksStatus("読み込み中…");
    try{
      var res = await apiFetch("/api/tasks");
      tasksState = res.tasks || [];
      setTasksStatus("ポータルに保存済み");
    } catch(err){
      tasksState = [];
      setTasksStatus(apiErrorMessage(err, "タスク"), "err");
    }
    renderTasks();
  }

  function buildTaskRow(task, todayKey){
    var li = document.createElement("li");
    li.className = "task-item" + (task.done ? " done" : "") + (taskExpandedIds[task.id] ? " expanded" : "");

    var row = document.createElement("div");
    row.className = "task-row";

    var check = document.createElement("button");
    check.type = "button";
    check.className = "task-check";
    check.setAttribute("aria-label", task.done ? "未完了に戻す" : "完了にする");
    check.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M4 12l6 6L20 6"/></svg>';
    check.addEventListener("click", function(e){
      e.stopPropagation();
      if (!task.done && task.repeat && task.repeat !== "none"){
        // Repeating task: completing it rolls the due date to the next
        // occurrence instead of leaving it checked off permanently.
        var base = (task.due && task.due > todayKey) ? task.due : todayKey;
        var next = nextRepeatDueKey(task, base);
        if (next){
          task.due = next;
          task.done = false;
        } else {
          task.done = true;
        }
      } else {
        task.done = !task.done;
      }
      renderTasks();
      scheduleTasksSave();
    });

    var text = document.createElement("span");
    text.className = "task-text";
    text.textContent = task.text;

    var tagBadge = document.createElement("span");
    tagBadge.className = "tag-badge tag-" + (task.tag || "haruka");
    tagBadge.textContent = TASK_TAG_LABEL[task.tag] || "はるか";

    var expandBtn = document.createElement("button");
    expandBtn.type = "button";
    expandBtn.className = "task-expand-btn";
    expandBtn.setAttribute("aria-label", "詳細を表示");
    expandBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>';

    var del = document.createElement("button");
    del.type = "button";
    del.className = "task-del-btn";
    del.setAttribute("aria-label", "削除");
    del.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    del.addEventListener("click", async function(e){
      e.stopPropagation();
      if (!(await askConfirm('「' + task.text + '」を削除しますか?'))) return;
      tasksState = tasksState.filter(function(t){ return t.id !== task.id; });
      renderTasks();
      scheduleTasksSave();
    });

    row.appendChild(check); row.appendChild(text);
    if (Array.isArray(task.tags) && task.tags.length){
      var tw = document.createElement("span");
      tw.className = "task-row-tags";
      task.tags.slice(0, 3).forEach(function(tg){
        var c = document.createElement("span"); c.className = "task-freetag"; c.textContent = tg;
        tw.appendChild(c);
      });
      if (task.tags.length > 3){
        var more = document.createElement("span"); more.className = "task-freetag"; more.textContent = "+" + (task.tags.length - 3);
        tw.appendChild(more);
      }
      row.appendChild(tw);
    }
    if (task.due){
      var due = document.createElement("span");
      due.className = "task-due";
      due.setAttribute("data-overdue", String(!task.done && task.due < todayKey));
      due.textContent = task.due.slice(5).replace("-", "/") + (task.dueTime ? " " + task.dueTime : "");
      row.appendChild(due);
    }
    row.appendChild(tagBadge);
    row.appendChild(expandBtn);
    row.appendChild(del);
    row.addEventListener("click", function(){
      if (taskExpandedIds[task.id]) delete taskExpandedIds[task.id];
      else taskExpandedIds[task.id] = true;
      renderTasks();
    });

    var detail = document.createElement("div");
    detail.className = "task-detail";
    var summary = repeatSummary(task);
    if (summary){
      var rep = document.createElement("span");
      rep.className = "task-repeat-badge";
      rep.innerHTML = REPEAT_ICON_SVG + "<span>" + escapeHtml(summary) + "</span>";
      detail.appendChild(rep);
    }
    if (task.url){
      var link = document.createElement("a");
      link.className = "task-url";
      link.href = task.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.07 0l2.83-2.83a5 5 0 0 0-7.07-7.07L11.5 4.5"/><path d="M14 11a5 5 0 0 0-7.07 0L4.1 13.83a5 5 0 0 0 7.07 7.07L12.5 19.5"/></svg><span>' + escapeHtml(task.url) + '</span>';
      link.addEventListener("click", function(e){ e.stopPropagation(); });
      detail.appendChild(link);
    }
    if (task.remarks){
      var remarks = document.createElement("div");
      remarks.className = "task-remarks";
      remarks.textContent = task.remarks;
      detail.appendChild(remarks);
    }
    var editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "task-edit-btn";
    editBtn.textContent = "編集";
    editBtn.addEventListener("click", function(e){ e.stopPropagation(); openEditTask(task); });
    detail.appendChild(editBtn);

    li.appendChild(row); li.appendChild(detail);
    return li;
  }

  function buildTaskSection(key, label, items, todayKey){
    var section = document.createElement("div");
    section.className = "task-section" + (taskSectionCollapsed[key] ? " collapsed" : "");
    var head = document.createElement("button");
    head.type = "button";
    head.className = "task-section-head";
    head.innerHTML = '<svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg><span>'
      + escapeHtml(label) + '</span><span class="task-section-count">' + items.length + '</span>';
    head.addEventListener("click", function(){
      taskSectionCollapsed[key] = !taskSectionCollapsed[key];
      renderTasks();
    });
    var ul = document.createElement("ul");
    items.forEach(function(task){ ul.appendChild(buildTaskRow(task, todayKey)); });
    section.appendChild(head); section.appendChild(ul);
    return section;
  }

  function renderTasks(){
    renderBizTasks(); // ビジネス画面の「最近のタスク」ミニリストも同時に更新
    renderTaskTagFilter();
    taskList.innerHTML = "";
    var items = tasksState.filter(function(t){
      if (taskFilterTag !== "all" && t.tag !== taskFilterTag) return false;
      if (taskTagFilter && (t.tags || []).indexOf(taskTagFilter) === -1) return false;
      return true;
    });
    if (items.length === 0){
      taskList.innerHTML = '<div class="task-empty">タスクはありません。「+ 新規タスク」から追加してください。</div>';
      return;
    }
    var todayKey = jstDateKey(new Date());
    var byDue = function(a, b){ return (a.due || "9999-99-99").localeCompare(b.due || "9999-99-99"); };
    var pending = items.filter(function(t){ return !t.done; }).sort(byDue);
    var done = items.filter(function(t){ return t.done; }).sort(byDue);
    if (pending.length) taskList.appendChild(buildTaskSection("pending", "未完了", pending, todayKey));
    if (done.length) taskList.appendChild(buildTaskSection("done", "完了", done, todayKey));
  }

  function scheduleTasksSave(){
    setTasksStatus("保存中…");
    if (taskSaveTimer) clearTimeout(taskSaveTimer);
    taskSaveTimer = setTimeout(saveTasksNow, 600);
  }

  async function saveTasksNow(){
    try{
      await apiFetch("/api/tasks/bulk", {
        method: "PUT",
        body: JSON.stringify({ tasks: tasksState })
      });
      setTasksStatus("保存済み ・ " + fmtSavedAt(Date.now()));
    } catch(err){
      console.error("[saveTasksNow] failed:", err);
      setTasksStatus(artifactErrorMessage(err), "err");
    }
  }

  wireAcctTabs("task-filter-tabs", function(){ return taskFilterTag; }, function(v){
    taskFilterTag = v;
    renderTasks();
  });
  wireAcctTabs("task-tag-tabs", function(){ return taskFormTag; }, function(v){ taskFormTag = v; });

  function setWeekdayPicker(selectedDays){
    taskFormRepeatDays = (selectedDays || []).slice();
    taskWeekdayPicker.querySelectorAll(".weekday-btn").forEach(function(btn){
      btn.classList.toggle("active", taskFormRepeatDays.indexOf(Number(btn.getAttribute("data-day"))) !== -1);
    });
  }
  function openNewTask(defaultTag){
    editingTaskId = null;
    taskModalTitle.textContent = "新規タスク";
    taskTitleInput.value = "";
    taskDueInput.value = "";
    var dtN = document.getElementById("task-duetime-input"); if (dtN) dtN.value = "";
    var tgN = document.getElementById("task-tags-input"); if (tgN) tgN.value = "";
    renderTaskTagChips();
    taskRepeatInput.value = "none";
    setWeekdayPicker([]);
    taskMonthdayInput.value = "";
    updateRepeatDetailVisibility();
    taskUrlInput.value = "";
    taskRemarksInput.value = "";
    taskFormTag = defaultTag === "syslea" ? "syslea" : "haruka";
    setActiveTab("task-tag-tabs", taskFormTag);
    taskFormError.hidden = true;
    taskDeleteBtn.hidden = true;
    taskModal.hidden = false;
    document.body.style.overflow = "hidden";
    taskTitleInput.focus();
  }
  function openEditTask(task){
    editingTaskId = task.id;
    taskModalTitle.textContent = "タスクを編集";
    taskTitleInput.value = task.text || "";
    taskDueInput.value = task.due || "";
    var dtE = document.getElementById("task-duetime-input"); if (dtE) dtE.value = task.dueTime || "";
    var tgE = document.getElementById("task-tags-input"); if (tgE) tgE.value = (task.tags || []).join(", ");
    renderTaskTagChips();
    taskRepeatInput.value = task.repeat || "none";
    setWeekdayPicker(task.repeatDays || []);
    taskMonthdayInput.value = task.repeatDayOfMonth || "";
    updateRepeatDetailVisibility();
    taskUrlInput.value = task.url || "";
    taskRemarksInput.value = task.remarks || "";
    taskFormTag = task.tag || "haruka";
    setActiveTab("task-tag-tabs", taskFormTag);
    taskFormError.hidden = true;
    taskDeleteBtn.hidden = false;
    taskModal.hidden = false;
    document.body.style.overflow = "hidden";
    taskTitleInput.focus();
  }
  function closeTaskModal(){
    taskModal.hidden = true;
    document.body.style.overflow = "";
  }

  document.getElementById("task-new").addEventListener("click", openNewTask);
  document.getElementById("task-modal-close").addEventListener("click", closeTaskModal);
  document.getElementById("task-cancel").addEventListener("click", closeTaskModal);
  taskModal.addEventListener("click", function(e){ if (e.target === taskModal) closeTaskModal(); });

  taskForm.addEventListener("submit", function(e){
    e.preventDefault();
    var text = taskTitleInput.value.trim();
    if (!text){
      taskFormError.hidden = false;
      taskFormError.textContent = "タイトルを入力してください。";
      return;
    }
    var url = taskUrlInput.value.trim();
    var repeat = taskRepeatInput.value || "none";
    var dtInput = document.getElementById("task-duetime-input");
    var dueTime = dtInput && /^\d{1,2}:\d{2}$/.test(dtInput.value) ? dtInput.value : null;
    var tagsInput = document.getElementById("task-tags-input");
    var fields = {
      text: text,
      due: taskDueInput.value || null,
      dueTime: (taskDueInput.value && dueTime) ? dueTime : null,
      tag: taskFormTag,
      tags: tagsInput ? parseFreeTags(tagsInput.value) : [],
      repeat: repeat,
      repeatDays: repeat === "weekly" ? taskFormRepeatDays.slice() : null,
      repeatDayOfMonth: repeat === "monthly" && taskMonthdayInput.value ? Number(taskMonthdayInput.value) : null,
      url: url || null,
      remarks: taskRemarksInput.value.trim() || null
    };
    if (editingTaskId){
      var existing = tasksState.find(function(t){ return t.id === editingTaskId; });
      if (existing) Object.assign(existing, fields);
    } else {
      tasksState.push(Object.assign({ id: uid(), done: false, createdAt: Date.now() }, fields));
    }
    closeTaskModal();
    renderTasks();
    scheduleTasksSave();
  });

  taskDeleteBtn.addEventListener("click", async function(){
    if (!editingTaskId) return;
    var target = tasksState.find(function(t){ return t.id === editingTaskId; });
    if (!(await askConfirm('「' + ((target && target.text) || "このタスク") + '」を削除しますか?'))) return;
    tasksState = tasksState.filter(function(t){ return t.id !== editingTaskId; });
    closeTaskModal();
    renderTasks();
    scheduleTasksSave();
  });

  /* ================= NOTES (self-persisted in the portal via the artifact capability) ================= */
  var NOTES_PATH = "data/notes.json";
  var notesState = [];
  var notesStatusBar = document.getElementById("notes-status-bar");
  var notesGrid = document.getElementById("notes-grid");
  var noteSaveTimer = null;
  var editingNoteId = null; // null = creating a new note
  var noteFilterTag = "all";
  var noteSearchQuery = "";
  var noteFormTag = "haruka";

  var noteModal = document.getElementById("note-modal");
  var noteModalTitle = document.getElementById("note-modal-title");
  var noteForm = document.getElementById("note-form");
  var noteTitleInput = document.getElementById("note-title-input");
  var noteBodyInput = document.getElementById("note-body-input");
  var noteFormError = document.getElementById("note-form-error");
  var noteDeleteBtn = document.getElementById("note-delete");
  var noteSearchInput = document.getElementById("note-search");
  var noteBoldBtn = document.getElementById("note-bold-btn");

  function setNotesStatus(text, cls){
    notesStatusBar.textContent = text;
    notesStatusBar.className = "panel cal-status-bar" + (cls ? " " + cls : "");
  }

  async function initNotes(){
    setNotesStatus("読み込み中…");
    try{
      var res = await apiFetch("/api/notes");
      notesState = res.notes || [];
      setNotesStatus("ポータルに保存済み");
    } catch(err){
      notesState = [];
      setNotesStatus(apiErrorMessage(err, "メモ"), "err");
    }
    renderNotes();
  }

  // The editor is a contenteditable div (so 太字 shows real bold while
  // typing, not literal ** markers). Storage stays plain text with a
  // lightweight **bold** marker so old/plain viewers still make sense of it.
  function noteMarkdownToEditableHtml(text){
    var esc = escapeHtml(text || "").replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    return esc.replace(/\n/g, "<br>");
  }
  function noteEditableToMarkdown(container){
    var out = "";
    function walk(node, bold){
      node.childNodes.forEach(function(child){
        if (child.nodeType === Node.TEXT_NODE){
          out += bold ? "**" + child.nodeValue + "**" : child.nodeValue;
        } else if (child.nodeType === Node.ELEMENT_NODE){
          var tag = child.tagName;
          if (tag === "BR"){
            out += "\n";
          } else if (tag === "DIV" || tag === "P"){
            if (out && !/\n$/.test(out)) out += "\n";
            walk(child, bold || tag === "B" || tag === "STRONG");
          } else {
            walk(child, bold || tag === "B" || tag === "STRONG");
          }
        }
      });
    }
    walk(container, false);
    return out;
  }
  // Plain-text preview for the card grid — bold markers are an editing aid,
  // not something the list view needs to render.
  function noteSnippetText(text){
    return (text || "").replace(/\*\*(.+?)\*\*/g, "$1");
  }

  // ビジネス画面の「最近のメモ」ミニリスト(SYSLEA タグ、最新5件)。
  // notesState を直接見るので、メモページ側の検索/フィルタとは独立に常に同期する。
  function renderBizNotes(){
    var list = document.getElementById("biz-note-list");
    if (!list) return;
    var items = notesState
      .filter(function(n){ return n.tag === "syslea"; })
      .slice()
      .sort(function(a, b){ return (b.updatedAt || 0) - (a.updatedAt || 0); })
      .slice(0, 5);
    if (!items.length){
      list.innerHTML = '<li class="sched-empty">SYSLEA のメモはまだありません。</li>';
      return;
    }
    list.innerHTML = "";
    items.forEach(function(note){
      var li = document.createElement("li");
      li.className = "pv-up-item";
      var dot = document.createElement("span"); dot.className = "pv-up-dot";
      var dt = document.createElement("span"); dt.className = "pv-up-date"; dt.textContent = note.updatedAt ? fmtSavedAt(note.updatedAt) : "";
      var ti = document.createElement("span"); ti.className = "pv-up-title"; ti.textContent = note.title || "(無題)";
      li.appendChild(dot); li.appendChild(dt); li.appendChild(ti);
      li.addEventListener("click", function(){ openEditNote(note); });
      list.appendChild(li);
    });
  }

  // ビジネス画面の「最近のタスク」ミニリスト(SYSLEA タグ・未完了、期限が近い順に最新5件)。
  // tasksState を直接見るので、タスクページ側のフィルタとは独立に常に同期する。
  function renderBizTasks(){
    var list = document.getElementById("biz-task-list");
    if (!list) return;
    var items = tasksState
      .filter(function(t){ return t.tag === "syslea" && !t.done; })
      .slice()
      .sort(function(a, b){ return (a.due || "9999-99-99").localeCompare(b.due || "9999-99-99"); })
      .slice(0, 5);
    if (!items.length){
      list.innerHTML = '<li class="sched-empty">SYSLEA の未完了タスクはありません。</li>';
      return;
    }
    list.innerHTML = "";
    items.forEach(function(task){
      var li = document.createElement("li");
      li.className = "pv-up-item";
      var dot = document.createElement("span"); dot.className = "pv-up-dot";
      var dt = document.createElement("span"); dt.className = "pv-up-date";
      dt.textContent = task.due ? mdLabel(task.due) : "期限なし";
      var ti = document.createElement("span"); ti.className = "pv-up-title"; ti.textContent = task.text || "(無題)";
      li.appendChild(dot); li.appendChild(dt); li.appendChild(ti);
      li.addEventListener("click", function(){ openEditTask(task); });
      list.appendChild(li);
    });
  }

  function renderNotes(){
    renderBizNotes();
    notesGrid.innerHTML = "";
    var q = noteSearchQuery.trim().toLowerCase();
    var items = notesState.filter(function(n){
      if (noteFilterTag !== "all" && n.tag !== noteFilterTag) return false;
      if (!q) return true;
      return (n.title || "").toLowerCase().indexOf(q) !== -1 || (n.body || "").toLowerCase().indexOf(q) !== -1;
    });
    if (items.length === 0){
      notesGrid.innerHTML = notesState.length === 0
        ? '<div class="notes-empty">メモはありません。「+ 新規メモ」から作成してください。</div>'
        : '<div class="notes-empty">条件に一致するメモが見つかりませんでした。</div>';
      return;
    }
    items
      .slice()
      .sort(function(a, b){ return (b.updatedAt || 0) - (a.updatedAt || 0); })
      .forEach(function(note){
        var card = document.createElement("div");
        card.className = "note-card";

        var head = document.createElement("div");
        head.className = "note-card-head";
        var title = document.createElement("div");
        title.className = "note-title";
        title.textContent = note.title || "(無題)";
        var tagBadge = document.createElement("span");
        tagBadge.className = "tag-badge tag-" + (note.tag || "haruka");
        tagBadge.textContent = TASK_TAG_LABEL[note.tag] || "はるか";
        head.appendChild(title); head.appendChild(tagBadge);

        var snippet = document.createElement("div");
        snippet.className = "note-snippet";
        snippet.textContent = noteSnippetText(note.body || "");

        var meta = document.createElement("div");
        meta.className = "note-meta";
        meta.textContent = note.updatedAt ? fmtSavedAt(note.updatedAt) + " 更新" : "";

        card.appendChild(head); card.appendChild(snippet); card.appendChild(meta);
        card.addEventListener("click", function(){ openEditNote(note); });
        notesGrid.appendChild(card);
      });
  }

  function scheduleNotesSave(){
    setNotesStatus("保存中…");
    if (noteSaveTimer) clearTimeout(noteSaveTimer);
    noteSaveTimer = setTimeout(saveNotesNow, 600);
  }

  async function saveNotesNow(){
    try{
      await apiFetch("/api/notes/bulk", {
        method: "PUT",
        body: JSON.stringify({ notes: notesState })
      });
      setNotesStatus("保存済み ・ " + fmtSavedAt(Date.now()));
    } catch(err){
      console.error("[saveNotesNow] failed:", err);
      setNotesStatus(artifactErrorMessage(err), "err");
    }
  }

  wireAcctTabs("note-filter-tabs", function(){ return noteFilterTag; }, function(v){
    noteFilterTag = v;
    renderNotes();
  });
  wireAcctTabs("note-tag-tabs", function(){ return noteFormTag; }, function(v){ noteFormTag = v; });

  noteSearchInput.addEventListener("input", function(){
    noteSearchQuery = noteSearchInput.value;
    renderNotes();
  });

  // Wraps the current selection in a real <b> element directly via the
  // Selection/Range APIs. (document.execCommand("bold") was tried first, but
  // its "toggle bold for future typing" semantics apply unpredictably to a
  // collapsed caret and, in testing, ended up bolding the wrong span of
  // text — a known execCommand quirk. Manipulating the Range ourselves is
  // deterministic: it bolds exactly what's selected, once, every time.)
  // Some environments report the empty editor's ambient typing style as
  // already-bold (a font-loading/fallback quirk, not anything this page
  // sets), which would silently bold whatever gets typed next with no
  // button ever pressed. Neutralize that the moment the editor gains focus.
  noteBodyInput.addEventListener("focus", function(){
    try{
      if (noteBodyInput.textContent === "" && document.queryCommandState("bold")){
        document.execCommand("bold");
      }
    } catch(e){}
  });

  noteBoldBtn.addEventListener("mousedown", function(e){ e.preventDefault(); });
  noteBoldBtn.addEventListener("click", function(){
    var sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !noteBodyInput.contains(sel.getRangeAt(0).commonAncestorContainer)){
      noteBodyInput.focus();
      return;
    }
    var range = sel.getRangeAt(0);
    var b = document.createElement("b");
    if (range.collapsed){
      b.textContent = "太字";
      range.insertNode(b);
    } else {
      b.appendChild(range.extractContents());
      range.insertNode(b);
    }
    var newRange = document.createRange();
    newRange.selectNodeContents(b);
    sel.removeAllRanges();
    sel.addRange(newRange);
  });

  function openNewNote(defaultTag){
    editingNoteId = null;
    noteModalTitle.textContent = "新規メモ";
    noteTitleInput.value = "";
    noteBodyInput.innerHTML = "";
    noteFormTag = defaultTag === "syslea" ? "syslea" : "haruka";
    setActiveTab("note-tag-tabs", noteFormTag);
    noteFormError.hidden = true;
    noteDeleteBtn.hidden = true;
    noteModal.hidden = false;
    document.body.style.overflow = "hidden";
    noteTitleInput.focus();
  }
  function openEditNote(note){
    editingNoteId = note.id;
    noteModalTitle.textContent = "メモを編集";
    noteTitleInput.value = note.title || "";
    noteBodyInput.innerHTML = noteMarkdownToEditableHtml(note.body || "");
    noteFormTag = note.tag || "haruka";
    setActiveTab("note-tag-tabs", noteFormTag);
    noteFormError.hidden = true;
    noteDeleteBtn.hidden = false;
    noteModal.hidden = false;
    document.body.style.overflow = "hidden";
    noteTitleInput.focus();
  }
  function closeNoteModal(){
    noteModal.hidden = true;
    document.body.style.overflow = "";
  }

  document.getElementById("note-new").addEventListener("click", openNewNote);
  document.getElementById("note-modal-close").addEventListener("click", closeNoteModal);
  document.getElementById("note-cancel").addEventListener("click", closeNoteModal);
  noteModal.addEventListener("click", function(e){ if (e.target === noteModal) closeNoteModal(); });

  noteForm.addEventListener("submit", function(e){
    e.preventDefault();
    var title = noteTitleInput.value.trim();
    if (!title){
      noteFormError.hidden = false;
      noteFormError.textContent = "タイトルを入力してください。";
      return;
    }
    var body = noteEditableToMarkdown(noteBodyInput);
    if (editingNoteId){
      var existing = notesState.find(function(n){ return n.id === editingNoteId; });
      if (existing){ existing.title = title; existing.body = body; existing.tag = noteFormTag; existing.updatedAt = Date.now(); }
    } else {
      notesState.push({ id: uid(), title: title, body: body, tag: noteFormTag, updatedAt: Date.now() });
    }
    closeNoteModal();
    renderNotes();
    scheduleNotesSave();
  });

  noteDeleteBtn.addEventListener("click", async function(){
    if (!editingNoteId) return;
    var target = notesState.find(function(n){ return n.id === editingNoteId; });
    if (!(await askConfirm('「' + ((target && target.title) || "このメモ") + '」を削除しますか?'))) return;
    notesState = notesState.filter(function(n){ return n.id !== editingNoteId; });
    closeNoteModal();
    renderNotes();
    scheduleNotesSave();
  });

  // Esc で「いちばん手前のモーダル」を1つだけ閉じる。上から順に評価し、最初に
  // 開いているものを閉じて打ち切る。以前は if/else の二段チェーンだったが、
  // モーダルを増やすたびに追記が必要で漏れやすかったため配列1本にした
  // (並び順＝優先順位。標準モーダルは生成済みの変数、管理モーダルは都度 getElementById)。
  document.addEventListener("keydown", function(e){
    if (e.key !== "Escape") return;
    var byId = function(id){ return document.getElementById(id); };
    var stack = [
      { el: eventModal,    close: closeEventModal },
      { el: mailModal,     close: closeMailModal },
      { el: noteModal,     close: closeNoteModal },
      { el: taskModal,     close: closeTaskModal },
      { el: ideaModal,     close: closeIdeaModal },
      { el: confirmModal,  close: function(){ closeConfirmModal(false); } },
      { el: settingsModal, close: closeSettings },
      { el: byId("plan-apply-modal"), close: function(){ closePlanApply("cancel"); } },
      { el: byId("finance-modal"),    close: closeFinanceModal },
      { el: byId("habit-modal"),      close: habitModalBack },
      { el: byId("plan-modal"),       close: planModalBack },
      { el: byId("pb-modal"),         close: pbModalBack },
      { el: byId("contract-modal"),   close: contractModalBack },
      { el: byId("subs-modal"),       close: closeSubsModal },
      { el: byId("habit-count-pop"),  close: function(){ closeHabitCountPop(false); } }
    ];
    for (var i = 0; i < stack.length; i++){
      if (stack[i].el && !stack[i].el.hidden){ stack[i].close(); return; }
    }
  });

  /* ================= 設定(歯車ボタン) =================
     users/{uid}/private/settings をバックエンド /api/settings 経由で読み書きする。
     - Google 連携: はるか/SYSLEA の再連携ボタン + 残り日数
     - 天気: 地点名(サーバー側で Open-Meteo ジオコーディングして緯度経度に変換)
     - 表示: ヒーローのイラスト ON/OFF・カレンダー初期ビュー・初期アカウント
     - アカウント表示: ヘッダーの表示名・アバター文字
     初回のみ表示系(初期ビュー/初期アカウント)を反映し、以降は保存時に
     アカウント表示・イラストだけ即時反映する(初期ビュー等は次回ロードで有効)。 */
  var SETTINGS_CACHE_KEY = "cyberPortalSettings";
  var CAL_VIEWS_ALLOWED = ["day", "week", "month"];
  var settingsState = null;
  var settingsFirstApply = true;

  function readCachedSettings(){
    try { return JSON.parse(localStorage.getItem(SETTINGS_CACHE_KEY) || "null"); } catch(e){ return null; }
  }
  function cacheSettings(s){
    try { localStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify(s)); } catch(e){}
  }

  function setHeroVisible(on){
    var scene = document.getElementById("hero-scene");
    try { localStorage.setItem("pref_heroIllustration", String(on)); } catch(e){}
    if (!scene) return;
    scene.style.display = on ? "" : "none";
    if (on){
      var img = document.getElementById("scene-illustration");
      var narrow = window.matchMedia && window.matchMedia("(max-width: 640px)").matches;
      if (img && !img.getAttribute("src") && HERO_ILLUSTRATIONS.length && !narrow){
        img.addEventListener("load", function(){ scene.classList.add("has-illustration"); });
        img.src = HERO_ILLUSTRATIONS[Math.floor(Math.random() * HERO_ILLUSTRATIONS.length)];
      }
    }
  }

  function setDefaultAccount(acct){
    acct = acct === "syslea" ? "syslea" : "haruka";
    schedAccount = acct;
    calState.account = acct;
    mailState.account = acct;
    ["sched-acct-tabs", "cal-acct-tabs", "mail-acct-tabs"].forEach(function(id){
      document.querySelectorAll("#" + id + " .acct-tab").forEach(function(b){
        b.classList.toggle("active", b.getAttribute("data-account") === acct);
      });
    });
  }

  function applySettings(s){
    if (!s) return;
    settingsState = s;
    var acc = s.account || {};
    var disp = s.display || {};
    document.querySelectorAll(".profile-meta .uname").forEach(function(el){
      el.textContent = acc.displayName || "HARUKA";
    });
    document.querySelectorAll(".avatar").forEach(function(el){
      el.textContent = acc.avatarText || "遥";
    });
    setHeroVisible(disp.heroIllustration !== false);
    if (settingsFirstApply){
      settingsFirstApply = false;
      setDefaultAccount(disp.defaultAccount);
      if (CAL_VIEWS_ALLOWED.indexOf(disp.calendarView) !== -1) calState.view = disp.calendarView;
    }
  }

  async function loadSettings(){
    try {
      var res = await apiFetch("/api/settings");
      if (res && res.settings){
        applySettings(res.settings);
        cacheSettings(res.settings);
        loadWeather(); // 地点が変わっている可能性があるので取り直す
      }
    } catch(e){ /* キャッシュ値のまま継続 */ }
  }

  // 起動直後(認証前)にキャッシュを即適用しておく。認証後 loadSettings が最新値で上書き。
  applySettings(readCachedSettings());

  /* ---- 設定モーダル ---- */
  var settingsBtn = document.getElementById("settings-btn");
  var settingsModal = document.getElementById("settings-modal");
  var settingsForm = document.getElementById("settings-form");
  var settingsErr = document.getElementById("settings-form-error");
  var elSetPlace = document.getElementById("settings-weather-place");
  var elSetPlaceCurrent = document.getElementById("settings-weather-current");
  var elSetHero = document.getElementById("settings-hero");
  var elSetCalView = document.getElementById("settings-cal-view");
  var elSetDefAcct = document.getElementById("settings-default-account");
  var elSetName = document.getElementById("settings-display-name");
  var elSetAvatar = document.getElementById("settings-avatar-text");
  var elSetFinanceUrl = document.getElementById("settings-finance-url");
  var elSetFinanceCurrent = document.getElementById("settings-finance-current");

  function fillSettingsForm(){
    var s = settingsState || {};
    var w = s.weather || {}, d = s.display || {}, a = s.account || {}, f = s.finance || {};
    if (elSetPlace) elSetPlace.value = "";
    if (elSetPlaceCurrent) elSetPlaceCurrent.textContent = "現在: " + (w.place || "柏市");
    if (elSetHero) elSetHero.checked = d.heroIllustration !== false;
    if (elSetCalView) elSetCalView.value = CAL_VIEWS_ALLOWED.indexOf(d.calendarView) !== -1 ? d.calendarView : "day";
    if (elSetDefAcct) elSetDefAcct.value = d.defaultAccount === "syslea" ? "syslea" : "haruka";
    if (elSetName) elSetName.value = a.displayName || "";
    if (elSetAvatar) elSetAvatar.value = a.avatarText || "";
    if (elSetFinanceUrl) elSetFinanceUrl.value = f.sheetUrl || "";
    if (elSetFinanceCurrent) elSetFinanceCurrent.textContent = "現在: " + (f.sheetId ? "設定済み" : "未設定");
  }

  async function fillSettingsConnState(){
    var map = { haruka: "settings-conn-state-haruka", syslea: "settings-conn-state-syslea" };
    Object.keys(map).forEach(function(k){
      var el = document.getElementById(map[k]);
      if (el) el.textContent = "確認中…";
    });
    try {
      var data = await apiFetch("/api/google/status");
      var accts = (data && data.accounts) || {};
      Object.keys(map).forEach(function(k){
        var el = document.getElementById(map[k]);
        if (!el) return;
        var st = accts[k] || {};
        if (!st.connected){ el.textContent = "未連携 / 期限切れ"; el.className = "settings-conn-state is-stale"; return; }
        var days = st.expiresAt ? Math.max(0, Math.ceil((st.expiresAt - Date.now()) / 86400000)) : null;
        el.textContent = days != null ? ("連携中 ・ あと約" + days + "日") : "連携中";
        el.className = "settings-conn-state" + (days != null && days <= 2 ? " is-stale" : "");
      });
    } catch(e){
      Object.keys(map).forEach(function(k){
        var el = document.getElementById(map[k]);
        if (el) el.textContent = "状態を取得できませんでした";
      });
    }
  }

  function openSettings(){
    if (!settingsModal) return;
    if (settingsErr){ settingsErr.hidden = true; settingsErr.textContent = ""; }
    fillSettingsForm();
    settingsModal.hidden = false;
    if (!settingsState){ loadSettings().then(fillSettingsForm); }
    fillSettingsConnState();
    refreshBackupState();
    csvImportReset();
  }
  function closeSettings(){ if (settingsModal) settingsModal.hidden = true; }

  // データのバックアップ(レベル1): /api/export を叩いて全データを1つの JSON にまとめ、
  // その場で Blob URL を作ってダウンロードさせる。サーバーには何も保存しない。
  async function exportAllData(){
    var btn = document.getElementById("settings-export-btn");
    var statusEl = document.getElementById("settings-export-status");
    if (statusEl){ statusEl.hidden = true; statusEl.classList.remove("is-err"); }
    if (btn){ btn.disabled = true; btn.textContent = "書き出し中…"; }
    try {
      var data = await apiFetch("/api/export");
      var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = "cyber-portal-export-" + jstDateKey(new Date()) + ".json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function(){ URL.revokeObjectURL(url); }, 4000);
    } catch (err){
      if (statusEl){
        statusEl.textContent = apiErrorMessage(err, "エクスポート");
        statusEl.hidden = false;
        statusEl.classList.add("is-err");
      }
    } finally {
      if (btn){ btn.disabled = false; btn.textContent = "全データをJSONでダウンロード"; }
    }
  }

  if (settingsBtn) settingsBtn.addEventListener("click", openSettings);
  var settingsClose = document.getElementById("settings-modal-close");
  var settingsCancel = document.getElementById("settings-cancel");
  if (settingsClose) settingsClose.addEventListener("click", closeSettings);
  if (settingsCancel) settingsCancel.addEventListener("click", closeSettings);
  if (settingsModal){
    settingsModal.addEventListener("click", function(e){ if (e.target === settingsModal) closeSettings(); });
  }
  document.querySelectorAll("#settings-modal .settings-conn-row button[data-account]").forEach(function(btn){
    btn.addEventListener("click", function(){ startGoogleConnect(btn.getAttribute("data-account")); });
  });
  var settingsExportBtn = document.getElementById("settings-export-btn");
  if (settingsExportBtn) settingsExportBtn.addEventListener("click", exportAllData);

  // ---- データ: Drive バックアップ / CSV 書き出し・読み込み ----
  var csvImportText = "";   // 選択された CSV ファイルの中身(テキスト)
  var csvDryRun = null;     // 直近のプレビュー結果

  function backupStateText(s){
    if (!s || !s.lastAt) return "Drive バックアップ: まだ実行されていません";
    var when = new Intl.DateTimeFormat("ja-JP", { timeZone: JP_TZ, month:"numeric", day:"numeric", hour:"2-digit", minute:"2-digit" }).format(new Date(s.lastAt));
    var kb = s.lastBytes ? " ・ " + Math.max(1, Math.round(s.lastBytes / 1024)) + "KB" : "";
    return "Drive バックアップ: 最終 " + when + " ・ " + (s.fileCount || 1) + "世代" + kb;
  }
  async function refreshBackupState(){
    var el = document.getElementById("settings-backup-state");
    if (!el) return;
    el.textContent = "Drive バックアップ: 確認中…";
    try { el.textContent = backupStateText(await apiFetch("/api/backup/status")); }
    catch(e){ el.textContent = "Drive バックアップ: 状態を取得できませんでした"; }
  }
  var backupNowBtn = document.getElementById("settings-backup-now-btn");
  if (backupNowBtn) backupNowBtn.addEventListener("click", async function(){
    var el = document.getElementById("settings-backup-state");
    backupNowBtn.disabled = true; backupNowBtn.textContent = "保存中…";
    if (el) el.textContent = "Drive バックアップ: 実行中…";
    try {
      var s = await apiFetch("/api/backup/run", { method:"POST", body:"{}" });
      if (el) el.textContent = backupStateText(s) + (s.lastFile ? "（" + s.lastFile + "）" : "");
    } catch(e){
      if (el) el.textContent = "Drive バックアップ: 失敗 — " + apiErrorMessage(e, "バックアップ");
    } finally {
      backupNowBtn.disabled = false; backupNowBtn.textContent = "Driveに今すぐ保存";
    }
  });

  var csvExportBtn = document.getElementById("settings-csv-export-btn");
  if (csvExportBtn) csvExportBtn.addEventListener("click", async function(){
    var sel = document.getElementById("settings-csv-target");
    var target = sel ? sel.value : "tasks";
    csvExportBtn.disabled = true; csvExportBtn.textContent = "書き出し中…";
    try {
      var blob = await apiFetchBlob("/api/export/csv?collection=" + encodeURIComponent(target));
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = target + "-" + jstDateKey(new Date()) + ".csv";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function(){ URL.revokeObjectURL(url); }, 4000);
    } catch(e){ alert(apiErrorMessage(e, "CSV書き出し")); }
    finally { csvExportBtn.disabled = false; csvExportBtn.textContent = "CSVで書き出し"; }
  });

  function csvImportReset(){
    var box = document.getElementById("settings-csv-import-box");
    if (box) box.hidden = true;
    csvImportText = ""; csvDryRun = null;
    var f = document.getElementById("settings-csv-file"); if (f) f.value = "";
    var w = document.getElementById("settings-csv-replace-word"); if (w) w.value = "";
    var m = document.querySelector('#settings-modal input[name="csv-mode"][value="merge"]'); if (m) m.checked = true;
    var rc = document.getElementById("settings-csv-replace-confirm"); if (rc) rc.hidden = true;
    var rs = document.getElementById("settings-csv-result"); if (rs){ rs.hidden = true; rs.textContent = ""; }
    var ap = document.getElementById("settings-csv-apply-btn"); if (ap) ap.disabled = true;
  }

  // File → テキスト。UTF-8 で読めなければ Shift_JIS(Excel 既定)で読み直す。
  async function csvReadFile(file){
    var buf = await file.arrayBuffer();
    try { return new TextDecoder("utf-8", { fatal:true }).decode(buf); }
    catch(e){
      try { return new TextDecoder("shift_jis").decode(buf); }
      catch(e2){ return new TextDecoder("utf-8").decode(buf); }
    }
  }
  function csvSelectedMode(){
    var r = document.querySelector('#settings-modal input[name="csv-mode"]:checked');
    return r && r.value === "replace" ? "replace" : "merge";
  }
  function csvUpdateApplyEnabled(){
    var btn = document.getElementById("settings-csv-apply-btn");
    if (!btn) return;
    var ok = !!csvDryRun;
    if (csvSelectedMode() === "replace"){
      var w = document.getElementById("settings-csv-replace-word");
      ok = ok && !!w && w.value.trim() === "置換";
    }
    btn.disabled = !ok;
  }
  async function csvRunPreview(){
    var sel = document.getElementById("settings-csv-target");
    var target = sel ? sel.value : "tasks";
    var pv = document.getElementById("settings-csv-preview");
    var mode = csvSelectedMode();
    csvDryRun = null; csvUpdateApplyEnabled();
    if (pv) pv.textContent = "確認中…";
    try {
      var res = await apiFetch("/api/import/" + encodeURIComponent(target), {
        method: "POST",
        body: JSON.stringify({ csv: csvImportText, mode: mode, dryRun: true })
      });
      csvDryRun = res;
      var c = res.counts || {};
      var msg = "新規 " + (c.create || 0) + " ・ 更新 " + (c.update || 0)
        + (mode === "replace" ? " ・ 削除 " + (c.delete || 0) : "")
        + " ・ エラー " + (c.error || 0);
      if (res.errors && res.errors.length){
        msg += "\n" + res.errors.slice(0, 8).map(function(x){ return x.row + "行目: " + x.message; }).join("\n");
      }
      if (pv) pv.textContent = msg;
    } catch(e){
      csvDryRun = null;
      if (pv) pv.textContent = "エラー: " + apiErrorMessage(e, "CSV読み込み");
    }
    csvUpdateApplyEnabled();
  }

  var csvFileInput = document.getElementById("settings-csv-file");
  if (csvFileInput) csvFileInput.addEventListener("change", async function(){
    var file = csvFileInput.files && csvFileInput.files[0];
    if (!file) return;
    var box = document.getElementById("settings-csv-import-box");
    var nameEl = document.getElementById("settings-csv-file-name");
    var rs = document.getElementById("settings-csv-result");
    if (rs){ rs.hidden = true; rs.textContent = ""; }
    if (nameEl) nameEl.textContent = "ファイル: " + file.name;
    if (box) box.hidden = false;
    try { csvImportText = await csvReadFile(file); }
    catch(e){
      csvImportText = "";
      var pv = document.getElementById("settings-csv-preview");
      if (pv) pv.textContent = "ファイルを読み込めませんでした。";
      return;
    }
    csvRunPreview();
  });
  document.querySelectorAll('#settings-modal input[name="csv-mode"]').forEach(function(r){
    r.addEventListener("change", function(){
      var rc = document.getElementById("settings-csv-replace-confirm");
      if (rc) rc.hidden = csvSelectedMode() !== "replace";
      if (csvImportText) csvRunPreview(); else csvUpdateApplyEnabled();
    });
  });
  var csvReplaceWord = document.getElementById("settings-csv-replace-word");
  if (csvReplaceWord) csvReplaceWord.addEventListener("input", csvUpdateApplyEnabled);
  var csvCancelBtn = document.getElementById("settings-csv-cancel-btn");
  if (csvCancelBtn) csvCancelBtn.addEventListener("click", csvImportReset);

  var csvApplyBtn = document.getElementById("settings-csv-apply-btn");
  if (csvApplyBtn) csvApplyBtn.addEventListener("click", async function(){
    var sel = document.getElementById("settings-csv-target");
    var target = sel ? sel.value : "tasks";
    var mode = csvSelectedMode();
    var rs = document.getElementById("settings-csv-result");
    csvApplyBtn.disabled = true; csvApplyBtn.textContent = "取り込み中…";
    try {
      var res = await apiFetch("/api/import/" + encodeURIComponent(target), {
        method: "POST",
        body: JSON.stringify({ csv: csvImportText, mode: mode, dryRun: false })
      });
      var c = res.counts || {};
      if (rs){
        rs.hidden = false;
        rs.textContent = "取り込み完了: 新規 " + (c.create || 0) + " ・ 更新 " + (c.update || 0)
          + (mode === "replace" ? " ・ 削除 " + (c.delete || 0) : "") + " ・ スキップ " + (c.error || 0);
      }
      if (target === "tasks" && tasksInitialized) initTasks();
      if (target === "notes" && notesInitialized) initNotes();
      if (target === "contracts" && businessInitialized) loadContracts();
      if (target === "event_trackers" && businessInitialized) loadEventTrackers();
      var f = document.getElementById("settings-csv-file"); if (f) f.value = "";
      csvImportText = ""; csvDryRun = null;
    } catch(e){
      if (rs){ rs.hidden = false; rs.textContent = "失敗: " + apiErrorMessage(e, "CSV取り込み"); }
    } finally {
      csvApplyBtn.textContent = "取り込む";
      csvUpdateApplyEnabled();
    }
  });

  if (settingsForm){
    settingsForm.addEventListener("submit", async function(e){
      e.preventDefault();
      var saveBtn = document.getElementById("settings-save");
      if (settingsErr){ settingsErr.hidden = true; settingsErr.textContent = ""; }
      var patch = {
        display: {
          heroIllustration: !!(elSetHero && elSetHero.checked),
          calendarView: elSetCalView ? elSetCalView.value : "day",
          defaultAccount: elSetDefAcct ? elSetDefAcct.value : "haruka"
        },
        account: {
          displayName: elSetName ? elSetName.value.trim() : "",
          avatarText: elSetAvatar ? elSetAvatar.value.trim() : ""
        }
      };
      var placeInput = elSetPlace ? elSetPlace.value.trim() : "";
      if (placeInput) patch.weather = { place: placeInput };

      // 家計簿シート URL: 現在値から変わったときだけ送る(空にすると連携解除)。
      var financeChanged = false;
      if (elSetFinanceUrl){
        var curUrl = (settingsState && settingsState.finance && settingsState.finance.sheetUrl) || "";
        var newUrl = elSetFinanceUrl.value.trim();
        if (newUrl !== curUrl){ patch.finance = { sheetUrl: newUrl }; financeChanged = true; }
      }

      if (saveBtn){ saveBtn.disabled = true; saveBtn.textContent = "保存中…"; }
      try {
        var res = await apiFetch("/api/settings", { method: "PUT", body: JSON.stringify(patch) });
        if (res && res.settings){
          applySettings(res.settings);
          cacheSettings(res.settings);
          loadWeather();
        }
        if (financeChanged && typeof loadFinance === "function") loadFinance();
        closeSettings();
      } catch(err){
        if (settingsErr){
          settingsErr.textContent = apiErrorMessage(err, "設定");
          settingsErr.hidden = false;
        }
      } finally {
        if (saveBtn){ saveBtn.disabled = false; saveBtn.textContent = "保存"; }
      }
    });
  }

  /* ================= アイデア帳(Obsidian vault ビューア) =================
     マイドライブの「Obsidian」フォルダを Google Drive API(読み取り専用)で辿り、
     .md ファイルを簡易 Markdown レンダラで表示する。
     機密ノート(frontmatter 機密:true)はバックエンドが本文を返さないので
     「機密ノートのため表示しません」とだけ出す。 */
  var ideasBody = document.getElementById("ideas-body");
  var ideasCrumbs = document.getElementById("ideas-crumbs");
  var ideasStatusBar = document.getElementById("ideas-status-bar");
  var ideasStack = [{ id: null, name: "Obsidian" }]; // [{id,name}]; id=null は vault ルート
  var ideasLoadToken = 0;

  function setIdeasStatus(html, cls){
    ideasStatusBar.innerHTML = html;
    ideasStatusBar.className = "panel cal-status-bar" + (cls ? " " + cls : "");
  }

  function renderIdeasCrumbs(){
    ideasCrumbs.innerHTML = "";
    ideasStack.forEach(function(node, idx){
      if (idx > 0){
        var sep = document.createElement("span");
        sep.className = "ideas-crumb-sep";
        sep.textContent = "/";
        ideasCrumbs.appendChild(sep);
      }
      var b = document.createElement("button");
      b.type = "button";
      b.className = "ideas-crumb";
      b.textContent = node.name;
      b.disabled = idx === ideasStack.length - 1;
      b.addEventListener("click", function(){
        ideasStack = ideasStack.slice(0, idx + 1);
        ideasOpenFolder(node.id, node.name, true);
      });
      ideasCrumbs.appendChild(b);
    });
  }

  function ideasErrorInto(container, err){
    if (err && err.code === "google_not_connected"){
      container.innerHTML = "";
      container.appendChild(buildConnectPrompt("haruka", "はるか"));
      return;
    }
    var msg = (err && err.code === "vault_not_found")
      ? "マイドライブに『Obsidian』フォルダが見つかりませんでした。"
      : apiErrorMessage(err, "Google Drive");
    container.innerHTML = '<div class="sched-error" style="padding:20px 4px;">' + escapeHtml(msg) + "</div>";
  }

  async function ideasOpenFolder(folderId, folderName, fromCrumbOrRoot){
    var pushed = false;
    if (!fromCrumbOrRoot){
      ideasStack.push({ id: folderId, name: folderName });
      pushed = true;
    }
    renderIdeasCrumbs();
    var token = ++ideasLoadToken;
    ideasBody.innerHTML = mailSkeletonHtml(5);
    setIdeasStatus("読み込み中…", "");
    try {
      var qs = folderId ? "?folder=" + encodeURIComponent(folderId) : "";
      var res = await apiFetch("/api/drive/notes" + qs);
      if (token !== ideasLoadToken) return;
      renderIdeasList(res.items || []);
      setIdeasStatus('<span class="live">●</span> Obsidian vault (Google Drive・読み取り専用)', "");
    } catch(err){
      // 遷移に失敗したら push した分を戻す(パンくずが実体とズレないように)
      if (pushed && ideasStack.length && ideasStack[ideasStack.length - 1].id === folderId){
        ideasStack.pop();
        renderIdeasCrumbs();
      }
      if (token !== ideasLoadToken) return;
      setIdeasStatus(escapeHtml(apiErrorMessage(err, "Google Drive")), "err");
      ideasErrorInto(ideasBody, err);
    }
  }

  function renderIdeasList(items){
    if (!items.length){
      ideasBody.innerHTML = '<div class="sched-empty">このフォルダに .md ファイル・サブフォルダはありません</div>';
      return;
    }
    var ul = document.createElement("ul");
    ul.className = "ideas-list";
    items.forEach(function(it){
      var li = document.createElement("li");
      li.className = "ideas-item ideas-" + it.type;
      li.setAttribute("tabindex", "0");
      var icon = document.createElement("span");
      icon.className = "ideas-icon";
      icon.textContent = it.type === "folder" ? "📁" : "📄";
      var name = document.createElement("span");
      name.className = "ideas-name";
      name.textContent = it.type === "file" ? it.name.replace(/\.md$/i, "") : it.name;
      li.appendChild(icon); li.appendChild(name);
      var open = function(){
        if (it.type === "folder") ideasOpenFolder(it.id, it.name);
        else ideasOpenNote(it.id, it.name);
      };
      li.addEventListener("click", open);
      li.addEventListener("keydown", function(e){
        if (e.key === "Enter" || e.key === " "){ e.preventDefault(); open(); }
      });
      ul.appendChild(li);
    });
    ideasBody.innerHTML = "";
    ideasBody.appendChild(ul);
  }

  async function ideasOpenNote(id, filename){
    var token = ++ideasLoadToken;
    ideasBody.innerHTML = '<div class="sched-empty">読み込み中…</div>';
    setIdeasStatus(escapeHtml(filename.replace(/\.md$/i, "")), "");
    try {
      var res = await apiFetch("/api/drive/notes/" + encodeURIComponent(id));
      if (token !== ideasLoadToken) return;
      var wrap = document.createElement("div");
      wrap.className = "ideas-note";
      var back = document.createElement("button");
      back.type = "button";
      back.className = "ideas-note-back";
      back.textContent = "← 一覧に戻る";
      back.addEventListener("click", function(){
        var cur = ideasStack[ideasStack.length - 1];
        ideasOpenFolder(cur.id, cur.name, true);
      });
      wrap.appendChild(back);
      var h = document.createElement("h1");
      h.className = "ideas-note-title";
      h.textContent = (res.name || filename).replace(/\.md$/i, "");
      wrap.appendChild(h);
      var art = document.createElement("div");
      art.className = "md-body";
      if (res.confidential){
        art.innerHTML = '<div class="md-frontmatter">🔒 機密ノートのため表示しません。</div>';
      } else {
        art.innerHTML = renderMarkdown(res.content || "");
      }
      wrap.appendChild(art);
      ideasBody.innerHTML = "";
      ideasBody.appendChild(wrap);
      setIdeasStatus('<span class="live">●</span> ' + escapeHtml((res.name || filename).replace(/\.md$/i, "")), "");
    } catch(err){
      if (token !== ideasLoadToken) return;
      setIdeasStatus(escapeHtml(apiErrorMessage(err, "Google Drive")), "err");
      ideasErrorInto(ideasBody, err);
    }
  }

  document.getElementById("ideas-refresh").addEventListener("click", function(){
    var cur = ideasStack[ideasStack.length - 1] || { id: null, name: "Obsidian" };
    ideasOpenFolder(cur.id, cur.name, true);
  });

  /* ---- アイデア帳: 新規ノート作成(POST /api/drive/notes。drive 書き込みスコープ) ---- */
  var ideaModal = document.getElementById("idea-modal");
  var ideaNameInput = document.getElementById("idea-name-input");
  var ideaBodyInput = document.getElementById("idea-body-input");
  var ideaFormError = document.getElementById("idea-form-error");

  function openIdeaModal(){
    if (!ideaModal) return;
    var loc = document.getElementById("idea-modal-loc");
    if (loc) loc.textContent = "保存先: " + ideasStack.map(function(n){ return n.name; }).join(" / ");
    ideaNameInput.value = "";
    ideaBodyInput.value = "";
    if (ideaFormError){ ideaFormError.hidden = true; ideaFormError.textContent = ""; }
    ideaModal.hidden = false;
    document.body.style.overflow = "hidden";
    setTimeout(function(){ ideaNameInput.focus(); }, 0);
  }
  function closeIdeaModal(){
    if (ideaModal) ideaModal.hidden = true;
    document.body.style.overflow = "";
  }
  async function saveIdea(){
    var cur = ideasStack[ideasStack.length - 1] || { id: null, name: "Obsidian" };
    var name = (ideaNameInput.value || "").trim();
    if (!name){
      if (ideaFormError){ ideaFormError.hidden = false; ideaFormError.textContent = "ファイル名を入力してください。"; }
      return;
    }
    var saveBtn = document.getElementById("idea-save");
    if (saveBtn) saveBtn.disabled = true;
    try {
      var res = await apiFetch("/api/drive/notes", {
        method: "POST",
        body: JSON.stringify({ folder: cur.id || "", name: name, content: ideaBodyInput.value || "" })
      });
      closeIdeaModal();
      // 作成先フォルダを開き直して反映
      ideasOpenFolder(cur.id, cur.name, true);
    } catch(err){
      if (ideaFormError){
        ideaFormError.hidden = false;
        ideaFormError.textContent = (err && err.code === "google_scope_missing")
          ? "Drive の書き込み権限がありません。設定から「はるか」を再連携してください。"
          : (apiErrorMessage(err, "Google Drive") || "ノートの作成に失敗しました");
      }
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }
  var ideaNewBtn = document.getElementById("ideas-new");
  if (ideaNewBtn) ideaNewBtn.addEventListener("click", openIdeaModal);
  var ideaCloseBtn = document.getElementById("idea-modal-close");
  if (ideaCloseBtn) ideaCloseBtn.addEventListener("click", closeIdeaModal);
  var ideaCancelBtn = document.getElementById("idea-cancel");
  if (ideaCancelBtn) ideaCancelBtn.addEventListener("click", closeIdeaModal);
  if (ideaModal) ideaModal.addEventListener("click", function(e){ if (e.target === ideaModal) closeIdeaModal(); });
  var ideaForm = document.getElementById("idea-form");
  if (ideaForm) ideaForm.addEventListener("submit", function(e){ e.preventDefault(); saveIdea(); });

  /* 簡易 Markdown レンダラ。Obsidian ノート閲覧に必要な範囲だけ対応:
     見出し / 箇条書き・番号リスト / 引用 / 水平線 / フェンスコード /
     太字・斜体・打消し・インラインコード / 通常リンク / ウィキリンク(表示のみ) /
     チェックボックス / frontmatter(そのまま淡色表示)。テーブルは非対応。 */
  function renderMarkdown(src){
    src = String(src == null ? "" : src).replace(/\r\n?/g, "\n");
    var lines = src.split("\n");
    var out = [];
    var i = 0;
    var inList = null; // 'ul' | 'ol' | null

    function closeList(){ if (inList){ out.push("</" + inList + ">"); inList = null; } }

    function inlineMd(s){
      s = escapeHtml(s);
      var codes = [];
      s = s.replace(/`([^`]+)`/g, function(_, c){ codes.push(c); return "" + (codes.length - 1) + ""; });
      s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, function(_, alt){ return "🖼 " + (alt || "画像"); });
      s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
      s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, function(_, page, alias){
        return '<span class="wl">' + (alias || page) + "</span>";
      });
      s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
      s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
      s = s.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
      s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
      s = s.replace(/(\d+)/g, function(_, n){ return "<code>" + codes[+n] + "</code>"; });
      return s;
    }

    // frontmatter
    if (lines[0] === "---"){
      var j = 1;
      var fm = [];
      while (j < lines.length && lines[j] !== "---"){ fm.push(lines[j]); j++; }
      if (j < lines.length){
        out.push('<div class="md-frontmatter">' + escapeHtml(fm.join("\n")) + "</div>");
        i = j + 1;
      }
    }

    for (; i < lines.length; i++){
      var line = lines[i];

      var fence = line.match(/^```/);
      if (fence){
        closeList();
        var code = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])){ code.push(lines[i]); i++; }
        out.push('<pre class="md-pre"><code>' + escapeHtml(code.join("\n")) + "</code></pre>");
        continue;
      }

      if (/^\s*$/.test(line)){ closeList(); continue; }

      if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)){ closeList(); out.push("<hr>"); continue; }

      var h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h){ closeList(); out.push("<h" + h[1].length + ">" + inlineMd(h[2]) + "</h" + h[1].length + ">"); continue; }

      if (/^\s*>\s?/.test(line)){
        closeList();
        var bq = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])){ bq.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
        i--;
        out.push("<blockquote>" + renderMarkdown(bq.join("\n")) + "</blockquote>");
        continue;
      }

      var li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
      if (li){
        var ordered = /\d/.test(li[2]);
        var type = ordered ? "ol" : "ul";
        if (inList && inList !== type) closeList();
        if (!inList){ out.push("<" + type + ">"); inList = type; }
        var body = li[3];
        var task = body.match(/^\[([ xX])\]\s+(.*)$/);
        if (task){
          out.push('<li class="md-task"><input type="checkbox" disabled' +
            (/[xX]/.test(task[1]) ? " checked" : "") + "> " + inlineMd(task[2]) + "</li>");
        } else {
          out.push("<li>" + inlineMd(body) + "</li>");
        }
        continue;
      }

      closeList();
      var para = [line];
      while (i + 1 < lines.length && !/^\s*$/.test(lines[i + 1]) &&
        !/^```/.test(lines[i + 1]) &&
        !/^(#{1,6})\s/.test(lines[i + 1]) &&
        !/^\s*>\s?/.test(lines[i + 1]) &&
        !/^(\s*)([-*+]|\d+[.)])\s+/.test(lines[i + 1]) &&
        !/^\s*([-*_])\s*(\1\s*){2,}$/.test(lines[i + 1])){
        i++;
        para.push(lines[i]);
      }
      out.push("<p>" + para.map(inlineMd).join("<br>") + "</p>");
    }
    closeList();
    return out.join("\n");
  }

  /* ================= 通知センター(ベル)+ PWA =================
     ベルを押すと、未読メール・本日の残り予定・再連携リマインダーをまとめたパネルを出す。
     「デスクトップ通知」を有効にすると、ポータルを開いている間に未読が増えたとき
     ブラウザ通知を出す(バックエンドのプッシュ基盤は無し)。
     PWA: サービスワーカー登録 + インストールボタン(beforeinstallprompt)。 */
  var notifBtn = document.getElementById("notif-btn");
  var notifPanel = document.getElementById("notif-panel");
  // ヘッダーの .panel は backdrop-filter でスタッキングコンテキストを作り、
  // その中の position:fixed はビューポート基準にならず後続パネルに隠れる。
  // パネルを body 直下へ移して回避する(位置は JS がベルの座標から算出)。
  if (notifPanel && notifPanel.parentElement !== document.body){
    document.body.appendChild(notifPanel);
  }
  var notifList = document.getElementById("notif-list");
  var notifDot = document.getElementById("notif-dot");
  var notifPermBtn = document.getElementById("notif-perm-btn");
  var notifInstallBtn = document.getElementById("notif-install-btn");
  var NOTIF_ENABLED_KEY = "notifEnabled";
  var NOTIF_LAST_UNREAD_KEY = "notifLastUnread";
  var deferredInstallPrompt = null;

  function notifSupported(){ return typeof window.Notification === "function"; }
  function notifEnabled(){
    try { return localStorage.getItem(NOTIF_ENABLED_KEY) === "1"; } catch(e){ return false; }
  }

  function totalUnread(){
    var h = typeof harukaUnreadCount === "number" ? harukaUnreadCount : 0;
    var s = typeof sysleaUnreadCount === "number" ? sysleaUnreadCount : 0;
    return h + s;
  }

  // 本日これから始まる予定(終日は当日ぶんを対象)。schedEventsToday を使う。
  function upcomingTodayEvents(){
    var now = Date.now();
    return (schedEventsToday || []).filter(function(ev){
      if (ev.start && ev.start.date) return true;            // 終日
      var dt = ev.start && ev.start.dateTime;
      return dt && new Date(dt).getTime() >= now - 60000;    // 直近(1分前まで許容)
    }).sort(function(a,b){
      var ta = (a.start && (a.start.dateTime || a.start.date)) || "";
      var tb = (b.start && (b.start.dateTime || b.start.date)) || "";
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
  }

  function buildNotifItem(icon, title, sub, cls, onClick){
    var li = document.createElement("li");
    li.className = "notif-item" + (cls ? " " + cls : "") + (onClick ? "" : " notif-static");
    var i = document.createElement("span"); i.className = "notif-ico"; i.textContent = icon;
    var body = document.createElement("div"); body.className = "notif-body";
    var t = document.createElement("div"); t.className = "notif-title"; t.textContent = title;
    body.appendChild(t);
    if (sub){ var s = document.createElement("div"); s.className = "notif-sub"; s.textContent = sub; body.appendChild(s); }
    li.appendChild(i); li.appendChild(body);
    if (onClick){
      li.addEventListener("click", function(){ closeNotifPanel(); onClick(); });
    }
    return li;
  }

  function refreshNotifCenter(){
    if (!notifList) return;
    var items = [];
    var unread = totalUnread();
    var reauthActive = !!reauthBannerAccount;

    if (unread > 0){
      var parts = [];
      if (typeof harukaUnreadCount === "number" && harukaUnreadCount > 0) parts.push("はるか " + harukaUnreadCount);
      if (typeof sysleaUnreadCount === "number" && sysleaUnreadCount > 0) parts.push("SYSLEA " + sysleaUnreadCount);
      items.push(buildNotifItem("✉", "未読メール " + unread + " 件", parts.join(" ・ "), null, function(){ showView("mail"); }));
    }

    var ev = upcomingTodayEvents();
    ev.slice(0, 3).forEach(function(e){
      var when = e.start && e.start.date ? "終日" : fmtEventTime(e.start);
      items.push(buildNotifItem("🗓", e.summary || "(タイトルなし)", "本日 " + when, null, function(){ showView("calendar"); }));
    });

    if (reauthActive){
      var label = (typeof ACCOUNT_LABELS === "object" && ACCOUNT_LABELS[reauthBannerAccount]) || reauthBannerAccount;
      items.push(buildNotifItem("⚠", label + " の Google 連携がまもなく期限切れ", "タップで再連携", "notif-warn", function(){
        startGoogleConnect(reauthBannerAccount);
      }));
    }

    notifList.innerHTML = "";
    if (!items.length){
      var empty = document.createElement("li");
      empty.className = "notif-empty";
      empty.textContent = "新しい通知はありません";
      notifList.appendChild(empty);
    } else {
      items.forEach(function(li){ notifList.appendChild(li); });
    }

    if (notifDot) notifDot.hidden = !(unread > 0 || reauthActive);
    updateNotifPermBtn();
  }

  function updateNotifPermBtn(){
    if (!notifPermBtn) return;
    if (!notifSupported()){ notifPermBtn.hidden = true; return; }
    notifPermBtn.hidden = false;
    var perm = Notification.permission;
    if (perm === "denied"){
      notifPermBtn.textContent = "通知はブラウザ設定でブロック中";
      notifPermBtn.disabled = true;
      notifPermBtn.classList.remove("is-on");
      return;
    }
    notifPermBtn.disabled = false;
    if (perm === "granted" && notifEnabled()){
      notifPermBtn.textContent = "デスクトップ通知: ON";
      notifPermBtn.classList.add("is-on");
    } else {
      notifPermBtn.textContent = "デスクトップ通知を有効にする";
      notifPermBtn.classList.remove("is-on");
    }
  }

  if (notifPermBtn){
    notifPermBtn.addEventListener("click", async function(){
      if (!notifSupported()) return;
      if (Notification.permission === "granted"){
        // トグル(権限はブラウザ側でしか取り消せないので localStorage のみ)
        var on = !notifEnabled();
        try { localStorage.setItem(NOTIF_ENABLED_KEY, on ? "1" : "0"); } catch(e){}
        if (on){
          try { localStorage.setItem(NOTIF_LAST_UNREAD_KEY, String(totalUnread())); } catch(e){}
        }
        updateNotifPermBtn();
        return;
      }
      var res = await Notification.requestPermission();
      if (res === "granted"){
        try {
          localStorage.setItem(NOTIF_ENABLED_KEY, "1");
          localStorage.setItem(NOTIF_LAST_UNREAD_KEY, String(totalUnread()));
        } catch(e){}
      }
      updateNotifPermBtn();
    });
  }

  // 未読が前回より増えていたら通知(ポータルを開いている間だけ)。
  function maybeNotifyNewMail(){
    if (!notifSupported() || Notification.permission !== "granted" || !notifEnabled()) return;
    var cur = totalUnread();
    var prev;
    try { prev = parseInt(localStorage.getItem(NOTIF_LAST_UNREAD_KEY) || "0", 10); } catch(e){ prev = 0; }
    if (isNaN(prev)) prev = 0;
    if (cur > prev){
      var delta = cur - prev;
      var show = function(reg){
        var opts = { body: "未読メールが " + delta + " 件増えました(合計 " + cur + " 件)", icon: "icon-192.png", tag: "cyber-portal-mail", renotify: true };
        if (reg && reg.showNotification) reg.showNotification("新着メール", opts);
        else new Notification("新着メール", opts);
      };
      if (navigator.serviceWorker && navigator.serviceWorker.ready){
        navigator.serviceWorker.ready.then(show).catch(function(){ show(null); });
      } else {
        show(null);
      }
    }
    try { localStorage.setItem(NOTIF_LAST_UNREAD_KEY, String(cur)); } catch(e){}
  }

  function positionNotifPanel(){
    if (!notifPanel || !notifBtn) return;
    var mobile = window.matchMedia && window.matchMedia("(max-width: 640px)").matches;
    if (mobile){
      // モバイルは CSS(position:fixed の固定オフセット)に任せる
      notifPanel.style.top = ""; notifPanel.style.right = ""; notifPanel.style.left = "";
      return;
    }
    notifPanel.style.left = "";
    var r = notifBtn.getBoundingClientRect();
    var pw = notifPanel.offsetWidth || 300;
    var right = Math.max(8, window.innerWidth - r.right);
    if (right + pw > window.innerWidth - 8) right = window.innerWidth - pw - 8;
    notifPanel.style.top = Math.round(r.bottom + 10) + "px";
    notifPanel.style.right = Math.round(right) + "px";
  }

  function openNotifPanel(){
    if (!notifPanel) return;
    refreshNotifCenter();
    notifPanel.hidden = false;
    positionNotifPanel();
    if (notifBtn) notifBtn.setAttribute("aria-expanded", "true");
    document.addEventListener("mousedown", onNotifOutside, true);
    document.addEventListener("keydown", onNotifEsc, true);
    window.addEventListener("resize", positionNotifPanel);
  }
  function closeNotifPanel(){
    if (!notifPanel) return;
    notifPanel.hidden = true;
    if (notifBtn) notifBtn.setAttribute("aria-expanded", "false");
    document.removeEventListener("mousedown", onNotifOutside, true);
    document.removeEventListener("keydown", onNotifEsc, true);
    window.removeEventListener("resize", positionNotifPanel);
  }
  function onNotifOutside(e){
    if (notifPanel && !notifPanel.contains(e.target) && notifBtn && !notifBtn.contains(e.target)){
      closeNotifPanel();
    }
  }
  function onNotifEsc(e){ if (e.key === "Escape") closeNotifPanel(); }

  if (notifBtn){
    notifBtn.addEventListener("click", function(){
      if (notifPanel.hidden) openNotifPanel(); else closeNotifPanel();
    });
  }

  // PWA: インストールプロンプト
  window.addEventListener("beforeinstallprompt", function(e){
    e.preventDefault();
    deferredInstallPrompt = e;
    if (notifInstallBtn) notifInstallBtn.hidden = false;
  });
  window.addEventListener("appinstalled", function(){
    deferredInstallPrompt = null;
    if (notifInstallBtn) notifInstallBtn.hidden = true;
  });
  if (notifInstallBtn){
    notifInstallBtn.addEventListener("click", async function(){
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      try { await deferredInstallPrompt.userChoice; } catch(e){}
      deferredInstallPrompt = null;
      notifInstallBtn.hidden = true;
    });
  }

  // PWA: サービスワーカー登録
  if ("serviceWorker" in navigator){
    var reg = function(){ navigator.serviceWorker.register("sw.js").catch(function(err){ console.warn("[sw] register failed", err); }); };
    if (document.readyState === "complete") reg();
    else window.addEventListener("load", reg);
  }

  updateNotifPermBtn();

  // ログイン完了(auth-gate側の type="module" スクリプトが発火)後に、
  // Home画面で必要な最小限のデータ(メール未読件数)を読み込む。
  // タスク/メモは各ビューを開いたタイミングで initTasks/initNotes が読み込む。
  // メール一覧・カレンダー画面もログイン直後に裏で先読みしておき、ボタンを押した時に
  // すぐ表示できるようにする(showView 側は先読み済みなら再取得しない)。
  function warmCalendarView(){
    if (calInitialized) return;
    calInitialized = true;
    loadAndRenderCalendar();
  }

  // 重い投機的プリフェッチ(メール一覧・カレンダー月グリッド)は HOME 表示に
  // 必須ではないので、可視データの取得を邪魔しないようアイドル時間へ回す。
  function scheduleIdle(fn){
    if (typeof requestIdleCallback === "function") requestIdleCallback(fn, { timeout: 4000 });
    else setTimeout(fn, 1200);
  }

  // /api/bootstrap/home の集約レスポンスを各カードへ配る。セクションが欠けている /
  // エラー印が付いている場合はそのセクションだけ従来の個別ロードにフォールバックする。
  function applyHomeBootstrap(b){
    b = b || {};

    if (b.settings){ applySettings(b.settings); cacheSettings(b.settings); }
    else loadSettings();

    // 天気は集約レスポンスを使わず、必ず loadWeather()(ブラウザから Open-Meteo 直取得、
    // 失敗時のみバックエンド経由)に任せる。Render→Open-Meteo が不通でも表示を欠かさない。
    loadWeather();

    var gu = b.gmailUnread;
    if (gu){
      var h = gu.haruka || {}, s = gu.syslea || {};
      if (typeof h.unreadCount === "number"){ harukaUnreadCount = h.unreadCount; harukaUnreadError = null; }
      else { harukaUnreadError = { code: h.error || "upstream_error" }; }
      if (typeof s.unreadCount === "number"){ sysleaUnreadCount = s.unreadCount; sysleaUnreadError = null; }
      else { sysleaUnreadError = { code: s.error || "upstream_error" }; }
      renderHomeInbox();
    } else {
      loadGmailUnreadCount();
    }

    var ct = b.calendarToday && b.calendarToday.haruka;
    // schedAccount は初期値 "haruka"。applySettings で既定アカウントが syslea に
    // 変わっている場合は集約の haruka 分は使わず個別取得する。
    if (schedAccount === "haruka" && ct && ct.events){
      applyCalendarToday(ct.events, "haruka");
    } else {
      initCalendarWatch();
    }

    if (b.googleStatus) applyReauthStatus(b.googleStatus);
    else checkReauthReminder();
  }

  async function warmOnAuthReady(){
    refreshNotifCenter();
    try {
      applyHomeBootstrap(await apiFetch("/api/bootstrap/home"));
    } catch(e){
      // 集約が失敗したら従来どおり個別ロードにフォールバック(= 変更前の挙動)。
      loadSettings();
      loadGmailUnreadCount();
      initCalendarWatch();
      loadWeather();
      checkReauthReminder();
    }
    scheduleIdle(function(){ loadHarukaMail(); warmCalendarView(); });
  }
  document.addEventListener("cyberportal:authready", warmOnAuthReady);
  // 未読件数を定期的に取り直す(通知センター/デスクトップ通知のため)。
  setInterval(function(){
    if (document.visibilityState !== "visible") return;
    if (window.__cyberPortalAuth && window.__cyberPortalAuth.currentUser) loadGmailUnreadCount();
  }, 3 * 60 * 1000);
  // 既にログイン済みの状態でこのスクリプトが後から評価されるケース
  // (モジュールスクリプトの実行順は保証されないため)にも対応する。
  if (window.__cyberPortalAuth && window.__cyberPortalAuth.currentUser){
    warmOnAuthReady();
  }

})();
