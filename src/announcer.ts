import type { AnnouncerStyle, Session } from "./timers.js";
import { fmtMs } from "./timers.js";

const pick = (arr: string[]): string => arr[Math.floor(Math.random() * arr.length)];

export function announceStart(style: AnnouncerStyle, names: string[], targetMs?: number): string {
  const label = names.map((n) => `'${n}'`).join(" vs ");
  const target = targetMs !== undefined ? ` Target: ${fmtMs(targetMs)}.` : "";
  const race = names.length > 1;
  switch (style) {
    case "hype":
      return pick(
        race
          ? [`🏁 IT'S A RACE! ${label} launched on the SAME nanosecond. May the fastest win!${target}`]
          : [
              `🏁 AND WE'RE OFF! ${label} is LIVE — the clock is eating milliseconds as we speak!${target}`,
              `🔥 GREEN LIGHT! ${label} has started. Every. Millisecond. Counts.${target}`,
            ]
      );
    case "zen":
      return `🍃 The moment begins. ${label} flows. Return when you are ready.${target}`;
    case "sergeant":
      return `📢 CLOCK IS RUNNING, ${names.join(" AND ").toUpperCase()}! MOVE MOVE MOVE!${target}`;
    case "sports":
      return `🎙️ And they're underway — ${label} off to a clean start here.${target}`;
    default:
      return `▶ Started ${label}.${target}`;
  }
}

export function announceSplit(
  style: AnnouncerStyle,
  name: string,
  label: string,
  atMs: number,
  deltaVsBest?: number
): string {
  const t = fmtMs(atMs);
  const d =
    deltaVsBest === undefined
      ? ""
      : deltaVsBest <= 0
        ? ` — ${fmtMs(Math.abs(deltaVsBest))} AHEAD of PB pace 🟢`
        : ` — ${fmtMs(deltaVsBest)} behind PB pace 🔴`;
  switch (style) {
    case "hype":
      return `⚡ SPLIT! '${label}' on '${name}' at ${t}${d}`;
    case "zen":
      return `🍃 A marker placed: '${label}' at ${t}${d}`;
    case "sergeant":
      return `📢 CHECKPOINT '${label.toUpperCase()}' — ${t}${d}. KEEP PUSHING!`;
    case "sports":
      return `🎙️ Through '${label}' at ${t}${d}`;
    default:
      return `◦ ${label}: ${t}${d}`;
  }
}

export function announceStop(style: AnnouncerStyle, s: Session): string {
  const t = fmtMs(s.elapsed_ms);
  const pb = s.pb
    ? s.pb_margin_ms !== undefined
      ? ` 🏆 NEW PERSONAL BEST — ${fmtMs(s.pb_margin_ms)} faster than the old record!`
      : ` 🏆 First time on the books — that's the record to beat!`
    : "";
  const target =
    s.over_under_ms === undefined
      ? ""
      : s.over_under_ms <= 0
        ? ` ✅ ${fmtMs(Math.abs(s.over_under_ms))} under target.`
        : ` ⚠️ ${fmtMs(s.over_under_ms)} over target.`;
  switch (style) {
    case "hype":
      return `🏁 STOP THE CLOCK! '${s.name}' finishes in ${t}!${pb}${target}`;
    case "zen":
      return `🍃 Stillness. '${s.name}' completed in ${t}.${pb}${target}`;
    case "sergeant":
      return `📢 TIME! '${s.name.toUpperCase()}' — ${t}.${pb}${target} DISMISSED.`;
    case "sports":
      return `🎙️ Across the line! '${s.name}' clocks ${t}.${pb}${target}`;
    default:
      return `■ ${s.name}: ${t}.${pb}${target}`;
  }
}
