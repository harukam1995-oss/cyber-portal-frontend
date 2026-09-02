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

  var API_ERROR_MESSAGES = {
    unauthenticated: "ログインが必要です。画面を再読み込みしてください。",
    invalid_token: "認証の有効期限が切れました。再ログインしてください。",
    google_not_connected: "{service}との連携が完了していません。設定から連携してください。",
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
    elTime.textContent = timeFmt.format(now);
    elSec.textContent = secFmt.format(now);
    elMd.textContent = dateFmt.format(now);
    elYr.textContent = yearFmt.format(now);
    elDow.textContent = dowFmt.format(now).toUpperCase();

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

  /* ================= weather (AccuWeather) =================
     柏市固定。locationKey は "Kashiwa, Chiba, Japan" で widgets-search-claude を検索して
     得たもの("柏, 千葉県" / 1509903) をそのまま使う — 毎回検索し直す必要はない。
     気象警報(注意報等)が出ている場合はそれも一言添える。 */
  var WEATHER_LOCATION_KEY = "1509903"; // 柏, 千葉県
  var elWeatherSummary = document.getElementById("weather-summary");
  var elWeatherRange = document.getElementById("weather-range");
  var elWeatherNote = document.getElementById("weather-note");

  async function loadWeather(){
    var mcp = await getMcp();
    if (!mcp){ elWeatherNote.textContent = "天気を取得できませんでした(接続なし)"; return; }
    try{
      var current = await mcp.callTool("AccuWeather®", "widgets-current-claude", {
        queryParams: { locationKey: WEATHER_LOCATION_KEY, unit: "metric", lang: "ja" }
      });
      var daily = await mcp.callTool("AccuWeather®", "widgets-daily-claude", {
        queryParams: { locationKey: WEATHER_LOCATION_KEY, unit: "metric", lang: "ja" }
      });
      var cc = current.payload && current.payload.currentConditions;
      var loc = current.payload && current.payload.location;
      var today = daily.payload && daily.payload.dailyForecast && daily.payload.dailyForecast[0];
      var alerts = (current.payload && current.payload.alerts) || [];

      var placeName = (loc && loc.info && loc.info.name) || "柏, 千葉県";
      var temp = cc ? cc.temperature : "--°";
      var phrase = cc ? cc.phrase : "";
      elWeatherSummary.textContent = placeName + " " + temp + "・" + phrase;

      if (today){
        elWeatherRange.textContent = today.day.displayTemperature + " / " + today.night.displayTemperature;
      }

      if (alerts.length){
        elWeatherNote.textContent = "⚠ " + alerts.map(function(a){ return a.name; }).join("、") + "が発表されています";
      } else {
        elWeatherNote.textContent = "AccuWeather® 連携中";
      }
    } catch(err){
      elWeatherNote.textContent = mcpErrorMessage(err, "AccuWeather®") || "天気を取得できませんでした";
    }
  }
  // loadWeather(); // 天気機能は今回の移行スコープから除外(AccuWeather無料枠廃止のため)

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

  function renderEvents(events){
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
    if (schedRefreshBtn){ schedRefreshBtn.classList.remove("spinning"); }
    if (acct !== "haruka"){
      schedSourceLabel.textContent = "カレンダー連携: SYSLEAは未対応";
      schedList.innerHTML = '<li class="sched-empty">SYSLEA アカウントのカレンダーは接続できません</li>';
      if (schedRefreshBtn) schedRefreshBtn.disabled = false;
      return;
    }
    schedList.innerHTML = '<li class="sched-empty">読み込み中…</li>';
    try{
      var res = await apiFetch("/api/google/calendar/today");
      if (acct !== schedAccount) return;
      renderEvents(res.events || []);
      schedSourceLabel.innerHTML = '<span class="live">●</span> Google Calendar 連携中 (はるか)';
      schedUpdated.textContent = new Intl.DateTimeFormat("ja-JP", { timeZone: JP_TZ, hour:"2-digit", minute:"2-digit" }).format(new Date()) + " 時点";
    } catch(err){
      if (acct !== schedAccount) return;
      schedSourceLabel.textContent = "カレンダー取得エラー";
      schedList.innerHTML = '<li class="sched-error">' + escapeHtml(apiErrorMessage(err, "Google Calendar")) + '</li>';
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

  /* ================= view routing (HOME ⇄ CALENDAR ⇄ MAIL) ================= */
  var viewHome = document.getElementById("view-home");
  var viewCalendar = document.getElementById("view-calendar");
  var viewMail = document.getElementById("view-mail");
  var viewTasks = document.getElementById("view-tasks");
  var viewNotes = document.getElementById("view-notes");
  var navHome = document.getElementById("nav-home");
  var calInitialized = false;
  var mailInitialized = false;
  var tasksInitialized = false;
  var notesInitialized = false;

  function showView(name){
    viewHome.hidden = name !== "home";
    viewCalendar.hidden = name !== "calendar";
    viewMail.hidden = name !== "mail";
    viewTasks.hidden = name !== "tasks";
    viewNotes.hidden = name !== "notes";
    navHome.classList.toggle("active", name === "home");
    if (name === "calendar" && !calInitialized){
      calInitialized = true;
      loadAndRenderCalendar();
    }
    if (name === "mail" && !mailInitialized){
      mailInitialized = true;
      if (mailState.account === "haruka") loadHarukaMail();
      else renderMailList();
    }
    if (name === "tasks" && !tasksInitialized){
      tasksInitialized = true;
      initTasks();
    }
    if (name === "notes" && !notesInitialized){
      notesInitialized = true;
      initNotes();
    }
    window.scrollTo(0, 0);
  }

  document.getElementById("quick-calendar").addEventListener("click", function(){ showView("calendar"); });
  document.getElementById("quick-mail").addEventListener("click", function(){ showView("mail"); });
  document.getElementById("quick-tasks").addEventListener("click", function(){ showView("tasks"); });
  document.getElementById("quick-notes").addEventListener("click", function(){ showView("notes"); });
  navHome.addEventListener("click", function(e){ e.preventDefault(); showView("home"); });
  document.getElementById("cal-back").addEventListener("click", function(){ showView("home"); });
  document.getElementById("mail-back").addEventListener("click", function(){ showView("home"); });
  document.getElementById("tasks-back").addEventListener("click", function(){ showView("home"); });
  document.getElementById("notes-back").addEventListener("click", function(){ showView("home"); });
  document.querySelectorAll(".nav a[aria-disabled]").forEach(function(a){
    a.addEventListener("click", function(e){ e.preventDefault(); });
  });

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

  async function loadAndRenderCalendar(){
    updateViewButtons();
    var token = ++calLoadToken;
    if (calState.account !== "haruka"){
      setCalStatus("SYSLEA アカウントのカレンダーは接続できません", "err");
      calGridContainer.innerHTML = '<div class="sched-error" style="padding:24px 4px;">SYSLEA アカウントのカレンダーは接続できません(Googleコネクタは1アカウントのみ対応)</div>';
      return;
    }
    var range = getFetchRange();
    var bounds = jstRangeForKeys(range.start, range.endExclusive);
    setCalStatus("読み込み中…", "");
    try{
      var res = await apiFetch("/api/google/calendar/events?start=" + encodeURIComponent(bounds.start) + "&end=" + encodeURIComponent(bounds.end));
      if (token !== calLoadToken) return;
      calState.events = res.events || [];
      calState.loadedCalendarId = "primary";
      renderCalendarView();
      setCalStatus('<span class="live">●</span> Google Calendar 連携中 (はるか)', "");
    } catch(err){
      if (token !== calLoadToken) return;
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
        openEditFormById(el.getAttribute("data-event-id"));
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
        openEditFormById(el.getAttribute("data-event-id"));
      });
    });
  }

  function openEditFormById(id){
    var ev = calState.events.find(function(x){ return x.id === id; });
    if (ev) openEditForm(ev);
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
        await apiFetch("/api/google/calendar/events/" + encodeURIComponent(editingEvent.id), {
          method: "PATCH", body: JSON.stringify(input)
        });
      } else {
        await apiFetch("/api/google/calendar/events", {
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
      await apiFetch("/api/google/calendar/events/" + encodeURIComponent(editingEvent.id), { method: "DELETE" });
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
  var MAIL_DATA = {
    syslea: [
      { from: "田中 (SYSLEA)", initial: "田", subject: "明日の定例MTGの資料共有", snippet: "明日10時からの定例ミーティングで使う資料を共有します。", time: "10:05", unread: true,
        body: "満光さん\n\nお疲れ様です、田中です。\n明日10時からの定例ミーティングで使用する資料を共有します。事前にご確認をお願いします。\n\n※これはダミーデータです。実際のメールではありません。" },
      { from: "情報システム部", initial: "情", subject: "【重要】パスワード定期更新のお願い", snippet: "セキュリティポリシーに基づき、パスワードの更新期限が近づいています。", time: "8:50", unread: true,
        body: "満光様\n\n社内システムのパスワード更新期限が来週に迫っています。\n期限までに更新をお願いいたします。\n\n※これはダミーデータです。実際のメールではありません。" },
      { from: "佐藤マネージャー", initial: "佐", subject: "先日のご提案、ありがとうございました", snippet: "先日の資料、とても分かりやすかったです。来週の…", time: "昨日", unread: false,
        body: "満光さん\n\n先日の提案資料、とても分かりやすくまとまっていました。ありがとうございます。\n来週の打ち合わせで詳細を詰めましょう。\n\n※これはダミーデータです。実際のメールではありません。" },
      { from: "人事部", initial: "人", subject: "年末調整書類の提出について", snippet: "年末調整に必要な書類の提出期限をお知らせします。", time: "3日前", unread: false,
        body: "満光様\n\n年末調整に必要な書類の提出期限は月末までとなっております。\nご協力をお願いいたします。\n\n※これはダミーデータです。実際のメールではありません。" }
    ]
  };

  var mailState = { account: "haruka", filter: "all", pageIndex: 0 };
  var MAIL_PAGE_SIZE = 20;
  var mailList = document.getElementById("mail-list");
  var mailPager = document.getElementById("mail-pager");
  var mailPagerInfo = document.getElementById("mail-pager-info");
  var mailPrevBtn = document.getElementById("mail-prev");
  var mailNextBtn = document.getElementById("mail-next");
  var mailModal = document.getElementById("mail-modal");
  var mailModalTitle = document.getElementById("mail-modal-title");
  var mailDetailBody = document.getElementById("mail-detail-body");
  var mailTag = document.getElementById("mail-tag");
  var mailStatusBar = document.getElementById("mail-status-bar");
  var homeInboxTag = document.getElementById("home-inbox-tag");
  var homeInboxCountBtn = document.getElementById("home-inbox-count-btn");
  var homeInboxCountNum = document.getElementById("home-inbox-count-num");
  var homeInboxCountLabel = document.getElementById("home-inbox-count-label");
  var homeGoogleConnectBtn = document.getElementById("home-google-connect-btn");

  // Gmail/Calendar/DriveへのアクセスはFirebase Authenticationのログインとは別に、
  // 追加のGoogle同意(googleAuth.js)が必要。未連携時はもちろん、連携済みでも
  // トークン失効やスコープ変更に備えて「再連携」ボタンを常時出しておく。
  // 押すとバックエンドから認可URLを取得して遷移する。
  var googleConnecting = false;
  async function startGoogleConnect(){
    googleConnecting = true;
    homeGoogleConnectBtn.disabled = true;
    homeGoogleConnectBtn.textContent = "連携ページへ移動中…";
    try {
      var res = await apiFetch("/api/google/oauth/start");
      if (res && res.url){
        window.location.href = res.url;
      } else {
        throw new Error("認可URLを取得できませんでした。");
      }
    } catch (err) {
      console.error("[google] oauth start failed:", err);
      googleConnecting = false;
      homeGoogleConnectBtn.disabled = false;
      homeGoogleConnectBtn.textContent = "連携に失敗。もう一度";
    }
  }
  homeGoogleConnectBtn.addEventListener("click", startGoogleConnect);

  var harukaMailItems = null; // null = 未取得; [] = 取得済み(空)
  var harukaMailError = null;
  var harukaMailLoading = false;
  var mailPageTokens = [null]; // mailPageTokens[i] = ページ i を取得する pageToken(先頭ページは null)
  var harukaMailNextToken = null;

  // Home画面の「未読件数」表示は、メールページの一覧取得(loadHarukaMail、まだMCP依存で
  // 次の増分まで保留)とは切り離し、バックエンドの軽量な未読件数APIだけを呼ぶ。
  var harukaUnreadCount = null; // null = 未取得
  var harukaUnreadError = null;
  async function loadGmailUnreadCount(){
    try{
      var res = await apiFetch("/api/google/gmail/unread-count");
      harukaUnreadCount = res.unreadCount;
      harukaUnreadError = null;
    } catch(err){
      harukaUnreadError = err;
    }
    renderHomeInbox();
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
    apiFetch("/api/google/gmail/messages" + params).then(function(res){
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

  function updateMailHeaderUI(){
    if (mailState.account === "haruka"){
      mailTag.hidden = true;
      if (harukaMailError){
        setMailStatus(escapeHtml(apiErrorMessage(harukaMailError, "Gmail")), "err");
      } else if (!harukaMailItems){
        setMailStatus("接続確認中…", "");
      } else {
        setMailStatus('<span class="live">●</span> Gmail 連携中(はるか個人)', "");
      }
    } else {
      mailTag.hidden = false;
      mailTag.textContent = "仮データ";
      setMailStatus("Gmailコネクタは1アカウントのみ接続可能なため、SYSLEA側はダミーデータを表示しています", "");
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
    if (mailState.account !== "haruka" || harukaMailError || !harukaMailItems){
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
    mailPagerInfo.textContent = (mailState.filter === "unread" ? "未読 " : "") + (mailState.pageIndex + 1) + " ページ目";
  }

  function renderMailList(){
    updateMailHeaderUI();
    mailList.innerHTML = "";

    if (mailState.account === "haruka"){
      if (harukaMailError){
        mailList.innerHTML = '<li class="sched-error">' + escapeHtml(apiErrorMessage(harukaMailError, "Gmail")) + '</li>';
        updateMailPager();
        return;
      }
      if (!harukaMailItems || harukaMailLoading){
        mailList.innerHTML = '<li class="sched-empty">読み込み中…</li>';
        updateMailPager();
        return;
      }
      if (!harukaMailItems.length){
        mailList.innerHTML = '<li class="sched-empty">' + (mailState.filter === "unread" ? "未読メールはありません" : "メールはありません") + '</li>';
        updateMailPager();
        return;
      }
      harukaMailItems.forEach(function(mail){
        mailList.appendChild(buildMailListItem(mail, function(){ openMailDetail(mail); }));
      });
      updateMailPager();
      return;
    }

    mailPager.hidden = true;
    var items = (MAIL_DATA[mailState.account] || []).filter(function(m){
      return mailState.filter === "unread" ? m.unread : true;
    });
    if (!items.length){
      mailList.innerHTML = '<li class="sched-empty">' + (mailState.filter === "unread" ? "未読メールはありません" : "メールはありません") + '</li>';
      return;
    }
    items.forEach(function(mail){
      mailList.appendChild(buildMailListItem(mail, function(){ openMailDetail(mail); }));
    });
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
        var res = await apiFetch("/api/google/gmail/threads/" + encodeURIComponent(mail.threadId));
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
    if (mailState.account === "haruka" && mailState.filter === "unread" && !harukaMailLoading){
      fetchMailPage();
    }
  }

  document.getElementById("mail-modal-close").addEventListener("click", closeMailModal);
  mailModal.addEventListener("click", function(e){ if (e.target === mailModal) closeMailModal(); });

  wireAcctTabs("mail-acct-tabs", function(){ return mailState.account; }, function(acct){
    mailState.account = acct;
    if (acct === "haruka") loadHarukaMail();
    else renderMailList();
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
      if (mailState.account === "haruka") reloadMailFromFirstPage();
      else renderMailList();
    });
  });

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

  function renderHomeInbox(){
    homeInboxTag.hidden = true;
    // 連携ボタンは常時表示。未連携なら「連携する」、連携済みなら「再連携」。
    homeGoogleConnectBtn.hidden = false;
    if (!googleConnecting){
      var notConnected = harukaUnreadError && harukaUnreadError.code === "google_not_connected";
      homeGoogleConnectBtn.textContent = notConnected ? "Googleサービスと連携する" : "Google再連携";
    }
    if (harukaUnreadError){
      homeInboxCountNum.textContent = "!";
      homeInboxCountLabel.textContent = apiErrorMessage(harukaUnreadError, "Gmail");
      return;
    }
    if (harukaUnreadCount === null){
      homeInboxCountNum.textContent = "--";
      homeInboxCountLabel.textContent = "読み込み中…";
      return;
    }
    homeInboxCountNum.textContent = String(harukaUnreadCount);
    homeInboxCountLabel.textContent = harukaUnreadCount ? "件の新着メール" : "新着メールはありません";
  }

  homeInboxCountBtn.addEventListener("click", function(){ showView("mail"); });
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

  async function loadJsonFile(path){
    try{
      var res = await fetch(path, { cache: "no-store" });
      if (!res.ok) return [];
      var data = await res.json();
      return Array.isArray(data) ? data : [];
    } catch(e){
      return [];
    }
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

  function renderNotes(){
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

  function openNewNote(){
    editingNoteId = null;
    noteModalTitle.textContent = "新規メモ";
    noteTitleInput.value = "";
    noteBodyInput.innerHTML = "";
    noteFormTag = "haruka";
    setActiveTab("note-tag-tabs", "haruka");
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
    }
  });

  // ログイン完了(auth-gate側の type="module" スクリプトが発火)後に、
  // Home画面で必要な最小限のデータ(メール未読件数)を読み込む。
  // タスク/メモは各ビューを開いたタイミングで initTasks/initNotes が読み込む。
  document.addEventListener("cyberportal:authready", function(){
    loadGmailUnreadCount();
    loadHarukaMail();
    initCalendarWatch();
  });
  // 既にログイン済みの状態でこのスクリプトが後から評価されるケース
  // (モジュールスクリプトの実行順は保証されないため)にも対応する。
  if (window.__cyberPortalAuth && window.__cyberPortalAuth.currentUser){
    loadGmailUnreadCount();
    loadHarukaMail();
    initCalendarWatch();
  }

})();
