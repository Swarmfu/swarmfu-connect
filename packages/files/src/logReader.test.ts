import { afterEach, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdtempSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogReader } from "./logReader.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const PREFIX = "[swarmfu] ";
/** A line as Hyperspace's log() writes it. */
const line = (body: object) => `[Lua]: ${PREFIX}${JSON.stringify(body)}    \n`;
const manifest = (session: string) =>
  line({ t: "manifest", v: 1, source: "ftl", session });
const event = (session: string, seq: number, type: string) =>
  line({ t: "event", v: 1, source: "ftl", session, seq, type, data: {} });
const heartbeat = (session: string, over: object = {}) =>
  line({ t: "heartbeat", v: 1, session, paused: false, ...over });

function rig(options: { fromStart?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ftl-log-"));
  dirs.push(dir);
  const file = join(dir, "FTL_HS.log");
  let clock = 1_000_000;
  const logs: string[] = [];
  const reader = new LogReader({
    file,
    prefix: PREFIX,
    now: () => clock,
    log: (l) => logs.push(l),
    ...options,
  });
  return {
    file,
    reader,
    logs,
    tick: (ms: number) => (clock += ms),
    now: () => clock,
  };
}

test("the first look catches up: the session, heartbeat and state, but not old events, stamped with the file's last write", () => {
  const { file, reader } = rig();
  writeFileSync(
    file,
    `Starting Lua\n${manifest("1-7")}${event("1-7", 1, "session_start")}${heartbeat("1-7")}some other log line\n`,
  );
  utimesSync(file, 500, 500);
  const first = reader.read();
  expect(first.events).toEqual([]);
  expect(first.manifest).toMatchObject({
    source: "ftl",
    session: "500000-1-7",
    events_file: "FTL_HS.log",
    started_at: 500_000,
  });
  expect(first.heartbeat).toMatchObject({
    session: "500000-1-7",
    ts: 500_000,
    paused: false,
  });
});

test("what's added after is handed back, stamped as it's read; lines of other mods and torn lines wait or are skipped", () => {
  const { file, reader, tick, now } = rig();
  writeFileSync(file, manifest("1-7"));
  reader.read();
  tick(2_000);
  appendFileSync(
    file,
    `[Lua]: hello from another mod    \n${event("1-7", 1, "jumped")}${event("1-7", 2, "hull_hit").slice(0, 30)}`,
  );
  const read = reader.read();
  expect(read.events.map((e) => [e.type, e.ts])).toEqual([["jumped", now()]]);
  appendFileSync(file, event("1-7", 2, "hull_hit").slice(30));
  expect(reader.read().events.map((e) => e.type)).toEqual(["hull_hit"]);
});

test("a gap in seq counts as lost; a repeated line is dropped", () => {
  const { file, reader } = rig();
  writeFileSync(file, manifest("1-7"));
  reader.read();
  appendFileSync(
    file,
    event("1-7", 1, "jumped") +
      event("1-7", 1, "jumped") +
      event("1-7", 4, "jumped"),
  );
  expect(reader.read().events.map((e) => e.seq)).toEqual([1, 4]);
  expect(reader.lost).toBe(2);
});

test("a new session (a run started) is followed from its manifest", () => {
  const { file, reader } = rig();
  writeFileSync(file, manifest("1-7"));
  reader.read();
  appendFileSync(file, manifest("2-9") + event("2-9", 1, "session_start"));
  const read = reader.read();
  expect(read.manifest?.session).toEndWith("-2-9");
  expect(read.events.map((e) => [e.type, e.session])).toEqual([
    ["session_start", read.manifest!.session],
  ]);
});

test("the game starting again (the log moved aside and written anew) is read from its start", () => {
  const { file, reader, logs } = rig();
  writeFileSync(file, manifest("1-7") + event("1-7", 1, "session_start"));
  reader.read();
  renameSync(file, `${file}.bak`);
  writeFileSync(file, manifest("1-3") + event("1-3", 1, "session_start"));
  const read = reader.read();
  expect(read.events.map((e) => e.type)).toEqual(["session_start"]);
  expect(read.manifest?.session).toEndWith("-1-3");
  expect(logs.some((l) => l.includes("started again"))).toBe(true);
});

test("asked to, the first look hands back what's already there", () => {
  const { file, reader } = rig({ fromStart: true });
  writeFileSync(
    file,
    manifest("1-7") +
      event("1-7", 1, "session_start") +
      event("1-7", 2, "jumped"),
  );
  expect(reader.read().events.map((e) => e.type)).toEqual([
    "session_start",
    "jumped",
  ]);
});

test("no log yet is nothing to read", () => {
  const { reader } = rig();
  expect(reader.read()).toEqual({
    manifest: null,
    events: [],
    heartbeat: null,
    state: null,
  });
});
