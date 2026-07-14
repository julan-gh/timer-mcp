/**
 * TimerMCP timer engine.
 *
 * Precision model
 * ---------------
 * All elapsed math uses process.hrtime.bigint() — a monotonic nanosecond
 * clock immune to NTP jumps and DST. Wall-clock (Date.now) is stored only
 * for display and crash recovery.
 *
 * Latency model (why this is honest to the millisecond)
 * -----------------------------------------------------
 * The user says "start" at t0, the command reaches this server after delay
 * d1 (typing + model + transport). Server stamps S1 = t0 + d1.
 * The user says "stop" at t1, stamped S2 = t1 + d2.
 *
 *   reported = S2 - S1 = (t1 - t0) + (d2 - d1)
 *
 * The constant part of the pipeline delay cancels. Only the *difference*
 * in latency between the two calls leaks into the result. For symmetric
 * calls that difference is small; for users who want to bias it out,
 * start_offset_ms / stop_offset_ms are subtracted from the raw elapsed.
 */
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
export const ANNOUNCER_STYLES = ["hype", "zen", "sergeant", "sports", "minimal"];
const HISTORY_CAP = 200;
const DEFAULT_CONFIG = { announcer: "hype", start_offset_ms: 0, stop_offset_ms: 0, max_hours: 4 };
export function fmtMs(ms) {
    const sign = ms < 0 ? "-" : "";
    // Round to whole ms FIRST so a .9995+ fraction carries into the seconds
    // digit instead of rendering as "5.1000".
    let v = Math.round(Math.abs(ms));
    const h = Math.floor(v / 3_600_000);
    v -= h * 3_600_000;
    const m = Math.floor(v / 60_000);
    v -= m * 60_000;
    const s = Math.floor(v / 1000);
    const msStr = String(v - s * 1000).padStart(3, "0");
    if (h > 0)
        return `${sign}${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${msStr}`;
    if (m > 0)
        return `${sign}${m}:${String(s).padStart(2, "0")}.${msStr}`;
    return `${sign}${s}.${msStr}`;
}
export class TimerEngine extends EventEmitter {
    home;
    stateFile;
    cardsDir;
    running = new Map();
    records = {};
    config = { ...DEFAULT_CONFIG };
    constructor(home) {
        super();
        const explicit = home ?? process.env.TIMERMCP_HOME ?? process.env.SPLITSECOND_HOME;
        this.home = explicit ?? path.join(os.homedir(), ".timermcp");
        this.stateFile = path.join(this.home, "state.json");
        this.cardsDir = path.join(this.home, "cards");
        // Only adopt pre-rename history when running against the DEFAULT home; an
        // explicitly configured home is taken as-is (test sandboxes rely on this).
        if (!explicit)
            this.migrateLegacyHome();
        fs.mkdirSync(this.cardsDir, { recursive: true });
        this.load();
    }
    /** One-time adoption of pre-rename history from ~/.splitsecond. */
    migrateLegacyHome() {
        try {
            if (fs.existsSync(this.stateFile))
                return;
            const legacy = path.join(os.homedir(), ".splitsecond");
            const legacyState = path.join(legacy, "state.json");
            if (path.resolve(legacy) === path.resolve(this.home) || !fs.existsSync(legacyState))
                return;
            fs.mkdirSync(this.cardsDir, { recursive: true });
            fs.copyFileSync(legacyState, this.stateFile);
            const legacyCards = path.join(legacy, "cards");
            if (fs.existsSync(legacyCards)) {
                for (const f of fs.readdirSync(legacyCards)) {
                    try {
                        fs.copyFileSync(path.join(legacyCards, f), path.join(this.cardsDir, f));
                    }
                    catch { /* skip */ }
                }
            }
            console.error(`[timermcp] migrated timer history from ${legacy} to ${this.home}`);
        }
        catch { /* best effort; a fresh home is fine */ }
    }
    // ------------------------------------------------------------------ clock
    nowNs() { return process.hrtime.bigint(); }
    liveElapsedMs(t) {
        const raw = t.recovered
            ? Date.now() - t.started_wall
            : Number(this.nowNs() - t.startNs) / 1e6;
        return Math.max(0, raw - t.start_offset_ms);
    }
    // ------------------------------------------------------------ persistence
    load() {
        try {
            const raw = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
            this.config = { ...DEFAULT_CONFIG, ...raw.config };
            this.records = raw.records ?? {};
            for (const r of raw.running ?? []) {
                // Monotonic origin is lost across restarts; fall back to wall clock.
                this.running.set(r.name, {
                    name: r.name,
                    startNs: this.nowNs(),
                    started_wall: r.started_wall,
                    splits: r.splits ?? [],
                    target_ms: r.target_ms,
                    start_offset_ms: r.start_offset_ms ?? 0,
                    recovered: true,
                });
            }
        }
        catch {
            /* first run */
        }
    }
    save() {
        const state = {
            config: this.config,
            records: this.records,
            running: [...this.running.values()].map((t) => ({
                name: t.name,
                started_wall: t.started_wall,
                splits: t.splits,
                target_ms: t.target_ms,
                start_offset_ms: t.start_offset_ms,
            })),
        };
        try {
            fs.mkdirSync(this.home, { recursive: true });
            fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
        }
        catch (err) {
            console.error("[timermcp] failed to persist state:", err);
        }
    }
    touch() {
        this.save();
        this.emit("change", this.snapshot());
    }
    record(name) {
        if (!this.records[name])
            this.records[name] = { sessions: [], total_ms: 0, count: 0 };
        return this.records[name];
    }
    // ------------------------------------------------------------------ start
    start(names, opts = {}) {
        const startNs = this.nowNs(); // one instant for the whole batch → fair race starts
        const wall = Date.now();
        const started = [];
        const dupes = names.filter((n) => this.running.has(n));
        if (dupes.length) {
            throw new Error(`Timer${dupes.length > 1 ? "s" : ""} already running: ${dupes.join(", ")}. ` +
                `Stop with timer_stop, discard with timer_cancel, or start under a different name.`);
        }
        for (const name of names) {
            const t = {
                name,
                startNs,
                started_wall: wall,
                splits: [],
                target_ms: opts.target_ms,
                start_offset_ms: opts.start_offset_ms ?? this.config.start_offset_ms,
                recovered: false,
            };
            this.running.set(name, t);
            started.push(this.viewOf(t));
        }
        this.touch();
        return started;
    }
    // ------------------------------------------------------------------ split
    split(name, label) {
        const t = this.mustRun(name);
        const at = this.liveElapsedMs(t);
        const index = t.splits.length;
        const split = { label: label ?? `Split ${index + 1}`, at_ms: round3(at), wall: Date.now() };
        t.splits.push(split);
        // LiveSplit-style comparison against the same split index on the PB run.
        let delta;
        let bestLabel;
        const best = this.records[name]?.best;
        if (best && best.splits[index]) {
            delta = round3(at - best.splits[index].at_ms);
            bestLabel = best.splits[index].label;
        }
        this.touch();
        return { split, index, delta_vs_best_ms: delta, best_label: bestLabel };
    }
    // ------------------------------------------------------------------- stop
    stop(name, opts = {}) {
        const t = this.mustRun(name);
        const rawStopped = t.recovered
            ? Date.now() - t.started_wall
            : Number(this.nowNs() - t.startNs) / 1e6;
        const stopOffset = opts.stop_offset_ms ?? this.config.stop_offset_ms;
        let elapsed = Math.max(0, rawStopped - t.start_offset_ms - stopOffset);
        // Runaway rescue: cap the recorded time when the operator walked away and
        // only remembers how long they actually worked.
        const trimmed = opts.trim_to_ms != null && opts.trim_to_ms > 0 && elapsed > opts.trim_to_ms;
        if (trimmed)
            elapsed = opts.trim_to_ms;
        const rec = this.record(name);
        const prevBest = rec.best;
        const isPb = !prevBest || elapsed < prevBest.elapsed_ms;
        const session = {
            id: randomUUID().slice(0, 8),
            name,
            started_wall: t.started_wall,
            stopped_wall: Date.now(),
            elapsed_ms: round3(elapsed),
            raw_elapsed_ms: round3(rawStopped),
            splits: t.splits,
            target_ms: t.target_ms,
            over_under_ms: t.target_ms !== undefined ? round3(elapsed - t.target_ms) : undefined,
            pb: isPb,
            pb_margin_ms: isPb && prevBest ? round3(prevBest.elapsed_ms - elapsed) : undefined,
            ...(trimmed ? { trimmed: true } : {}),
        };
        this.running.delete(name);
        rec.sessions.unshift(session);
        if (rec.sessions.length > HISTORY_CAP)
            rec.sessions.length = HISTORY_CAP;
        rec.total_ms = round3(rec.total_ms + elapsed);
        rec.count += 1;
        if (isPb)
            rec.best = session;
        this.touch();
        this.emit("stopped", session);
        return session;
    }
    // ----------------------------------------------------------------- cancel
    cancel(name) {
        const t = this.mustRun(name);
        const elapsed = round3(this.liveElapsedMs(t));
        this.running.delete(name);
        this.touch();
        return { name, discarded_elapsed_ms: elapsed };
    }
    // ------------------------------------------------------------------ views
    mustRun(name) {
        const t = this.running.get(name);
        if (!t) {
            const live = [...this.running.keys()];
            throw new Error(`No timer named '${name}' is running.` +
                (live.length ? ` Currently running: ${live.join(", ")}.` : " Nothing is running — use timer_start."));
        }
        return t;
    }
    viewOf(t) {
        const elapsed = round3(this.liveElapsedMs(t));
        return {
            name: t.name,
            running: true,
            elapsed_ms: elapsed,
            started_wall: t.started_wall,
            target_ms: t.target_ms,
            remaining_ms: t.target_ms !== undefined ? round3(t.target_ms - elapsed) : undefined,
            splits: t.splits,
            best_ms: this.records[t.name]?.best?.elapsed_ms,
            recovered: t.recovered,
            runaway: elapsed > this.config.max_hours * 3_600_000,
        };
    }
    /** Full records snapshot in the state.json shape, for cloud sync. */
    exportRecords() {
        return this.records;
    }
    status(name) {
        if (name) {
            const t = this.running.get(name);
            return t ? [this.viewOf(t)] : [];
        }
        return [...this.running.values()].map((t) => this.viewOf(t));
    }
    history(name, limit = 10) {
        const names = name ? [name] : Object.keys(this.records);
        const bests = names
            .filter((n) => this.records[n])
            .map((n) => {
            const r = this.records[n];
            return { name: n, best_ms: r.best?.elapsed_ms, count: r.count, total_ms: round3(r.total_ms) };
        })
            .sort((a, b) => b.count - a.count);
        const recent = names
            .flatMap((n) => this.records[n]?.sessions ?? [])
            .sort((a, b) => b.stopped_wall - a.stopped_wall)
            .slice(0, limit);
        const grand = Object.values(this.records).reduce((acc, r) => ({ ms: acc.ms + r.total_ms, n: acc.n + r.count }), { ms: 0, n: 0 });
        return { bests, recent, lifetime_ms: round3(grand.ms), lifetime_sessions: grand.n };
    }
    setConfig(patch) {
        this.config = { ...this.config, ...patch };
        this.touch();
        return this.config;
    }
    cardPath(id) {
        return path.join(this.cardsDir, `${id}.svg`);
    }
    snapshot() {
        // 60 recent sessions so the dashboard can derive streaks and achievements;
        // it only displays the first handful.
        return {
            now: Date.now(),
            config: this.config,
            running: this.status(),
            ...this.history(undefined, 60),
        };
    }
}
function round3(n) {
    return Math.round(n * 1000) / 1000;
}
