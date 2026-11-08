import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs";

const PORT = "5719";
const HOME = "/tmp/timermcp-smoke";
fs.rmSync(HOME, { recursive: true, force: true });

const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined));
const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...env, TIMERMCP_HOME: HOME, TIMERMCP_PORT: PORT },
});
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exit(1); } console.log("ok  -", msg); };

// 1. tools present
const tools = await client.listTools();
const names = tools.tools.map((t) => t.name).sort();
assert(
  ["timer_cancel", "timer_config", "timer_history", "timer_split", "timer_start", "timer_status", "timer_stop"]
    .every((n) => names.includes(n)),
  `all 7 tools registered: ${names.join(", ")}`
);

// 2. start → split → stop with known sleeps
const t0 = process.hrtime.bigint();
const start = await client.callTool({ name: "timer_start", arguments: { name: "smoke-run" } });
assert(start.structuredContent?.started?.[0]?.name === "smoke-run", "start returns structured session");
assert(typeof start.structuredContent.announcement === "string" && start.structuredContent.announcement.length > 5, "start announcement present");

await sleep(1200);
const split = await client.callTool({ name: "timer_split", arguments: { name: "smoke-run", label: "checkpoint" } });
const splitAt = split.structuredContent.at_ms;
assert(splitAt > 1100 && splitAt < 1600, `split at ~1.2s (got ${splitAt}ms)`);

await sleep(800);
const stop = await client.callTool({ name: "timer_stop", arguments: { name: "smoke-run" } });
const s = stop.structuredContent.session;
const wallElapsed = Number(process.hrtime.bigint() - t0) / 1e6;
assert(s.elapsed_ms > 1900 && s.elapsed_ms < wallElapsed + 5, `elapsed ~2s and ≤ client-side wall (${s.elapsed_ms}ms vs ${wallElapsed.toFixed(1)}ms)`);
assert(s.pb === true, "first run flagged PB");
assert(s.splits.length === 1 && s.splits[0].label === "checkpoint", "split recorded on session");
assert(fs.existsSync(stop.structuredContent.card_path), `SVG card written: ${stop.structuredContent.card_path}`);

// 3. second faster-ish run → not PB (it's slower) then offsets
const r2s = await client.callTool({ name: "timer_start", arguments: { name: "smoke-run" } });
await sleep(2500);
const r2 = await client.callTool({ name: "timer_stop", arguments: { name: "smoke-run" } });
assert(r2.structuredContent.session.pb === false, "slower second run is not PB");

// 4. offsets subtract
await client.callTool({ name: "timer_config", arguments: { start_offset_ms: 100, stop_offset_ms: 50 } });
await client.callTool({ name: "timer_start", arguments: { name: "offset-run" } });
await sleep(1000);
const off = await client.callTool({ name: "timer_stop", arguments: { name: "offset-run" } });
const oS = off.structuredContent.session;
const diff = oS.raw_elapsed_ms - oS.elapsed_ms;
assert(Math.abs(diff - 150) < 1, `offsets subtracted (raw−adjusted = ${diff.toFixed(3)}ms ≈ 150ms)`);
await client.callTool({ name: "timer_config", arguments: { start_offset_ms: 0, stop_offset_ms: 0 } });

// 5. race start — identical nanosecond
const race = await client.callTool({ name: "timer_start", arguments: { name: "alice,bob" } });
assert(race.structuredContent.started.length === 2, "race mode started two timers");
const st = await client.callTool({ name: "timer_status", arguments: {} });
const [a, b] = st.structuredContent.running;
assert(Math.abs(a.elapsed_ms - b.elapsed_ms) < 0.5, `race timers within 0.5ms of each other (Δ=${Math.abs(a.elapsed_ms - b.elapsed_ms).toFixed(3)}ms)`);
await client.callTool({ name: "timer_cancel", arguments: { name: "alice" } });
await client.callTool({ name: "timer_cancel", arguments: { name: "bob" } });

// 6. error path
const err = await client.callTool({ name: "timer_stop", arguments: { name: "ghost" } });
assert(err.isError === true, "stopping a non-running timer returns actionable error");

// 7. history
const hist = await client.callTool({ name: "timer_history", arguments: {} });
assert(hist.structuredContent.lifetime_sessions === 3, `history counts 3 finished runs (got ${hist.structuredContent.lifetime_sessions})`);

// 8. dashboard endpoints
const state = await fetch(`http://127.0.0.1:${PORT}/state`).then((r) => r.json());
assert(state.config && Array.isArray(state.running), "GET /state serves snapshot");
const html = await fetch(`http://127.0.0.1:${PORT}/`).then((r) => r.text());
assert(html.includes("TIMERMCP") && html.includes("EventSource"), "dashboard HTML served with SSE client");
const cardId = stop.structuredContent.session.id;
const card = await fetch(`http://127.0.0.1:${PORT}/card/${cardId}`);
assert(card.status === 200 && (await card.text()).includes("<svg"), "card served over HTTP");
const apiStart = await fetch(`http://127.0.0.1:${PORT}/api/start`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "browser" }),
}).then((r) => r.json());
assert(apiStart[0]?.name === "browser", "browser POST /api/start works");
const badRequest = await fetch(`http://127.0.0.1:${PORT}/api/start`, {
  method: "POST", headers: { "content-type": "application/json" }, body: "{",
});
const badRequestBody = await badRequest.json();
assert(badRequest.status === 400 && badRequestBody.error === "request failed", "dashboard errors do not expose internal details");
await fetch(`http://127.0.0.1:${PORT}/api/cancel`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "browser" }),
});

console.log("\nALL SMOKE TESTS PASSED ✅");
await client.close();
process.exit(0);
