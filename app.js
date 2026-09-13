(function(){
  "use strict";

  // オンデマンドモジュール(app.business.js/app.payables.js)のキャッシュ busting 用。
  // SHELL に無いこの2ファイルは {cache:"reload"} プリフェッチの対象外なので、素の
  // <script src> だとブラウザ HTTP キャッシュ／CDN エッジの max-age=600 に従ってしまい、
  // デプロイ直後 最大10分 古い版のまま実行される事故があった(2026/09/09 判明)。
  // bump.mjs が sw.js の CACHE 番号と同時にこの値も上げるので、番号が変われば
  // URL が変わり毎回キャッシュミス=強制的に新しい版を取りに行く。
  var BUILD_V = 144;
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
  // カレンダーのイベント色は「どのアカウントの予定か」だけを表す（2026/09/10）。
  // 以前は event.id のハッシュで暖色5色を割り当てていたが、色に意味が無く
  // どれも同じ茶色に見えるだけだった。はるか=アクセント / SYSLEA=寒色ニュートラル。
  var ACCOUNT_COLOR = { haruka: "#ff8f3f", syslea: "#8fa0b0" };
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
  var viewPayables = document.getElementById("view-payables");
  var viewContracts = document.getElementById("view-contracts");
  var viewProjects = document.getElementById("view-projects");
  var viewSlack = document.getElementById("view-slack");
  var viewFinance = document.getElementById("view-finance");
  var viewSubs = document.getElementById("view-subs");
  var viewJimuhack = document.getElementById("view-jimuhack");
  var appTopbar = document.getElementById("app-topbar");

  /* サブ画面(カレンダー/メール/請求書管理/収支/サブスク/契約書/タスク/メモ/アイデア帳)の
     ヘッダーは #app-topbar と違い brand + profile だけの静的表示。同じ 24 行の markup を
     9 箇所コピペしていた(六角ロゴの <linearGradient> id も重複)ので、index.html には
     <header class="panel topbar" data-subhead="表示名" data-subtag="小見出し"> だけ置き、
     ここで1テンプレから流し込む。この後の querySelectorAll(".profile") 等が拾えるよう
     view routing より前に実行する。 */
  Array.prototype.forEach.call(
    document.querySelectorAll("header.topbar[data-subhead]"),
    function(h, i){
      var gid = "brandGrad" + i;
      h.innerHTML =
        '<div class="brand">' +
          '<div class="brand-mark">' +
            '<svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">' +
              '<path d="M20 3 L36 12 V28 L20 37 L4 28 V12 Z" stroke="url(#' + gid + ')" stroke-width="2.4"/>' +
              '<path d="M20 12 L28 17 V27 L20 32 L12 27 V17 Z" fill="url(#' + gid + ')" opacity="0.85"/>' +
              '<defs><linearGradient id="' + gid + '" x1="4" y1="3" x2="36" y2="37">' +
                '<stop stop-color="#ff2f92"/><stop offset="1" stop-color="#2ce3ff"/></linearGradient></defs>' +
            '</svg>' +
          '</div>' +
          '<div class="brand-text"><div class="name"></div><div class="tag"></div></div>' +
        '</div>' +
        '<div class="top-actions">' +
          '<div class="profile">' +
            '<div class="avatar">遥</div>' +
            '<div class="profile-meta"><div class="uname">HARUKA</div><div class="status">Online</div></div>' +
          '</div>' +
        '</div>';
      h.querySelector(".brand-text .name").textContent = h.getAttribute("data-subhead") || "CYBER PORTAL";
      h.querySelector(".brand-text .tag").textContent = h.getAttribute("data-subtag") || "CYBER PORTAL";
    }
  );

  var navHome = document.getElementById("nav-home");
  var navPrivate = document.getElementById("nav-private");
  var navBusiness = document.getElementById("nav-business");
  var currentDashboard = "home"; // サブ画面の「← 戻る」で戻る先
  var currentView = "home";      // いま表示している画面(= URL の hash)
  var calInitialized = false;
  var mailInitialized = false;
  var tasksInitialized = false;
  var notesInitialized = false;
  var ideasInitialized = false;
  var privateInitialized = false;
  var businessInitialized = false;
  var payablesInitialized = false;
  var jimuhackInitialized = false;
  var contractsPageInitialized = false;
  // showView("contracts") のときに開きたいタブ。モジュールのロードを待ってから
  // __CP.setContractsTab() に渡す(HOME の契約書アラート行 →「アラート」タブ 用)。
  var contractsPendingTab = null;
  var projectsPageInitialized = false;
  var slackPageInitialized = false;
  var financeInitialized = false;
  var subsPageInitialized = false;

  // #view-payables 用の分離モジュール(app.payables.js)を初回だけ動的ロードする。
  // index.html には置かず、sw.js の SHELL にも入れない(開いたとき取得 → SW が実行時キャッシュ、
  // 以後はオフラインでも動く)。2回目以降の呼び出しは同じ Promise を返す。
  var _moduleLoads = {};
  function loadModuleOnce(src, readyKey){
    if (_moduleLoads[src]) return _moduleLoads[src];
    _moduleLoads[src] = new Promise(function(resolve, reject){
      var s = document.createElement("script");
      s.src = src + "?v=" + BUILD_V; // キャッシュ busting(上のコメント参照)
      s.async = true;
      s.onload = function(){
        if (window.__CP && typeof window.__CP[readyKey] === "function") resolve();
        else { _moduleLoads[src] = null; reject(new Error(src + " は読めたが " + readyKey + " 未登録")); }
      };
      s.onerror = function(){ _moduleLoads[src] = null; reject(new Error(src + " の取得に失敗")); };
      document.head.appendChild(s);
    });
    return _moduleLoads[src];
  }
  function loadPayablesModule(){ return loadModuleOnce("app.payables.js", "initPayables"); }
  function loadBusinessModule(){ return loadModuleOnce("app.business.js", "initBusinessCards"); }
  function loadJimuhackModule(){ return loadModuleOnce("app.jimuhack.js", "initJimuhack"); }
  function bizModuleFail(err){
    ["pv-contracts-status", "pv-events-status", "pv-slack-status", "contracts-page-status", "projects-page-status", "slack-page-status"].forEach(function(id){
      var el = document.getElementById(id);
      if (el) el.textContent = "モジュールの読み込みに失敗しました。タブを開き直してください。";
    });
    console.error("[business]", err);
  }

  // 契約書トラッカー / プロジェクトボード / Slackダイジェスト は app.business.js に分離。
  // 「最近のメモ / 最近のタスク」カードの配線は tasks/notes モジュール依存なのでここに残す。
  function initBusiness(){
    var img = document.getElementById("biz-hero-img");
    if (img && !img.getAttribute("src") && HERO_ILLUSTRATIONS.length){
      img.src = HERO_ILLUSTRATIONS[Math.floor(Math.random() * HERO_ILLUSTRATIONS.length)];
    }
    wireDashNoteTaskCards("biz-note-new", "biz-task-new", "syslea");
    loadBusinessModule().then(function(){ window.__CP.initBusinessCards(); }).catch(bizModuleFail);
  }

  // ダッシュボードの「最近のメモ / 最近のタスク」カード共通の初期化。
  // ビジネス(SYSLEA)・プライベート(はるか)の両方から呼ぶ。
  // notes/tasks は遅延初期化なので、未初期化なら init を、済んでいれば再描画だけ走らせる。
  var dashCardsWired = {};
  function wireDashNoteTaskCards(noteBtnId, taskBtnId, tag){
    if (!dashCardsWired[noteBtnId]){
      dashCardsWired[noteBtnId] = true;
      var noteNewBtn = document.getElementById(noteBtnId);
      if (noteNewBtn) noteNewBtn.addEventListener("click", function(){ openNewNote(tag); });
      var taskNewBtn = document.getElementById(taskBtnId);
      if (taskNewBtn) taskNewBtn.addEventListener("click", function(){ openNewTask(tag); });
    }
    if (!notesInitialized){ notesInitialized = true; initNotes(); }
    else renderNoteCards();
    if (!tasksInitialized){ tasksInitialized = true; initTasks(); }
    else renderTaskCards();
  }

  function showView(name, opts){
    opts = opts || {};
    currentView = name;
    var isDash = name === "home" || name === "private" || name === "business";
    viewHome.hidden = name !== "home";
    if (viewPrivate) viewPrivate.hidden = name !== "private";
    if (viewBusiness) viewBusiness.hidden = name !== "business";
    viewCalendar.hidden = name !== "calendar";
    viewMail.hidden = name !== "mail";
    viewTasks.hidden = name !== "tasks";
    viewNotes.hidden = name !== "notes";
    viewIdeas.hidden = name !== "ideas";
    if (viewPayables) viewPayables.hidden = name !== "payables";
    if (viewContracts) viewContracts.hidden = name !== "contracts";
    if (viewProjects) viewProjects.hidden = name !== "projects";
    if (viewSlack) viewSlack.hidden = name !== "slack";
    if (viewFinance) viewFinance.hidden = name !== "finance";
    if (viewSubs) viewSubs.hidden = name !== "subs";
    if (viewJimuhack) viewJimuhack.hidden = name !== "jimuhack";

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
    if (name === "payables" && !payablesInitialized){
      payablesInitialized = true;
      loadPayablesModule().then(function(){
        window.__CP.initPayables();
      }).catch(function(err){
        payablesInitialized = false;
        var host = document.getElementById("pay2-status");
        if (host) host.textContent = "請求書管理モジュールの読み込みに失敗しました。通信環境を確認してタブを開き直してください。";
        console.error("[payables]", err);
      });
    }
    if (name === "contracts"){
      loadBusinessModule().then(function(){
        if (!contractsPageInitialized){ contractsPageInitialized = true; window.__CP.initContractsPage(); }
        else window.__CP.renderContractsPage();
        if (contractsPendingTab != null){
          window.__CP.setContractsTab(contractsPendingTab);
          contractsPendingTab = null;
        }
      }).catch(bizModuleFail);
    }
    if (name === "projects"){
      loadBusinessModule().then(function(){
        if (!projectsPageInitialized){ projectsPageInitialized = true; window.__CP.initProjectsPage(); }
        else window.__CP.renderProjectsPage();
      }).catch(bizModuleFail);
    }
    if (name === "slack"){
      loadBusinessModule().then(function(){
        if (!slackPageInitialized){ slackPageInitialized = true; window.__CP.initSlackPage(); }
        else window.__CP.renderSlackPage();
      }).catch(bizModuleFail);
    }
    // 配線は初回だけ。データはシート(正)が外で変わりうるので開くたびに取り直す。
    // 収支は月ナビで過去へ行けるので、入り直したら当月に戻す。
    if (name === "finance"){
      if (!financeInitialized){ financeInitialized = true; wireFinanceModal(); }
      financeMonth = finCurrentMonth();
      loadFinance();
    }
    if (name === "subs"){
      if (!subsPageInitialized){ subsPageInitialized = true; wireSubs(); }
      loadSubs();
    }
    // 事務ハック(ブログ)は app.jimuhack.js に分離。2回目以降は再描画だけ(WordPress の記事一覧は
    // モジュール側が10分キャッシュして、古ければ取り直す)。
    if (name === "jimuhack"){
      loadJimuhackModule().then(function(){
        if (!jimuhackInitialized){ jimuhackInitialized = true; window.__CP.initJimuhack(); }
        else window.__CP.renderJimuhack();
      }).catch(function(err){
        var el = document.getElementById("jh-status");
        if (el) el.textContent = "事務ハックモジュールの読み込みに失敗しました。タブを開き直してください。";
        console.error("[jimuhack]", err);
      });
    }
    if (!opts.fromHistory) syncHash(name, opts.replace);
    window.scrollTo(0, 0);
  }

  /* ================= URL ルーティング(hash) =================
     showView() は DOM の hidden を切り替えるだけで URL を触っていなかったため、
     (1) リロードすると必ず HOME に戻る (2) ブラウザの戻る = PWA だとアプリごと終了
     (3) タブやサブ画面をブックマーク/共有できない、という3点があった。
     ここで「表示 → hash」「hash → 表示」の双方向を閉じる。
     ・showView() が pushState で hash を書く(pushState は hashchange を発火しないので
       下のハンドラと往復しない)。
     ・戻る/進む(popstate)と手打ちの hash 変更(hashchange)は applyRoute() で表示に反映し、
       このときは opts.fromHistory を立てて書き戻さない。
     ・currentView との一致で二重発火を弾く(popstate と hashchange は同時に飛ぶ)。 */
  var VIEW_ROUTES = [
    "home", "private", "business",
    "calendar", "mail", "tasks", "notes", "ideas",
    "payables", "contracts", "projects", "slack", "finance", "subs", "jimuhack"
  ];
  function routeFromHash(){
    var h = String(location.hash || "").slice(1);
    if (h.charAt(0) === "/") h = h.slice(1);
    return VIEW_ROUTES.indexOf(h) !== -1 ? h : "home";
  }
  function syncHash(name, replace){
    var want = "#" + name;
    if (location.hash === want) return;
    try {
      if (replace) history.replaceState(null, "", want);
      else history.pushState(null, "", want);
    } catch (e) {
      // file:// 等 History API が使えない環境へのフォールバック。
      location.hash = name;
    }
  }
  function applyRoute(){
    var name = routeFromHash();
    if (name === currentView) return;
    showView(name, { fromHistory: true });
  }
  window.addEventListener("popstate", applyRoute);
  window.addEventListener("hashchange", applyRoute);
  // ログイン完了後に1回だけ、URL の hash が指す画面を開く。サブ画面は表示時に
  // API を叩くものがある(finance/subs 等)ので、認証が通るまで待つ。
  var routeApplied = false;
  function applyInitialRoute(){
    if (routeApplied) return;
    routeApplied = true;
    // 初回は replace。pushState だと戻るで hash 無しの同じ画面に戻るだけの
    // 空エントリが1つ増える。
    showView(routeFromHash(), { replace: true });
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
  ["cal-back", "mail-back", "tasks-back", "notes-back", "ideas-back", "payables-back", "contracts-back", "projects-back", "slack-back", "finance-back", "subs-back", "jimuhack-back"].forEach(function(id){
    var b = document.getElementById(id);
    if (b) b.addEventListener("click", function(){ showView(currentDashboard); });
  });
  // プライベートのクイックアクセス: はるかを選択済みにしてサブ画面を開く
  [["pv-quick-tasks", "tasks"], ["pv-quick-calendar", "calendar"], ["pv-quick-notes", "notes"],
   ["pv-quick-mail", "mail"], ["pv-quick-ideas", "ideas"],
   ["pv-quick-finance", "finance"], ["pv-quick-subs", "subs"], ["pv-quick-jimuhack", "jimuhack"]].forEach(function(pair){
    var b = document.getElementById(pair[0]);
    if (b) b.addEventListener("click", function(){
      if (typeof setDefaultAccount === "function") setDefaultAccount("haruka");
      showView(pair[1]);
    });
  });
  // ビジネスのクイックアクセス: SYSLEA を選択済みにしてサブ画面を開く
  [["biz-quick-tasks", "tasks"], ["biz-quick-calendar", "calendar"], ["biz-quick-notes", "notes"],
   ["biz-quick-mail", "mail"], ["biz-quick-ideas", "ideas"], ["biz-quick-payables", "payables"]].forEach(function(pair){
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
    wireDashNoteTaskCards("pv-note-new", "pv-task-new", "haruka");
    wireHabitTracker();
    loadHabits();
    wirePlan();
    loadPlan();
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
  var subsRows = [];            // 「まとめて編集」モーダルの作業コピー
  var subsFinanceRows = null;   // 家計簿との突合用（当月の明細。取れなければ null）
  var subRowEditIndex = -1;     // 1件編集モーダルが編集中の subsState インデックス（-1 = 新規）

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
  function subTodayParts(){
    return new Intl.DateTimeFormat("en-CA", { timeZone: JP_TZ, year: "numeric", month: "2-digit", day: "2-digit" })
      .format(new Date()).split("-").map(Number);
  }
  function subYm(y, m){ return y + "-" + String(m).padStart(2, "0"); }
  /* s の課金月を列挙する。subNextParts と同じアンカー(2年前の基準月)から周期ぶんずつ
     前進させ、fromYm から count ヶ月ぶんの窓に入るものを [{ym,y,m,d}] で返す。
     「今月の請求」「年間の分布」はどちらもこれ1本で出す。 */
  function subChargesInRange(s, fromYm, count){
    var step = subEvery(s) * (subUnit(s) === "year" ? 12 : 1);
    var day = Math.min(31, Math.max(1, Math.round(Number(s.day) || 1)));
    var p = subTodayParts();
    var fp = String(fromYm).split("-").map(Number);
    var fromIdx = fp[0] * 12 + (fp[1] - 1);
    var toIdx = fromIdx + count - 1;
    var anchorM = step === 1 ? p[1] : Math.min(12, Math.max(1, Math.round(Number(s.month) || p[1])));
    var anchorIdx = (p[0] - 2) * 12 + (anchorM - 1);
    var skip = Math.max(0, Math.ceil((fromIdx - anchorIdx) / step));
    var out = [];
    for (var idx = anchorIdx + skip * step; idx <= toIdx && out.length < 200; idx += step){
      var y = Math.floor(idx / 12), m = (idx % 12) + 1;
      out.push({ ym: subYm(y, m), y: y, m: m, d: Math.min(day, new Date(y, m, 0).getDate()) });
    }
    return out;
  }
  // 次回課金までの日数（0 = 今日）
  function subDaysUntil(s){
    var n = subNextParts(s);
    var p = subTodayParts();
    var a = Date.UTC(n.y, n.m - 1, n.d), b = Date.UTC(p[0], p[1] - 1, p[2]);
    return Math.round((a - b) / 86400000);
  }
  function subNextDateLabel(s){
    var n = subNextParts(s);
    return n.m + "/" + String(n.d).padStart(2, "0");
  }
  function subDaysLabel(days){
    if (days <= 0) return "今日";
    if (days === 1) return "明日";
    return "あと" + days + "日";
  }
  function subCategoryOf(s){ return String(s.category || "").trim(); }
  // 名前どうしのゆるい照合（家計簿の備考にサービス名が入っている前提）
  function subNorm(s){
    return String(s || "").toLowerCase().replace(/[\s　・,，.。]/g, "");
  }

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
        subsState = [];
        if (kpis) kpis.hidden = true;
        if (body) body.hidden = true;
        if (recon) recon.hidden = true;
        if (mngBtn) mngBtn.hidden = true;
        if (addBtn) addBtn.hidden = true;
        subsSetStatus("設定 → 家計簿スプレッドシート に共有 URL を登録すると使えます。");
        return;
      }
      if (mngBtn) mngBtn.hidden = false;
      if (addBtn) addBtn.hidden = false;
      subsState = res.subscriptions || [];
      // 突合用に家計簿の当月明細も取る（失敗しても本体は出す）
      try {
        var fin = await apiFetch("/api/sheets/finance");
        subsFinanceRows = (fin && fin.configured !== false && Array.isArray(fin.rows)) ? fin.rows : null;
      } catch(e){ subsFinanceRows = null; }
      renderSubs();
      subsSetStatus("");
    } catch(err){
      if (mngBtn) mngBtn.hidden = false;
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
      note.type = "text"; note.maxLength = 200; note.placeholder = "備考(任意)"; note.value = r.note || "";
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
      note: String(r.note || "").trim().slice(0, 200),
      category: String(r.category || "").trim().slice(0, 40)
    };
  }
  // シートは全置換なので、1件編集でも常に全件を送る
  async function putSubs(list){
    await apiFetch("/api/sheets/subscriptions", {
      method: "PUT",
      body: JSON.stringify({ subscriptions: list })
    });
    await loadSubs(); // シート(正)から取り直す
  }

  async function saveSubs(){
    var err = document.getElementById("subs-form-error");
    var cleaned = subsRows
      .filter(function(r){ return (r.name || "").trim(); })
      .map(cleanSubRow);
    var saveBtn = document.getElementById("subs-save");
    if (saveBtn) saveBtn.disabled = true;
    try {
      await putSubs(cleaned);
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
    subRowEditIndex = (index != null && index >= 0) ? index : -1;
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
      await putSubs(list);
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

  function finYen(n){
    return "¥" + (Math.round(Number(n) || 0)).toLocaleString("ja-JP");
  }
  function finCurrentMonth(){ return jstDateKey(new Date()).slice(0, 7); }
  function finShiftMonth(ym, n){
    var p = String(ym).split("-").map(Number);
    var t = (p[0] * 12 + (p[1] - 1)) + n;
    return String(Math.floor(t / 12)) + "-" + String((t % 12) + 1).padStart(2, "0");
  }
  function finMonthLabel(ym){
    var p = String(ym).split("-");
    return p[0] + "年" + Number(p[1]) + "月";
  }
  // "YYYY-MM-DD" → "9/03(水)"。dowFmt は JST 固定なので UTC 正午で組んでズレを避ける。
  function finDayLabel(key){
    var p = String(key).split("-").map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2], 3));
    return p[1] + "/" + String(p[2]).padStart(2, "0") + "(" + dowFmt.format(d) + ")";
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
    if (countEl) countEl.textContent = rows.length
      ? rows.length + "件" + (editable ? " ・ 行をクリックで編集" : "")
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


  /* ================= calendar page: state ================= */
  var HOUR_PX = 48;
  // account は "haruka" | "syslea" | "both"（both = 2アカウントを重ねて表示）。
  var calState = { view: "day", account: "haruka", anchor: jstDateKey(new Date()), events: [], overlays: [] };
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
    renderLayerToggles();   // 「両方」のときだけ出すアカウント色の凡例を出し入れする
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
    // ステータスは独立パネルではなくツールバー内のチップ（1行ぶん縦を節約する）。
    calStatusBar.className = "cal-status-chip" + (cls ? " " + cls : "");
    calStatusBar.innerHTML = html;
  }

  function calAccountLabel(){
    return calState.account === "syslea" ? "SYSLEA" : calState.account === "both" ? "両方" : "はるか";
  }

  /* ================= カレンダーのレイヤー（ポータル内の期限ものを重ねる） =================
     Google の予定だけでなく、ポータルが既に持っている「日付のあるもの」を同じ画面に出す。
     どれも既存 API をそのまま叩くだけで、バックの改修もデータ構造の変更も無い。
     色は増やさない：期限もの＝金(--warn)、期限超過＝赤(--err) の2値だけで、
     種別は先頭の小さいバッジ（タスク/契約/支払/TR/サブスク）で見分ける。 */
  var CAL_LAYERS = [
    { key: "tasks",     label: "タスク",   badge: "タスク",   view: "tasks" },
    { key: "contracts", label: "契約書",   badge: "契約",     view: "contracts" },
    { key: "payables",  label: "支払",     badge: "支払",     view: "payables" },
    { key: "trackers",  label: "トラッカー", badge: "TR",     view: "business" },
    { key: "subs",      label: "サブスク", badge: "サブスク", view: "subs" }
  ];
  var CAL_LAYERS_LS = "cp_cal_layers";
  // 既定：サブスクだけ OFF（毎月必ず出るので、まず他を見たいことが多い）。
  var calLayers = { tasks: true, contracts: true, payables: true, trackers: true, subs: false };
  try{
    var savedLayers = JSON.parse(localStorage.getItem(CAL_LAYERS_LS) || "null");
    if (savedLayers && typeof savedLayers === "object"){
      CAL_LAYERS.forEach(function(l){ if (typeof savedLayers[l.key] === "boolean") calLayers[l.key] = savedLayers[l.key]; });
    }
  } catch(_){ /* localStorage が使えなくても既定値で動く */ }

  // レイヤーごとの生データ。初回 ON のときだけ取得してセッション中は使い回す。
  var calLayerCache = {};   // key -> 正規化済み [{dayKey,time,label,badge,layer,overdue}]
  var calLayerLoading = {}; // key -> Promise（同時多重リクエストの抑止）

  function calItem(layer, dayKey, time, label, todayKey, closed){
    return {
      layer: layer.key, badge: layer.badge, view: layer.view,
      dayKey: dayKey, time: time || "", label: label || "(無題)",
      overdue: !closed && dayKey < todayKey
    };
  }

  var CAL_LAYER_FETCH = {
    tasks: async function(layer){
      var today = jstDateKey(new Date());
      var res = await apiFetch("/api/tasks");
      return (res.tasks || [])
        .filter(function(t){ return t && t.due && !t.done; })
        .map(function(t){ return calItem(layer, t.due, t.dueTime || "", t.text || "(無題)", today, false); });
    },
    contracts: async function(layer){
      var today = jstDateKey(new Date());
      var res = await apiFetch("/api/contracts");
      return (res.contracts || [])
        .filter(function(c){ return c && c.dueDate && c.status !== "締結済み" && c.status !== "報告済み"; })
        .map(function(c){ return calItem(layer, c.dueDate, "", (c.client || c.title || "(名称未設定)") + " 締結期限", today, false); });
    },
    payables: async function(layer){
      var today = jstDateKey(new Date());
      var res = await apiFetch("/api/payables");
      return (res.payables || [])
        .filter(function(p){ return p && !p.paid && (p.scheduledDate || p.dueDate); })
        .map(function(p){
          var amt = p.amountIncl ? " " + subYen(p.amountIncl) : "";
          return calItem(layer, p.scheduledDate || p.dueDate, "", (p.vendorName || "(取引先不明)") + amt, today, false);
        });
    },
    trackers: async function(layer){
      var today = jstDateKey(new Date());
      var res = await apiFetch("/api/event-trackers");
      var out = [];
      (res.eventTrackers || []).forEach(function(t){
        if (!t || t.archived) return;
        (t.items || []).forEach(function(it){
          if (!it || !it.dueDate || it.done) return;
          out.push(calItem(layer, it.dueDate, "", t.name + ": " + (it.text || "(無題)"), today, false));
        });
      });
      return out;
    },
    subs: async function(layer){
      var today = jstDateKey(new Date());
      var res = await apiFetch("/api/sheets/subscriptions");
      if (!res || res.configured === false) return [];
      var out = [];
      // 前後13ヶ月ぶんの課金日を先に展開しておく（表示範囲の絞り込みは描画時）。
      var p = keyParts(addDaysKey(today, -400));
      var fromYm = p.y + "-" + String(p.m).padStart(2, "0");
      (res.subscriptions || []).forEach(function(s){
        if (!s || !s.name) return;
        subChargesInRange(s, fromYm, 26).forEach(function(c){
          var dk = c.y + "-" + String(c.m).padStart(2,"0") + "-" + String(c.d).padStart(2,"0");
          out.push(calItem(layer, dk, "", s.name + (s.amount ? " " + subYen(s.amount) : ""), today, true));
        });
      });
      return out;
    }
  };

  // ON になっているレイヤーを（未取得なら取得して）まとめる。1本コケても他は出す。
  // タスクや請求書は別画面で更新されるので、3分で取り直す（毎描画だと重い）。
  var CAL_LAYER_TTL_MS = 3 * 60 * 1000;
  async function loadCalOverlays(){
    var now = Date.now();
    var wanted = CAL_LAYERS.filter(function(l){ return calLayers[l.key]; });
    wanted.forEach(function(l){
      var c = calLayerCache[l.key];
      if (c && now - c.at > CAL_LAYER_TTL_MS) calLayerCache[l.key] = null;
    });
    await Promise.all(wanted.map(function(l){
      if (calLayerCache[l.key]) return null;
      if (!calLayerLoading[l.key]){
        calLayerLoading[l.key] = CAL_LAYER_FETCH[l.key](l)
          .then(function(items){ calLayerCache[l.key] = { at: Date.now(), items: items }; })
          .catch(function(){ calLayerCache[l.key] = { at: Date.now(), items: [] }; }) // 取れなければ黙って空（本体を止めない）
          .finally(function(){ calLayerLoading[l.key] = null; });
      }
      return calLayerLoading[l.key];
    }));
    var all = [];
    wanted.forEach(function(l){ all = all.concat((calLayerCache[l.key] || {}).items || []); });
    calState.overlays = all;
  }

  function overlaysFor(dayKey){
    return calState.overlays.filter(function(o){ return o.dayKey === dayKey; });
  }
  // 終日帯に出すもの（時刻なし）と、時間軸に置けるもの（タスクの dueTime）を分ける。
  function overlaysAllDay(dayKey){ return overlaysFor(dayKey).filter(function(o){ return !o.time; }); }
  function overlaysTimed(dayKey){ return overlaysFor(dayKey).filter(function(o){ return !!o.time; }); }

  function overlayChipHtml(o, extraClass, extraStyle){
    return '<div class="cal-ov-chip' + (o.overdue ? " is-overdue" : "") + (extraClass ? " " + extraClass : "") + '"'
      + ' tabindex="0" role="button" data-ov-view="' + escapeHtml(o.view) + '"'
      + ' title="' + escapeHtml(o.badge + " · " + o.label + (o.overdue ? "（期限超過）" : "")) + '"'
      + (extraStyle ? ' style="' + extraStyle + '"' : '')
      + '><span class="cal-ov-badge">' + escapeHtml(o.badge) + '</span>'
      + (o.time ? '<span class="t">' + escapeHtml(o.time) + '</span>' : '')
      + '<span class="cal-ov-text">' + escapeHtml(o.label) + '</span></div>';
  }

  // レイヤーのトグル列（ツールバー下段）。押すたびに保存して再描画する。
  var calLayersBar = document.getElementById("cal-layers");
  function renderLayerToggles(){
    if (!calLayersBar) return;
    // 「両方」表示のときだけ、どちらの色がどちらのアカウントかを凡例で出す。
    var legend = calState.account !== "both" ? "" : ["haruka", "syslea"].map(function(a){
      return '<span class="cal-acct-legend" style="--lg-color:' + ACCOUNT_COLOR[a] + ';"><i></i>'
        + escapeHtml(ACCOUNTS[a].label) + '</span>';
    }).join("");
    calLayersBar.innerHTML = '<span class="cal-layers-label">重ねて表示</span>' + CAL_LAYERS.map(function(l){
      return '<button type="button" class="cal-layer-chip' + (calLayers[l.key] ? " is-on" : "") + '"'
        + ' data-layer="' + l.key + '" aria-pressed="' + (calLayers[l.key] ? "true" : "false") + '">'
        + escapeHtml(l.label) + '</button>';
    }).join("") + legend;
    calLayersBar.querySelectorAll(".cal-layer-chip").forEach(function(btn){
      btn.addEventListener("click", function(){
        var k = btn.getAttribute("data-layer");
        calLayers[k] = !calLayers[k];
        try{ localStorage.setItem(CAL_LAYERS_LS, JSON.stringify(calLayers)); } catch(_){ }
        renderLayerToggles();
        loadAndRenderCalendar();
      });
    });
  }
  renderLayerToggles();

  async function loadAndRenderCalendar(){
    updateViewButtons();
    var token = ++calLoadToken;
    var range = getFetchRange();
    var bounds = jstRangeForKeys(range.start, range.endExclusive);
    setCalStatus("読み込み中…", "");
    if (!calState.loadOk) calGridContainer.innerHTML = calSkeletonHtml();
    var acct = calState.account;
    var qs = "/api/google/calendar/events?start=" + encodeURIComponent(bounds.start) + "&end=" + encodeURIComponent(bounds.end);
    // 「両方」は2アカウントを並列に取り、_acct を付けて1本にまとめる。
    // 片方だけコケても、取れた方は出す（両方ダメなら従来のエラー処理へ）。
    var accts = acct === "both" ? ["haruka", "syslea"] : [acct];
    // レイヤーの取得は予定の取得と並行に走らせる（直列だと Render のコールドスタートぶん待たされる）
    var overlaysP = loadCalOverlays();
    try{
      var settled = await Promise.all(accts.map(function(a){
        return apiFetch(acctPath(qs, a))
          .then(function(res){ return { acct: a, events: res.events || [] }; })
          .catch(function(err){ return { acct: a, err: err }; });
      }));
      if (token !== calLoadToken) return;
      var failed = settled.filter(function(s){ return s.err; });
      if (failed.length === accts.length) throw failed[0].err;

      var events = [];
      settled.forEach(function(s){
        if (s.err) return;
        s.events.forEach(function(ev){ ev._acct = s.acct; events.push(ev); });
      });
      calState.events = events;
      calState.loadedCalendarId = "primary";
      calState.loadOk = true;
      await overlaysP;
      if (token !== calLoadToken) return;
      renderCalendarView();
      var partial = failed.length
        ? ' <span class="warn">' + escapeHtml(ACCOUNTS[failed[0].acct].label) + ' は取得できず</span>'
        : "";
      setCalStatus('<span class="live">●</span> Google Calendar 連携中 (' + escapeHtml(calAccountLabel()) + ')' + partial, "");
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
          btn.addEventListener("click", function(){ startGoogleConnect(acct === "both" ? "haruka" : acct); });
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

  // 予定がどのアカウントのものか。「両方」表示のときは取得時に _acct を付けてある。
  function eventAccount(ev){
    if (ev && ev._acct) return ev._acct;
    return calState.account === "syslea" ? "syslea" : "haruka";
  }
  function colorForEvent(ev){ return ACCOUNT_COLOR[eventAccount(ev)] || ACCOUNT_COLOR.haruka; }

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

  // 曜日クラス（土=sat / 日=sun）。週末だけ地の色を1段変える用。
  function dowClass(dayKey){
    var w = keyWeekday(dayKey);
    return w === 0 ? " sun" : w === 6 ? " sat" : "";
  }

  function renderCalendarView(){
    // 表示中のビューを親に出しておき、CSS 側で「日次だけ幅を絞る」等を切り替える。
    calGridContainer.className = "cal-grid is-" + calState.view;
    if (calState.view === "day") renderDayOrWeek([calState.anchor]);
    else if (calState.view === "week"){
      var s = startOfWeekKey(calState.anchor);
      var keys = []; for (var i = 0; i < 7; i++) keys.push(addDaysKey(s, i));
      renderDayOrWeek(keys);
    } else renderMonth();
  }

  // 予定チップ＝詳細ポップオーバー、レイヤーチップ＝そのデータの画面へ移動。
  // 日次/週次/月次で共通なので1本にまとめてある。
  function wireCalChipClicks(){
    calGridContainer.querySelectorAll("[data-event-id]").forEach(function(el){
      el.addEventListener("click", function(e){
        e.stopPropagation();
        openEventPopover(el.getAttribute("data-event-id"), el);
      });
    });
    calGridContainer.querySelectorAll("[data-ov-view]").forEach(function(el){
      el.addEventListener("click", function(e){
        e.stopPropagation();
        showView(el.getAttribute("data-ov-view"));
      });
    });
  }

  function renderDayOrWeek(dayKeys){
    var isWeek = dayKeys.length > 1;
    var todayKey = jstDateKey(new Date());
    var html = "";

    if (isWeek){
      html += '<div class="cal-week-headers"><div style="width:46px;flex:none;"></div><div style="flex:1;display:grid;grid-template-columns:repeat(' + dayKeys.length + ',1fr);">';
      dayKeys.forEach(function(k){
        var today = k === todayKey;
        html += '<div class="cal-col-header' + dowClass(k) + (today ? ' today' : '') + '">' + escapeHtml(formatColHeader(k)) + '</div>';
      });
      html += '</div></div>';
    }

    // 終日イベントもレイヤーも無い週/日では帯ごと出さない（空の帯が縦を無駄に食っていた）。
    var hasAllDay = dayKeys.some(function(k){
      return classifyEvents(k).allDay.length > 0 || overlaysAllDay(k).length > 0;
    });
    if (hasAllDay){
      html += '<div class="cal-allday-row"><div class="cal-allday-gutter">終日</div><div class="cal-allday-cols" style="grid-template-columns:repeat(' + dayKeys.length + ',1fr);">';
      dayKeys.forEach(function(k){
        var cls = classifyEvents(k);
        html += '<div>';
        cls.allDay.forEach(function(ev){
          html += '<div class="cal-allday-chip" tabindex="0" data-event-id="' + escapeHtml(ev.id) + '" style="--ev-color:' + colorForEvent(ev) + ';">'
            + escapeHtml(ev.summary || "(タイトルなし)") + '</div>';
        });
        overlaysAllDay(k).forEach(function(o){ html += overlayChipHtml(o); });
        html += '</div>';
      });
      html += '</div></div>';
    }

    html += '<div class="cal-timeline-scroll" id="cal-timeline-scroll"><div class="cal-timeline" style="height:' + (24*HOUR_PX) + 'px;">';
    html += '<div class="cal-hour-gutter">';
    for (var h = 0; h < 24; h++){ html += '<div class="cal-hour-label" style="top:' + (h*HOUR_PX) + 'px;">' + String(h).padStart(2,"0") + ':00</div>'; }
    html += '</div>';
    html += '<div class="cal-day-cols" style="grid-template-columns:repeat(' + dayKeys.length + ',1fr); height:' + (24*HOUR_PX) + 'px;">';
    dayKeys.forEach(function(k){
      html += '<div class="cal-day-col' + dowClass(k) + '" data-day-key="' + k + '">';
      for (var h2 = 0; h2 < 24; h2++){ html += '<div class="cal-hour-line" style="top:' + (h2*HOUR_PX) + 'px;"></div>'; }
      if (k === todayKey){
        var nowMin = minutesInDay(new Date().toISOString(), k);
        html += '<div class="cal-now-line" style="top:' + (nowMin/60*HOUR_PX) + 'px;"></div>';
      }
      var cls2 = classifyEvents(k);
      var laid = layoutTimed(cls2.timed, k);
      laid.forEach(function(item){
        var top = item.startMin/60*HOUR_PX;
        var height = Math.max(18, (item.endMin-item.startMin)/60*HOUR_PX);
        var widthPct = 100/item.colCount;
        var leftPct = item.col*widthPct;
        var acctName = calState.account === "both" ? " ・" + ACCOUNTS[eventAccount(item.ev)].label : "";
        var fullLabel = fmtEventTime(item.ev.start) + " " + (item.ev.summary || "(タイトルなし)") + acctName;
        html += '<div class="cal-event-block" tabindex="0" data-event-id="' + escapeHtml(item.ev.id) + '" title="' + escapeHtml(fullLabel) + '" style="top:' + top + 'px;height:' + height + 'px;left:calc(' + leftPct + '% + 2px);width:calc(' + widthPct + '% - 4px);--ev-color:' + colorForEvent(item.ev) + ';">'
          + '<span class="t">' + escapeHtml(fmtEventTime(item.ev.start)) + '</span>' + escapeHtml(item.ev.summary || "(タイトルなし)") + '</div>';
      });
      // 時刻つきのレイヤー（＝期限時刻を入れたタスク）は時間軸の右端に細く重ねる。
      overlaysTimed(k).forEach(function(o){
        var parts = o.time.split(":");
        var top = (Number(parts[0]) * 60 + Number(parts[1])) / 60 * HOUR_PX;
        html += overlayChipHtml(o, "is-timed", "top:" + top + "px;");
      });
      html += '</div>';
    });
    html += '</div></div></div>';

    calGridContainer.innerHTML = html;

    calGridContainer.querySelectorAll(".cal-day-col").forEach(function(col){
      col.addEventListener("click", function(e){
        if (e.target.closest("[data-event-id],[data-ov-view]")) return;
        var rect = col.getBoundingClientRect();
        var offsetY = e.clientY - rect.top;
        var minutes = Math.round(offsetY / HOUR_PX * 60 / 15) * 15;
        minutes = Math.max(0, Math.min(1425, minutes));
        openCreateForm(col.getAttribute("data-day-key"), minutes);
      });
    });
    wireCalChipClicks();

    // 表示範囲に今日が含まれるなら現在時刻が上から 1/3 に来る位置へ、
    // 含まれないなら従来どおり 07:00 を先頭に。
    var scrollEl = document.getElementById("cal-timeline-scroll");
    if (scrollEl){
      var target = 7 * HOUR_PX;
      if (dayKeys.indexOf(todayKey) !== -1){
        var nowPx = minutesInDay(new Date().toISOString(), todayKey) / 60 * HOUR_PX;
        target = nowPx - scrollEl.clientHeight / 3;
      }
      scrollEl.scrollTop = Math.max(0, Math.min(24 * HOUR_PX - scrollEl.clientHeight, target));
    }
  }

  // 月グリッドのセルは高さがビューポート追従（1fr）なので、入る件数は固定できない。
  // 描画後に実測して、はみ出すチップだけ隠し「+N件」に畳む。
  function fitMonthChips(){
    var MORE_H = 16; // 「+N件」行の見込み高さ
    calGridContainer.querySelectorAll(".cal-month-cell").forEach(function(cell){
      var chips = Array.prototype.slice.call(cell.querySelectorAll(".cal-month-chip"));
      var more = cell.querySelector(".cal-month-more");
      chips.forEach(function(c){ c.hidden = false; });
      if (more) more.hidden = true;
      if (!chips.length) return;
      var bottom = cell.getBoundingClientRect().bottom - 6; // セル下 padding ぶん
      var shown = chips.length;
      for (var i = 0; i < chips.length; i++){
        var reserve = (i < chips.length - 1) ? MORE_H : 0; // 続きがあるなら +N 行を確保
        if (chips[i].getBoundingClientRect().bottom > bottom - reserve){ shown = i; break; }
      }
      if (shown >= chips.length) return;
      for (var j = shown; j < chips.length; j++) chips[j].hidden = true;
      if (more){ more.hidden = false; more.textContent = "+" + (chips.length - shown) + "件"; }
    });
  }

  var calFitTimer = null;
  window.addEventListener("resize", function(){
    if (calState.view !== "month") return;
    var frame = document.getElementById("view-calendar");
    if (!frame || frame.hidden) return;
    clearTimeout(calFitTimer);
    calFitTimer = setTimeout(fitMonthChips, 150);
  });

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
    DOW_JA.forEach(function(l, i){
      html += '<div class="cal-month-dow' + (i === 0 ? ' sun' : i === 6 ? ' sat' : '') + '">' + l + '</div>';
    });

    keys.forEach(function(dayKey){
      var pk = keyParts(dayKey);
      var outside = pk.m !== p.m;
      var isToday = dayKey === todayKey;
      var cls2 = classifyEvents(dayKey);
      var allItems = cls2.allDay.concat(cls2.timed.slice().sort(function(a,b){
        var ta = a.start.dateTime || "", tb = b.start.dateTime || "";
        return ta < tb ? -1 : ta > tb ? 1 : 0;
      }));
      html += '<div class="cal-month-cell' + dowClass(dayKey) + (outside ? ' outside' : '') + (isToday ? ' today' : '') + '" data-day-key="' + dayKey + '">';
      html += '<div class="cal-month-date">' + pk.d + '</div>';
      // 期限超過だけは予定より前に出す。後ろに置くと、予定で埋まったセルでは
      // fitMonthChips に必ず畳まれて「+N件」の中に消える＝一番見落としたくない
      // ものが見えなくなる（本番の「両方」表示で実際にそうなった）。
      var ovs = overlaysFor(dayKey);
      ovs.filter(function(o){ return o.overdue; }).slice(0, 6)
        .forEach(function(o){ html += overlayChipHtml(o, "cal-month-chip"); });
      // セルの高さはビューポート追従なので、何件出せるかは描画後に実測して決める
      // （下の fitMonthChips）。ここでは全件（上限12）出しておく。
      allItems.slice(0, 12).forEach(function(ev){
        var timePrefix = ev.start.date ? "" : escapeHtml(fmtEventTime(ev.start)) + " ";
        var acctName = calState.account === "both" ? " ・" + ACCOUNTS[eventAccount(ev)].label : "";
        var monthFullLabel = (ev.start.date ? "終日" : fmtEventTime(ev.start)) + " " + (ev.summary || "(タイトルなし)") + acctName;
        html += '<div class="cal-month-chip" data-event-id="' + escapeHtml(ev.id) + '" title="' + escapeHtml(monthFullLabel) + '" style="--ev-color:' + colorForEvent(ev) + ';">'
          + timePrefix + escapeHtml(ev.summary || "(タイトルなし)") + '</div>';
      });
      // 期限内のレイヤーは予定の下に（畳まれても「+N件」で件数は分かる）。
      ovs.filter(function(o){ return !o.overdue; }).slice(0, 12)
        .forEach(function(o){ html += overlayChipHtml(o, "cal-month-chip"); });
      html += '<div class="cal-month-more" hidden></div>';
      html += '</div>';
    });
    html += '</div>';
    calGridContainer.innerHTML = html;
    fitMonthChips();

    calGridContainer.querySelectorAll(".cal-month-cell").forEach(function(cell){
      cell.addEventListener("click", function(e){
        if (e.target.closest("[data-event-id],[data-ov-view]")) return;
        calState.anchor = cell.getAttribute("data-day-key");
        calState.view = "day";
        loadAndRenderCalendar();
      });
    });
    wireCalChipClicks();
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
    // 「両方」表示だと、どちらのカレンダーの予定か分からないと編集/削除が怖い。
    evPopTime.textContent = fmtEventRange(ev)
      + (calState.account === "both" ? "  ・" + (ACCOUNTS[eventAccount(ev)] || ACCOUNTS.haruka).label : "");
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
        await apiFetch(acctPath("/api/google/calendar/events/" + encodeURIComponent(ev.id), eventAccount(ev)), { method: "DELETE" });
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

  var evAcctRow = document.getElementById("ev-acct-row");
  var evAcct = document.getElementById("ev-acct");

  var editingEvent = null;
  var editingEventCalendarId = null;
  var editingEventAccount = null;   // 編集中の予定がどちらのアカウントのものか（「両方」表示用）
  var editingOriginalDescription = null;
  var editingOriginalDescriptionPlain = null;

  // 書き込み先アカウント。編集中はその予定のアカウント、新規は「両方」なら選択値。
  function calWriteAccount(){
    if (editingEvent) return editingEventAccount || "haruka";
    if (calState.account === "both") return (evAcct && evAcct.value) || "haruka";
    return calState.account;
  }

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

  // 「両方」表示のときだけ、どちらのカレンダーに書くかを選ばせる。
  // 編集時は移動できない（PATCH に付け替えの口が無い）ので選択不可にして表示だけする。
  function syncEventAcctRow(){
    if (!evAcctRow || !evAcct) return;
    var both = calState.account === "both";
    evAcctRow.hidden = !both;
    if (!both) return;
    evAcct.value = editingEvent ? (editingEventAccount || "haruka") : (evAcct.value || "haruka");
    evAcct.disabled = !!editingEvent;
  }

  function openCreateForm(dayKey, minutesFromMidnight){
    editingEvent = null;
    editingEventCalendarId = null;
    editingEventAccount = null;
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
    syncEventAcctRow();
    showEventModal();
  }

  function openEditForm(ev){
    editingEvent = ev;
    editingEventAccount = eventAccount(ev);
    editingEventCalendarId = calState.loadedCalendarId || (ACCOUNTS[editingEventAccount] || ACCOUNTS.haruka).calendarId;
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
    syncEventAcctRow();
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
        await apiFetch(acctPath("/api/google/calendar/events/" + encodeURIComponent(editingEvent.id), calWriteAccount()), {
          method: "PATCH", body: JSON.stringify(input)
        });
      } else {
        await apiFetch(acctPath("/api/google/calendar/events", calWriteAccount()), {
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
      await apiFetch(acctPath("/api/google/calendar/events/" + encodeURIComponent(editingEvent.id), calWriteAccount()), { method: "DELETE" });
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
  // 返信・転送の材料。スレッド取得(GET /gmail/threads/:id)のレスポンスから受け取る。
  var currentMailReply = null;    // { to, cc, subject, forwardSubject, inReplyTo, references, ... }
  var currentMailBodyText = "";   // 引用に使う本文
  var currentMailInfo = null;     // 一覧行(from / time / subject)
  var mailStatusBar = document.getElementById("mail-status-bar");
  var homeInboxCountBtn = document.getElementById("home-inbox-count-btn");
  var homeInboxCountNum = document.getElementById("home-inbox-count-num");
  var homeInboxCountLabel = document.getElementById("home-inbox-count-label");
  var homeInboxCountBtnSyslea = document.getElementById("home-inbox-count-btn-syslea");
  var homeInboxCountNumSyslea = document.getElementById("home-inbox-count-num-syslea");
  var homeInboxCountLabelSyslea = document.getElementById("home-inbox-count-label-syslea");
  var homeGoogleConnectBtn = document.getElementById("home-google-connect-btn");
  var homeContractAlertBtn = document.getElementById("home-contract-alert-btn");
  var homeContractAlertNum = document.getElementById("home-contract-alert-num");
  var homeContractAutoBtn = document.getElementById("home-contract-auto-btn");
  var homeContractAutoNum = document.getElementById("home-contract-auto-num");

  /* ---- 契約書トラッカーのアラート判定（HOME の INBOX と app.business.js で共用） ----
     app.business.js は業務タブを開くまでロードされないので、HOME でも要る この3つだけは
     本体側に置き、window.__CP 経由でモジュールへ渡す。判定の実装を2箇所に分けないため。 */
  var CONTRACT_STATUSES = ["依頼受領", "送付済み", "締結済み", "報告済み"];
  // 状態の進行度 = CONTRACT_STATUSES の添字。未知の値は 0(依頼受領)扱い。
  function contractStatusIdx(c){
    var i = CONTRACT_STATUSES.indexOf(c && c.status);
    return i === -1 ? 0 : i;
  }
  // 依頼日があるのに未送付 / 送付から1週間で未締結 / 期限超過、のいずれかをアラートとする。
  function contractAlertLabels(c){
    var today = jstDateKey(new Date());
    var out = [];
    if (c.requestedDate && !c.sentDate) out.push("⚠ 送付待ち");
    if (c.sentDate && !c.signedDate && addDaysKey(c.sentDate, 7) < today) out.push("⚠ 締結遅延");
    if (c.dueDate && c.dueDate < today && contractStatusIdx(c) < 2) out.push("⚠ 期限超過");
    return out;
  }

  // from-digest が status を自動で進めた行かどうか（バックが付ける印）。
  // 「確認済みにする」を押すまで立ったままなので、見逃さない。
  function contractAutoAdvanced(c){
    return !!(c && Number(c.autoAdvancedAt) > 0);
  }

  // HOME の INBOX に出す契約書アラート件数／自動更新の件数。0 件なら行ごと隠す。
  var homeContractAlerts = 0;
  var homeContractAutos = 0;
  function renderHomeContractAlert(){
    if (homeContractAlertBtn){
      homeContractAlertBtn.hidden = homeContractAlerts <= 0;
      if (homeContractAlertNum) homeContractAlertNum.textContent = String(homeContractAlerts);
    }
    if (homeContractAutoBtn){
      homeContractAutoBtn.hidden = homeContractAutos <= 0;
      if (homeContractAutoNum) homeContractAutoNum.textContent = String(homeContractAutos);
    }
  }
  function applyHomeContractAlerts(list){
    if (!Array.isArray(list)) return;
    homeContractAlerts = list.filter(function(c){ return contractAlertLabels(c).length > 0; }).length;
    homeContractAutos = list.filter(contractAutoAdvanced).length;
    renderHomeContractAlert();
  }
  if (homeContractAlertBtn) homeContractAlertBtn.addEventListener("click", function(){
    contractsPendingTab = "alert";
    showView("contracts");
  });
  // 自動更新はステータス横断（報告済みまで進んだ行も含む）なので「すべて」タブで開く。
  // 一覧ページ側は自動更新の行を完了の折りたたみから除外しているので必ず見える。
  if (homeContractAutoBtn) homeContractAutoBtn.addEventListener("click", function(){
    contractsPendingTab = "";
    showView("contracts");
  });

  /* ---- HOME の INBOX に出す「期限切れタスク」行 ----
     タスク管理タブを開かないと期限切れに気づけなかったため。件数は tasksState から
     直に数えるので、タスクを触った瞬間に HOME 側も正しくなる（再取得なし）。 */
  var homeTaskOverdueBtn = document.getElementById("home-task-overdue-btn");
  var homeTaskOverdueNum = document.getElementById("home-task-overdue-num");
  var homeTaskOverdueAcct = document.getElementById("home-task-overdue-acct");
  function renderHomeTaskOverdue(){
    if (!homeTaskOverdueBtn) return;
    var todayKey = jstDateKey(new Date());
    var over = tasksState.filter(function(t){
      return !t.done && t.due && t.due < todayKey;
    });
    homeTaskOverdueBtn.hidden = over.length === 0;
    if (homeTaskOverdueNum) homeTaskOverdueNum.textContent = String(over.length);
    if (homeTaskOverdueAcct){
      // 全部が同じアカウントならその名前、混在なら「両方」
      var tags = {};
      over.forEach(function(t){ tags[t.tag || "haruka"] = 1; });
      var keys = Object.keys(tags);
      homeTaskOverdueAcct.textContent = keys.length === 1 ? (TASK_TAG_LABEL[keys[0]] || keys[0]) : "両方";
    }
  }
  if (homeTaskOverdueBtn) homeTaskOverdueBtn.addEventListener("click", function(){
    taskView = "overdue";
    taskStatusTab = "pending";
    showView("tasks");
    if (tasksInitialized) renderTasks();
  });

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
  // /api/google/status の accounts をそのまま保持。HOME INBOX の「再連携」ボタンを
  // 「本当に再連携が要るときだけ」出す判定に使う(未取得なら null)。
  var googleAcctStatus = null;

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
    googleAcctStatus = accounts;
    if (typeof renderHomeInbox === "function") renderHomeInbox();
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
    currentMailReply = null;
    currentMailBodyText = "";
    currentMailInfo = mail;
    if (mailActionsEl){
      mailActionsEl.hidden = !mail.threadId;   // 仮データ(threadId無し)には操作を出さない
      mailActionsEl.querySelectorAll(".mail-act-btn").forEach(function(b){ b.disabled = false; });
      // 返信系は reply メタ(宛先・In-Reply-To)が届くまで押させない
      setMailReplyEnabled(false);
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
        currentMailBodyText = res.body || "";
        currentMailReply = res.reply || null;
        setMailReplyEnabled(!!currentMailReply);
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
    mailActionsEl.querySelectorAll(".mail-act-btn[data-mail-action]").forEach(function(btn){
      btn.addEventListener("click", function(){ runMailAction(btn.getAttribute("data-mail-action")); });
    });
  }

  /* ---- メール → タスク化 ----
     件名をタスク名、Gmail の permalink を URL 欄に入れてタスクモーダルを開く。
     即保存はしない（期限や優先度を入れてから保存できるように）。
     アカウント枠 = そのままタグに使う（SYSLEA のメール → SYSLEA タスク）。 */
  var mailToTaskBtn = document.getElementById("mail-to-task-btn");
  // authuser にアドレスを渡すと、ブラウザに複数の Google アカウントがログインしていても
  // 正しい方の Gmail が開く（/u/0 固定だと SYSLEA 側で別人の受信箱が開いてしまう）。
  function gmailThreadUrl(threadId, selfAddress){
    if (!threadId) return "";
    var base = "https://mail.google.com/mail/";
    if (selfAddress) base += "?authuser=" + encodeURIComponent(selfAddress);
    return base + "#all/" + encodeURIComponent(threadId);
  }
  if (mailToTaskBtn) mailToTaskBtn.addEventListener("click", function(){
    if (!currentMailInfo) return;
    var subject = (currentMailInfo.subject || "").trim() || "(件名なし)";
    var self = (currentMailReply && currentMailReply.self) || "";
    var url = gmailThreadUrl(currentMailThread, self);
    var from = (currentMailInfo.from || currentMailInfo.name || "").trim();

    // タスク側が未初期化だと openNewTask が空の tasksState を触るので先に読み込む
    if (!tasksInitialized){ tasksInitialized = true; initTasks(); }

    closeMailModal();
    openNewTask(mailState.account === "syslea" ? "syslea" : "haruka");
    taskTitleInput.value = subject.slice(0, 200);
    taskUrlInput.value = url;
    if (from) taskRemarksInput.value = "差出人: " + from;
    taskTitleInput.focus();
    taskTitleInput.select();
  });

  /* ================= メール作成(新規 / 返信 / 全員に返信 / 転送) =================
     送信は POST /api/google/gmail/send。必要スコープは users.messages.send の
     許可スコープに含まれる gmail.modify で足りるので、既存のトークンのまま送れる
     (再連携・GCP 同意画面の変更は不要)。本文はプレーンテキストのみ。
     宛先・件名・In-Reply-To/References はバックエンドがスレッドから導出したものを使う。 */
  var mailComposeModal = document.getElementById("mail-compose-modal");
  var mailComposeForm = document.getElementById("mail-compose-form");
  var mailComposeTitle = document.getElementById("mail-compose-title");
  var mailComposeFrom = document.getElementById("mail-compose-from");
  var mailComposeTo = document.getElementById("mail-compose-to");
  var mailComposeCc = document.getElementById("mail-compose-cc");
  var mailComposeBcc = document.getElementById("mail-compose-bcc");
  var mailComposeSubject = document.getElementById("mail-compose-subject");
  var mailComposeBody = document.getElementById("mail-compose-body");
  var mailComposeError = document.getElementById("mail-compose-error");
  var mailComposeSend = document.getElementById("mail-compose-send");
  var mailComposeDraft = document.getElementById("mail-compose-draft");
  var mailReplyBtn = document.getElementById("mail-reply-btn");
  var mailReplyAllBtn = document.getElementById("mail-reply-all-btn");
  var mailForwardBtn = document.getElementById("mail-forward-btn");
  // 送信中の付随情報(スレッドにぶら下げるための threadId と返信ヘッダ)
  var composeCtx = { threadId: "", inReplyTo: "", references: "", account: "haruka" };

  var MAIL_ACCOUNT_LABEL = { haruka: "はるか（個人）", syslea: "SYSLEA" };

  function setMailReplyEnabled(on){
    [mailReplyBtn, mailReplyAllBtn, mailForwardBtn].forEach(function(b){
      if (b) b.disabled = !on;
    });
  }

  function mailComposeSetError(msg){
    if (!mailComposeError) return;
    mailComposeError.textContent = msg || "";
    mailComposeError.hidden = !msg;
  }

  // 引用ブロック。Gmail と同じく "> " 前置き。
  function mailQuote(text){
    return String(text || "")
      .split(/\r?\n/)
      .map(function(line){ return "> " + line; })
      .join("\n");
  }

  function mailQuoteIntro(meta, mail){
    var who = (meta && meta.originalFrom) || (mail && mail.from) || "";
    var when = (mail && mail.time) || (meta && meta.originalDate) || "";
    if (!who && !when) return "";
    return (when ? when + " " : "") + who + " のメール:";
  }

  function openMailCompose(mode){
    if (!mailComposeModal) return;
    var meta = currentMailReply;
    var mail = currentMailInfo;
    composeCtx = { threadId: "", inReplyTo: "", references: "", account: mailState.account };

    if (mode === "reply" || mode === "replyAll"){
      if (!meta) return;
      mailComposeTitle.textContent = mode === "replyAll" ? "全員に返信" : "返信";
      mailComposeTo.value = meta.to || "";
      mailComposeCc.value = mode === "replyAll" ? (meta.cc || "") : "";
      mailComposeSubject.value = meta.subject || "";
      mailComposeBody.value = "\n\n" + mailQuoteIntro(meta, mail) + "\n" + mailQuote(currentMailBodyText);
      // 同じスレッドにぶら下げる(Gmail 上でも会話が分かれない)
      composeCtx.threadId = currentMailThread || "";
      composeCtx.inReplyTo = meta.inReplyTo || "";
      composeCtx.references = meta.references || "";
    } else if (mode === "forward"){
      if (!meta) return;
      mailComposeTitle.textContent = "転送";
      mailComposeTo.value = "";
      mailComposeCc.value = "";
      mailComposeSubject.value = meta.forwardSubject || "";
      mailComposeBody.value =
        "\n\n---------- 転送メッセージ ----------\n" +
        "From: " + (meta.originalFrom || "") + "\n" +
        "Date: " + (meta.originalDate || (mail && mail.time) || "") + "\n" +
        "Subject: " + (meta.originalSubject || "") + "\n" +
        "To: " + (meta.originalTo || "") + "\n\n" +
        currentMailBodyText;
      // 転送は元スレッドにぶら下げない(別の会話として送る)
    } else {
      mailComposeTitle.textContent = "新規メール";
      mailComposeTo.value = "";
      mailComposeCc.value = "";
      mailComposeSubject.value = "";
      mailComposeBody.value = "";
    }
    mailComposeBcc.value = "";
    mailComposeSetError("");
    mailComposeFrom.innerHTML =
      "差出人: <b>" + escapeHtml(MAIL_ACCOUNT_LABEL[composeCtx.account] || composeCtx.account) + "</b> のアカウントから送信します";
    mailComposeSend.disabled = false;
    if (mailComposeDraft) mailComposeDraft.disabled = false;

    mailComposeModal.hidden = false;
    document.body.style.overflow = "hidden";
    // 返信は本文にすぐ書き始めたい / 新規は宛先から。
    // focus() だけだと引用の長い本文で textarea もフォームも末尾までスクロールした状態で
    // 開いてしまい、宛先欄と書き始めの位置が見えないので、両方を先頭に戻す。
    var focusEl = (mode === "new" || mode === "forward") ? mailComposeTo : mailComposeBody;
    setTimeout(function(){
      focusEl.focus();
      if (focusEl === mailComposeBody){
        mailComposeBody.setSelectionRange(0, 0);
        mailComposeBody.scrollTop = 0;
      }
      mailComposeForm.scrollTop = 0;
    }, 30);
  }

  function closeMailCompose(){
    if (!mailComposeModal) return;
    mailComposeModal.hidden = true;
    // 詳細モーダルが開いたままなら body のスクロール止めは維持する
    if (mailModal && mailModal.hidden) document.body.style.overflow = "";
  }

  function mailComposePayload(){
    return {
      to: mailComposeTo.value.trim(),
      cc: mailComposeCc.value.trim(),
      bcc: mailComposeBcc.value.trim(),
      subject: mailComposeSubject.value.trim(),
      body: mailComposeBody.value,
      threadId: composeCtx.threadId,
      inReplyTo: composeCtx.inReplyTo,
      references: composeCtx.references
    };
  }

  async function submitMailCompose(){
    var payload = mailComposePayload();
    if (!payload.to){
      mailComposeSetError("宛先(To)を入力してください。");
      mailComposeTo.focus();
      return;
    }
    // 送信は取り消せないので、宛先と件名を確認してから送る
    var confirmMsg =
      "このメールを送信します。\n\n" +
      "差出人: " + (MAIL_ACCOUNT_LABEL[composeCtx.account] || composeCtx.account) + "\n" +
      "宛先: " + payload.to + (payload.cc ? "\nCc: " + payload.cc : "") + (payload.bcc ? "\nBcc: " + payload.bcc : "") + "\n" +
      "件名: " + (payload.subject || "(件名なし)");
    if (!window.confirm(confirmMsg)) return;

    mailComposeSetError("");
    mailComposeSend.disabled = true;
    if (mailComposeDraft) mailComposeDraft.disabled = true;
    try{
      await apiFetch(acctPath("/api/google/gmail/send", composeCtx.account), {
        method: "POST",
        body: JSON.stringify(payload)
      });
      closeMailCompose();
      if (mailActMsg) mailActMsg.textContent = "送信しました。";
      // 返信でスレッドが伸びるので一覧を取り直す
      fetchMailPage();
    } catch(err){
      mailComposeSetError(apiErrorMessage(err, "Gmail") || "送信に失敗しました。");
      mailComposeSend.disabled = false;
      if (mailComposeDraft) mailComposeDraft.disabled = false;
    }
  }

  async function saveMailDraft(){
    mailComposeSetError("");
    mailComposeSend.disabled = true;
    mailComposeDraft.disabled = true;
    try{
      await apiFetch(acctPath("/api/google/gmail/drafts", composeCtx.account), {
        method: "POST",
        body: JSON.stringify(mailComposePayload())
      });
      closeMailCompose();
      if (mailActMsg) mailActMsg.textContent = "下書きに保存しました。";
    } catch(err){
      mailComposeSetError(apiErrorMessage(err, "Gmail") || "下書きの保存に失敗しました。");
    }
    mailComposeSend.disabled = false;
    mailComposeDraft.disabled = false;
  }

  if (mailComposeForm){
    mailComposeForm.addEventListener("submit", function(e){ e.preventDefault(); submitMailCompose(); });
    document.getElementById("mail-compose-close").addEventListener("click", closeMailCompose);
    document.getElementById("mail-compose-cancel").addEventListener("click", closeMailCompose);
    mailComposeDraft.addEventListener("click", saveMailDraft);
    mailComposeModal.addEventListener("click", function(e){ if (e.target === mailComposeModal) closeMailCompose(); });
    // Ctrl/Cmd + Enter で送信(本文に入ったまま送れるように)
    mailComposeBody.addEventListener("keydown", function(e){
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter"){ e.preventDefault(); submitMailCompose(); }
    });
  }
  if (mailReplyBtn) mailReplyBtn.addEventListener("click", function(){ openMailCompose("reply"); });
  if (mailReplyAllBtn) mailReplyAllBtn.addEventListener("click", function(){ openMailCompose("replyAll"); });
  if (mailForwardBtn) mailForwardBtn.addEventListener("click", function(){ openMailCompose("forward"); });
  var mailComposeNewBtn = document.getElementById("mail-compose-new");
  if (mailComposeNewBtn) mailComposeNewBtn.addEventListener("click", function(){ openMailCompose("new"); });

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
    // 2026/09/13 に 01.payment のラベル構成を変更（01.銀行振込/02.口座振替/03.UPSIDER/04.変更通知/05.対象外、
    // 済_YYYY/MM 廃止）。この機能は旧構成（スレッド単位で親ラベルを外す）前提なので入口を閉じる。
    // ラベル付けは請求書管理（台帳の method からメール1通単位）へ移行し、ここは撤去予定。
    return false;
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
    // 再連携ボタンは「実際に再連携が要るとき」だけ出す(どちらかの枠が未連携 or 失効、
    // または未読取得が google_not_connected)。期限が近いだけの警告は上部の reauth
    // バナーが担当。両枠とも連携中で有効なら出さない(以前は常時表示でエラーに見えた)。
    var needReconnect =
      (harukaUnreadError && harukaUnreadError.code === "google_not_connected") ||
      (sysleaUnreadError && sysleaUnreadError.code === "google_not_connected");
    if (googleAcctStatus){
      Object.keys(googleAcctStatus).forEach(function(a){
        var s = googleAcctStatus[a] || {};
        if (!s.connected) needReconnect = true;
        else if (s.expiresAt && s.expiresAt <= Date.now()) needReconnect = true;
      });
    }
    homeGoogleConnectBtn.hidden = !(needReconnect || googleConnecting);
    if (!googleConnecting){
      var everConnected = googleAcctStatus
        ? Object.keys(googleAcctStatus).some(function(a){ return (googleAcctStatus[a] || {}).connected; })
        : !(harukaUnreadError && harukaUnreadError.code === "google_not_connected");
      homeGoogleConnectBtn.textContent = everConnected ? "Google再連携" : "Googleサービスと連携する";
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
    if (task.repeat === "yearly"){
      // 同じ月日の翌年。2/29 は翌年が平年なら 2/28 に丸める(monthly と同じ考え方)。
      var q = keyParts(fromKey);
      var ny = q.y + 1;
      var nLast = new Date(Date.UTC(ny, q.m, 0)).getUTCDate();
      return ny + "-" + String(q.m).padStart(2, "0") + "-" + String(Math.min(q.d, nLast)).padStart(2, "0");
    }
    return null;
  }

  /* ---- タスクの優先度 ---- */
  // 色は意味色のみ（高=err / 中=warn / 低=ニュートラル）。アクセントは増やさない。
  var TASK_PRIO_LABEL = { high: "高", mid: "中", low: "低" };
  // 並べ替え用の重み。未設定は「中の下」= 1.5 相当に置いて、
  // 「高」より下・「低」より上になるようにする(未設定を最下位に落とさない)。
  var TASK_PRIO_RANK = { high: 3, mid: 2, low: 1 };
  function taskPrioRank(t){
    var p = t && t.priority;
    return TASK_PRIO_RANK[p] !== undefined ? TASK_PRIO_RANK[p] : 1.5;
  }

  // 期限の相対表示。サブスクの「あとN日」と同じ語彙。
  // 返り値は { text, cls } で cls は "" | "soon" | "over"。
  function dueRelLabel(dueKey, todayKey){
    if (!dueKey) return null;
    var d = diffDaysKey(todayKey, dueKey);
    if (d === null) return null;
    if (d < 0) return { text: (-d) + "日超過", cls: "over" };
    if (d === 0) return { text: "今日", cls: "soon" };
    if (d === 1) return { text: "明日", cls: "soon" };
    if (d <= 7) return { text: "あと" + d + "日", cls: "soon" };
    return { text: "あと" + d + "日", cls: "" };
  }
  // 2つの日付キー(YYYY-MM-DD)の日数差 = to - from。不正なら null。
  function diffDaysKey(fromKey, toKey){
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromKey || "") || !/^\d{4}-\d{2}-\d{2}$/.test(toKey || "")) return null;
    var a = Date.UTC(+fromKey.slice(0, 4), +fromKey.slice(5, 7) - 1, +fromKey.slice(8, 10));
    var b = Date.UTC(+toKey.slice(0, 4), +toKey.slice(5, 7) - 1, +toKey.slice(8, 10));
    return Math.round((b - a) / 86400000);
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
  var taskFilterTag = "all";      // アカウント(all/haruka/syslea) — 上部タブ
  var taskTagFilter = "";         // 自由タグでの絞り込み("" = なし) — サイドバー
  var taskStatusTab = "pending";  // "pending" | "done" — メイン上部タブ
  var taskView = "all";           // "all" | "today" | "week" | "overdue" — サイドバー
  var taskProjectFilter = "";     // "" | "__none" | <projectId> — サイドバー
  var taskSearchQuery = "";       // ツールバーの検索窓（本文・備考・タグ・プロジェクト名を横断）
  var taskSortMode = "due";       // "due"(期限順＝グループ表示) | "prio" | "created" | "title"
  var taskGroupCollapsed = {};    // 期限グループの折りたたみ状態 key -> true
  var projectsForLink = [];       // [{ id, name, archived }] — タスク⇔プロジェクト用に独立ロード
  var projectsLoaded = false;
  var editingTaskId = null; // null = creating a new task
  var taskFormTag = "haruka";

  // event_trackers(プロジェクトボード)を、ビジネスタブのカード描画とは独立に一覧取得する。
  // タスクモーダルの「プロジェクト」セレクトとサイドバーの「プロジェクト」一覧で使う。
  async function ensureProjectsLoaded(force){
    if (projectsLoaded && !force) return projectsForLink;
    try {
      var res = await apiFetch("/api/event-trackers");
      projectsForLink = (res && res.eventTrackers || []).map(function(t){
        return { id: t.id, name: t.name || "(無題)", archived: !!t.archived };
      });
      projectsLoaded = true;
    } catch(e){ /* 取れなければ前回値のまま */ }
    return projectsForLink;
  }
  function projectName(id){
    if (!id) return "";
    var p = projectsForLink.filter(function(x){ return x.id === id; })[0];
    if (p) return p.name;
    var trackers = (window.__CP && window.__CP.getEventTrackers) ? window.__CP.getEventTrackers() : [];
    var e = trackers.filter(function(x){ return x.id === id; })[0];
    return e ? (e.name || "(無題)") : "";
  }
  // サイドバー「ビュー」の判定。view 明示。due 無しは "all" のときだけ含める。
  function taskViewMatch(task, todayKey, view){
    if (view === "all") return true;
    if (!task.due) return false;
    if (view === "today") return task.due === todayKey;
    if (view === "overdue") return task.due < todayKey && !task.done;
    if (view === "week") return task.due >= todayKey && task.due < addDaysKey(todayKey, 7);
    return true;
  }

  // ツールバー検索。空なら素通し。本文・備考・自由タグ・プロジェクト名を横断して
  // 空白区切りの AND で見る（メモ側の全文検索と同じ感覚で使えるように）。
  function taskSearchMatch(task){
    var q = taskSearchQuery.trim().toLowerCase();
    if (!q) return true;
    var hay = [
      task.text || "",
      task.remarks || "",
      (task.tags || []).join(" "),
      projectName(task.projectId)
    ].join(" ").toLowerCase();
    return q.split(/\s+/).every(function(w){ return hay.indexOf(w) !== -1; });
  }

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
  // サイドバー(ビュー / プロジェクト / タグ)を描く。件数は「現在のアカウントタブ＋
  // 未完了/完了タブ」を通した集合に対して数える(＝その項目を選んだら何件出るか)。
  function taskSideItem(listEl, label, count, active, onClick){
    var li = document.createElement("li");
    li.className = "task-side-item" + (active ? " is-active" : "");
    var lab = document.createElement("span");
    lab.className = "task-side-label"; lab.textContent = label; lab.title = label;
    var cnt = document.createElement("span");
    cnt.className = "task-side-count"; cnt.textContent = count;
    li.appendChild(lab); li.appendChild(cnt);
    li.addEventListener("click", onClick);
    listEl.appendChild(li);
  }
  function renderTaskSidebar(){
    var todayKey = jstDateKey(new Date());
    var base = tasksState.filter(function(t){
      if (taskFilterTag !== "all" && t.tag !== taskFilterTag) return false;
      return (taskStatusTab === "done") ? !!t.done : !t.done;
    });

    var vEl = document.getElementById("task-side-views");
    if (vEl){
      vEl.innerHTML = "";
      [["all", "すべて"], ["today", "今日"], ["week", "今週"], ["overdue", "期限切れ"]].forEach(function(p){
        var n = base.filter(function(t){ return taskViewMatch(t, todayKey, p[0]); }).length;
        taskSideItem(vEl, p[1], n, taskView === p[0], function(){ taskView = p[0]; renderTasks(); });
      });
    }

    var pEl = document.getElementById("task-side-projects");
    if (pEl){
      pEl.innerHTML = "";
      taskSideItem(pEl, "すべて", base.length, taskProjectFilter === "", function(){ taskProjectFilter = ""; renderTasks(); });
      taskSideItem(pEl, "（プロジェクトなし）", base.filter(function(t){ return !t.projectId; }).length,
        taskProjectFilter === "__none", function(){ taskProjectFilter = "__none"; renderTasks(); });
      projectsForLink.filter(function(p){ return !p.archived; }).forEach(function(p){
        var n = base.filter(function(t){ return t.projectId === p.id; }).length;
        taskSideItem(pEl, p.name, n, taskProjectFilter === p.id, function(){ taskProjectFilter = p.id; renderTasks(); });
      });
      // 絞り込み中のプロジェクトが一覧に無い(アーカイブ等)なら選択を解除
      if (taskProjectFilter && taskProjectFilter !== "__none" &&
          !projectsForLink.some(function(p){ return p.id === taskProjectFilter && !p.archived; })) {
        taskProjectFilter = "";
      }
    }

    var tEl = document.getElementById("task-side-tags");
    var tGroup = document.getElementById("task-side-tags-group");
    if (tEl){
      var all = {};
      base.forEach(function(t){ (t.tags || []).forEach(function(x){ if (x) all[x] = (all[x] || 0) + 1; }); });
      var keys = Object.keys(all).sort(function(a, b){ return a.localeCompare(b, "ja"); });
      if (taskTagFilter && keys.indexOf(taskTagFilter) === -1) taskTagFilter = "";
      tEl.innerHTML = "";
      if (tGroup) tGroup.hidden = !keys.length;
      if (keys.length){
        taskSideItem(tEl, "すべて", base.length, taskTagFilter === "", function(){ taskTagFilter = ""; renderTasks(); });
        keys.forEach(function(k){
          taskSideItem(tEl, k, all[k], taskTagFilter === k, function(){
            taskTagFilter = (taskTagFilter === k) ? "" : k; renderTasks();
          });
        });
      }
    }
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
    tasksStatusBar.className = "cal-status-chip" + (cls ? " " + cls : "");
  }

  async function initTasks(){
    setTasksStatus("読み込み中…");
    try{
      var res = await apiFetch("/api/tasks");
      tasksState = res.tasks || [];
      tasksLoadOk = true;
      setTasksStatus("ポータルに保存済み");
    } catch(err){
      tasksState = [];
      setTasksStatus(apiErrorMessage(err, "タスク"), "err");
    }
    tasksLoadDone = true;
    renderTasks();
    // プロジェクト一覧(サイドバー・モーダルのセレクト用)を裏で用意しておく
    ensureProjectsLoaded().then(function(){ renderTaskSidebar(); });
  }

  function buildTaskRow(task, todayKey, depth){
    var li = document.createElement("li");
    li.className = "task-item" + (task.done ? " done" : "") + (taskExpandedIds[task.id] ? " expanded" : "")
      + (depth ? " is-child" : "")
      + (task.priority ? " prio-" + task.priority : "")
      + (task.id === taskCursorId ? " is-cursor" : "");
    li.setAttribute("data-task-id", task.id);
    var kids = depth ? [] : tasksState.filter(function(t){ return t.parentId === task.id; });

    var row = document.createElement("div");
    row.className = "task-row";

    var check = document.createElement("button");
    check.type = "button";
    check.className = "task-check";
    check.setAttribute("aria-label", task.done ? "未完了に戻す" : "完了にする");
    check.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M4 12l6 6L20 6"/></svg>';
    check.addEventListener("click", function(e){
      e.stopPropagation();
      toggleTaskDone(task, todayKey);
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
    if (kids.length){
      var kc = document.createElement("span");
      kc.className = "task-kid-count";
      kc.textContent = "子 " + kids.filter(function(k){ return k.done; }).length + "/" + kids.length;
      row.appendChild(kc);
    }
    if (task.due){
      var due = document.createElement("span");
      due.className = "task-due";
      due.setAttribute("data-overdue", String(!task.done && task.due < todayKey));
      due.textContent = task.due.slice(5).replace("-", "/") + (task.dueTime ? " " + task.dueTime : "");
      row.appendChild(due);
      // 相対表示（サブスクの「あとN日」と同じ語彙）。完了済みには出さない。
      var rel = task.done ? null : dueRelLabel(task.due, todayKey);
      if (rel){
        var relEl = document.createElement("span");
        relEl.className = "task-due-rel" + (rel.cls ? " is-" + rel.cls : "");
        relEl.textContent = rel.text;
        row.appendChild(relEl);
      }
    }
    // プロジェクト名のチップ。すでにそのプロジェクトで絞り込んでいるときは冗長なので出さない。
    if (task.projectId && taskProjectFilter !== task.projectId){
      var pn = projectName(task.projectId);
      if (pn){
        var pc = document.createElement("span");
        pc.className = "task-project-chip";
        pc.textContent = pn;
        pc.title = "プロジェクト：" + pn;
        row.appendChild(pc);
      }
    }
    if (task.priority){
      var prio = document.createElement("span");
      prio.className = "task-prio-badge is-" + task.priority;
      prio.textContent = TASK_PRIO_LABEL[task.priority] || "";
      prio.title = "優先度：" + (TASK_PRIO_LABEL[task.priority] || "");
      row.appendChild(prio);
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
    if (task.projectId){
      var pj = document.createElement("div");
      pj.className = "task-remarks";
      pj.textContent = "プロジェクト: " + (projectName(task.projectId) || "（不明）");
      detail.appendChild(pj);
    }
    if (depth && task.parentId){
      var par = tasksState.filter(function(t){ return t.id === task.parentId; })[0];
      var ph = document.createElement("div");
      ph.className = "task-remarks";
      ph.textContent = "親: " + ((par && par.text) || "（不明）");
      detail.appendChild(ph);
    }
    var btnRow = document.createElement("div");
    btnRow.className = "task-detail-btns";
    var editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "task-edit-btn";
    editBtn.textContent = "編集";
    editBtn.addEventListener("click", function(e){ e.stopPropagation(); openEditTask(task); });
    btnRow.appendChild(editBtn);
    if (!depth){
      var subBtn = document.createElement("button");
      subBtn.type = "button";
      subBtn.className = "task-subtask-btn";
      subBtn.textContent = "＋ サブタスク";
      subBtn.addEventListener("click", function(e){ e.stopPropagation(); openNewTask(task.tag, task.id); });
      btnRow.appendChild(subBtn);
    }
    detail.appendChild(btnRow);

    li.appendChild(row); li.appendChild(detail);
    return li;
  }

  // ビジネス(SYSLEA)＋プライベート(はるか)の両ダッシュボードのタスクカードを更新
  function renderTaskCards(){
    renderMiniTasks("biz-task-list", "syslea");
    renderMiniTasks("pv-task-list", "haruka");
    renderHomeTaskOverdue(); // HOME の INBOX の「期限切れ」行も同じタイミングで
  }

  function renderTasks(){
    renderTaskCards(); // ダッシュボードの「最近のタスク」ミニリストも同時に更新
    renderTaskSidebar();
    // 事務ハック画面の計画リストも同期する(モジュール未ロードなら何もしない)
    if (window.__CP && typeof window.__CP.onTasksChanged === "function") window.__CP.onTasksChanged();
    var todayKey = jstDateKey(new Date());

    // 未完了/完了タブの件数(アカウントタブ通過後)
    var acctSet = tasksState.filter(function(t){ return taskFilterTag === "all" || t.tag === taskFilterTag; });
    var cp = document.getElementById("task-count-pending");
    var cd = document.getElementById("task-count-done");
    if (cp) cp.textContent = acctSet.filter(function(t){ return !t.done; }).length;
    if (cd) cd.textContent = acctSet.filter(function(t){ return t.done; }).length;
    document.querySelectorAll("#task-status-tabs .task-status-tab").forEach(function(b){
      b.classList.toggle("is-active", b.getAttribute("data-status") === taskStatusTab);
    });

    var matched = tasksState.filter(function(t){
      if (taskFilterTag !== "all" && t.tag !== taskFilterTag) return false;
      if ((taskStatusTab === "done") ? !t.done : !!t.done) return false;
      if (!taskViewMatch(t, todayKey, taskView)) return false;
      if (taskProjectFilter === "__none" && t.projectId) return false;
      if (taskProjectFilter && taskProjectFilter !== "__none" && t.projectId !== taskProjectFilter) return false;
      if (taskTagFilter && (t.tags || []).indexOf(taskTagFilter) === -1) return false;
      if (!taskSearchMatch(t)) return false;
      return true;
    });

    renderTaskKpis(acctSet, todayKey);

    taskList.innerHTML = "";

    // 完了タブ: 古い完了は既定で畳む。全件置換で保存する構造上、溜めると保存が重くなるので
    // 「まとめて削除」も添える（自動削除はしない＝データを黙って消さない）。
    if (taskStatusTab === "done"){
      var oldOnes = matched.filter(taskIsOldDone);
      if (oldOnes.length){
        taskList.appendChild(buildOldDoneBar(oldOnes.length));
        if (!taskShowOldDone) matched = matched.filter(function(t){ return !taskIsOldDone(t); });
      }
    }

    if (!matched.length){
      taskList.appendChild(taskEmptyState());
      return;
    }

    // matched から親子ツリーを組む(1階層)。親が matched に無い子はトップレベル扱い。
    var inMatched = {};
    matched.forEach(function(t){ inMatched[t.id] = true; });
    var cmp = taskComparator(taskSortMode);
    var roots = matched.filter(function(t){ return !t.parentId || !inMatched[t.parentId]; }).sort(cmp);
    // 子は常に期限順（親の下でのグルーピングはしない）
    var byDue = taskComparator("due");
    function appendTree(ul, root){
      ul.appendChild(buildTaskRow(root, todayKey, 0));
      matched.filter(function(t){ return t.parentId === root.id; }).sort(byDue).forEach(function(ch){
        ul.appendChild(buildTaskRow(ch, todayKey, 1));
      });
    }

    // 期限順のときだけ「期限切れ / 今日 / 明日 / 今週 / それ以降 / 期限なし」に畳む。
    // 他の並べ替えではグループの意味が無くなるのでフラットに出す。
    if (taskSortMode !== "due"){
      var flat = document.createElement("ul");
      flat.className = "task-tree";
      roots.forEach(function(r){ appendTree(flat, r); });
      taskList.appendChild(flat);
      return;
    }

    var buckets = TASK_DUE_GROUPS.map(function(g){ return { g: g, items: [] }; });
    roots.forEach(function(t){
      var key = taskDueGroupKey(t, todayKey);
      var b = buckets.filter(function(x){ return x.g.key === key; })[0] || buckets[buckets.length - 1];
      b.items.push(t);
    });
    buckets.forEach(function(b){
      if (!b.items.length) return;
      taskList.appendChild(buildTaskGroup(b.g, b.items, todayKey, appendTree));
    });
  }

  /* ---- 完了タスクの整理（自動アーカイブ） ----
     タスクは `PUT /api/tasks/bulk` で毎回コレクション全体を置換するので、完了が溜まると
     保存の往復がそのぶん重くなる。ただし黙って消すのは危険なので「既定で畳む」＋
     「まとめて削除は確認つき」の2段にしてある。 */
  var TASK_OLD_DONE_DAYS = 30;
  var taskShowOldDone = false;
  function taskIsOldDone(t){
    if (!t.done) return false;
    // completedAt が無い(この機能より前に完了した)行は updatedAt で代用。
    // どちらも無ければ「いつ完了したか不明」なので畳まない（消す対象にもしない）。
    var at = Number(t.completedAt || t.updatedAt || 0);
    if (!at) return false;
    return (Date.now() - at) > TASK_OLD_DONE_DAYS * 86400000;
  }
  function buildOldDoneBar(n){
    var bar = document.createElement("div");
    bar.className = "task-oldbar";

    var msg = document.createElement("span");
    msg.className = "task-oldbar-msg";
    msg.textContent = TASK_OLD_DONE_DAYS + "日以上前に完了したタスクが " + n + " 件あります";

    var toggle = document.createElement("button");
    toggle.type = "button"; toggle.className = "task-oldbar-btn";
    toggle.textContent = taskShowOldDone ? "畳む" : "表示する";
    toggle.addEventListener("click", function(){ taskShowOldDone = !taskShowOldDone; renderTasks(); });

    var purge = document.createElement("button");
    purge.type = "button"; purge.className = "task-oldbar-btn is-danger";
    purge.textContent = "まとめて削除";
    purge.addEventListener("click", async function(){
      if (!(await askConfirm(TASK_OLD_DONE_DAYS + "日以上前に完了した " + n + " 件を削除しますか?\nこの操作は取り消せません。"))) return;
      // 子タスクだけが残って迷子にならないよう、消す行を親に持つ子の parentId も外す。
      var goneIds = {};
      tasksState.filter(taskIsOldDone).forEach(function(t){ goneIds[t.id] = true; });
      tasksState = tasksState.filter(function(t){ return !goneIds[t.id]; });
      tasksState.forEach(function(t){ if (t.parentId && goneIds[t.parentId]) t.parentId = null; });
      taskShowOldDone = false;
      renderTasks();
      scheduleTasksSave();
    });

    bar.appendChild(msg); bar.appendChild(toggle); bar.appendChild(purge);
    return bar;
  }

  // 期限グループの定義。上から出る順。
  var TASK_DUE_GROUPS = [
    { key: "overdue", label: "期限切れ", cls: "is-over" },
    { key: "today",   label: "今日",     cls: "is-soon" },
    { key: "tomorrow",label: "明日",     cls: "is-soon" },
    { key: "week",    label: "今週",     cls: "" },
    { key: "later",   label: "それ以降", cls: "" },
    { key: "none",    label: "期限なし", cls: "" }
  ];
  function taskDueGroupKey(t, todayKey){
    if (!t.due) return "none";
    var d = diffDaysKey(todayKey, t.due);
    if (d === null) return "none";
    if (d < 0) return t.done ? "later" : "overdue"; // 完了済みは「期限切れ」に出さない
    if (d === 0) return "today";
    if (d === 1) return "tomorrow";
    if (d <= 7) return "week";
    return "later";
  }
  function buildTaskGroup(g, items, todayKey, appendTree){
    var sec = document.createElement("div");
    sec.className = "task-section" + (taskGroupCollapsed[g.key] ? " collapsed" : "");

    var head = document.createElement("button");
    head.type = "button";
    head.className = "task-section-head " + g.cls;
    head.innerHTML = '<svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>';
    var lbl = document.createElement("span"); lbl.textContent = g.label;
    var cnt = document.createElement("span"); cnt.className = "task-section-count"; cnt.textContent = items.length;
    head.appendChild(lbl); head.appendChild(cnt);
    head.addEventListener("click", function(){
      if (taskGroupCollapsed[g.key]) delete taskGroupCollapsed[g.key];
      else taskGroupCollapsed[g.key] = true;
      renderTasks();
    });

    var ul = document.createElement("ul");
    ul.className = "task-tree";
    items.forEach(function(t){ appendTree(ul, t); });

    sec.appendChild(head); sec.appendChild(ul);
    return sec;
  }

  // 並べ替え。第2キーは常に期限→タイトルで、同点でも並びがぶれないようにする。
  function taskComparator(mode){
    var byDue = function(a, b){ return (a.due || "9999-99-99").localeCompare(b.due || "9999-99-99"); };
    var byTitle = function(a, b){ return (a.text || "").localeCompare(b.text || "", "ja"); };
    if (mode === "prio"){
      return function(a, b){ return (taskPrioRank(b) - taskPrioRank(a)) || byDue(a, b) || byTitle(a, b); };
    }
    if (mode === "created"){
      return function(a, b){ return ((b.createdAt || 0) - (a.createdAt || 0)) || byTitle(a, b); };
    }
    if (mode === "title"){
      return function(a, b){ return byTitle(a, b) || byDue(a, b); };
    }
    // "due": 期限順。同じ期限なら優先度が高い方を上に。
    return function(a, b){ return byDue(a, b) || (taskPrioRank(b) - taskPrioRank(a)) || byTitle(a, b); };
  }

  // KPIバンド。アカウントタブ通過後の全件（未完了/完了タブの絞り込みは掛けない）で数える。
  function renderTaskKpis(acctSet, todayKey){
    var pending = acctSet.filter(function(t){ return !t.done; });
    var today = pending.filter(function(t){ return t.due === todayKey; }).length;
    var week = pending.filter(function(t){
      var d = t.due ? diffDaysKey(todayKey, t.due) : null;
      return d !== null && d >= 0 && d <= 7;
    }).length;
    var overdue = pending.filter(function(t){
      var d = t.due ? diffDaysKey(todayKey, t.due) : null;
      return d !== null && d < 0;
    });
    var doneN = acctSet.filter(function(t){ return t.done; }).length;
    var rate = acctSet.length ? Math.round((doneN / acctSet.length) * 100) : null;

    function set(id, v){ var el = document.getElementById(id); if (el) el.textContent = v; }
    set("task-kpi-today", String(today));
    set("task-kpi-week", String(week));
    set("task-kpi-overdue", String(overdue.length));
    set("task-kpi-rate", rate === null ? "--%" : rate + "%");
    set("task-kpi-rate-sub", acctSet.length ? doneN + " / " + acctSet.length + " 件" : "");

    // 期限切れの最も古いものを添える（どれだけ放置しているかが一目で分かる）
    var oldest = overdue.slice().sort(function(a, b){ return (a.due || "").localeCompare(b.due || ""); })[0];
    var sub = "";
    if (oldest){
      var d = diffDaysKey(todayKey, oldest.due);
      sub = "最長 " + (-d) + "日";
    }
    set("task-kpi-overdue-sub", sub);

    var ov = document.getElementById("task-kpi-overdue");
    if (ov) ov.className = "kpi-value" + (overdue.length ? " is-neg" : "");
    var rt = document.getElementById("task-kpi-rate");
    if (rt) rt.className = "kpi-value" + (rate !== null && rate >= 80 ? " is-pos" : "");
  }

  // 空状態。デザイン方針が「スポット絵は空状態・エラー・404 など普段見えない所に限る」と
  // 明記している場所なので、ink(text-faint)＋accent の2色・線幅1.5px・発光なしの線画を置く。
  function taskEmptyState(){
    var wrap = document.createElement("div");
    wrap.className = "task-empty empty-state";
    var searching = taskSearchQuery.trim() || taskTagFilter || taskProjectFilter || taskView !== "all";
    wrap.innerHTML =
      '<svg class="empty-art" viewBox="0 0 96 72" fill="none" stroke-width="1.5" aria-hidden="true">' +
        '<rect class="ink" x="18" y="10" width="60" height="54" rx="2"/>' +
        '<path class="ink" d="M30 10V6M66 10V6M18 22h60"/>' +
        '<path class="ink" d="M28 34h26M28 44h34M28 54h18"/>' +
        '<path class="accent" d="M64 46l5 5 11-13"/>' +
      '</svg>' +
      '<div class="empty-title">' + (searching ? "該当するタスクはありません" : (taskStatusTab === "done" ? "完了したタスクはまだありません" : "未完了のタスクはありません")) + '</div>' +
      '<div class="empty-sub">' + (searching ? "検索やサイドバーの絞り込みを外すと全件に戻ります。" : "右上の「+ 新規タスク」から追加できます。") + '</div>';
    return wrap;
  }

  // 完了チェックの共通処理。タスク行のチェックボタンと、事務ハック画面の計画リスト(__CP 経由)で共用。
  function toggleTaskDone(task, todayKey){
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
    // 完了時刻。完了タブの「古い完了」の畳み込み・整理に使う。
    if (task.done) task.completedAt = Date.now();
    else delete task.completedAt;
    renderTasks();
    scheduleTasksSave();
  }

  // タスクを本体の外(app.jimuhack.js)から触るための入口。
  // PUT /api/tasks/bulk は全置換なので、一覧の読み込みが成功する前に1件足して保存すると
  // 既存タスクが消える。外から作る/触る前に必ずこれで読み込み完了(成功)を待つ。
  var tasksLoadDone = false;
  var tasksLoadOk = false;
  function ensureTasksLoaded(){
    if (!tasksInitialized){ tasksInitialized = true; initTasks(); }
    return new Promise(function(resolve){
      var n = 0;
      (function wait(){
        if (tasksLoadDone || n++ > 150) return resolve(tasksLoadOk);
        setTimeout(wait, 100);
      })();
    });
  }
  // 本文・自由タグ・期限・URL・備考を入れた状態で新規タスクモーダルを開く(保存はユーザーが押す)。
  function openNewTaskPreset(p){
    p = p || {};
    return ensureTasksLoaded().then(function(ok){
      if (!ok) return false;
      openNewTask("haruka");
      taskTitleInput.value = p.text || "";
      var tg = document.getElementById("task-tags-input");
      if (tg && p.tags) tg.value = p.tags.join(", ");
      renderTaskTagChips();
      if (p.due) taskDueInput.value = p.due;
      if (p.url) taskUrlInput.value = p.url;
      if (p.remarks) taskRemarksInput.value = p.remarks;
      return true;
    });
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

  /* ---- キーボード操作（#view-tasks を表示中のみ） ----
     n=新規 / /=検索へ / j,k=カーソル移動 / x=完了切替 / e=編集 / Enter=詳細開閉 / Esc=解除。
     入力欄やモーダルにフォーカスがあるときは何もしない（通常の文字入力を邪魔しない）。 */
  var taskCursorId = null;   // カーソル位置のタスク id
  function taskRowsInOrder(){
    return Array.prototype.slice.call(taskList.querySelectorAll(".task-item"))
      .map(function(li){ return li.getAttribute("data-task-id"); })
      .filter(Boolean);
  }
  function moveTaskCursor(delta){
    var ids = taskRowsInOrder();
    if (!ids.length) return;
    var i = ids.indexOf(taskCursorId);
    i = (i === -1) ? (delta > 0 ? 0 : ids.length - 1) : Math.max(0, Math.min(ids.length - 1, i + delta));
    taskCursorId = ids[i];
    paintTaskCursor();
    var el = taskList.querySelector('.task-item[data-task-id="' + cssEscapeId(taskCursorId) + '"]');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
  }
  function paintTaskCursor(){
    taskList.querySelectorAll(".task-item").forEach(function(li){
      li.classList.toggle("is-cursor", li.getAttribute("data-task-id") === taskCursorId);
    });
  }
  // id は uid() 由来の英数なので実質エスケープ不要だが、属性セレクタに入れる以上は保険をかける
  function cssEscapeId(id){
    return String(id == null ? "" : id).replace(/["\\]/g, "\\$&");
  }
  function taskByCursor(){
    return tasksState.filter(function(t){ return t.id === taskCursorId; })[0] || null;
  }
  function typingInField(el){
    if (!el) return false;
    var t = (el.tagName || "").toLowerCase();
    return t === "input" || t === "textarea" || t === "select" || el.isContentEditable;
  }
  document.addEventListener("keydown", function(e){
    if (viewTasks.hidden) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // モーダルが開いている間はモーダル側の操作に任せる
    // （削除の確認ダイアログ中に n が効いて裏で新規モーダルが開く、を防ぐ）
    if (!taskModal.hidden) return;
    if (confirmModal && !confirmModal.hidden) return;
    if (noteModal && !noteModal.hidden) return;
    var active = document.activeElement;

    if (e.key === "/" && !typingInField(active)){
      e.preventDefault();
      if (taskSearchInput) taskSearchInput.focus();
      return;
    }
    if (e.key === "Escape" && typingInField(active) && active === taskSearchInput){
      taskSearchInput.value = ""; taskSearchQuery = ""; taskSearchInput.blur(); renderTasks();
      return;
    }
    if (typingInField(active)) return;

    if (e.key === "n"){ e.preventDefault(); openNewTask(taskFilterTag === "syslea" ? "syslea" : "haruka"); return; }
    if (e.key === "j"){ e.preventDefault(); moveTaskCursor(1); return; }
    if (e.key === "k"){ e.preventDefault(); moveTaskCursor(-1); return; }
    if (e.key === "Escape"){ taskCursorId = null; paintTaskCursor(); return; }

    var cur = taskByCursor();
    if (!cur) return;
    if (e.key === "x"){
      e.preventDefault();
      var btn = taskList.querySelector('.task-item[data-task-id="' + cssEscapeId(cur.id) + '"] .task-check');
      if (btn) btn.click();   // 繰り返しタスクのロールも含めて既存の処理をそのまま使う
      return;
    }
    if (e.key === "e"){ e.preventDefault(); openEditTask(cur); return; }
    if (e.key === "Enter"){
      e.preventDefault();
      if (taskExpandedIds[cur.id]) delete taskExpandedIds[cur.id];
      else taskExpandedIds[cur.id] = true;
      renderTasks();
      return;
    }
  });

  var taskSortSelect = document.getElementById("task-sort");
  if (taskSortSelect) taskSortSelect.addEventListener("change", function(){
    taskSortMode = taskSortSelect.value || "due";
    renderTasks();
  });

  // モーダルの優先度ピッカー（ラジオ相当）。値は taskFormPrio に持つ。
  var taskFormPrio = "";
  var taskPrioPicker = document.getElementById("task-prio-picker");
  function setTaskFormPrio(v){
    taskFormPrio = (v === "high" || v === "mid" || v === "low") ? v : "";
    if (!taskPrioPicker) return;
    taskPrioPicker.querySelectorAll(".task-prio-btn").forEach(function(b){
      b.classList.toggle("is-active", (b.getAttribute("data-prio") || "") === taskFormPrio);
    });
  }
  if (taskPrioPicker) taskPrioPicker.addEventListener("click", function(e){
    var b = e.target.closest(".task-prio-btn");
    if (b) setTaskFormPrio(b.getAttribute("data-prio") || "");
  });

  var taskSearchInput = document.getElementById("task-search");
  if (taskSearchInput) taskSearchInput.addEventListener("input", function(){
    taskSearchQuery = taskSearchInput.value;
    renderTasks();
  });

  var taskStatusTabsEl = document.getElementById("task-status-tabs");
  if (taskStatusTabsEl) taskStatusTabsEl.addEventListener("click", function(e){
    var b = e.target.closest(".task-status-tab");
    if (!b) return;
    taskStatusTab = b.getAttribute("data-status") === "done" ? "done" : "pending";
    renderTasks();
  });

  function setWeekdayPicker(selectedDays){
    taskFormRepeatDays = (selectedDays || []).slice();
    taskWeekdayPicker.querySelectorAll(".weekday-btn").forEach(function(btn){
      btn.classList.toggle("active", taskFormRepeatDays.indexOf(Number(btn.getAttribute("data-day"))) !== -1);
    });
  }
  // モーダルの「親タスク」「プロジェクト」セレクトを埋める。
  //   currentId       : 編集中タスクの id(自分自身・自分の子は親候補から除外)
  //   presetParent    : 事前選択する親 id("" で なし)。undefined なら現在値維持
  //   presetProject   : 事前選択するプロジェクト id。undefined なら現在値維持
  function populateTaskModalSelects(currentId, presetParent, presetProject){
    var pSel = document.getElementById("task-parent-input");
    if (pSel){
      var curParent = presetParent !== undefined ? presetParent : pSel.value;
      pSel.innerHTML = '<option value="">（なし）</option>';
      tasksState.forEach(function(t){
        if (t.id === currentId) return;   // 自分は親にできない
        if (t.parentId) return;           // 1階層のみ: すでに子のタスクは親候補にしない
        if (currentId && t.parentId === currentId) return; // (念のため)自分の子も除外
        var o = document.createElement("option");
        o.value = t.id; o.textContent = t.text || "(無題)";
        pSel.appendChild(o);
      });
      // 編集中タスクに子がいる場合、そのタスク自身は子になれない → 親セレクトを無効化
      var hasKids = currentId && tasksState.some(function(t){ return t.parentId === currentId; });
      pSel.disabled = !!hasKids;
      pSel.value = hasKids ? "" : (curParent || "");
    }
    var prjSel = document.getElementById("task-project-input");
    if (prjSel){
      var curPrj = presetProject !== undefined ? presetProject : prjSel.value;
      prjSel.innerHTML = '<option value="">（なし）</option>';
      projectsForLink.filter(function(p){ return !p.archived; }).forEach(function(p){
        var o = document.createElement("option"); o.value = p.id; o.textContent = p.name;
        prjSel.appendChild(o);
      });
      var found = false;
      for (var i = 0; i < prjSel.options.length; i++){ if (prjSel.options[i].value === curPrj) found = true; }
      if (curPrj && !found){
        var ox = document.createElement("option");
        ox.value = curPrj; ox.textContent = (projectName(curPrj) || "（不明なプロジェクト）");
        prjSel.appendChild(ox);
      }
      prjSel.value = curPrj || "";
    }
  }
  function openNewTask(defaultTag, parentId){
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
    setTaskFormPrio("");
    taskFormTag = defaultTag === "syslea" ? "syslea" : "haruka";
    setActiveTab("task-tag-tabs", taskFormTag);
    populateTaskModalSelects(null, (typeof parentId === "string" ? parentId : ""), "");
    ensureProjectsLoaded().then(function(){ if (!taskModal.hidden && editingTaskId === null) populateTaskModalSelects(null, undefined, undefined); });
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
    populateTaskModalSelects(task.id, task.parentId || "", task.projectId || "");
    ensureProjectsLoaded().then(function(){ if (!taskModal.hidden && editingTaskId === task.id) populateTaskModalSelects(task.id, undefined, undefined); });
    taskRepeatInput.value = task.repeat || "none";
    setWeekdayPicker(task.repeatDays || []);
    taskMonthdayInput.value = task.repeatDayOfMonth || "";
    updateRepeatDetailVisibility();
    taskUrlInput.value = task.url || "";
    taskRemarksInput.value = task.remarks || "";
    setTaskFormPrio(task.priority || "");
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
    var parentSel = document.getElementById("task-parent-input");
    var projectSel = document.getElementById("task-project-input");
    var parentId = (parentSel && !parentSel.disabled && parentSel.value) ? parentSel.value : null;
    if (parentId && parentId === editingTaskId) parentId = null; // 念のため自己参照を弾く
    var fields = {
      text: text,
      due: taskDueInput.value || null,
      dueTime: (taskDueInput.value && dueTime) ? dueTime : null,
      tag: taskFormTag,
      tags: tagsInput ? parseFreeTags(tagsInput.value) : [],
      parentId: parentId,
      projectId: (projectSel && projectSel.value) ? projectSel.value : null,
      repeat: repeat,
      repeatDays: repeat === "weekly" ? taskFormRepeatDays.slice() : null,
      repeatDayOfMonth: repeat === "monthly" && taskMonthdayInput.value ? Number(taskMonthdayInput.value) : null,
      url: url || null,
      priority: taskFormPrio || null,
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
  var noteTagFilter = "";         // 自由タグでの絞り込み("" = なし)
  var noteSortMode = "updated";   // "updated" | "created" | "title"（ピン留めは常に先頭）
  var noteDensity = "card";       // "card" | "list"
  var noteFormPinned = false;
  var noteEditMode = "edit";      // モーダルの 編集/プレビュー

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
    notesStatusBar.className = "cal-status-chip" + (cls ? " " + cls : "");
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
  // 見出しの # と チェックの [ ] も、プレビューでは記号のままだと読みにくいので整える。
  function noteSnippetText(text){
    return (text || "")
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^(\s*[-*]\s+)\[ \]\s+/gm, "$1☐ ")
      .replace(/^(\s*[-*]\s+)\[[xX]\]\s+/gm, "$1☑ ")
      .replace(/^\s*[-*]\s+/gm, "・")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/^>\s?/gm, "");
  }

  /* ---- 軽量 Markdown レンダラ（メモのプレビュー用） ----
     ライブラリは足さない。対応するのは 見出し / 箇条書き / 番号 / チェックボックス /
     太字 / インラインコード / 引用 / 区切り線 / 素の URL だけ。
     入力は必ず escapeHtml を通してから記法を当てるので、生の HTML は描画されない。
     チェックボックスには data-line（本文の行番号）を持たせて、押したら本文へ書き戻す。 */
  function noteInline(s){
    return s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  }
  function noteMarkdownToHtml(text){
    var lines = String(text == null ? "" : text).split("\n");
    var out = [];
    var listType = null; // "ul" | "ol" | null
    function closeList(){ if (listType){ out.push("</" + listType + ">"); listType = null; } }
    function openList(t){ if (listType !== t){ closeList(); out.push("<" + t + ">"); listType = t; } }

    lines.forEach(function(raw, idx){
      var line = escapeHtml(raw);
      var m;

      if (/^\s*$/.test(raw)){ closeList(); return; }
      if (/^\s*(---+|\*\*\*+)\s*$/.test(raw)){ closeList(); out.push("<hr>"); return; }

      m = line.match(/^(#{1,6})\s+(.*)$/);
      if (m){ closeList(); var lv = Math.min(m[1].length, 4) + 2; out.push("<h" + lv + ">" + noteInline(m[2]) + "</h" + lv + ">"); return; }

      m = line.match(/^\s*&gt;\s?(.*)$/);
      if (m){ closeList(); out.push("<blockquote>" + noteInline(m[1]) + "</blockquote>"); return; }

      // チェックボックス（箇条書きの有無どちらも許す）
      m = line.match(/^(\s*)(?:[-*]\s+)?\[([ xX])\]\s+(.*)$/);
      if (m){
        openList("ul");
        var checked = m[2] !== " ";
        out.push('<li class="md-task' + (checked ? " is-done" : "") + '">' +
          '<button type="button" class="md-check" data-line="' + idx + '" aria-pressed="' + checked + '">' +
          (checked ? "&#10003;" : "") + "</button>" +
          "<span>" + noteInline(m[3]) + "</span></li>");
        return;
      }

      m = line.match(/^\s*[-*]\s+(.*)$/);
      if (m){ openList("ul"); out.push("<li>" + noteInline(m[1]) + "</li>"); return; }

      m = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (m){ openList("ol"); out.push("<li>" + noteInline(m[1]) + "</li>"); return; }

      closeList();
      out.push("<p>" + noteInline(line) + "</p>");
    });
    closeList();
    return out.join("");
  }

  /* ---- 検索（AND ＋ ヒット強調） ----
     Slackダイジェストの全件ページと同じ考え方。空白区切りの語をすべて含むものだけ残し、
     カードのタイトル・本文プレビューでヒット箇所を <mark> で囲む。 */
  function searchTerms(q){
    return String(q == null ? "" : q).trim().toLowerCase().split(/\s+/).filter(Boolean);
  }
  function matchesAllTerms(haystack, terms){
    var h = String(haystack || "").toLowerCase();
    return terms.every(function(t){ return h.indexOf(t) !== -1; });
  }
  // escapeHtml 済みの文字列を返す。terms は小文字。
  function highlightHtml(text, terms){
    var esc = escapeHtml(text || "");
    if (!terms.length) return esc;
    // 長い語から当てて、短い語が先に食い合わないようにする
    var pattern = terms.slice().sort(function(a, b){ return b.length - a.length; })
      .map(function(t){ return escapeRegExp(escapeHtml(t)); }).join("|");
    if (!pattern) return esc;
    return esc.replace(new RegExp("(" + pattern + ")", "gi"), "<mark>$1</mark>");
  }
  function escapeRegExp(s){ return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  // ダッシュボードの「最近のメモ」ミニリスト(最新5件)。
  // ビジネス=SYSLEA タグ / プライベート=はるか タグ の2箇所から tag 違いで呼ぶ。
  // notesState を直接見るので、メモページ側の検索/フィルタとは独立に常に同期する。
  function renderMiniNotes(listId, tag){
    var list = document.getElementById(listId);
    if (!list) return;
    var items = notesState
      .filter(function(n){ return (n.tag || "haruka") === tag; })
      .slice()
      // ピン留めはカード側でも先頭に出す（メモページと同じ優先順位）
      .sort(function(a, b){ return ((b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)) || ((b.updatedAt || 0) - (a.updatedAt || 0)); })
      .slice(0, 5);
    if (!items.length){
      list.innerHTML = '<li class="sched-empty">' + (TASK_TAG_LABEL[tag] || tag) + ' のメモはまだありません。</li>';
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

  // ダッシュボードの「最近のタスク」ミニリスト(未完了、期限が近い順に最新5件)。
  // ビジネス=SYSLEA タグ / プライベート=はるか タグ の2箇所から tag 違いで呼ぶ。
  // tasksState を直接見るので、タスクページ側のフィルタとは独立に常に同期する。
  function renderMiniTasks(listId, tag){
    var list = document.getElementById(listId);
    if (!list) return;
    var items = tasksState
      .filter(function(t){ return (t.tag || "haruka") === tag && !t.done && !t.parentId; })
      .slice()
      .sort(function(a, b){ return (a.due || "9999-99-99").localeCompare(b.due || "9999-99-99"); })
      .slice(0, 5);
    if (!items.length){
      list.innerHTML = '<li class="sched-empty">' + (TASK_TAG_LABEL[tag] || tag) + ' の未完了タスクはありません。</li>';
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

  // ビジネス(SYSLEA)＋プライベート(はるか)の両ダッシュボードのメモカードを更新
  function renderNoteCards(){
    renderMiniNotes("biz-note-list", "syslea");
    renderMiniNotes("pv-note-list", "haruka");
  }

  function renderNotes(){
    renderNoteCards();
    renderNoteTagbar();
    notesGrid.className = "notes-grid" + (noteDensity === "list" ? " is-list" : "");
    notesGrid.innerHTML = "";

    var terms = searchTerms(noteSearchQuery);
    var items = notesState.filter(function(n){
      if (noteFilterTag !== "all" && (n.tag || "haruka") !== noteFilterTag) return false;
      if (noteTagFilter && (n.tags || []).indexOf(noteTagFilter) === -1) return false;
      if (!terms.length) return true;
      return matchesAllTerms((n.title || "") + "\n" + (n.body || "") + "\n" + (n.tags || []).join(" "), terms);
    });
    if (items.length === 0){
      notesGrid.appendChild(noteEmptyState());
      return;
    }

    items.slice().sort(noteComparator(noteSortMode)).forEach(function(note){
      notesGrid.appendChild(buildNoteCard(note, terms));
    });
  }

  // ピン留めは常に先頭。その中で選んだ並べ替えを効かせる。
  function noteComparator(mode){
    var byTitle = function(a, b){ return (a.title || "").localeCompare(b.title || "", "ja"); };
    var inner;
    if (mode === "created") inner = function(a, b){ return ((b.createdAt || b.updatedAt || 0) - (a.createdAt || a.updatedAt || 0)) || byTitle(a, b); };
    else if (mode === "title") inner = byTitle;
    else inner = function(a, b){ return ((b.updatedAt || 0) - (a.updatedAt || 0)) || byTitle(a, b); };
    return function(a, b){
      var pa = a.pinned ? 1 : 0, pb = b.pinned ? 1 : 0;
      return (pb - pa) || inner(a, b);
    };
  }

  function buildNoteCard(note, terms){
    var card = document.createElement("div");
    card.className = "note-card" + (note.pinned ? " is-pinned" : "") + " tagcol-" + (note.tag || "haruka");

    var head = document.createElement("div");
    head.className = "note-card-head";
    var title = document.createElement("div");
    title.className = "note-title";
    title.innerHTML = highlightHtml(note.title || "(無題)", terms);

    // ピンのトグル。カード上で完結させたいので、ここだけクリックの伝播を止める。
    var pin = document.createElement("button");
    pin.type = "button";
    pin.className = "note-pin-btn" + (note.pinned ? " is-on" : "");
    pin.setAttribute("aria-label", note.pinned ? "ピン留めを外す" : "ピン留めする");
    pin.setAttribute("aria-pressed", String(!!note.pinned));
    pin.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 17v5M9 3h6l-1 6 3 3v2H7v-2l3-3z"/></svg>';
    pin.addEventListener("click", function(e){
      e.stopPropagation();
      note.pinned = !note.pinned;
      note.updatedAt = note.updatedAt || Date.now(); // ピンだけでは「更新」扱いにしない
      renderNotes();
      scheduleNotesSave();
    });

    var tagBadge = document.createElement("span");
    tagBadge.className = "tag-badge tag-" + (note.tag || "haruka");
    tagBadge.textContent = TASK_TAG_LABEL[note.tag] || "はるか";
    head.appendChild(title); head.appendChild(pin); head.appendChild(tagBadge);

    var snippet = document.createElement("div");
    snippet.className = "note-snippet";
    snippet.innerHTML = highlightHtml(noteSnippetText(note.body || ""), terms);

    var foot = document.createElement("div");
    foot.className = "note-meta";
    var when = document.createElement("span");
    when.textContent = note.updatedAt ? fmtSavedAt(note.updatedAt) + " 更新" : "";
    foot.appendChild(when);
    // 未完了のチェックが残っていれば「☐ 2/5」を出す（買い物メモ等の進み具合）
    var prog = noteCheckProgress(note.body || "");
    if (prog){
      var pg = document.createElement("span");
      pg.className = "note-progress" + (prog.done === prog.total ? " is-done" : "");
      pg.textContent = "☑ " + prog.done + "/" + prog.total;
      foot.appendChild(pg);
    }

    card.appendChild(head); card.appendChild(snippet);
    if ((note.tags || []).length){
      var tw = document.createElement("div");
      tw.className = "note-card-tags";
      note.tags.slice(0, 4).forEach(function(t){
        var c = document.createElement("span"); c.className = "task-freetag"; c.textContent = t;
        tw.appendChild(c);
      });
      if (note.tags.length > 4){
        var more = document.createElement("span"); more.className = "task-freetag"; more.textContent = "+" + (note.tags.length - 4);
        tw.appendChild(more);
      }
      card.appendChild(tw);
    }
    card.appendChild(foot);
    card.addEventListener("click", function(){ openEditNote(note); });
    return card;
  }

  // 本文中の [ ] / [x] の数。1つも無ければ null。
  function noteCheckProgress(body){
    var all = String(body || "").match(/^(\s*(?:[-*]\s+)?)\[([ xX])\]\s+/gm);
    if (!all || !all.length) return null;
    var done = all.filter(function(s){ return !/\[ \]/.test(s); }).length;
    return { done: done, total: all.length };
  }

  // 自由タグのチップ列。1つもタグが無ければ行ごと隠す。
  function renderNoteTagbar(){
    var bar = document.getElementById("note-tagbar");
    if (!bar) return;
    var counts = {};
    notesState.forEach(function(n){
      if (noteFilterTag !== "all" && (n.tag || "haruka") !== noteFilterTag) return;
      (n.tags || []).forEach(function(t){ if (t) counts[t] = (counts[t] || 0) + 1; });
    });
    var keys = Object.keys(counts).sort(function(a, b){ return a.localeCompare(b, "ja"); });
    if (noteTagFilter && keys.indexOf(noteTagFilter) === -1) noteTagFilter = "";
    bar.hidden = !keys.length;
    bar.innerHTML = "";
    if (!keys.length) return;
    var lbl = document.createElement("span");
    lbl.className = "note-tagbar-label"; lbl.textContent = "タグ";
    bar.appendChild(lbl);
    keys.forEach(function(k){
      var b = document.createElement("button");
      b.type = "button";
      b.className = "note-tagchip" + (noteTagFilter === k ? " is-on" : "");
      b.textContent = k + " " + counts[k];
      b.addEventListener("click", function(){
        noteTagFilter = (noteTagFilter === k) ? "" : k;
        renderNotes();
      });
      bar.appendChild(b);
    });
  }

  function noteEmptyState(){
    var wrap = document.createElement("div");
    wrap.className = "notes-empty empty-state";
    var filtering = noteSearchQuery.trim() || noteTagFilter || noteFilterTag !== "all";
    wrap.innerHTML =
      '<svg class="empty-art" viewBox="0 0 96 72" fill="none" stroke-width="1.5" aria-hidden="true">' +
        '<path class="ink" d="M22 8h34l18 18v38a2 2 0 0 1-2 2H22a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z"/>' +
        '<path class="ink" d="M56 8v18h18"/>' +
        '<path class="ink" d="M30 38h30M30 48h22"/>' +
        '<path class="accent" d="M30 28h16"/>' +
      '</svg>' +
      '<div class="empty-title">' + (filtering ? "条件に一致するメモがありません" : "メモはまだありません") + '</div>' +
      '<div class="empty-sub">' + (filtering ? "検索語やタグの絞り込みを外すと全件に戻ります。" : "右上の「+ 新規メモ」から作成できます。") + '</div>';
    return wrap;
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

  var noteSortSelect = document.getElementById("note-sort");
  if (noteSortSelect) noteSortSelect.addEventListener("change", function(){
    noteSortMode = noteSortSelect.value || "updated";
    renderNotes();
  });
  document.querySelectorAll(".note-density-btn").forEach(function(b){
    b.addEventListener("click", function(){
      noteDensity = b.getAttribute("data-density") === "list" ? "list" : "card";
      document.querySelectorAll(".note-density-btn").forEach(function(x){
        x.classList.toggle("is-active", x.getAttribute("data-density") === noteDensity);
      });
      try { localStorage.setItem("cp_note_density", noteDensity); } catch(e){}
      renderNotes();
    });
  });
  // 表示密度だけは端末ごとの好みなので localStorage に残す（他は毎回既定に戻す）
  try {
    var savedDensity = localStorage.getItem("cp_note_density");
    if (savedDensity === "list" || savedDensity === "card"){
      noteDensity = savedDensity;
      document.querySelectorAll(".note-density-btn").forEach(function(x){
        x.classList.toggle("is-active", x.getAttribute("data-density") === noteDensity);
      });
    }
  } catch(e){}

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
    setNoteFormTags([]);
    setNoteFormPinned(false);
    setNoteEditMode("edit");
    noteFormTag = defaultTag === "syslea" ? "syslea" : "haruka";
    setActiveTab("note-tag-tabs", noteFormTag);
    noteFormError.hidden = true;
    noteDeleteBtn.hidden = true;
    if (noteToTaskBtn) noteToTaskBtn.hidden = true;   // 未保存のメモからは変換させない
    noteModal.hidden = false;
    document.body.style.overflow = "hidden";
    noteTitleInput.focus();
  }
  function openEditNote(note){
    editingNoteId = note.id;
    noteModalTitle.textContent = "メモを編集";
    noteTitleInput.value = note.title || "";
    noteBodyInput.innerHTML = noteMarkdownToEditableHtml(note.body || "");
    setNoteFormTags(note.tags || []);
    setNoteFormPinned(!!note.pinned);
    setNoteEditMode("edit");
    noteFormTag = note.tag || "haruka";
    setActiveTab("note-tag-tabs", noteFormTag);
    noteFormError.hidden = true;
    noteDeleteBtn.hidden = false;
    if (noteToTaskBtn) noteToTaskBtn.hidden = false;
    noteModal.hidden = false;
    document.body.style.overflow = "hidden";
    noteTitleInput.focus();
  }

  /* ---- モーダルの追加パーツ（自由タグ / ピン / プレビュー） ---- */
  var noteTagsInputEl = document.getElementById("note-tags-input");
  var noteTagsChipsEl = document.getElementById("note-tags-chips");
  var notePinToggle = document.getElementById("note-pin-toggle");
  var notePinLabel = document.getElementById("note-pin-label");
  var noteBodyPreview = document.getElementById("note-body-preview");
  var noteToTaskBtn = document.getElementById("note-to-task");

  function setNoteFormTags(tags){
    if (noteTagsInputEl) noteTagsInputEl.value = (tags || []).join(", ");
    renderNoteTagChips();
  }
  function renderNoteTagChips(){
    if (!noteTagsInputEl || !noteTagsChipsEl) return;
    var tags = parseFreeTags(noteTagsInputEl.value);
    noteTagsChipsEl.innerHTML = "";
    noteTagsChipsEl.hidden = !tags.length;
    tags.forEach(function(t){
      noteTagsChipsEl.appendChild(taskFreeTagChip(t, function(){
        noteTagsInputEl.value = tags.filter(function(x){ return x !== t; }).join(", ");
        renderNoteTagChips();
      }));
    });
  }
  if (noteTagsInputEl){
    noteTagsInputEl.addEventListener("input", renderNoteTagChips);
    noteTagsInputEl.addEventListener("blur", function(){
      noteTagsInputEl.value = parseFreeTags(noteTagsInputEl.value).join(", ");
      renderNoteTagChips();
    });
  }

  function setNoteFormPinned(on){
    noteFormPinned = !!on;
    if (notePinToggle){
      notePinToggle.classList.toggle("is-on", noteFormPinned);
      notePinToggle.setAttribute("aria-pressed", String(noteFormPinned));
    }
    if (notePinLabel) notePinLabel.textContent = noteFormPinned ? "ピン留め中" : "留めていない";
  }
  if (notePinToggle) notePinToggle.addEventListener("click", function(){ setNoteFormPinned(!noteFormPinned); });

  function setNoteEditMode(mode){
    noteEditMode = mode === "preview" ? "preview" : "edit";
    var preview = noteEditMode === "preview";
    if (preview && noteBodyPreview){
      noteBodyPreview.innerHTML = noteMarkdownToHtml(noteEditableToMarkdown(noteBodyInput));
    }
    noteBodyInput.hidden = preview;
    if (noteBodyPreview) noteBodyPreview.hidden = !preview;
    document.querySelectorAll(".note-mode-btn").forEach(function(b){
      b.classList.toggle("is-active", b.getAttribute("data-mode") === noteEditMode);
    });
  }
  document.querySelectorAll(".note-mode-btn").forEach(function(b){
    b.addEventListener("click", function(){ setNoteEditMode(b.getAttribute("data-mode")); });
  });
  var noteMdHelpBtn = document.getElementById("note-md-help-btn");
  if (noteMdHelpBtn) noteMdHelpBtn.addEventListener("click", function(){
    var h = document.getElementById("note-md-help");
    if (h) h.hidden = !h.hidden;
  });

  // プレビュー上のチェックボックス。押した行の [ ] / [x] を反転して編集側へ書き戻す。
  // （保存はいつもどおりモーダルの「保存」。ここでは本文を書き換えるだけ）
  if (noteBodyPreview) noteBodyPreview.addEventListener("click", function(e){
    var btn = e.target.closest(".md-check");
    if (!btn) return;
    var lineNo = Number(btn.getAttribute("data-line"));
    var text = noteEditableToMarkdown(noteBodyInput).split("\n");
    if (!(lineNo >= 0 && lineNo < text.length)) return;
    text[lineNo] = text[lineNo].replace(/\[([ xX])\]/, function(_, c){ return c === " " ? "[x]" : "[ ]"; });
    var joined = text.join("\n");
    noteBodyInput.innerHTML = noteMarkdownToEditableHtml(joined);
    noteBodyPreview.innerHTML = noteMarkdownToHtml(joined);
  });

  /* ---- メモ → タスク化 ----
     タイトルをタスク名、本文を備考、自由タグとアカウントタグをそのまま引き継いで
     タスクモーダルを開く。メモは消さない（元の記録は残す）。 */
  if (noteToTaskBtn) noteToTaskBtn.addEventListener("click", function(){
    var title = noteTitleInput.value.trim() || "(無題)";
    var body = noteEditableToMarkdown(noteBodyInput);
    var tags = noteTagsInputEl ? parseFreeTags(noteTagsInputEl.value) : [];
    var tag = noteFormTag;
    closeNoteModal();
    if (!tasksInitialized){ tasksInitialized = true; initTasks(); }
    openNewTask(tag === "syslea" ? "syslea" : "haruka");
    taskTitleInput.value = title.slice(0, 200);
    taskRemarksInput.value = noteSnippetText(body).slice(0, 2000);
    var tgEl = document.getElementById("task-tags-input");
    if (tgEl){ tgEl.value = tags.join(", "); renderTaskTagChips(); }
    taskTitleInput.focus();
    taskTitleInput.select();
  });
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
    // プレビュー表示中でも編集側の DOM は残っているので、そこから本文を取る
    var body = noteEditableToMarkdown(noteBodyInput);
    var freeTags = noteTagsInputEl ? parseFreeTags(noteTagsInputEl.value) : [];
    if (editingNoteId){
      var existing = notesState.find(function(n){ return n.id === editingNoteId; });
      if (existing){
        existing.title = title; existing.body = body; existing.tag = noteFormTag;
        existing.tags = freeTags; existing.pinned = noteFormPinned || false;
        existing.updatedAt = Date.now();
      }
    } else {
      notesState.push({
        id: uid(), title: title, body: body, tag: noteFormTag,
        tags: freeTags, pinned: noteFormPinned || false,
        createdAt: Date.now(), updatedAt: Date.now()
      });
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
      { el: mailComposeModal, close: closeMailCompose },  // メール詳細より手前に開く
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

  // 画面を固定アスペクト比にするか(設定 表示>画面を固定比率にする)。
  // 実際の比率切替(PC=16:9 / タブレット=4:3 / スマホは無効)は style.css の
  // html.fixed-aspect メディアクエリ側。ここはクラスの付け外しとキャッシュのみ。
  function setFixedAspect(on){
    try { localStorage.setItem("pref_fixedAspect", String(!!on)); } catch(e){}
    document.documentElement.classList.toggle("fixed-aspect", !!on);
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
    setFixedAspect(disp.fixedAspect === true);
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
  var elSetAspect = document.getElementById("settings-aspect");
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
    if (elSetAspect) elSetAspect.checked = d.fixedAspect === true;
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
      if (target === "contracts" && window.__CP && window.__CP.loadContracts) window.__CP.loadContracts();
      if (target === "event_trackers" && window.__CP && window.__CP.loadEventTrackers) window.__CP.loadEventTrackers();
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
          fixedAspect: !!(elSetAspect && elSetAspect.checked),
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

  /* ===== 右上プロフィール → ログアウトメニュー =====
     .profile はヘッダーごとに8箇所ある(#app-topbar の1つは showView が表示中frameへ
     移動、残り7つは各フルスクリーンviewの静的ヘッダー)。個別バインドせず document
     への委譲で拾う。メニュー本体(#profile-menu)は body 直下の1つを共用し、位置は
     クリックされた .profile の座標から算出する(notif-panel と同じ方式)。 */
  var profileMenu = document.getElementById("profile-menu");
  var profileMenuEmail = document.getElementById("profile-menu-email");
  var profileSignoutBtn = document.getElementById("profile-signout-btn");
  var profileMenuAnchor = null;

  Array.prototype.forEach.call(document.querySelectorAll(".profile"), function(p){
    p.setAttribute("role", "button");
    p.setAttribute("tabindex", "0");
    p.setAttribute("aria-haspopup", "menu");
    if (!p.getAttribute("title")) p.setAttribute("title", "アカウント");
  });

  function positionProfileMenu(){
    if (!profileMenu || !profileMenuAnchor) return;
    var mobile = window.matchMedia && window.matchMedia("(max-width: 640px)").matches;
    if (mobile){
      // モバイルは CSS の固定オフセットに任せる
      profileMenu.style.top = ""; profileMenu.style.right = ""; profileMenu.style.left = "";
      return;
    }
    var r = profileMenuAnchor.getBoundingClientRect();
    var pw = profileMenu.offsetWidth || 190;
    var right = window.innerWidth - r.right;
    // ビューポート内に収める(右端 / 左端どちらにもはみ出させない)
    right = Math.min(Math.max(8, right), Math.max(8, window.innerWidth - pw - 8));
    profileMenu.style.left = "";
    profileMenu.style.top = Math.round(r.bottom + 10) + "px";
    profileMenu.style.right = Math.round(right) + "px";
  }
  function openProfileMenu(anchor){
    if (!profileMenu) return;
    profileMenuAnchor = anchor;
    if (profileMenuEmail){
      var u = window.__cyberPortalAuth && window.__cyberPortalAuth.currentUser;
      profileMenuEmail.textContent = (u && (u.email || u.displayName)) || "アカウント";
    }
    profileMenu.hidden = false;
    positionProfileMenu();
    if (anchor.setAttribute) anchor.setAttribute("aria-expanded", "true");
    document.addEventListener("mousedown", onProfileOutside, true);
    document.addEventListener("keydown", onProfileEsc, true);
    window.addEventListener("resize", positionProfileMenu);
    if (profileSignoutBtn) profileSignoutBtn.focus();
  }
  function closeProfileMenu(){
    if (!profileMenu) return;
    profileMenu.hidden = true;
    if (profileMenuAnchor && profileMenuAnchor.setAttribute) profileMenuAnchor.setAttribute("aria-expanded", "false");
    profileMenuAnchor = null;
    document.removeEventListener("mousedown", onProfileOutside, true);
    document.removeEventListener("keydown", onProfileEsc, true);
    window.removeEventListener("resize", positionProfileMenu);
  }
  function onProfileOutside(e){
    var inProfile = e.target.closest && e.target.closest(".profile");
    if (profileMenu && !profileMenu.contains(e.target) && !inProfile) closeProfileMenu();
  }
  function onProfileEsc(e){
    if (e.key === "Escape"){ e.preventDefault(); closeProfileMenu(); if (profileMenuAnchor && profileMenuAnchor.focus) profileMenuAnchor.focus(); }
  }
  function toggleProfileMenu(prof){
    if (profileMenu && profileMenu.hidden) openProfileMenu(prof); else closeProfileMenu();
  }

  document.addEventListener("click", function(e){
    var prof = e.target.closest && e.target.closest(".profile");
    if (!prof) return;
    e.preventDefault();
    toggleProfileMenu(prof);
  });
  document.addEventListener("keydown", function(e){
    if (e.key !== "Enter" && e.key !== " ") return;
    var prof = e.target.closest && e.target.closest(".profile");
    if (!prof || !prof.hasAttribute("tabindex")) return;
    e.preventDefault();
    toggleProfileMenu(prof);
  });
  if (profileSignoutBtn){
    profileSignoutBtn.addEventListener("click", function(){
      closeProfileMenu();
      try {
        var p = window.__cyberPortalSignOut && window.__cyberPortalSignOut();
        if (p && p.catch) p.catch(function(err){ console.error("[auth] signOut failed:", err); });
      } catch (err){ console.error("[auth] signOut failed:", err); }
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
    // 新しい SW が制御を奪ったら(＝デプロイでシェルが更新されたら)1回だけリロードする。
    // これが無いと「新しい index.html × キャッシュされた旧 app.js」のままのタブが残り、
    // 削除済み DOM 要素へのアクセス等で初期化が停止する(2026/09 に getContext エラーで再現)。
    // controller が既にある(=更新)ときだけ購読し、初回訪問では発火させない。
    if (navigator.serviceWorker.controller){
      var swReloading = false;
      navigator.serviceWorker.addEventListener("controllerchange", function(){
        if (swReloading) return;
        swReloading = true;
        window.location.reload();
      });
    }
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

    // 契約書アラート。取れなかったときは行を出さないだけにして、
    // HOME のために追加の往復を増やさない(業務タブを開けば正しい件数になる)。
    applyHomeContractAlerts(b.contracts);
  }

  async function warmOnAuthReady(){
    applyInitialRoute();
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
    // タスクは HOME の INBOX（期限切れ行）とプライベート/ビジネスのカードで使うので、
    // アイドルになったら先に取っておく。以後のタブ切り替えは再取得なし。
    scheduleIdle(function(){
      loadHarukaMail();
      warmCalendarView();
      if (!tasksInitialized){ tasksInitialized = true; initTasks(); }
    });
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

  /* ================= 分離モジュールへのブリッジ =================
     app.payables.js(#view-payables・請求書管理)と app.business.js(契約書トラッカー /
     プロジェクトボード / Slackダイジェスト)は本体から分離し、そのタブを初回に開いたとき
     loadPayablesModule() / loadBusinessModule() が <script> を注入してロードする。
     各モジュールは下の window.__CP からヘルパーを alias で受け取り、エントリポイント
     (initPayables / initBusinessCards ほか)を __CP に登録し返す。
     HOME/メール/カレンダー等しか使わないロードではこの2ファイルは取得も解析もされない。 */
  window.__CP = {
    escapeHtml: escapeHtml,
    apiFetch: apiFetch,
    apiFetchBlob: apiFetchBlob,
    apiErrorMessage: apiErrorMessage,
    jstDateKey: jstDateKey,
    addDaysKey: addDaysKey,
    fmtSavedAt: fmtSavedAt,
    uid: uid,
    mdLabel: mdLabel,
    makeStatusSetter: makeStatusSetter,
    askConfirm: askConfirm,
    mkHabitIconBtn: mkHabitIconBtn,
    showView: showView,
    acctPath: acctPath,
    extractPdfText: extractPdfText,
    mailAttachBytes: mailAttachBytes,
    // 契約書のアラート判定は HOME の INBOX でも使うので本体側に置き、ここから渡す。
    CONTRACT_STATUSES: CONTRACT_STATUSES,
    contractStatusIdx: contractStatusIdx,
    contractAlertLabels: contractAlertLabels,
    contractAutoAdvanced: contractAutoAdvanced,
    // 「確認済みにする」で INBOX の件数もその場で消すため（再取得を待たない）。
    refreshHomeContractCounts: applyHomeContractAlerts,
    // 事務ハック(app.jimuhack.js)の計画リスト＝ポータルのタスク(自由タグ「事務ハック」)を使う。
    ensureTasksLoaded: ensureTasksLoaded,
    getTasks: function(){ return tasksState; },
    openNewTaskPreset: openNewTaskPreset,
    openEditTaskById: function(id){
      var t = tasksState.filter(function(x){ return x.id === id; })[0];
      if (t) openEditTask(t);
    },
    toggleTaskDoneById: function(id){
      var t = tasksState.filter(function(x){ return x.id === id; })[0];
      if (t) toggleTaskDone(t, jstDateKey(new Date()));
    }
  };

})();
