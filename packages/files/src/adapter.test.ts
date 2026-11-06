import { afterEach, expect, test } from "bun:test";
import type { GameEvent } from "@swarmfu/connect-protocol";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileAdapter } from "./adapter.ts";
import { projectzomboid } from "./packs/projectzomboid.ts";

/** Her "right now" lines: the status and the pack's others. */
const STATE_KINDS = new Set(["status", "carrying", "gear", "body", "watching"]);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** A connector folder written by hand, and the adapter following it. */
function rig({ fromStart = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "connector-"));
  dirs.push(dir);
  let clock = 100_000;
  const events: GameEvent[] = [];
  const logs: string[] = [];
  const write = (name: string, value: unknown) =>
    writeFileSync(join(dir, name), JSON.stringify(value));
  const manifest = (session: string, part = 1) =>
    write("manifest.json", {
      v: 1,
      source: "projectzomboid",
      session,
      events_file: `events-${session}-${part}.log`,
      game: { save: "Muldraugh" },
    });
  const line = (
    session: string,
    seq: number,
    type: string,
    data: object = {},
    part = 1,
  ) =>
    appendFileSync(
      join(dir, `events-${session}-${part}.log`),
      `${JSON.stringify({ v: 1, session, seq, ts: clock, type, data })}\n`,
    );
  const heartbeat = (session: string, over: object = {}) =>
    write("heartbeat.json", {
      v: 1,
      session,
      ts: clock,
      paused: false,
      player: {
        username: "Bob",
        profession: "veteran",
        hours_survived: 3.2,
        zombie_kills: 7,
      },
      ...over,
    });
  const adapter = createFileAdapter(projectzomboid, {
    dir,
    fromStart,
    now: () => clock,
    onEvent: (event) => events.push(event),
    log: (text) => logs.push(text),
  });
  return {
    dir,
    adapter,
    events,
    logs,
    manifest,
    line,
    heartbeat,
    write,
    tick: (ms: number) => (clock += ms),
    summaries: () => events.map((e) => e.summary),
  };
}

const kill = { by_local_player: true, distance: 0.9, weapon: "Machete" };

test("a session already running is followed from now; from the start when asked", () => {
  for (const fromStart of [false, true]) {
    const r = rig({ fromStart });
    r.manifest("s1");
    r.heartbeat("s1");
    r.line("s1", 1, "zombie_killed", kill);
    r.adapter.poll();
    r.line("s1", 2, "zombie_killed", { ...kill, distance: 0.2 });
    r.adapter.poll();
    const kills = r.events
      .filter((e) => e.kind === "zombie_killed")
      .map((e) => e.data?.distance);
    expect(kills).toEqual(fromStart ? [0.9, 0.2] : [0.2]);
  }
});

test("each kill is its own tallied event, named from the heartbeat", () => {
  const r = rig({ fromStart: true });
  r.manifest("s1");
  r.heartbeat("s1");
  r.line("s1", 1, "zombie_killed", kill);
  r.line("s1", 2, "zombie_killed", { by_local_player: false, distance: 1 });
  r.line("s1", 3, "zombie_killed", { ...kill, distance: 0.3 });
  r.adapter.poll();
  const kills = r.events.filter((e) => e.kind === "zombie_killed");
  expect(kills.map((e) => [e.summary, e.tally, e.lane])).toEqual([
    ["Bob killed a zombie with the Machete, 0.9 m away.", true, "silent"],
    ["Bob killed a zombie with the Machete, 0.3 m away.", true, "silent"],
  ]);
});

test("a line still being written waits; lost lines are counted; repeats are skipped", () => {
  const r = rig({ fromStart: true });
  r.manifest("s1");
  r.heartbeat("s1");
  const path = join(r.dir, "events-s1-1.log");
  const whole = JSON.stringify({
    v: 1,
    session: "s1",
    seq: 1,
    ts: 1,
    type: "skill_up",
    data: { skill: "Long Blade", level: 2 },
  });
  appendFileSync(path, whole.slice(0, 30));
  r.adapter.poll();
  expect(r.events.filter((e) => e.kind === "skill_up")).toHaveLength(0);
  appendFileSync(path, `${whole.slice(30)}\n`);
  r.line("s1", 4, "skill_up", { skill: "Cooking", level: 1 });
  r.line("s1", 4, "skill_up", { skill: "Cooking", level: 1 });
  r.adapter.poll();
  expect(
    r.events.filter((e) => e.kind === "skill_up").map((e) => e.summary),
  ).toEqual([
    "Bob's Long Blade went up to level 2.",
    "Bob's Cooking went up to level 1.",
  ]);
  expect(r.adapter.resource("state")).toMatchObject({
    lost_events: 2,
    running: true,
  });
  expect(r.logs.some((l) => l.includes("lost 2"))).toBe(true);
});

test("a file rolled to its next part is read to its end, then the new one from its start", () => {
  const r = rig({ fromStart: true });
  r.manifest("s1");
  r.heartbeat("s1");
  r.line("s1", 1, "zombie_killed", kill);
  r.adapter.poll();
  r.line("s1", 2, "zombie_killed", { ...kill, distance: 0.5 });
  r.line("s1", 3, "zombie_killed", { ...kill, distance: 0.7 }, 2);
  r.manifest("s1", 2);
  r.adapter.poll();
  expect(
    r.events
      .filter((e) => e.kind === "zombie_killed")
      .map((e) => e.data?.distance),
  ).toEqual([0.9, 0.5, 0.7]);
});

test("a new session is read from its first line, even when attached mid-session before", () => {
  const r = rig();
  r.manifest("s1");
  r.heartbeat("s1");
  r.line("s1", 1, "zombie_killed", kill);
  r.adapter.poll();
  r.line("s2", 1, "session_start", { mode: "Apocalypse", save: "Muldraugh" });
  r.manifest("s2");
  r.heartbeat("s2");
  r.adapter.poll();
  expect(r.summaries()).toContain(
    "Bob loaded into their Apocalypse save, Muldraugh.",
  );
  expect(r.adapter.resource("self")).toEqual({
    partner: "Bob",
    world: "Muldraugh",
  });
});

test("the heartbeat says when the game pauses, closes and comes back, and her status follows the state file", () => {
  const r = rig();
  r.manifest("s1");
  r.heartbeat("s1");
  r.write("state.json", {
    v: 1,
    session: "s1",
    ts: 100_000,
    game_time: { hour: 9, minute: 5 },
    day_phase: "day",
    player: { forename: "Carlton", surname: "O'Connell" },
    place: { room: "kids_bedroom" },
    condition: { band: "healthy" },
    threat: { nearby: 3, chasing: 1 },
    weather: { label: "fog" },
  });
  r.adapter.poll();
  expect(r.summaries()).toEqual([
    "Carlton O'Connell is in the kids bedroom, healthy; 3 zombies nearby, 1 chasing. fog, day, 9:05 am.",
  ]);
  // Unchanged, it isn't sent again, however long it's been.
  r.tick(31_000);
  // A pause shorter than PAUSE_HOLD_MS (a menu, switching windows) isn't one.
  r.heartbeat("s1", { paused: true });
  r.adapter.poll();
  r.tick(2_000);
  r.heartbeat("s1");
  r.adapter.poll();
  expect(r.summaries()).toHaveLength(1);
  r.heartbeat("s1", { paused: true });
  r.adapter.poll();
  r.tick(5_000);
  r.heartbeat("s1", { paused: true });
  r.adapter.poll();
  expect(r.summaries().slice(1)).toEqual(["The game is paused."]);
  r.tick(11_000);
  r.adapter.poll();
  expect(r.summaries().at(-1)).toBe("Project Zomboid has closed (or crashed).");
  r.heartbeat("s1");
  r.adapter.poll();
  expect(r.summaries().slice(-2)).toEqual([
    "Project Zomboid is running again.",
    "The game is unpaused.",
  ]);
  expect(r.adapter.resource("state")).toMatchObject({
    running: true,
    threat: { nearby: 3 },
  });
});

test("the milestone 1 sample from the game reads as her events", () => {
  const events: GameEvent[] = [];
  const adapter = createFileAdapter(projectzomboid, {
    dir: join(import.meta.dir, "../fixtures/projectzomboid-m1"),
    fromStart: true,
    // Just after its last heartbeat, so the game counts as running.
    now: () => 1793850663511 + 1_000,
    onEvent: (event) => events.push(event),
    log: () => {},
  });
  adapter.poll();
  const kinds = events.map((e) => e.kind);
  // 15 lines: one kill wasn't the player's, and it's dropped.
  expect(kinds.filter((k) => k === "zombie_killed")).toHaveLength(11);
  expect(kinds.slice(0, 2)).toEqual(["session_start", "player_spawned"]);
  expect(kinds).toContain("skill_up");
  expect(events[0]?.summary).toBe("AdriennePoindexter loaded into their Apocalypse save, ARK v1.10.13 2026-10-18 23-12-26.");
  // It ended paused, so her status is the heartbeat's.
  expect(adapter.resource("state")).toMatchObject({ running: true, paused: true });
});

test("the milestone 2 sample reads as her events: fights, chases and scares reach her, the rest she just knows", () => {
  const events: GameEvent[] = [];
  const dir = join(import.meta.dir, "../fixtures/projectzomboid-m2");
  const heartbeat = JSON.parse(readFileSync(join(dir, "heartbeat.json"), "utf8")) as { ts: number };
  const adapter = createFileAdapter(projectzomboid, {
    dir,
    fromStart: true,
    now: () => heartbeat.ts + 1_000,
    onEvent: (event) => events.push(event),
    log: () => {},
  });
  adapter.poll();
  const pack = events.filter((e) => !STATE_KINDS.has(e.kind));
  // Every line of the session is something she knows about; none dropped.
  expect(pack).toHaveLength(89);
  const by = (kind: string) => events.filter((e) => e.kind === kind);
  expect(by("zombie_killed").every((e) => e.tally && e.lane === "silent")).toBe(true);
  expect(by("jump_scare")[0]).toMatchObject({ lane: "reflex", reaction: "startle" });
  expect(by("chase_start")[0]).toMatchObject({ lane: "reflex", reaction: "concern" });
  expect(by("chase_end")[0]?.summary).toBe(
    "Carlton O'Connell got away after a 25 s chase, up to 2 behind them, 2 down on the way, 0.5 health lost.",
  );
  // Fights she'd remark on: hurt, or three or more at once.
  expect(by("fight_end").filter((e) => e.lane === "respond")).toHaveLength(5);
  expect(by("moodle_increased").filter((e) => e.lane === "respond").map((e) => e.summary)).toEqual([
    "Carlton O'Connell's panic is at level 3 of 4.",
    "Carlton O'Connell's panic is at level 4 of 4.",
  ]);
  expect(adapter.resource("self")).toEqual({ partner: "Carlton O'Connell", world: "2026-11-04_23-27-26" });
  expect(adapter.resource("state")).toMatchObject({ running: true, place: { room: "hall" }, threat: { nearby: 0 } });
  expect(by("status")[0]?.summary).toBe(
    "Carlton O'Connell is in the hall, healthy; 0 zombies nearby, 0 chasing. clear, day, 2:34 pm.",
  );
});

test("connector 0.3.0: hits, near misses and distances in metres", () => {
  const r = rig({ fromStart: true });
  r.manifest("s1");
  r.heartbeat("s1");
  r.line("s1", 1, "zombie_killed", { by_local_player: true, distance_m: 0.4, weapon: "Axe" });
  r.line("s1", 2, "player_hit", { wounded: true, injury: "bite", body_part: "forearm_l", bleeding: true, from_behind: true });
  r.line("s1", 3, "player_hit", { wounded: false, from_behind: false });
  r.line("s1", 4, "near_miss", { outcome: "interrupted", distance_m: 0.9, from_behind: false });
  r.line("s1", 5, "near_death", { health: 14.6, bleeding_parts: 2, chasing: 3 });
  r.line("s1", 6, "vehicle_entered", { vehicle: "Base.CarNormal", driver: true });
  r.adapter.poll();
  const events = r.events.filter((e) => !STATE_KINDS.has(e.kind));
  expect(events.map((e) => [e.kind, e.lane, e.summary])).toEqual([
    ["zombie_killed", "silent", "Bob killed a zombie with the Axe, 0.4 m away."],
    ["player_hit", "respond", "A zombie bit Bob on the forearm l!"],
    ["player_hit", "reflex", "A zombie hit Bob, but their clothes stopped it."],
    ["near_miss", "reflex", "A zombie went for Bob but was cut off, 0.9 m away."],
    ["near_death", "respond", "Bob is close to death: 15 health, 2 parts bleeding, 3 zombies chasing."],
    ["vehicle_entered", "silent", "Bob got behind the wheel of the Base.CarNormal."],
  ]);
  expect(events[2]?.reaction).toBe("flinch");
});

test("a file caught half-written is ignored until it's whole again", () => {
  const r = rig({ fromStart: true });
  r.manifest("s1");
  r.heartbeat("s1");
  r.line("s1", 1, "skill_up", { skill: "Axe", level: 1 });
  r.adapter.poll();
  // Mid-write: the manifest and heartbeat are cut off.
  writeFileSync(join(r.dir, "manifest.json"), '{"v":1,"source":"projectzom');
  writeFileSync(join(r.dir, "heartbeat.json"), '{"v":1,"sess');
  r.line("s1", 2, "skill_up", { skill: "Axe", level: 2 });
  r.adapter.poll();
  expect(r.adapter.resource("state")).toMatchObject({ running: true });
  r.manifest("s1");
  r.heartbeat("s1");
  r.adapter.poll();
  expect(r.events.filter((e) => e.kind === "skill_up").map((e) => e.summary)).toEqual([
    "Bob's Axe went up to level 1.",
    "Bob's Axe went up to level 2.",
  ]);
  expect(r.summaries()).not.toContain("Project Zomboid has closed (or crashed).");
});
