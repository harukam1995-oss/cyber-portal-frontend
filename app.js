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

  var mcpPromise = null;
  function getMcp(){
    if (!mcpPromise){
      mcpPromise = (window.claude && typeof window.claude.use === "function")
        ? window.claude.use("mcp")
        : Promise.resolve(null);
    }
    return mcpPromise;
  }

  /* {service} はどのコネクタのエラーかで置き換える(下の mcpErrorMessage 第2引数)。
     4つのコネクタ(Google Calendar / Google Drive / Gmail / AccuWeather)すべてで
     このメッセージ集を共用しているため、コネクタ名を埋め込まない汎用文言にしてある。 */
  var MCP_ERROR_MESSAGES = {
    needs_reauth: "{service}の認証が切れています。claude.aiの設定 → コネクタ から再接続してください。",
    server_not_connected: "{service}が接続されていません。claude.aiの設定 → コネクタ から追加してください。",
    not_granted: "この画面では{service}へのアクセスが許可されていません。",
    capability_disabled: "この環境では{service}連携を利用できません。",
    capability_removed: "この環境では{service}連携を利用できません。",
    blocked_by_policy: "組織のポリシーにより{service}へのアクセスがブロックされています。",
    approval_required: "この操作には承認が必要です。",
    server_unavailable: "{service}サーバーに接続できません。しばらくしてから再度お試しください。",
    selection_required: "複数の{service}接続があります。claude.aiで使用する接続を選択してください。",
    server_not_found: "接続先が見つかりませんでした。",
    upstream_error: "予期しないエラーが発生しました。"
  };
  function mcpErrorMessage(err, service){
    var code = err && err.code;
    var label = service || "連携先";
    var tmpl = MCP_ERROR_MESSAGES[code];
    if (tmpl) return tmpl.replace(/\{service\}/g, label);
    return (err && err.message) || "情報を取得できませんでした";
  }

  // ---- バックエンドAPI(Render) + Firebase Authentication ----
  var API_BASE = "https://cyber-portal-backend.onrender.com";

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
    var res = await fetch(API_BASE + path, Object.assign({}, options, { headers: headers }));
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
    rate_limited: "リクエストが多すぎます。少し待ってから再度お試しください。"
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
  var dowFmt  = new Intl.DateTimeFormat("en-US", { timeZone: JP_TZ, weekday: "short" });

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
    var fmt = new Intl.DateTimeFormat("en-US", { timeZone: JP_TZ, hour:"2-digit", minute:"2-digit", second:"2-digit", hour12:false });
    var parts = fmt.formatToParts(d).reduce(function(acc,p){ acc[p.type]=p.value; return acc; }, {});
    var h = parseInt(parts.hour === "24" ? "0" : parts.hour, 10);
    return { h: h, m: parseInt(parts.minute,10), s: parseInt(parts.second,10) };
  }

  function tick(){
    var now = new Date();
    var tStr = timeFmt.format(now), sStr = secFmt.format(now);
    var mdStr = dateFmt.format(now), yrStr = yearFmt.format(now);
    var dowStr = dowFmt.format(now).toUpperCase();
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

  async function loadWeather(){
    try{
      // 設定画面で地点を変更していれば lat/lon を渡す(未設定なら既定=柏市)。
      var qs = "";
      var wp = settingsState && settingsState.weather;
      if (wp && wp.lat != null && wp.lon != null){
        qs = "?lat=" + encodeURIComponent(wp.lat) +
             "&lon=" + encodeURIComponent(wp.lon) +
             "&place=" + encodeURIComponent(wp.place || "");
      }
      var w = await apiFetch("/api/weather" + qs);
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
    } catch(err){
      paintWeather("柏市 --", null, apiErrorMessage(err, "天気") || "天気を取得できませんでした");
    }
  }
  // 30分ごとに更新
  setInterval(loadWeather, 30 * 60 * 1000);

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

  window.addEventListener("resize", resize);
  resize();

  /* ================= hero illustrations (user-supplied artwork, one shown at random per load) ================= */
  var HERO_ILLUSTRATIONS = [
    "hero1.jpg",
    "hero2.jpg",
    "hero3.jpg",
    "hero4.jpg"
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
  var dotColors = ["#2ce3ff", "#ff2f92", "#8b5cf6", "#3cf2b4", "#ffcf6b"];
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
        dot.className = "sched-dot";
        dot.style.background = dotColors[idx % dotColors.length];
        dot.style.boxShadow = "0 0 6px " + dotColors[idx % dotColors.length];
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

  // ホームの TODAY'S SCHEDULE。バックエンド(/api/google/calendar/today)から取得する。
  // 旧MCPのwatchTool方式は廃止し、読み込み時と更新ボタン押下時に単発フェッチする。
  async function initCalendarWatch(){
    var acct = schedAccount;
    var label = acct === "syslea" ? "SYSLEA" : "はるか";
    if (schedRefreshBtn){ schedRefreshBtn.classList.remove("spinning"); }
    schedList.innerHTML = schedSkeletonHtml(4);
    try{
      var res = await apiFetch(acctPath("/api/google/calendar/today", acct));
      if (acct !== schedAccount) return;
      renderEvents(res.events || []);
      schedSourceLabel.innerHTML = '<span class="live">●</span> Google Calendar 連携中 (' + label + ')';
      schedUpdated.textContent = new Intl.DateTimeFormat("ja-JP", { timeZone: JP_TZ, hour:"2-digit", minute:"2-digit" }).format(new Date()) + " 時点";
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
        var dow = new Intl.DateTimeFormat("en-US", { timeZone: JP_TZ, weekday: "short" }).format(d).toUpperCase();
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

  function habitMdLabel(key){ var p = keyParts(key); return p.m + "/" + p.d; }
  function buildWeekDays(sundayKey){
    var a = []; for (var i = 0; i < 7; i++) a.push(addDaysKey(sundayKey, i)); return a;
  }
  function setHabitStatus(msg, isErr){
    var el = document.getElementById("pv-habit-status");
    if (!el) return;
    el.textContent = msg || "";
    el.hidden = !msg;
    el.classList.toggle("is-err", !!isErr);
  }

  async function loadHabits(){
    var list = document.getElementById("pv-habit-list");
    if (!list) return;
    setHabitStatus("読み込み中…");
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

  function planSetStatus(msg, isErr){
    var el = document.getElementById("pv-plan-status");
    if (!el) return;
    el.textContent = msg || "";
    el.hidden = !msg;
    el.classList.toggle("is-err", !!isErr);
  }

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
    planSetStatus("読み込み中…");
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
    }
  }

  function renderPlan(){
    var list = document.getElementById("pv-plan-list");
    if (!list) return;
    var dateEl = document.getElementById("pv-plan-date");
    if (dateEl) dateEl.textContent = planDateLabel(planDateKey);

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

  /* ================= ビジネス: プロジェクトボード(案件管理, v1) =================
     Firestore に案件定義(cases)を持つ。習慣/テンプレと同じ master-detail 管理モーダル。
     機密フラグ(confidential)は「データ保存とバックアップ」ノートの方針どおり持たせておく
     (現時点は表示上の鍵アイコンのみ。将来のエージェント連携で内容非展開の扱いにする想定)。 */
  var CASE_STATUSES = ["進行中", "計画中", "完了"];
  var CASE_STATUS_COLOR = { "進行中": "var(--cyan)", "計画中": "var(--warn)", "完了": "var(--ok)" };
  var casesState = [];      // [{id,name,client,status,progress,dueDate,confidential,order}]
  var caseEditRows = [];    // 管理モーダルの作業コピー
  var caseDetailIdx = null; // null = 一覧ビュー、数値 = そのプロジェクトの詳細ビュー
  var casesWired = false;

  function caseSetStatus(msg, isErr){
    var el = document.getElementById("pv-cases-status");
    if (!el) return;
    el.textContent = msg || "";
    el.hidden = !msg;
    el.classList.toggle("is-err", !!isErr);
  }

  async function loadCases(){
    var list = document.getElementById("pv-cases-list");
    if (!list) return;
    caseSetStatus("読み込み中…");
    try {
      var res = await apiFetch("/api/cases");
      casesState = res.cases || [];
      renderCases();
      caseSetStatus("");
    } catch (err){
      casesState = [];
      renderCases();
      caseSetStatus(apiErrorMessage(err, "プロジェクトボード"), true);
    }
  }

  function renderCases(){
    var list = document.getElementById("pv-cases-list");
    if (!list) return;
    list.innerHTML = "";
    if (!casesState.length){
      list.innerHTML = '<div class="pv-habit-empty">「管理」からプロジェクトを追加してください。</div>';
      return;
    }
    casesState.forEach(function(c){
      var row = document.createElement("div");
      row.className = "pv-case-row";
      row.style.setProperty("--case-accent", CASE_STATUS_COLOR[c.status] || "var(--cyan)");

      var head = document.createElement("div");
      head.className = "pv-case-head";
      var name = document.createElement("span");
      name.className = "pv-case-name";
      name.textContent = c.name || "(名称未設定)";
      head.appendChild(name);
      if (c.confidential){
        var lock = document.createElement("span");
        lock.className = "pv-case-lock";
        lock.textContent = "🔒";
        lock.title = "機密案件";
        head.appendChild(lock);
      }
      var status = document.createElement("span");
      status.className = "pv-case-status-badge";
      status.textContent = c.status;
      head.appendChild(status);
      row.appendChild(head);

      if (c.client){
        var client = document.createElement("div");
        client.className = "pv-case-client";
        client.textContent = c.client;
        row.appendChild(client);
      }

      var meta = document.createElement("div");
      meta.className = "pv-case-meta";
      var bar = document.createElement("div");
      bar.className = "pv-case-bar";
      var fill = document.createElement("span");
      fill.style.width = c.progress + "%";
      bar.appendChild(fill);
      meta.appendChild(bar);
      var pct = document.createElement("span");
      pct.className = "pv-case-pct";
      pct.textContent = c.progress + "%";
      meta.appendChild(pct);
      if (c.dueDate){
        var due = document.createElement("span");
        due.className = "pv-case-due";
        var p = keyParts(c.dueDate);
        due.textContent = p.m + "/" + p.d + "まで";
        meta.appendChild(due);
      }
      row.appendChild(meta);

      list.appendChild(row);
    });
  }

  /* ---- 管理モーダル (一覧 → タイトルを押して詳細 / 新規作成) ---- */
  function openCaseModal(){
    var modal = document.getElementById("case-modal");
    if (!modal) return;
    var errEl = document.getElementById("case-form-error");
    if (errEl){ errEl.hidden = true; errEl.textContent = ""; }
    caseEditRows = casesState.map(function(c){
      return {
        id: c.id, name: c.name, client: c.client || "",
        status: CASE_STATUSES.indexOf(c.status) !== -1 ? c.status : "進行中",
        progress: c.progress || 0, dueDate: c.dueDate || "",
        confidential: c.confidential === true
      };
    });
    caseDetailIdx = null;
    renderCaseModal();
    modal.hidden = false;
  }
  function closeCaseModal(){
    var modal = document.getElementById("case-modal");
    if (modal) modal.hidden = true;
  }
  function caseModalBack(){
    if (caseDetailIdx != null){ caseDetailIdx = null; renderCaseModal(); }
    else closeCaseModal();
  }
  function caseNewRow(){
    return { id: uid(), name: "", client: "", status: "計画中", progress: 0, dueDate: "", confidential: false };
  }
  function caseHint(r){
    return (r.status || "計画中") + " ・ " + (r.progress || 0) + "%" + (r.confidential ? " ・ 🔒機密" : "");
  }
  function renderCaseModal(){
    var listView = document.getElementById("case-list-view");
    var detailView = document.getElementById("case-detail-view");
    var title = document.getElementById("case-modal-title");
    var inDetail = caseDetailIdx != null && !!caseEditRows[caseDetailIdx];
    if (!inDetail) caseDetailIdx = null;
    if (listView) listView.hidden = inDetail;
    if (detailView) detailView.hidden = !inDetail;
    if (title) title.textContent = inDetail ? "プロジェクトの設定" : "プロジェクトの管理";
    if (inDetail) renderCaseDetailView(caseDetailIdx);
    else renderCaseListView();
  }
  function renderCaseListView(){
    var wrap = document.getElementById("case-rows");
    if (!wrap) return;
    wrap.innerHTML = "";
    if (!caseEditRows.length){
      wrap.innerHTML = '<div class="habit-edit-empty">プロジェクトがありません。「＋ 新規作成」から追加してください。</div>';
      return;
    }
    var single = caseEditRows.length <= 1;
    caseEditRows.forEach(function(r, idx){
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
      hint.textContent = caseHint(r);
      txt.appendChild(nm); txt.appendChild(hint);

      var up = mkHabitIconBtn("↑", "上へ", "", function(e){
        e.stopPropagation();
        if (idx > 0){ var t = caseEditRows[idx - 1]; caseEditRows[idx - 1] = r; caseEditRows[idx] = t; renderCaseListView(); }
      });
      var down = mkHabitIconBtn("↓", "下へ", "", function(e){
        e.stopPropagation();
        if (idx < caseEditRows.length - 1){ var t = caseEditRows[idx + 1]; caseEditRows[idx + 1] = r; caseEditRows[idx] = t; renderCaseListView(); }
      });
      up.hidden = down.hidden = single;
      up.disabled = idx === 0;
      down.disabled = idx === caseEditRows.length - 1;

      var chev = document.createElement("span");
      chev.className = "habit-list-chev";
      chev.textContent = "›";

      row.appendChild(txt); row.appendChild(up); row.appendChild(down); row.appendChild(chev);
      function open(){ caseDetailIdx = idx; renderCaseModal(); }
      row.addEventListener("click", open);
      row.addEventListener("keydown", function(e){ if (e.key === "Enter" || e.key === " "){ e.preventDefault(); open(); } });
      wrap.appendChild(row);
    });
  }
  function renderCaseDetailView(idx){
    var body = document.getElementById("case-detail-body");
    var r = caseEditRows[idx];
    if (!body || !r) return;
    body.innerHTML = "";

    var name = document.createElement("input");
    name.type = "text"; name.className = "habit-edit-name"; name.maxLength = 60;
    name.placeholder = "プロジェクト名"; name.value = r.name || "";
    name.addEventListener("input", function(){ r.name = name.value; });
    body.appendChild(name);

    var client = document.createElement("input");
    client.type = "text"; client.className = "habit-edit-name"; client.maxLength = 60;
    client.placeholder = "クライアント名（任意）"; client.value = r.client || "";
    client.addEventListener("input", function(){ r.client = client.value; });
    body.appendChild(client);

    var lineStatus = document.createElement("div");
    lineStatus.className = "habit-block-line";
    var status = document.createElement("select");
    status.className = "habit-edit-cadence case-edit-status";
    status.innerHTML = CASE_STATUSES.map(function(s){ return '<option value="' + s + '">' + s + "</option>"; }).join("");
    status.value = r.status;
    status.addEventListener("change", function(){ r.status = status.value; });
    var progress = document.createElement("input");
    progress.type = "number"; progress.className = "habit-edit-target case-edit-progress";
    progress.min = "0"; progress.max = "100"; progress.value = String(r.progress || 0);
    progress.setAttribute("aria-label", "進捗率(%)");
    progress.addEventListener("input", function(){ r.progress = Math.max(0, Math.min(100, Math.round(Number(progress.value) || 0))); });
    var progressLabel = document.createElement("span");
    progressLabel.className = "case-edit-progress-label";
    progressLabel.textContent = "%";
    lineStatus.appendChild(status); lineStatus.appendChild(progress); lineStatus.appendChild(progressLabel);
    body.appendChild(lineStatus);

    var due = document.createElement("input");
    due.type = "date"; due.className = "case-edit-due";
    due.value = r.dueDate || "";
    due.setAttribute("aria-label", "期限（任意）");
    due.addEventListener("input", function(){ r.dueDate = due.value; });
    body.appendChild(due);

    var lineMisc = document.createElement("div");
    lineMisc.className = "habit-block-line";
    var conf = document.createElement("label");
    conf.className = "habit-pause";
    var ccb = document.createElement("input");
    ccb.type = "checkbox"; ccb.checked = r.confidential === true;
    ccb.addEventListener("change", function(){ r.confidential = ccb.checked; });
    conf.appendChild(ccb);
    conf.appendChild(document.createTextNode(" 機密案件（クライアントの秘密情報を含む）"));
    lineMisc.appendChild(conf);
    body.appendChild(lineMisc);
  }

  async function onCaseModalSubmit(e){
    e.preventDefault();
    var errEl = document.getElementById("case-form-error");
    var saveBtn = document.getElementById("case-save");
    if (errEl){ errEl.hidden = true; errEl.textContent = ""; }
    function showErr(msg){ if (errEl){ errEl.textContent = msg; errEl.hidden = false; } }
    function failAt(i, msg){ caseDetailIdx = i; renderCaseModal(); showErr(msg); }
    var cleaned = [];
    for (var i = 0; i < caseEditRows.length; i++){
      var r = caseEditRows[i];
      var nm = (r.name || "").trim();
      if (!nm){ failAt(i, "プロジェクト名を入力してください。"); return; }
      cleaned.push({
        id: r.id, name: nm.slice(0, 60), client: (r.client || "").trim().slice(0, 60),
        status: CASE_STATUSES.indexOf(r.status) !== -1 ? r.status : "計画中",
        progress: Math.max(0, Math.min(100, Math.round(Number(r.progress) || 0))),
        dueDate: r.dueDate || "", confidential: r.confidential === true
      });
    }
    if (saveBtn){ saveBtn.disabled = true; saveBtn.textContent = "保存中…"; }
    try {
      await apiFetch("/api/cases/bulk", { method: "PUT", body: JSON.stringify({ cases: cleaned }) });
      closeCaseModal();
      loadCases();
    } catch (err){
      if (errEl){ errEl.textContent = apiErrorMessage(err, "プロジェクトボード"); errEl.hidden = false; }
    } finally {
      if (saveBtn){ saveBtn.disabled = false; saveBtn.textContent = "保存"; }
    }
  }

  function wireCases(){
    if (casesWired) return;
    casesWired = true;
    var manageBtn = document.getElementById("pv-cases-manage");
    if (manageBtn) manageBtn.addEventListener("click", openCaseModal);

    var modal = document.getElementById("case-modal");
    var closeBtn = document.getElementById("case-modal-close");
    var cancelBtn = document.getElementById("case-cancel");
    var newBtn = document.getElementById("case-new");
    var backBtn = document.getElementById("case-detail-back");
    var delBtn = document.getElementById("case-detail-del");
    var form = document.getElementById("case-form");
    if (closeBtn) closeBtn.addEventListener("click", closeCaseModal);
    if (cancelBtn) cancelBtn.addEventListener("click", closeCaseModal);
    if (modal) modal.addEventListener("click", function(e){ if (e.target === modal) closeCaseModal(); });
    if (newBtn) newBtn.addEventListener("click", function(){
      caseEditRows.push(caseNewRow());
      caseDetailIdx = caseEditRows.length - 1;
      renderCaseModal();
    });
    if (backBtn) backBtn.addEventListener("click", function(){ caseDetailIdx = null; renderCaseModal(); });
    if (delBtn) delBtn.addEventListener("click", async function(){
      if (caseDetailIdx == null) return;
      var r = caseEditRows[caseDetailIdx];
      if (r && r.name && !(await askConfirm('「' + r.name + '」を削除しますか?'))) return;
      caseEditRows.splice(caseDetailIdx, 1);
      caseDetailIdx = null;
      renderCaseModal();
    });
    if (form) form.addEventListener("submit", onCaseModalSubmit);
  }

  /* ================= ビジネス: 契約書トラッカー(v1) =================
     営業から依頼される契約書送付の進捗を管理する。案件管理(cases)と同じ master-detail 管理モーダル。
     「締結済み」「報告済み」以外(＝依頼受領／送付済み)はカード側で未締結として強調表示する。 */
  var CONTRACT_STATUSES = ["依頼受領", "送付済み", "締結済み", "報告済み"];
  var CONTRACT_STATUS_COLOR = { "依頼受領": "var(--warn)", "送付済み": "var(--cyan)", "締結済み": "var(--ok)", "報告済み": "var(--violet)" };
  var contractsState = [];      // [{id,title,client,requestedBy,status,dueDate,confidential,order}]
  var contractEditRows = [];    // 管理モーダルの作業コピー
  var contractDetailIdx = null; // null = 一覧ビュー、数値 = その契約書の詳細ビュー
  var contractsWired = false;

  function contractSetStatus(msg, isErr){
    var el = document.getElementById("pv-contracts-status");
    if (!el) return;
    el.textContent = msg || "";
    el.hidden = !msg;
    el.classList.toggle("is-err", !!isErr);
  }

  async function loadContracts(){
    var list = document.getElementById("pv-contracts-list");
    if (!list) return;
    contractSetStatus("読み込み中…");
    try {
      var res = await apiFetch("/api/contracts");
      contractsState = res.contracts || [];
      renderContracts();
      contractSetStatus("");
    } catch (err){
      contractsState = [];
      renderContracts();
      contractSetStatus(apiErrorMessage(err, "契約書トラッカー"), true);
    }
  }

  function renderContracts(){
    var list = document.getElementById("pv-contracts-list");
    if (!list) return;
    list.innerHTML = "";
    if (!contractsState.length){
      list.innerHTML = '<div class="pv-habit-empty">「管理」から契約書を追加してください。</div>';
      return;
    }
    var todayKey = jstDateKey(new Date());
    contractsState.forEach(function(c){
      var pending = c.status !== "締結済み" && c.status !== "報告済み";
      var overdue = pending && c.dueDate && c.dueDate < todayKey;
      var row = document.createElement("div");
      row.className = "pv-contract-row" + (pending ? " is-pending" : "") + (overdue ? " is-overdue" : "");
      row.style.setProperty("--contract-accent", CONTRACT_STATUS_COLOR[c.status] || "var(--cyan)");

      var head = document.createElement("div");
      head.className = "pv-case-head";
      var name = document.createElement("span");
      name.className = "pv-case-name";
      name.textContent = c.title || "(名称未設定)";
      head.appendChild(name);
      if (c.confidential){
        var lock = document.createElement("span");
        lock.className = "pv-case-lock";
        lock.textContent = "🔒";
        lock.title = "機密案件";
        head.appendChild(lock);
      }
      if (pending){
        var alert = document.createElement("span");
        alert.className = "pv-contract-alert";
        alert.textContent = overdue ? "⚠ 期限超過" : "⚠ 未締結";
        head.appendChild(alert);
      }
      var status = document.createElement("span");
      status.className = "pv-case-status-badge";
      status.style.setProperty("--case-accent", CONTRACT_STATUS_COLOR[c.status] || "var(--cyan)");
      status.textContent = c.status;
      head.appendChild(status);
      row.appendChild(head);

      var metaLine = [];
      if (c.client) metaLine.push(c.client);
      if (c.requestedBy) metaLine.push(c.requestedBy + " 依頼");
      if (c.dueDate){ var p = keyParts(c.dueDate); metaLine.push(p.m + "/" + p.d + "まで"); }
      if (metaLine.length){
        var meta = document.createElement("div");
        meta.className = "pv-case-client";
        meta.textContent = metaLine.join(" ・ ");
        row.appendChild(meta);
      }

      list.appendChild(row);
    });
  }

  /* ---- 管理モーダル (一覧 → タイトルを押して詳細 / 新規作成) ---- */
  function openContractModal(){
    var modal = document.getElementById("contract-modal");
    if (!modal) return;
    var errEl = document.getElementById("contract-form-error");
    if (errEl){ errEl.hidden = true; errEl.textContent = ""; }
    contractEditRows = contractsState.map(function(c){
      return {
        id: c.id, title: c.title, client: c.client || "", requestedBy: c.requestedBy || "",
        status: CONTRACT_STATUSES.indexOf(c.status) !== -1 ? c.status : "依頼受領",
        dueDate: c.dueDate || "", confidential: c.confidential === true
      };
    });
    contractDetailIdx = null;
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
    return { id: uid(), title: "", client: "", requestedBy: "", status: "依頼受領", dueDate: "", confidential: false };
  }
  function contractHint(r){
    var pending = r.status !== "締結済み" && r.status !== "報告済み";
    return (r.status || "依頼受領") + (pending ? " ・ ⚠未締結" : "") + (r.confidential ? " ・ 🔒機密" : "");
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
      nm.textContent = (r.title || "").trim() || "（名称未設定）";
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

    var title = document.createElement("input");
    title.type = "text"; title.className = "habit-edit-name"; title.maxLength = 80;
    title.placeholder = "契約書名（例：A社 業務委託契約書）"; title.value = r.title || "";
    title.addEventListener("input", function(){ r.title = title.value; });
    body.appendChild(title);

    var client = document.createElement("input");
    client.type = "text"; client.className = "habit-edit-name"; client.maxLength = 60;
    client.placeholder = "クライアント名（任意）"; client.value = r.client || "";
    client.addEventListener("input", function(){ r.client = client.value; });
    body.appendChild(client);

    var requestedBy = document.createElement("input");
    requestedBy.type = "text"; requestedBy.className = "habit-edit-name"; requestedBy.maxLength = 40;
    requestedBy.placeholder = "依頼者（例：営業 山田）（任意）"; requestedBy.value = r.requestedBy || "";
    requestedBy.addEventListener("input", function(){ r.requestedBy = requestedBy.value; });
    body.appendChild(requestedBy);

    var lineStatus = document.createElement("div");
    lineStatus.className = "habit-block-line";
    var status = document.createElement("select");
    status.className = "habit-edit-cadence case-edit-status";
    status.innerHTML = CONTRACT_STATUSES.map(function(s){ return '<option value="' + s + '">' + s + "</option>"; }).join("");
    status.value = r.status;
    status.addEventListener("change", function(){ r.status = status.value; });
    var due = document.createElement("input");
    due.type = "date"; due.className = "case-edit-due";
    due.value = r.dueDate || "";
    due.setAttribute("aria-label", "期限（任意）");
    due.addEventListener("input", function(){ r.dueDate = due.value; });
    lineStatus.appendChild(status); lineStatus.appendChild(due);
    body.appendChild(lineStatus);

    var lineMisc = document.createElement("div");
    lineMisc.className = "habit-block-line";
    var conf = document.createElement("label");
    conf.className = "habit-pause";
    var ccb = document.createElement("input");
    ccb.type = "checkbox"; ccb.checked = r.confidential === true;
    ccb.addEventListener("change", function(){ r.confidential = ccb.checked; });
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
    var cleaned = [];
    for (var i = 0; i < contractEditRows.length; i++){
      var r = contractEditRows[i];
      var nm = (r.title || "").trim();
      if (!nm){ failAt(i, "契約書名を入力してください。"); return; }
      cleaned.push({
        id: r.id, title: nm.slice(0, 80), client: (r.client || "").trim().slice(0, 60),
        requestedBy: (r.requestedBy || "").trim().slice(0, 40),
        status: CONTRACT_STATUSES.indexOf(r.status) !== -1 ? r.status : "依頼受領",
        dueDate: r.dueDate || "", confidential: r.confidential === true
      });
    }
    if (saveBtn){ saveBtn.disabled = true; saveBtn.textContent = "保存中…"; }
    try {
      await apiFetch("/api/contracts/bulk", { method: "PUT", body: JSON.stringify({ contracts: cleaned }) });
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
    if (manageBtn) manageBtn.addEventListener("click", openContractModal);

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

  /* ================= ビジネス画面 (v1) =================
     TODAY は共通ロジック(tick)が biz 要素も更新する。ここではヒーロー画像・
     プロジェクトボード(案件管理)・最近のメモ(SYSLEA タグ)を担当。 */
  function initBusiness(){
    var img = document.getElementById("biz-hero-img");
    if (img && !img.getAttribute("src") && HERO_ILLUSTRATIONS.length){
      img.src = HERO_ILLUSTRATIONS[Math.floor(Math.random() * HERO_ILLUSTRATIONS.length)];
    }
    wireCases();
    loadCases();
    wireContracts();
    loadContracts();
    var noteNewBtn = document.getElementById("biz-note-new");
    if (noteNewBtn) noteNewBtn.addEventListener("click", function(){ openNewNote("syslea"); });
    if (!notesInitialized){
      notesInitialized = true;
      initNotes();
    } else {
      renderBizNotes();
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
  function formatDateLabelShort(key){
    var p = keyParts(key);
    return p.m + "/" + p.d;
  }
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
  var mailState = { account: "haruka", filter: "all", pageIndex: 0, query: "" };
  var MAIL_PAGE_SIZE = 20;
  var mailList = document.getElementById("mail-list");
  var mailPager = document.getElementById("mail-pager");
  var mailPagerInfo = document.getElementById("mail-pager-info");
  var mailPrevBtn = document.getElementById("mail-prev");
  var mailNextBtn = document.getElementById("mail-next");
  var mailModal = document.getElementById("mail-modal");
  var mailModalTitle = document.getElementById("mail-modal-title");
  var mailDetailBody = document.getElementById("mail-detail-body");
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
    if (mailState.query) params += "&q=" + encodeURIComponent(mailState.query);
    apiFetch(acctPath("/api/google/gmail/messages" + params, mailState.account)).then(function(res){
      var messages = res.messages || [];
      harukaMailItems = messages.map(function(m){
        return {
          threadId: m.threadId,
          from: m.from || "(不明な送信者)",
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
    fetchMailPage();
  }

  function loadHarukaMail(){
    if (harukaMailLoading) return;
    if (harukaMailItems !== null && !harukaMailError){ renderMailList(); return; }
    reloadMailFromFirstPage();
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
      setMailStatus('<span class="live">●</span> Gmail 連携中(' + escapeHtml(label) + ')', "");
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
      var emptyMsg = mailState.query
        ? "「" + mailState.query + "」に一致するメールはありません"
        : (mailState.filter === "unread" ? "未読メールはありません" : "メールはありません");
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
  function closeMailModal(){
    mailModal.hidden = true;
    document.body.style.overflow = "";
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

  var mailSearchInput = document.getElementById("mail-search");

  wireAcctTabs("mail-acct-tabs", function(){ return mailState.account; }, function(acct){
    mailState.account = acct;
    mailState.filter = "all";
    mailState.query = "";
    if (mailSearchInput) mailSearchInput.value = "";
    document.querySelectorAll("#mail-filter-tabs .acct-tab").forEach(function(b){
      b.classList.toggle("active", b.getAttribute("data-filter") === "all");
    });
    reloadMailFromFirstPage();
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

  /* ================= scheduled question check-in (spreadsheet-driven, saves to Obsidian via Google Drive) =================
     Question definitions live in a Google Sheet ("ポータル質問表", Vault② direct child,
     2 tabs: 質問マスタ / 選択肢マスタ) — NOT in this code. To add, change, or disable a
     question, edit that spreadsheet; this code only needs to change if the column
     layout itself changes. The two tabs are told apart by their header row content
     (質問文 vs 選択肢文), not by tab order or tab name, so reordering/renaming tabs
     in the sheet is safe.
     Each enabled question with a 表示時刻 is shown once its time has passed (JST),
     once per day, in the order it appears in the sheet. A choice's 動作 can be
     即保存/類似の文言 (save immediately), スヌーズを含む文言 (ask again after N
     minutes), or 追加入力して保存 (ask a follow-up before saving) — matched loosely
     by substring since it's free text she types into the sheet. That follow-up's
     追加質問ID is looked up against 質問マスタ: if it matches an existing question
     id the conversation chains into that question (so multi-step flows work without
     any code change — just add rows to the sheet), otherwise the text itself is used
     as a one-off follow-up prompt. Chain depth is capped (see QUESTION_CHAIN_DEPTH_LIMIT)
     so a mistaken circular 追加質問ID in the sheet can't hang the conversation.
     Whether "today" is already answered is checked against Google Drive itself
     (search_files for today's file in that question's own vault folder) so
     answering on one device is recognised on another; localStorage is only a
     same-device fast path plus per-device snooze memory. */
  var QUESTION_SHEET_ID = "1Hfc97Uo_nzW8N5yZ9lvoBb40ywhSVNci9I_IhwyImKA"; // Vault② ▸ ポータル質問表
  var QUESTION_FOLDERS = {
    "デイリー": "1k0_AMImmv5ex-E9SkrRywTMU-qZecTqK",
    "プライベート": "1HK5EjNXT9pSVB_oPKemYiaI_8nYw0irA",
    "仕事": "1-H0tm8g1TS7zHklXJOINOi7TDzVkRxl1",
    "ナレッジ": "1UoL-ZMCZJjU-Z20ma7wSUG71j_JAxxgB"
  };
  var QUESTION_CHAIN_DEPTH_LIMIT = 5;

  var lunchModal = document.getElementById("lunch-modal");
  var heroScene = document.getElementById("hero-scene");
  var lunchTitle = document.getElementById("lunch-modal-title");
  var lunchChat = document.getElementById("lunch-chat");
  var lunchQuickReplies = document.getElementById("lunch-quick-replies");
  var lunchInputRow = document.getElementById("lunch-input-row");
  var lunchWhatInput = document.getElementById("lunch-what-input");
  var lunchCloseBtn = document.getElementById("lunch-modal-close");
  var lunchPending = false; // true while waiting on a choice click or an in-flight save

  // read_file_content returns one markdown table per sheet tab, blank-line separated.
  // Each table's own first data-ish row is treated as its header row (Drive's
  // conversion doesn't mark a header specially — it may also emit an extra blank
  // "|  |  | ..." row and an alignment "| :-: | :-: | ..." row before it, both
  // filtered out here as "structural" rows).
  function parseMarkdownTables(text){
    var blocks = String(text || "").split(/\n\s*\n/).map(function(b){ return b.trim(); }).filter(Boolean);
    var tables = [];
    blocks.forEach(function(block){
      var rows = [];
      block.split("\n").forEach(function(line){
        line = line.trim();
        if (!line) return;
        var cells = line.replace(/^\|/, "").replace(/\|$/, "").split("|").map(function(c){ return c.trim(); });
        var isStructural = cells.every(function(c){ return c === "" || /^:?-+:?$/.test(c); });
        if (!isStructural) rows.push(cells);
      });
      if (!rows.length) return;
      var headers = rows[0];
      var dataRows = rows.slice(1).map(function(cells){
        var obj = {};
        headers.forEach(function(h, i){ obj[h] = cells[i] !== undefined ? cells[i] : ""; });
        return obj;
      });
      tables.push({ headers: headers, rows: dataRows });
    });
    return tables;
  }

  var questionTableCache = null; // cached for this page load only
  async function loadQuestionTable(){
    if (questionTableCache) return questionTableCache;
    var mcp = await getMcp();
    if (!mcp) return null;
    var res;
    try{
      res = await mcp.callTool("Google Drive", "read_file_content", { fileId: QUESTION_SHEET_ID });
    } catch(e){
      return null; // sheet unreachable — fail open, just don't ask anything this load
    }
    var text = res && res.payload && res.payload.fileContent;
    if (!text) return null;
    var tables = parseMarkdownTables(text);
    var qTable = tables.filter(function(t){ return t.headers.indexOf("質問文") !== -1; })[0];
    var cTable = tables.filter(function(t){ return t.headers.indexOf("選択肢文") !== -1; })[0];
    var questions = {};
    var errors = [];
    (qTable ? qTable.rows : []).forEach(function(r){
      var id = (r["質問ID"] || "").trim();
      if (!id) return;
      questions[id] = {
        id: id,
        text: (r["質問文"] || "").trim(),
        time: (r["表示時刻"] || "").trim(), // 空欄＝チェーン専用、この質問だけでは自動出題しない
        folder: (r["保存先"] || "").trim(),
        enabled: /^true$/i.test((r["有効"] || "").trim()),
        choices: []
      };
    });
    (cTable ? cTable.rows : []).forEach(function(r){
      var qid = (r["質問ID"] || "").trim();
      if (!questions[qid]){
        errors.push("選択肢マスタの質問ID「" + qid + "」が質問マスタに見つかりません。この選択肢は無視されます。");
        return;
      }
      var action = (r["動作"] || "").trim();
      var type = "save";
      if (action.indexOf("スヌーズ") !== -1) type = "snooze";
      else if (action.indexOf("追加入力") !== -1) type = "followup";
      var snoozeMinutes = parseInt(r["スヌーズ分数"], 10);
      questions[qid].choices.push({
        label: (r["選択肢文"] || "").trim(),
        type: type,
        nextRef: (r["追加質問ID"] || "").trim(), // 質問マスタの既存IDならチェーン、それ以外は追加質問の文言として使う
        snoozeMinutes: isFinite(snoozeMinutes) && snoozeMinutes > 0 ? snoozeMinutes : 60
      });
    });
    questionTableCache = { questions: questions, errors: errors };
    return questionTableCache;
  }

  function questionStateKey(qid){ return "cyberportal_q_" + qid; }
  function readQuestionState(qid){
    try{
      var raw = localStorage.getItem(questionStateKey(qid));
      return raw ? JSON.parse(raw) : {};
    } catch(e){ return {}; }
  }
  function writeQuestionState(qid, state){
    try{ localStorage.setItem(questionStateKey(qid), JSON.stringify(state)); } catch(e){}
  }

  // Cross-device "already answered today" check: looks for today's file
  // (title pattern "{date} {質問ID}.md") inside the question's own vault folder.
  async function questionAlreadyAnsweredToday(question, todayKey){
    var mcp = await getMcp();
    if (!mcp) return false; // can't check — fail open and just show the prompt
    var folderId = QUESTION_FOLDERS[question.folder];
    if (!folderId) return false;
    try{
      var res = await mcp.callTool("Google Drive", "search_files", {
        query: "parentId = '" + folderId + "' and title contains '" + todayKey + "' and title contains '" + question.id + "'",
        pageSize: 1
      });
      return !!(res && res.payload && res.payload.files && res.payload.files.length);
    } catch(e){
      return false; // fail open rather than silently never asking
    }
  }

  async function saveQuestionRecord(rootQuestion, answerLog){
    var now = new Date();
    var todayKey = jstDateKey(now);
    var timeLabel = new Intl.DateTimeFormat("ja-JP", { timeZone: JP_TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
    var folderId = QUESTION_FOLDERS[rootQuestion.folder];
    if (!folderId) throw { message: "保存先「" + rootQuestion.folder + "」がフォルダ設定に見つかりません。" };
    var lines = ["# " + rootQuestion.text + " " + todayKey, ""];
    answerLog.forEach(function(step){
      lines.push("- " + step.label + (step.extra ? "：" + step.extra : ""));
    });
    lines.push("- 記録時刻: " + timeLabel);
    var mcp = await getMcp();
    if (!mcp) throw { code: "not_granted" };
    await mcp.callTool("Google Drive", "create_file", {
      title: todayKey + " " + rootQuestion.id + ".md",
      textContent: lines.join("\n") + "\n",
      contentMimeType: "text/markdown",
      disableConversionToGoogleType: true,
      parentId: folderId
    });
    writeQuestionState(rootQuestion.id, { date: todayKey, answered: true });
  }

  function lunchAppend(from, text){
    var msg = document.createElement("div");
    msg.className = "lunch-msg " + from;
    msg.textContent = text;
    lunchChat.appendChild(msg);
    lunchChat.scrollTop = lunchChat.scrollHeight;
    return msg;
  }
  function closeLunchModal(){
    lunchModal.hidden = true;
    heroScene.setAttribute("aria-hidden", "true"); // restore decorative state for the skyline/illustration
  }

  // --- conversation driver: asks each queued top-level question in turn, following
  //     a 追加質問ID chain within a question before moving to the next queued one ---
  var questionRunner = null;

  function renderChoices(question){
    lunchQuickReplies.innerHTML = "";
    if (!question.choices.length){
      // no choices defined (chain-only sub-question) — free text only
      lunchQuickReplies.hidden = true;
      lunchInputRow.hidden = false;
      questionRunner.awaitingFreeText = false;
      lunchWhatInput.value = "";
      lunchWhatInput.focus();
      return;
    }
    lunchInputRow.hidden = true;
    lunchQuickReplies.hidden = false;
    question.choices.forEach(function(choice, i){
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "lunch-reply-btn";
      btn.textContent = choice.label;
      btn.setAttribute("data-choice-index", String(i));
      lunchQuickReplies.appendChild(btn);
    });
  }

  function askQuestion(qid){
    var question = questionRunner.questions[qid];
    if (!question){ advanceQueue(); return; } // dangling chain reference — skip, don't get stuck
    questionRunner.currentQuestion = question;
    lunchTitle.textContent = questionRunner.rootQuestion.text;
    lunchAppend("bot", question.text);
    renderChoices(question);
    lunchPending = false;
  }

  function advanceQueue(){
    questionRunner.queueIndex += 1;
    if (questionRunner.queueIndex >= questionRunner.queue.length){
      closeLunchModal();
      return;
    }
    startTopLevelQuestion(questionRunner.queue[questionRunner.queueIndex]);
  }

  function finishWithSave(){
    saveQuestionRecord(questionRunner.rootQuestion, questionRunner.answerLog)
      .then(function(){ lunchAppend("bot", "保存したよ！"); advanceQueue(); })
      .catch(function(err){ lunchAppend("err", mcpErrorMessage(err, "Google Drive") || "保存に失敗しました。"); lunchPending = false; });
  }

  function startTopLevelQuestion(qid){
    questionRunner.rootQuestion = questionRunner.questions[qid];
    questionRunner.answerLog = [];
    questionRunner.depth = 0;
    askQuestion(qid);
  }

  lunchQuickReplies.addEventListener("click", function(e){
    var btn = e.target.closest(".lunch-reply-btn");
    if (!btn || lunchPending || !questionRunner) return;
    var choice = questionRunner.currentQuestion.choices[Number(btn.getAttribute("data-choice-index"))];
    if (!choice) return;
    lunchPending = true;
    lunchAppend("user", choice.label);
    lunchQuickReplies.hidden = true;

    if (choice.type === "snooze"){
      var todayKey = jstDateKey(new Date());
      writeQuestionState(questionRunner.rootQuestion.id, { date: todayKey, snoozeUntil: Date.now() + choice.snoozeMinutes * 60 * 1000 });
      lunchAppend("bot", choice.snoozeMinutes + "分後にまた聞くね。");
      advanceQueue();
      return;
    }
    if (choice.type === "followup"){
      questionRunner.answerLog.push({ label: choice.label, extra: "" });
      var nextQuestion = questionRunner.questions[choice.nextRef];
      if (nextQuestion && questionRunner.depth < QUESTION_CHAIN_DEPTH_LIMIT){
        questionRunner.depth += 1;
        askQuestion(choice.nextRef);
        return;
      }
      // 追加質問IDが質問マスタの既存IDと一致しない → そのまま追加質問の文言として使う
      lunchAppend("bot", choice.nextRef || "詳しく教えて");
      questionRunner.awaitingFreeText = true;
      lunchInputRow.hidden = false;
      lunchWhatInput.value = "";
      lunchWhatInput.focus();
      lunchPending = false;
      return;
    }
    // "save" (即保存など) — 追加入力なしで確定保存
    questionRunner.answerLog.push({ label: choice.label, extra: "" });
    finishWithSave();
  });

  lunchInputRow.addEventListener("submit", function(e){
    e.preventDefault();
    if (!questionRunner) return;
    var text = lunchWhatInput.value.trim();
    if (!text) return;
    lunchAppend("user", text);
    lunchInputRow.hidden = true;
    lunchPending = true;
    if (questionRunner.awaitingFreeText && questionRunner.answerLog.length){
      questionRunner.answerLog[questionRunner.answerLog.length - 1].extra = text;
    } else {
      questionRunner.answerLog.push({ label: questionRunner.currentQuestion.text, extra: text });
    }
    finishWithSave();
  });

  async function maybeShowQuestionPrompts(){
    var table = await loadQuestionTable();
    if (!table) return;
    if (table.errors.length && window.console){
      table.errors.forEach(function(msg){ console.warn("[質問表]", msg); });
    }

    var todayKey = jstDateKey(new Date());
    var nowHHMM = Number(new Intl.DateTimeFormat("en-GB", { timeZone: JP_TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date()).replace(":", ""));
    var queue = [];
    var ids = Object.keys(table.questions);
    for (var i = 0; i < ids.length; i++){
      var q = table.questions[ids[i]];
      if (!q.enabled || !q.time) continue; // 表示時刻が空欄＝チェーン専用、自動出題しない
      var timeParts = q.time.split(":");
      var qHHMM = Number((timeParts[0] || "0").padStart(2, "0") + (timeParts[1] || "0").padStart(2, "0"));
      if (isNaN(qHHMM) || nowHHMM < qHHMM) continue;

      var state = readQuestionState(q.id);
      if (state.date !== todayKey) state = { date: todayKey };
      if (state.answered) continue; // same-device fast path, skips the Drive call
      if (state.snoozeUntil && Date.now() < state.snoozeUntil) continue;
      if (await questionAlreadyAnsweredToday(q, todayKey)){
        writeQuestionState(q.id, { date: todayKey, answered: true });
        continue;
      }
      queue.push(q.id);
    }
    if (!queue.length) return;

    questionRunner = { questions: table.questions, queue: queue, queueIndex: 0, currentQuestion: null, rootQuestion: null, answerLog: [], depth: 0, awaitingFreeText: false };
    lunchChat.innerHTML = "";
    lunchModal.hidden = false;
    heroScene.setAttribute("aria-hidden", "false"); // it's a real interactive dialogue now, not decorative art
    startTopLevelQuestion(queue[0]);
  }

  lunchCloseBtn.addEventListener("click", closeLunchModal);

  maybeShowQuestionPrompts();

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
  var editingTaskId = null; // null = creating a new task
  var taskFormTag = "haruka";
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
    if (task.due){
      var due = document.createElement("span");
      due.className = "task-due";
      due.setAttribute("data-overdue", String(!task.done && task.due < todayKey));
      due.textContent = task.due.slice(5).replace("-", "/");
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
    taskList.innerHTML = "";
    var items = tasksState.filter(function(t){ return taskFilterTag === "all" || t.tag === taskFilterTag; });
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
  function openNewTask(){
    editingTaskId = null;
    taskModalTitle.textContent = "新規タスク";
    taskTitleInput.value = "";
    taskDueInput.value = "";
    taskRepeatInput.value = "none";
    setWeekdayPicker([]);
    taskMonthdayInput.value = "";
    updateRepeatDetailVisibility();
    taskUrlInput.value = "";
    taskRemarksInput.value = "";
    taskFormTag = "haruka";
    setActiveTab("task-tag-tabs", "haruka");
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
    var fields = {
      text: text,
      due: taskDueInput.value || null,
      tag: taskFormTag,
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

  document.addEventListener("keydown", function(e){
    if (e.key === "Escape"){
      if (!eventModal.hidden) closeEventModal();
      else if (!mailModal.hidden) closeMailModal();
      else if (!noteModal.hidden) closeNoteModal();
      else if (!taskModal.hidden) closeTaskModal();
      else if (!confirmModal.hidden) closeConfirmModal(false);
      else if (settingsModal && !settingsModal.hidden) closeSettings();
      else {
        var finModal = document.getElementById("finance-modal");
        var habModal = document.getElementById("habit-modal");
        var habPop = document.getElementById("habit-count-pop");
        var planModal = document.getElementById("plan-modal");
        var planApply = document.getElementById("plan-apply-modal");
        var caseModal = document.getElementById("case-modal");
        var contractModal = document.getElementById("contract-modal");
        if (planApply && !planApply.hidden) closePlanApply("cancel");
        else if (finModal && !finModal.hidden) closeFinanceModal();
        else if (habModal && !habModal.hidden) habitModalBack();
        else if (planModal && !planModal.hidden) planModalBack();
        else if (caseModal && !caseModal.hidden) caseModalBack();
        else if (contractModal && !contractModal.hidden) contractModalBack();
        else if (habPop && !habPop.hidden) closeHabitCountPop(false);
      }
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
  function warmOnAuthReady(){
    loadSettings();
    loadGmailUnreadCount();
    loadHarukaMail();
    initCalendarWatch();
    warmCalendarView();
    loadWeather();
    checkReauthReminder();
    refreshNotifCenter();
  }
  document.addEventListener("cyberportal:authready", warmOnAuthReady);
  // 未読件数を定期的に取り直す(通知センター/デスクトップ通知のため)。
  setInterval(function(){ if (window.__cyberPortalAuth && window.__cyberPortalAuth.currentUser) loadGmailUnreadCount(); }, 3 * 60 * 1000);
  // 既にログイン済みの状態でこのスクリプトが後から評価されるケース
  // (モジュールスクリプトの実行順は保証されないため)にも対応する。
  if (window.__cyberPortalAuth && window.__cyberPortalAuth.currentUser){
    warmOnAuthReady();
  }

})();
