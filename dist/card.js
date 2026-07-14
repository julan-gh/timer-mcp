import { fmtMs } from "./timers.js";
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** 1200x630 (OG-image size) trackside-console result card. */
export function renderCard(s) {
    const date = new Date(s.stopped_wall);
    const dateStr = date.toLocaleString("en-US", {
        month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
    });
    const splits = s.splits.slice(0, 5);
    const splitRows = splits
        .map((sp, i) => `
    <text x="80" y="${470 + i * 30}" class="lbl">${esc(sp.label.slice(0, 28))}</text>
    <text x="520" y="${470 + i * 30}" class="val" text-anchor="end">${fmtMs(sp.at_ms)}</text>`)
        .join("");
    const pbBadge = s.pb
        ? `<g>
        <rect x="80" y="118" rx="6" width="288" height="44" fill="#F5C84C"/>
        <text x="224" y="147" text-anchor="middle" class="badge">★ PERSONAL BEST</text>
      </g>`
        : "";
    const target = s.over_under_ms === undefined
        ? ""
        : `<text x="1120" y="560" text-anchor="end" class="tgt" fill="${s.over_under_ms <= 0 ? "#7BD88F" : "#FF7A6B"}">${s.over_under_ms <= 0 ? "▼ " + fmtMs(Math.abs(s.over_under_ms)) + " under target" : "▲ " + fmtMs(s.over_under_ms) + " over target"}</text>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <style>
      .brand { font: 700 26px ui-monospace, 'SF Mono', Menlo, Consolas, monospace; fill: #8FA3B8; letter-spacing: 6px; }
      .name  { font: 700 54px ui-monospace, 'SF Mono', Menlo, Consolas, monospace; fill: #E8F0F8; }
      .time  { font: 700 150px ui-monospace, 'SF Mono', Menlo, Consolas, monospace; fill: #3DE8FF; }
      .badge { font: 800 24px ui-monospace, monospace; fill: #10131A; letter-spacing: 2px; }
      .lbl   { font: 500 22px ui-monospace, monospace; fill: #8FA3B8; }
      .val   { font: 700 22px ui-monospace, monospace; fill: #E8F0F8; }
      .meta  { font: 500 22px ui-monospace, monospace; fill: #647A92; }
      .tgt   { font: 700 26px ui-monospace, monospace; }
    </style>
    <filter id="glow"><feGaussianBlur stdDeviation="6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  <rect width="1200" height="630" fill="#05070C"/>
  <rect x="0" y="0" width="1200" height="6" fill="#3DE8FF"/>
  <text x="80" y="86" class="brand">TIMERMCP ⏱ OFFICIAL TIME</text>
  ${pbBadge}
  <text x="80" y="${s.pb ? 240 : 210}" class="name">${esc(s.name.slice(0, 24))}</text>
  <text x="74" y="${s.pb ? 392 : 372}" class="time" filter="url(#glow)">${fmtMs(s.elapsed_ms)}</text>
  ${splitRows}
  ${target}
  <text x="80" y="590" class="meta">${esc(dateStr)} · run #${esc(s.id)}</text>
</svg>`;
}
