import * as http from "node:http";
import * as fs from "node:fs";
import type { TimerEngine } from "./timers.js";

/**
 * The wall display. Open it on a second monitor / phone: it mirrors every
 * timer live over SSE and interpolates milliseconds locally between pushes,
 * so the readout streams smoothly even though the server only pushes on
 * state changes.
 *
 * Visual language: futuristic arcade timing console. One accent (electric
 * cyan phosphor), gold reserved for personal bests, green/red for pace.
 * Gamification layer (XP, levels, streaks, achievements) is derived
 * client-side from the snapshot — the engine stays a pure timer.
 */
export function startDashboard(
  engine: TimerEngine,
  port: number,
  host: string
): { url: string; close: () => void } {
  const clients = new Set<http.ServerResponse>();

  const broadcast = (): void => {
    const data = `data: ${JSON.stringify(engine.snapshot())}\n\n`;
    for (const res of clients) res.write(data);
  };
  engine.on("change", broadcast);
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(": ping\n\n");
  }, 15000);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    try {
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(HTML);
      } else if (req.method === "GET" && url.pathname === "/state") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(engine.snapshot()));
      } else if (req.method === "GET" && url.pathname === "/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(`data: ${JSON.stringify(engine.snapshot())}\n\n`);
        clients.add(res);
        req.on("close", () => clients.delete(res));
      } else if (req.method === "GET" && url.pathname.startsWith("/card/")) {
        const id = url.pathname.slice("/card/".length).replace(/[^a-zA-Z0-9-]/g, "");
        const p = engine.cardPath(id);
        if (fs.existsSync(p)) {
          res.writeHead(200, { "content-type": "image/svg+xml" });
          res.end(fs.readFileSync(p));
        } else {
          res.writeHead(404).end("card not found");
        }
      } else if (req.method === "POST" && url.pathname.startsWith("/api/")) {
        // Cross-origin webpages can fire no-preflight POSTs at localhost;
        // only accept requests from our own origin (or origin-less tools).
        const origin = req.headers.origin;
        if (origin) {
          let originHost = "";
          try { originHost = new URL(origin).host; } catch { /* malformed */ }
          if (originHost !== req.headers.host) {
            res.writeHead(403, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "cross-origin request rejected" }));
            return;
          }
        }
        const body = await readJson(req);
        const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "main";
        const action = url.pathname.slice("/api/".length);
        let out: unknown;
        if (action === "start") out = engine.start([name], { target_ms: numOrUndef(body.target_ms) });
        else if (action === "split") out = engine.split(name, typeof body.label === "string" ? body.label : undefined);
        else if (action === "stop") out = engine.stop(name);
        else if (action === "cancel") out = engine.cancel(name);
        else { res.writeHead(404).end(); return; }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
      } else {
        res.writeHead(404).end("not found");
      }
    } catch (err) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
  });

  server.listen(port, host);
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[timermcp] port ${port} already taken — probably another TimerMCP instance ` +
          `(e.g. Claude Desktop and Claude Code each spawn their own). Timers still work here; ` +
          `set TIMERMCP_PORT to give this instance its own wall display.`
      );
    } else {
      console.error("[timermcp] dashboard error:", err.message);
    }
  });
  const url = `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`;
  return {
    url,
    close: () => {
      clearInterval(heartbeat);
      engine.off("change", broadcast);
      server.close();
    },
  };
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 64 * 1024) { req.destroy(); reject(new Error("body too large")); }
    });
    req.on("end", () => {
      try { resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {}); }
      catch { reject(new Error("invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === "number" && isFinite(v) && v > 0 ? v : undefined;
}

/* ------------------------------------------------------------------ HTML
 * Design: futuristic arcade timing console. Deep space-black, electric
 * cyan phosphor digits, gold PB flag, green/red pace deltas. Gamification
 * (XP / levels / streaks / achievements) derived from snapshot data.
 * Client JS uses no template literals (this file wraps it in one).
 */
const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TimerMCP wall display</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%E2%8F%B1%3C/text%3E%3C/svg%3E">
<style>
  :root{
    --bg:#05070C; --panel:#0B111C; --panel2:#0E1624; --line:#182335;
    --ink:#E8F0F8; --mut:#8FA3B8; --dim:#647A92;
    --acc:#3DE8FF; --acc-deep:#12A8C4;
    --gold:#F5C84C; --up:#5EE49A; --down:#FF6E7A;
  }
  *{box-sizing:border-box;margin:0}
  html,body{height:100%}
  body{
    background:var(--bg); color:var(--ink);
    font-family:ui-monospace,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace;
    font-variant-numeric:tabular-nums; display:flex; flex-direction:column;
    background-image:radial-gradient(ellipse 80% 50% at 50% -10%, rgba(61,232,255,.06), transparent);
  }

  /* header: brand + player status */
  header{
    display:flex;align-items:center;gap:14px;padding:12px 22px;
    border-bottom:1px solid var(--line);flex-wrap:wrap;
  }
  header::before{content:"";width:9px;height:9px;border-radius:50%;
    background:var(--dim);flex:none;transition:background .3s}
  header.live::before{background:var(--acc);box-shadow:0 0 12px var(--acc)}
  h1{font-size:14px;letter-spacing:6px;color:var(--mut);font-weight:700}
  #player{margin-left:auto;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  #lvl{
    border:1px solid var(--acc-deep);color:var(--acc);border-radius:999px;
    padding:4px 12px;font-size:12px;font-weight:800;letter-spacing:2px;white-space:nowrap;
  }
  #rank{color:var(--mut);font-size:12px;letter-spacing:2px;white-space:nowrap}
  #xpwrap{display:flex;align-items:center;gap:8px}
  #xpbar{width:130px;height:6px;border-radius:999px;background:var(--panel2);
    border:1px solid var(--line);overflow:hidden}
  #xpfill{height:100%;width:0%;border-radius:999px;background:var(--acc);transition:width .6s ease}
  #xpnum{color:var(--dim);font-size:11px;white-space:nowrap}
  #streak{color:var(--gold);font-size:12px;font-weight:700;letter-spacing:1px;white-space:nowrap}
  #streak.cold{color:var(--dim);font-weight:500}
  #today{color:var(--ink);font-size:12px;font-weight:700;letter-spacing:1px;white-space:nowrap}
  /* professional mode (default): the gamification layer is hidden until toggled */
  body.pro #lvl,body.pro #rank,body.pro #xpwrap,body.pro #achSec{display:none}
  #hero .sub .warn{color:var(--down);font-weight:700}

  main{flex:1;display:flex;flex-direction:column;overflow:auto}

  /* hero */
  #hero{display:flex;flex-direction:column;align-items:center;justify-content:center;
    padding:34px 20px 20px;min-height:36vh;text-align:center}
  #hero .name{color:var(--mut);letter-spacing:4px;font-size:clamp(13px,2vw,18px);
    text-transform:uppercase}
  #hero .time{
    color:var(--acc); font-weight:700; line-height:1;
    font-size:clamp(60px,15vw,180px);
    text-shadow:0 0 24px rgba(61,232,255,.35), 0 0 70px rgba(61,232,255,.12);
  }
  #hero .time .ms{font-size:.42em;color:var(--acc-deep);vertical-align:baseline}
  #hero .sub{margin-top:10px;color:var(--mut);font-size:clamp(12px,1.6vw,16px)}
  #hero .sub .over{color:var(--down)} #hero .sub .under{color:var(--up)}
  #hero.idle .time{color:var(--dim);text-shadow:none}
  #tbar{display:none;margin-top:16px;width:min(520px,80vw);height:8px;border-radius:999px;
    background:var(--panel2);border:1px solid var(--line);overflow:hidden}
  #tbar .fill{height:100%;width:0%;background:var(--acc);border-radius:999px}
  #tbar.over .fill{background:var(--down)}

  /* other running timers */
  #others{display:flex;gap:12px;flex-wrap:wrap;justify-content:center;padding:0 20px 8px}
  .chip{background:var(--panel);border:1px solid var(--line);border-radius:12px;
    padding:10px 16px;display:flex;gap:14px;align-items:baseline}
  .chip .n{color:var(--mut);font-size:12px;letter-spacing:2px;text-transform:uppercase}
  .chip .t{color:var(--acc);font-weight:700;font-size:22px}

  /* panels */
  #grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;padding:18px 22px 26px}
  @media (max-width:760px){#grid{grid-template-columns:1fr}}
  section{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
  section h2{font-size:11px;letter-spacing:4px;color:var(--mut);font-weight:700;
    text-transform:uppercase;margin-bottom:10px}
  table{width:100%;border-collapse:collapse;font-size:14px}
  td{padding:5px 4px;border-top:1px solid var(--line)}
  tr:first-child td{border-top:0}
  td.r{text-align:right;font-weight:700}
  td.lbl{color:var(--mut)}
  .pbtag{color:var(--gold);font-weight:800}
  .empty{color:var(--dim);font-size:13px;padding:8px 2px}

  /* achievements shelf */
  #ach{display:flex;gap:10px;flex-wrap:wrap}
  .medal{
    display:flex;align-items:center;gap:8px;border-radius:999px;
    border:1px solid var(--line);background:var(--panel2);
    padding:7px 14px;font-size:12px;letter-spacing:1px;color:var(--dim);
    cursor:default;transition:transform .15s ease;
  }
  .medal .g{font-size:14px;filter:grayscale(1);opacity:.5}
  .medal .p{color:var(--dim);font-size:11px}
  .medal.on{border-color:var(--acc-deep);color:var(--ink);
    box-shadow:inset 0 0 18px rgba(61,232,255,.07)}
  .medal.on .g{filter:none;opacity:1;color:var(--acc)}
  .medal.on:hover{transform:translateY(-2px)}

  /* controls */
  footer{display:flex;gap:10px;padding:14px 22px;border-top:1px solid var(--line);
    flex-wrap:wrap;align-items:center}
  input{background:var(--bg);border:1px solid var(--line);color:var(--ink);
    border-radius:10px;padding:10px 12px;font:inherit;width:150px}
  input#target{width:130px}
  input:focus{outline:2px solid var(--acc);outline-offset:1px}
  button{font:inherit;font-weight:700;border:1px solid var(--line);border-radius:10px;
    padding:10px 18px;background:var(--panel);color:var(--ink);cursor:pointer;letter-spacing:1px}
  button:hover{border-color:var(--acc)}
  button:active{transform:translateY(1px)}
  button:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
  #bStart{background:var(--acc);color:#04252C;border-color:var(--acc)}
  #bStop{border-color:var(--down);color:var(--down)}
  footer .hint{color:var(--dim);font-size:12px;margin-left:auto}
  #toast{position:fixed;bottom:78px;left:50%;transform:translateX(-50%);
    background:var(--panel);border:1px solid var(--acc-deep);border-radius:10px;
    padding:10px 16px;font-size:13px;color:var(--ink);opacity:0;transition:opacity .2s;
    pointer-events:none;max-width:90vw;z-index:10}
  canvas#fx{position:fixed;inset:0;pointer-events:none;z-index:5}
  @media (prefers-reduced-motion:reduce){
    #hero .time{text-shadow:none}
    header.live::before{box-shadow:none}
    canvas#fx{display:none}
    .medal.on:hover{transform:none}
    #xpfill{transition:none}
  }
</style>
</head>
<body>
<header id="hdr">
  <h1>TIMERMCP</h1>
  <div id="player">
    <span id="today">TODAY 0.000</span>
    <span id="lvl">LV 1</span>
    <span id="rank">ROOKIE</span>
    <span id="xpwrap"><span id="xpbar"><span id="xpfill"></span></span><span id="xpnum">0 XP</span></span>
    <span id="streak" class="cold">NO STREAK</span>
  </div>
</header>
<main>
  <div id="hero" class="idle">
    <div class="name" id="heroName">STANDING BY</div>
    <div class="time" id="heroTime">0.<span class="ms">000</span></div>
    <div class="sub" id="heroSub">say “start the timer” to Claude, or press Start below</div>
    <div id="tbar"><div class="fill"></div></div>
  </div>
  <div id="others"></div>
  <div id="grid">
    <section><h2>Splits</h2><div id="splits"><div class="empty">no splits yet</div></div></section>
    <section><h2>Personal bests</h2><div id="bests"><div class="empty">no finished runs yet</div></div></section>
    <section id="achSec" style="grid-column:1/-1"><h2>Achievements</h2><div id="ach"></div></section>
    <section style="grid-column:1/-1"><h2>Recent runs</h2><div id="recent"><div class="empty">history appears here</div></div></section>
  </div>
</main>
<footer>
  <input id="name" placeholder="timer name (main)" aria-label="timer name">
  <input id="target" placeholder="target min" aria-label="countdown target in minutes" inputmode="numeric">
  <button id="bStart">Start</button>
  <button id="bSplit">Split</button>
  <button id="bStop">Stop</button>
  <button id="bCancel">Cancel</button>
  <button id="bFun" aria-pressed="false">Fun mode: off</button>
  <span class="hint">space = split &middot; enter = start/stop</span>
</footer>
<div id="toast" role="status"></div>
<canvas id="fx"></canvas>
<script>
(function(){
  "use strict";
  var state = null, recvAt = 0, seenPB = {}, firstSnap = true, prevLevel = null;
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var $ = function(id){ return document.getElementById(id); };

  function store(key, val){
    try {
      if (val === undefined) return JSON.parse(localStorage.getItem(key) || "null");
      localStorage.setItem(key, JSON.stringify(val));
    } catch(e){ return null; }
  }

  // Professional by default; the gamification layer is opt-in.
  var fun = store("tm_fun") === true;
  function applyMode(){
    document.body.classList.toggle("pro", !fun);
    var b = $("bFun");
    b.textContent = fun ? "Fun mode: on" : "Fun mode: off";
    b.setAttribute("aria-pressed", fun ? "true" : "false");
  }

  function fmt(ms){
    var sign = ms < 0 ? "-" : ""; var v = Math.abs(ms);
    var h = Math.floor(v/3600000); v -= h*3600000;
    var m = Math.floor(v/60000);  v -= m*60000;
    var s = Math.floor(v/1000);
    var mil = String(Math.floor(v - s*1000)).padStart(3,"0");
    var body;
    if (h > 0) body = h + ":" + String(m).padStart(2,"0") + ":" + String(s).padStart(2,"0");
    else if (m > 0) body = m + ":" + String(s).padStart(2,"0");
    else body = String(s);
    return { sign: sign, body: body, ms: mil, flat: sign + body + "." + mil };
  }
  function esc(s){ var d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
  function liveMs(t){ return t.elapsed_ms + (performance.now() - recvAt); }

  // ---------------------------------------------------------- gamification
  var RANKS = ["ROOKIE","PACER","TIMEKEEPER","CHRONO PILOT","SPLIT SURGEON",
               "PACE MACHINE","SPEEDRUNNER","TIME BANDIT","HYPERCLOCK","TIME LORD"];

  function xpOf(st){
    return (st.lifetime_sessions||0)*25 + Math.floor((st.lifetime_ms||0)/60000)*5;
  }
  function levelOf(xp){ return Math.floor(Math.sqrt(xp/100)) + 1; }

  function streakOf(recent){
    var days = {};
    for (var i = 0; i < recent.length; i++) {
      var d = new Date(recent[i].stopped_wall);
      days[d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate()] = 1;
    }
    var key = function(d){ return d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate(); };
    var t = new Date(), c = 0;
    if (!days[key(t)]) t.setDate(t.getDate() - 1);   // streak survives until end of today
    while (days[key(t)]) { c++; t.setDate(t.getDate() - 1); }
    return c;
  }

  function achievements(st){
    var n = st.lifetime_sessions || 0;
    var mins = Math.floor((st.lifetime_ms||0)/60000);
    var recent = st.recent || [];
    var bests = st.bests || [];
    var streak = streakOf(recent);
    var some = function(f){ for (var i=0;i<recent.length;i++){ if (f(recent[i])) return true; } return false; };
    if ((st.running||[]).length >= 2) store("ss_raceday", true);
    return [
      { id:"board",  g:"▶", label:"ON THE BOARD",    desc:"Finish your first run",                     on: n >= 1 },
      { id:"ten",    g:"◆", label:"DOUBLE DIGITS",   desc:"Finish 10 runs",                            on: n >= 10,  p: Math.min(n,10) + "/10" },
      { id:"cent",   g:"★", label:"CENTURION",       desc:"Finish 100 runs",                           on: n >= 100, p: Math.min(n,100) + "/100" },
      { id:"hour",   g:"⬢", label:"MARATHON HOUR",   desc:"Track 60 minutes total",                    on: mins >= 60, p: Math.min(mins,60) + "/60m" },
      { id:"flash",  g:"⚡", label:"PHOTO FINISH",    desc:"Finish a run under 5 seconds",              on: some(function(s){ return s.elapsed_ms < 5000; }) },
      { id:"break",  g:"▲", label:"RECORD BREAKER",  desc:"Beat one of your own PBs",                  on: some(function(s){ return s.pb && s.pb_margin_ms != null; }) },
      { id:"bull",   g:"◎", label:"BULLSEYE",        desc:"Finish a countdown under target",           on: some(function(s){ return s.over_under_ms != null && s.over_under_ms <= 0; }) },
      { id:"splits", g:"≡", label:"SPLIT SCIENTIST", desc:"Record 3+ splits in one run",               on: some(function(s){ return s.splits && s.splits.length >= 3; }) },
      { id:"streak", g:"🔥", label:"HOT STREAK", desc:"Run timers 3 days in a row",               on: streak >= 3, p: Math.min(streak,3) + "/3d" },
      { id:"owl",    g:"☾", label:"MIDNIGHT OIL",    desc:"Finish a run between midnight and 5am",     on: some(function(s){ return new Date(s.stopped_wall).getHours() < 5; }) },
      { id:"fleet",  g:"⌗", label:"FLEET COMMANDER", desc:"Personal bests on 3 different timers",      on: bests.length >= 3, p: Math.min(bests.length,3) + "/3" },
      { id:"race",   g:"⚑", label:"RACE DAY",        desc:"Two timers running at once",                on: !!store("ss_raceday") }
    ];
  }

  // ------------------------------------------------------------ live loop
  function render(){
    if (!state) return;
    var running = state.running || [];
    var hero = running[0];
    var heroEl = $("hero");
    var tbar = $("tbar");
    if (hero) {
      heroEl.classList.remove("idle");
      $("hdr").classList.add("live");
      var ms = liveMs(hero);
      var f;
      $("heroName").textContent = hero.name.toUpperCase() + (hero.recovered ? " · RECOVERED" : "");
      if (hero.target_ms != null) {
        var rem = hero.target_ms - ms; f = fmt(Math.abs(rem));
        $("heroTime").innerHTML = (rem < 0 ? "+" : "") + f.body + ".<span class=ms>" + f.ms + "</span>";
        $("heroTime").style.color = rem < 0 ? "var(--down)" : "";
        $("heroSub").innerHTML = rem < 0
          ? "<span class=over>OVER TARGET</span> · elapsed " + fmt(ms).flat
          : "<span class=under>counting down</span> · target " + fmt(hero.target_ms).flat;
        tbar.style.display = "block";
        tbar.classList.toggle("over", rem < 0);
        tbar.firstElementChild.style.width = Math.min(100, ms / hero.target_ms * 100) + "%";
      } else {
        f = fmt(ms);
        $("heroTime").style.color = "";
        $("heroTime").innerHTML = f.sign + f.body + ".<span class=ms>" + f.ms + "</span>";
        $("heroSub").textContent = hero.best_ms != null ? "PB " + fmt(hero.best_ms).flat : "no PB yet, set the bar";
        tbar.style.display = "none";
      }
      if (hero.runaway) {
        $("heroSub").innerHTML += " · <span class=warn>⚠ FORGOT ME? tell Claude: stop it, trim to what I worked</span>";
      }
    } else {
      heroEl.classList.add("idle");
      $("hdr").classList.remove("live");
      $("heroName").textContent = "STANDING BY";
      $("heroTime").innerHTML = "0.<span class=ms>000</span>";
      $("heroTime").style.color = "";
      $("heroSub").textContent = "say “start the timer” to Claude, or press Start below";
      tbar.style.display = "none";
    }
    var oth = "";
    for (var i = 1; i < running.length; i++) {
      var t = running[i];
      oth += "<div class=chip><span class=n>" + esc(t.name) + "</span><span class=t>" + fmt(liveMs(t)).flat + "</span></div>";
    }
    $("others").innerHTML = oth;
    requestAnimationFrame(render);
  }

  // ------------------------------------------------------- snapshot render
  function renderStatic(){
    var running = state.running || [];
    var hero = running[0];

    // today's tracked total (professional-mode headline stat)
    var todayMs = 0, now = new Date();
    var rec0 = state.recent || [];
    for (var ti = 0; ti < rec0.length; ti++) {
      var sd = new Date(rec0[ti].stopped_wall);
      if (sd.getFullYear() === now.getFullYear() && sd.getMonth() === now.getMonth() && sd.getDate() === now.getDate()) {
        todayMs += rec0[ti].elapsed_ms;
      }
    }
    $("today").textContent = "TODAY " + fmt(todayMs).flat;

    // player status: XP / level / rank / streak
    var xp = xpOf(state);
    var L = levelOf(xp);
    var base = 100*(L-1)*(L-1), next = 100*L*L;
    $("lvl").textContent = "LV " + L;
    $("rank").textContent = RANKS[Math.min(L-1, RANKS.length-1)];
    $("xpfill").style.width = Math.round((xp-base)/(next-base)*100) + "%";
    $("xpnum").textContent = xp + " XP";
    var streak = streakOf(state.recent || []);
    var stEl = $("streak");
    if (streak > 0) { stEl.textContent = "🔥 " + streak + " DAY STREAK"; stEl.classList.remove("cold"); }
    else { stEl.textContent = "NO STREAK"; stEl.classList.add("cold"); }
    if (prevLevel !== null && L > prevLevel && !firstSnap) {
      toast("LEVEL UP → LV " + L + " " + RANKS[Math.min(L-1, RANKS.length-1)]);
      burst(["#F5C84C","#3DE8FF","#E8F0F8"]);
    }
    prevLevel = L;

    // achievements shelf
    var ach = achievements(state);
    var seenAch = store("ss_ach") || {};
    var html = "";
    for (var a = 0; a < ach.length; a++) {
      var m = ach[a];
      html += "<span class=\\"medal" + (m.on ? " on" : "") + "\\" title=\\"" + esc(m.desc) + "\\">" +
              "<span class=g>" + m.g + "</span>" + esc(m.label) +
              (m.p && !m.on ? " <span class=p>" + esc(m.p) + "</span>" : "") + "</span>";
      if (m.on && !seenAch[m.id]) {
        seenAch[m.id] = true;
        if (!firstSnap) { toast("ACHIEVEMENT UNLOCKED → " + m.label); burst(["#3DE8FF","#E8F0F8","#5EE49A"]); }
      }
    }
    store("ss_ach", seenAch);
    $("ach").innerHTML = html;

    // splits of hero run
    if (hero && hero.splits.length) {
      var rows = "";
      for (var i = 0; i < hero.splits.length; i++) {
        var sp = hero.splits[i];
        rows += "<tr><td class=lbl>" + esc(sp.label) + "</td><td class=r>" + fmt(sp.at_ms).flat + "</td></tr>";
      }
      $("splits").innerHTML = "<table>" + rows + "</table>";
    } else {
      $("splits").innerHTML = "<div class=empty>" + (hero ? "no splits yet, say “split”" : "start a run to record splits") + "</div>";
    }
    // bests
    var bests = state.bests || [];
    if (bests.length) {
      var b = "";
      for (var j = 0; j < bests.length; j++) {
        var r = bests[j];
        b += "<tr><td class=lbl>" + esc(r.name) + "</td><td class=r>" + (r.best_ms != null ? fmt(r.best_ms).flat : "-") +
             "</td><td class=r style=color:var(--dim)>" + r.count + " runs</td></tr>";
      }
      $("bests").innerHTML = "<table>" + b + "</table>";
    }
    // recent + confetti on fresh PB
    var recent = (state.recent || []).slice(0, 8);
    if (recent.length) {
      var h = "";
      for (var k = 0; k < recent.length; k++) {
        var s = recent[k];
        h += "<tr><td class=lbl>" + esc(s.name) + "</td><td class=r>" + fmt(s.elapsed_ms).flat + "</td><td>" +
             (s.pb ? "<span class=pbtag>★ PB</span>" : "") + "</td><td class=r style=color:var(--dim)>" +
             new Date(s.stopped_wall).toLocaleTimeString() + "</td></tr>";
        if (s.pb && !seenPB[s.id] && !firstSnap) burst(["#F5C84C","#3DE8FF","#E8F0F8","#5EE49A"]);
        seenPB[s.id] = true;
      }
      $("recent").innerHTML = "<table>" + h + "</table>";
    }
    firstSnap = false;
  }

  // --- SSE
  var es = new EventSource("/events");
  es.onmessage = function(ev){
    state = JSON.parse(ev.data);
    recvAt = performance.now();
    renderStatic();
  };

  // --- controls
  function api(action){
    var name = $("name").value.trim() || "main";
    var payload = { name: name };
    if (action === "start") {
      var tmin = parseFloat($("target").value);
      if (isFinite(tmin) && tmin > 0) payload.target_ms = Math.round(tmin * 60000);
    }
    fetch("/api/" + action, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function(r){ return r.json(); }).then(function(j){
      if (j && j.error) toast(j.error);
    }).catch(function(){ toast("request failed"); });
  }
  $("bStart").onclick  = function(){ api("start"); };
  $("bSplit").onclick  = function(){ api("split"); };
  $("bStop").onclick   = function(){ api("stop"); };
  $("bCancel").onclick = function(){ api("cancel"); };
  $("bFun").onclick    = function(){ fun = !fun; store("tm_fun", fun); applyMode(); };
  applyMode();
  document.addEventListener("keydown", function(e){
    if (e.target && e.target.tagName === "INPUT") return;
    if (e.code === "Space") { e.preventDefault(); api("split"); }
    if (e.code === "Enter") {
      var name = $("name").value.trim() || "main";
      var runningNow = state && state.running.some(function(t){ return t.name === name; });
      api(runningNow ? "stop" : "start");
    }
  });
  var toastTimer;
  function toast(msg){
    var t = $("toast"); t.textContent = msg; t.style.opacity = "1";
    clearTimeout(toastTimer); toastTimer = setTimeout(function(){ t.style.opacity = "0"; }, 2600);
  }

  // --- confetti (tiny, no deps, disabled under reduced-motion)
  var cvs = $("fx"), ctx = cvs.getContext("2d"), parts = [];
  function size(){ cvs.width = innerWidth; cvs.height = innerHeight; }
  addEventListener("resize", size); size();
  function burst(colors){
    if (reduceMotion || !fun) return;
    for (var i = 0; i < 120; i++) parts.push({
      x: cvs.width/2, y: cvs.height*0.35,
      vx: (Math.random()-0.5)*14, vy: -Math.random()*11-3,
      s: Math.random()*5+2, c: colors[i%colors.length], l: 90+Math.random()*40, r: Math.random()*6.28
    });
    tickFx();
  }
  var fxOn = false;
  function tickFx(){
    if (fxOn) return; fxOn = true;
    (function loop(){
      ctx.clearRect(0,0,cvs.width,cvs.height);
      parts = parts.filter(function(p){ return p.l > 0; });
      if (!parts.length) { fxOn = false; return; }
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        p.x += p.vx; p.y += p.vy; p.vy += 0.28; p.l--; p.r += 0.1;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
        ctx.fillStyle = p.c; ctx.globalAlpha = Math.min(1, p.l/40);
        ctx.fillRect(-p.s/2, -p.s/2, p.s, p.s*0.6); ctx.restore();
      }
      requestAnimationFrame(loop);
    })();
  }

  requestAnimationFrame(render);
})();
</script>
</body>
</html>`;
