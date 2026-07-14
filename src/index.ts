#!/usr/bin/env node
/**
 * TimerMCP — a millisecond-precision talking stopwatch for MCP clients.
 *
 * stdio transport. Never write to stdout except MCP frames; all logs → stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "node:fs";

import { TimerEngine, fmtMs, ANNOUNCER_STYLES, type AnnouncerStyle } from "./timers.js";
import { announceStart, announceSplit, announceStop } from "./announcer.js";
import { renderCard } from "./card.js";
import { startDashboard } from "./dashboard.js";

if (process.argv.some((a) => ["--help", "-h", "--version", "-v"].includes(a))) {
  console.log(
    `timermcp 1.1.0 — millisecond-precision talking stopwatch (MCP, stdio)\n` +
      `Usage: node dist/index.js   (run by an MCP client; not interactive)\n` +
      `Env:   TIMERMCP_PORT=5717  TIMERMCP_HOST=127.0.0.1  TIMERMCP_HOME=~/.timermcp  TIMERMCP_NO_DASHBOARD=1\n` +
      `Test:  npm run smoke · Inspect: npx @modelcontextprotocol/inspector node dist/index.js`
  );
  process.exit(0);
}

const engine = new TimerEngine();

// TIMERMCP_* wins; SPLITSECOND_* accepted for pre-rename configs.
const PORT = parseInt(process.env.TIMERMCP_PORT ?? process.env.SPLITSECOND_PORT ?? "5717", 10);
const HOST = process.env.TIMERMCP_HOST ?? process.env.SPLITSECOND_HOST ?? "127.0.0.1";
const dashboard =
  (process.env.TIMERMCP_NO_DASHBOARD ?? process.env.SPLITSECOND_NO_DASHBOARD) === "1"
    ? { url: "(dashboard disabled)", close: () => {} }
    : startDashboard(engine, PORT, HOST);

const server = new McpServer({ name: "timermcp", version: "1.1.0" });

/**
 * Fire-and-forget cloud sync. Pushes the full records snapshot to the
 * TimerMCP cloud after every finished run when a sync token is configured.
 * Failures only log to stderr; timing is never blocked on the network.
 */
async function pushSync(): Promise<void> {
  const { sync_token, sync_url } = engine.config;
  if (!sync_token) return;
  const base = (sync_url ?? "https://timermcp.vercel.app").replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/api/sync`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${sync_token}` },
      body: JSON.stringify({ records: engine.exportRecords() }),
    });
    if (!res.ok) console.error(`[timermcp] cloud sync failed: HTTP ${res.status}`);
  } catch (err) {
    console.error("[timermcp] cloud sync failed:", err instanceof Error ? err.message : String(err));
  }
}

const announcerEnum = z.enum(["hype", "zen", "sergeant", "sports", "minimal"]);

const splitShape = z.object({
  label: z.string(),
  at_ms: z.number(),
  wall: z.number(),
});

// --------------------------------------------------------------- timer_start
server.registerTool(
  "timer_start",
  {
    title: "Start Timer",
    description: `Start a millisecond-precision stopwatch (or countdown) on the TimerMCP server.

The server stamps the start on a MONOTONIC nanosecond clock the instant this call arrives. Elapsed time is computed server-side as stop-stamp minus start-stamp, so the constant part of the pipeline delay (user → Claude → server) cancels out between start and stop — only the *difference* in latency between the two calls can leak in.

Args:
  - name (string, default "main"): Timer name. NAME IT AFTER THE TASK — when the user says what they are working on ("start a timer for the auth refactor"), use that as the name ("auth refactor") so their session log reads like a work journal. Pass a comma-separated list (e.g. "alice,bob") to start several timers on the SAME nanosecond — race mode.
  - target_ms (number, optional): Turns the run into a countdown (Pomodoro, rest interval, speedrun target). Stop reports over/under.
  - announcer ('hype'|'zen'|'sergeant'|'sports'|'minimal', optional): Voice for this run's announcements. Defaults to configured style.
  - start_offset_ms (number, optional): Milliseconds subtracted from the final elapsed to bias out start-side latency. Defaults to configured value (0).

Returns: { started: [{name, elapsed_ms, started_wall, target_ms?}], announcement, dashboard_url }

IMPORTANT: Relay the 'announcement' line to the user with matching energy — you are the track announcer. Mention the dashboard_url the first time so they can put the live wall display on a second screen.

Errors: fails if a timer with the same name is already running (stop or cancel it first, or pick another name).`,
    inputSchema: {
      name: z.string().trim().min(1).max(120).default("main")
        .describe('Timer name; comma-separate for a simultaneous race start, e.g. "me,rival"'),
      target_ms: z.number().positive().max(86_400_000).optional()
        .describe("Optional countdown target in ms (e.g. 1500000 for a 25-min Pomodoro)"),
      announcer: announcerEnum.optional().describe("Announcement personality for this run"),
      start_offset_ms: z.number().min(0).max(60_000).optional()
        .describe("Latency handicap subtracted from the final time (start side)"),
    },
    outputSchema: {
      started: z.array(z.object({
        name: z.string(),
        elapsed_ms: z.number(),
        started_wall: z.number(),
        target_ms: z.number().optional(),
      })),
      announcement: z.string(),
      dashboard_url: z.string(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ name, target_ms, announcer, start_offset_ms }) => {
    const names = [...new Set(name.split(",").map((s) => s.trim()).filter(Boolean))];
    const started = engine.start(names, { target_ms, start_offset_ms });
    const style: AnnouncerStyle = announcer ?? engine.config.announcer;
    const announcement = announceStart(style, names, target_ms);
    const output = {
      started: started.map((s) => ({
        name: s.name, elapsed_ms: s.elapsed_ms, started_wall: s.started_wall,
        ...(s.target_ms !== undefined ? { target_ms: s.target_ms } : {}),
      })),
      announcement,
      dashboard_url: dashboard.url,
    };
    return {
      content: [{
        type: "text",
        text: `${announcement}\n\nStarted at ${new Date(started[0].started_wall).toISOString()} on the server's monotonic clock.\nLive wall display: ${dashboard.url}`,
      }],
      structuredContent: output,
    };
  }
);

// ---------------------------------------------------------------- timer_stop
server.registerTool(
  "timer_stop",
  {
    title: "Stop Timer",
    description: `Stop a running timer and get the official elapsed time in milliseconds.

elapsed_ms = (monotonic stop-stamp − monotonic start-stamp) − start_offset_ms − stop_offset_ms.
raw_elapsed_ms is the pure unadjusted monotonic difference. Because both stamps are taken server-side, symmetric pipeline latency cancels; offsets exist only to bias out asymmetry if the user wants.

Args:
  - name (string, default "main"): Which timer to stop.
  - stop_offset_ms (number, optional): Override the configured stop-side latency handicap for this stop only.
  - trim_to_ms (number, optional): Cap the recorded time. Use when the user forgot to stop a runaway timer and tells you how long they actually worked (e.g. "I only worked 25 minutes" → trim_to_ms 1500000). The session records the capped time and is flagged trimmed.

Returns: { session: {name, elapsed_ms, raw_elapsed_ms, formatted, splits, pb, pb_margin_ms?, target_ms?, over_under_ms?, id}, announcement, card_path, card_url }

A shareable SVG result card is written on every stop (card_path on disk, card_url served by the dashboard).

IMPORTANT: Relay the 'announcement' to the user — big finish energy if it's a PB. Quote the exact millisecond figure.`,
    inputSchema: {
      name: z.string().trim().min(1).max(120).default("main").describe("Timer to stop"),
      stop_offset_ms: z.number().min(0).max(60_000).optional()
        .describe("Latency handicap subtracted from the final time (stop side)"),
      trim_to_ms: z.number().positive().max(86_400_000).optional()
        .describe("Cap the recorded time at this many ms (runaway-timer rescue)"),
    },
    outputSchema: {
      session: z.object({
        id: z.string(),
        name: z.string(),
        elapsed_ms: z.number(),
        raw_elapsed_ms: z.number(),
        formatted: z.string(),
        splits: z.array(splitShape),
        pb: z.boolean(),
        pb_margin_ms: z.number().optional(),
        target_ms: z.number().optional(),
        over_under_ms: z.number().optional(),
        trimmed: z.boolean().optional(),
      }),
      announcement: z.string(),
      card_path: z.string(),
      card_url: z.string(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ name, stop_offset_ms, trim_to_ms }) => {
    const session = engine.stop(name, { stop_offset_ms, trim_to_ms });
    void pushSync();
    const announcement = announceStop(engine.config.announcer, session);
    const cardPath = engine.cardPath(session.id);
    try { fs.writeFileSync(cardPath, renderCard(session)); }
    catch (err) { console.error("[timermcp] card write failed:", err); }
    const cardUrl = `${dashboard.url}/card/${session.id}`;
    const output = {
      session: {
        id: session.id,
        name: session.name,
        elapsed_ms: session.elapsed_ms,
        raw_elapsed_ms: session.raw_elapsed_ms,
        formatted: fmtMs(session.elapsed_ms),
        splits: session.splits,
        pb: session.pb,
        ...(session.pb_margin_ms !== undefined ? { pb_margin_ms: session.pb_margin_ms } : {}),
        ...(session.target_ms !== undefined ? { target_ms: session.target_ms } : {}),
        ...(session.over_under_ms !== undefined ? { over_under_ms: session.over_under_ms } : {}),
        ...(session.trimmed ? { trimmed: true } : {}),
      },
      announcement,
      card_path: cardPath,
      card_url: cardUrl,
    };
    const splitLines = session.splits.length
      ? "\nSplits:\n" + session.splits.map((s, i) => `  ${i + 1}. ${s.label} — ${fmtMs(s.at_ms)}`).join("\n")
      : "";
    const trimNote = session.trimmed ? ` (trimmed from ${fmtMs(session.raw_elapsed_ms)})` : "";
    const syncNote = engine.config.sync_token ? "\nCloud sync: queued." : "";
    return {
      content: [{
        type: "text",
        text: `${announcement}\n\nOfficial: ${session.elapsed_ms} ms (${fmtMs(session.elapsed_ms)})${trimNote} · raw monotonic: ${session.raw_elapsed_ms} ms${splitLines}\nResult card: ${cardUrl}${syncNote}`,
      }],
      structuredContent: output,
    };
  }
);

// --------------------------------------------------------------- timer_split
server.registerTool(
  "timer_split",
  {
    title: "Record Split / Lap",
    description: `Record a split (lap) on a running timer without stopping it — speedrun style.

If a personal-best run exists for this timer name, the split is compared against the SAME split index on the PB run and delta_vs_best_ms is returned (negative = ahead of PB pace, like LiveSplit green).

Args:
  - name (string, default "main"): Running timer to split.
  - label (string, optional): Name the checkpoint, e.g. "deploy done", "lap 2". Defaults to "Split N".

Returns: { name, index, label, at_ms, formatted, delta_vs_best_ms?, announcement }

Relay the announcement; if delta_vs_best_ms is present, call out ahead/behind PB pace.`,
    inputSchema: {
      name: z.string().trim().min(1).max(120).default("main").describe("Running timer to split"),
      label: z.string().trim().min(1).max(80).optional().describe("Checkpoint label"),
    },
    outputSchema: {
      name: z.string(),
      index: z.number(),
      label: z.string(),
      at_ms: z.number(),
      formatted: z.string(),
      delta_vs_best_ms: z.number().optional(),
      announcement: z.string(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ name, label }) => {
    const r = engine.split(name, label);
    const announcement = announceSplit(
      engine.config.announcer, name, r.split.label, r.split.at_ms, r.delta_vs_best_ms
    );
    const output = {
      name,
      index: r.index,
      label: r.split.label,
      at_ms: r.split.at_ms,
      formatted: fmtMs(r.split.at_ms),
      ...(r.delta_vs_best_ms !== undefined ? { delta_vs_best_ms: r.delta_vs_best_ms } : {}),
      announcement,
    };
    return {
      content: [{ type: "text", text: announcement }],
      structuredContent: output,
    };
  }
);

// -------------------------------------------------------------- timer_status
server.registerTool(
  "timer_status",
  {
    title: "Timer Status",
    description: `Check what's on the clock right now. Read-only.

Args:
  - name (string, optional): One timer, or omit for all running timers.

Returns: { running: [{name, elapsed_ms, formatted, target_ms?, remaining_ms?, splits, best_ms?, recovered, runaway}], count, dashboard_url }
'recovered' = true means the server restarted mid-run and that timer fell back to wall-clock precision.
'runaway' = true means the timer has been running longer than the configured max_hours (default 4) — the user probably forgot it. Ask if they want to stop it, offering trim_to_ms to cap the recorded time at what they actually worked.
elapsed_ms is a live server-side reading at the moment this call was processed.`,
    inputSchema: {
      name: z.string().trim().min(1).max(120).optional().describe("Specific timer, or omit for all"),
    },
    outputSchema: {
      running: z.array(z.object({
        name: z.string(),
        elapsed_ms: z.number(),
        formatted: z.string(),
        target_ms: z.number().optional(),
        remaining_ms: z.number().optional(),
        splits: z.array(splitShape),
        best_ms: z.number().optional(),
        recovered: z.boolean(),
        runaway: z.boolean(),
      })),
      count: z.number(),
      dashboard_url: z.string(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ name }) => {
    const running = engine.status(name);
    const output = {
      running: running.map((t) => ({
        name: t.name,
        elapsed_ms: t.elapsed_ms,
        formatted: fmtMs(t.elapsed_ms),
        ...(t.target_ms !== undefined ? { target_ms: t.target_ms } : {}),
        ...(t.remaining_ms !== undefined ? { remaining_ms: t.remaining_ms } : {}),
        splits: t.splits,
        ...(t.best_ms !== undefined ? { best_ms: t.best_ms } : {}),
        recovered: t.recovered,
        runaway: t.runaway,
      })),
      count: running.length,
      dashboard_url: dashboard.url,
    };
    const text = running.length
      ? running.map((t) =>
          `⏱ ${t.name}: ${fmtMs(t.elapsed_ms)}${t.remaining_ms !== undefined ? ` (${fmtMs(t.remaining_ms)} to target)` : ""}${t.splits.length ? ` · ${t.splits.length} split(s)` : ""}${t.recovered ? " · recovered (wall-clock precision)" : ""}${t.runaway ? " · ⚠ RUNAWAY: running over the configured max, probably forgotten — offer to stop with trim_to_ms" : ""}`
        ).join("\n")
      : name
        ? `No timer named '${name}' is running.`
        : "Nothing on the clock. timer_start when ready.";
    return { content: [{ type: "text", text }], structuredContent: output };
  }
);

// -------------------------------------------------------------- timer_cancel
server.registerTool(
  "timer_cancel",
  {
    title: "Cancel Timer",
    description: `Discard a running timer WITHOUT recording a session, PB, or history entry. Use for false starts ("wait, I wasn't ready"). The would-be elapsed is returned for reference only.

Args:
  - name (string, default "main"): Timer to discard.

Returns: { name, discarded_elapsed_ms }`,
    inputSchema: {
      name: z.string().trim().min(1).max(120).default("main").describe("Timer to discard"),
    },
    outputSchema: {
      name: z.string(),
      discarded_elapsed_ms: z.number(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  async ({ name }) => {
    const output = engine.cancel(name);
    return {
      content: [{
        type: "text",
        text: `🗑 '${output.name}' cancelled at ${fmtMs(output.discarded_elapsed_ms)} — nothing recorded. Clean slate.`,
      }],
      structuredContent: output,
    };
  }
);

// ------------------------------------------------------------- timer_history
server.registerTool(
  "timer_history",
  {
    title: "History & Personal Bests",
    description: `Personal bests, recent finished runs, and lifetime totals. Read-only.

Args:
  - name (string, optional): Filter to one timer name; omit for everything.
  - limit (number, default 10): Max recent sessions returned (1–50).

Returns: { bests: [{name, best_ms?, count, total_ms}], recent: [{id, name, elapsed_ms, formatted, pb, splits, stopped_wall, target_ms?, over_under_ms?}], lifetime_ms, lifetime_sessions }

Great for "what's my record?", "how much have I tracked today?", or building a leaderboard recap for the user.`,
    inputSchema: {
      name: z.string().trim().min(1).max(120).optional().describe("Filter to one timer name"),
      limit: z.number().int().min(1).max(50).default(10).describe("Max recent sessions"),
    },
    outputSchema: {
      bests: z.array(z.object({
        name: z.string(), best_ms: z.number().optional(), count: z.number(), total_ms: z.number(),
      })),
      recent: z.array(z.object({
        id: z.string(), name: z.string(), elapsed_ms: z.number(), formatted: z.string(),
        pb: z.boolean(), splits: z.array(splitShape), stopped_wall: z.number(),
        target_ms: z.number().optional(), over_under_ms: z.number().optional(),
      })),
      lifetime_ms: z.number(),
      lifetime_sessions: z.number(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ name, limit }) => {
    const h = engine.history(name, limit);
    const output = {
      bests: h.bests,
      recent: h.recent.map((s) => ({
        id: s.id, name: s.name, elapsed_ms: s.elapsed_ms, formatted: fmtMs(s.elapsed_ms),
        pb: s.pb, splits: s.splits, stopped_wall: s.stopped_wall,
        ...(s.target_ms !== undefined ? { target_ms: s.target_ms } : {}),
        ...(s.over_under_ms !== undefined ? { over_under_ms: s.over_under_ms } : {}),
      })),
      lifetime_ms: h.lifetime_ms,
      lifetime_sessions: h.lifetime_sessions,
    };
    const bestLines = h.bests.length
      ? h.bests.map((b) => `  ${b.name}: PB ${b.best_ms !== undefined ? fmtMs(b.best_ms) : "—"} · ${b.count} runs · ${fmtMs(b.total_ms)} total`).join("\n")
      : "  (no finished runs yet)";
    const recentLines = h.recent
      .map((s) => `  ${new Date(s.stopped_wall).toLocaleTimeString()} · ${s.name} — ${fmtMs(s.elapsed_ms)}${s.pb ? " ★PB" : ""}`)
      .join("\n");
    return {
      content: [{
        type: "text",
        text: `🏆 Personal bests\n${bestLines}\n\nRecent\n${recentLines || "  (none)"}\n\nLifetime: ${h.lifetime_sessions} runs · ${fmtMs(h.lifetime_ms)} tracked`,
      }],
      structuredContent: output,
    };
  }
);

// -------------------------------------------------------------- timer_config
server.registerTool(
  "timer_config",
  {
    title: "Configure TimerMCP",
    description: `Read or update TimerMCP settings. Call with no args to read.

Settings:
  - announcer ('hype'|'zen'|'sergeant'|'sports'|'minimal'): Default announcement personality. Styles: ${ANNOUNCER_STYLES.join(", ")}.
  - start_offset_ms / stop_offset_ms (number ≥ 0): Latency handicaps subtracted from every elapsed. Leave at 0 for most uses — symmetric pipeline latency already cancels because both timestamps are taken server-side on a monotonic clock. Set these only to bias out a known asymmetry (e.g. user reckons their "stop" reaches the server ~300ms slower than their "start").
  - max_hours (number): A running timer older than this is flagged runaway (default 4).
  - sync_token (string): Enables cloud auto-sync. The user gets this token from their dashboard at https://timermcp.vercel.app/app ("set my timer sync token to …"). Every finished run then syncs automatically. Pass an empty string to disable sync.
  - sync_url (string): Override the cloud endpoint (default https://timermcp.vercel.app).

Returns: { config: {announcer, start_offset_ms, stop_offset_ms, max_hours, sync_enabled, sync_token_tail?, sync_url?}, dashboard_url, data_dir }`,
    inputSchema: {
      announcer: announcerEnum.optional().describe("Default announcement personality"),
      start_offset_ms: z.number().min(0).max(60_000).optional().describe("Default start-side handicap in ms"),
      stop_offset_ms: z.number().min(0).max(60_000).optional().describe("Default stop-side handicap in ms"),
      max_hours: z.number().min(0.25).max(24).optional().describe("Hours before a running timer is flagged runaway"),
      sync_token: z.string().max(200).optional().describe("Cloud sync token from the TimerMCP dashboard; empty string disables sync"),
      sync_url: z.string().url().optional().describe("Cloud sync endpoint override"),
    },
    outputSchema: {
      config: z.object({
        announcer: announcerEnum,
        start_offset_ms: z.number(),
        stop_offset_ms: z.number(),
        max_hours: z.number(),
        sync_enabled: z.boolean(),
        sync_token_tail: z.string().optional(),
        sync_url: z.string().optional(),
      }),
      dashboard_url: z.string(),
      data_dir: z.string(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ announcer, start_offset_ms, stop_offset_ms, max_hours, sync_token, sync_url }) => {
    const patch: Record<string, unknown> = {};
    if (announcer !== undefined) patch.announcer = announcer;
    if (start_offset_ms !== undefined) patch.start_offset_ms = start_offset_ms;
    if (stop_offset_ms !== undefined) patch.stop_offset_ms = stop_offset_ms;
    if (max_hours !== undefined) patch.max_hours = max_hours;
    if (sync_token !== undefined) patch.sync_token = sync_token.trim() === "" ? undefined : sync_token.trim();
    if (sync_url !== undefined) patch.sync_url = sync_url;
    const config = Object.keys(patch).length ? engine.setConfig(patch) : engine.config;
    // Never echo the full token back into the conversation.
    const publicConfig = {
      announcer: config.announcer,
      start_offset_ms: config.start_offset_ms,
      stop_offset_ms: config.stop_offset_ms,
      max_hours: config.max_hours,
      sync_enabled: Boolean(config.sync_token),
      ...(config.sync_token ? { sync_token_tail: "…" + config.sync_token.slice(-4) } : {}),
      ...(config.sync_url ? { sync_url: config.sync_url } : {}),
    };
    const output = { config: publicConfig, dashboard_url: dashboard.url, data_dir: engine.home };
    const syncLine = publicConfig.sync_enabled
      ? `\nCloud sync: ON (token ${publicConfig.sync_token_tail}) → ${config.sync_url ?? "https://timermcp.vercel.app"}`
      : "\nCloud sync: off";
    return {
      content: [{
        type: "text",
        text: `⚙️ announcer: ${config.announcer} · start_offset: ${config.start_offset_ms}ms · stop_offset: ${config.stop_offset_ms}ms · max_hours: ${config.max_hours}${syncLine}\nDashboard: ${dashboard.url}\nData: ${engine.home}`,
      }],
      structuredContent: output,
    };
  }
);

// --------------------------------------------------------------------- boot
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[timermcp] ready · dashboard ${dashboard.url} · data ${engine.home}`);
}

main().catch((err) => {
  console.error("[timermcp] fatal:", err);
  process.exit(1);
});
