import { afterEach, expect, test } from "bun:test";
import type { GameEvent, GamePack } from "@swarmfu/connect-protocol";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileAdapter } from "./adapter.ts";
import { readPointers } from "./pointers.ts";

/** A made-up co-op game: nothing here is any real game's. */
const pack: GamePack = {
  id: "testgame",
  game: "Test Game",
  version: "1",
  role: "spectator",
  folder: {},
  player: ["{player.name}"],
  events: {
    hit: {
      description: "Someone hit something.",
      rules: [
        {
          when: { subject: "cohost" },
          summary: "{cohost} hit the {data.what}.",
          lane: "respond",
        },
        {
          when: { subject: "teammate" },
          summary: "{data.player_name} hit the {data.what}.",
          lane: "respond",
        },
        { summary: "{player} hit the {data.what}.", lane: "respond" },
      ],
    },
    decision_needed: {
      description: "Her turn.",
      rules: [{ summary: "{data.prompt}", lane: "respond", subject: "self" }],
    },
  },
  status: { everyMs: 0, summary: ["{player} has {hp} HP."] },
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function rig() {
  const home = mkdtempSync(join(tmpdir(), "swarmfu-home-"));
  dirs.push(home);
  const pointers = join(home, ".swarmfu", "connectors");
  mkdirSync(pointers, { recursive: true });
  let clock = 100_000;
  const events: GameEvent[] = [];
  /** One copy of the game, writing its folder and its pointer. */
  const copy = (instance: string, manifest: object, name: string) => {
    const root = join(home, "game", instance);
    mkdirSync(root, { recursive: true });
    const session = `s-${instance}`;
    let seq = 0;
    writeFileSync(
      join(root, "manifest.json"),
      JSON.stringify({
        v: 1,
        source: pack.id,
        session,
        events_file: "events.log",
        instance,
        started_at: clock,
        ...manifest,
      }),
    );
    writeFileSync(
      join(pointers, `${pack.id}-${instance}.json`),
      JSON.stringify({ v: 1, source: pack.id, instance, root, updated: clock }),
    );
    const beat = (over: object = {}) =>
      writeFileSync(
        join(root, "heartbeat.json"),
        JSON.stringify({
          v: 1,
          session,
          ts: clock,
          player: { name },
          hp: 40,
          ...over,
        }),
      );
    const event = (type: string, subject: string, data: object) =>
      appendFileSync(
        join(root, "events.log"),
        `${JSON.stringify({ v: 1, session, seq: ++seq, ts: clock, type, subject, data })}\n`,
      );
    beat();
    return { root, beat, event };
  };
  const adapter = createFileAdapter(pack, {
    pointers,
    home,
    now: () => clock,
    onEvent: (event) => events.push(event),
    log: () => {},
  });
  return {
    pointers,
    copy,
    adapter,
    tick: (ms: number) => (clock += ms),
    told: () =>
      events
        .filter((e) => !["status", "game_opened", "game_closed"].includes(e.kind))
        .map((e) => `${e.subject}: ${e.summary}`),
    events,
  };
}

test("a pointer file finds a copy of the game with no folder in its pack", () => {
  const r = rig();
  r.adapter.poll();
  const game = r.copy("a1", {}, "Bob");
  r.tick(2_000);
  r.adapter.poll();
  game.event("hit", "player", { what: "wall" });
  r.adapter.poll();
  expect(r.told()).toEqual(["user: Bob hit the wall."]);
  expect(r.events.find((e) => e.kind === "status")?.summary).toBe(
    "Bob has 40 HP.",
  );
});

test("a pointer that isn't one, or names a relative folder, is skipped", () => {
  const r = rig();
  writeFileSync(join(r.pointers, "junk.json"), "{not json");
  writeFileSync(
    join(r.pointers, "rel.json"),
    JSON.stringify({ v: 1, source: pack.id, instance: "x", root: "game/x" }),
  );
  r.copy("a1", {}, "Bob");
  expect(readPointers(r.pointers, pack.id).map((p) => p.instance)).toEqual([
    "a1",
  ]);
  expect(readPointers(r.pointers, "othergame")).toEqual([]);
});

test("in co-op, the streamer's copy narrates and hers adds only what's hers", () => {
  const r = rig();
  const streamer = r.copy(
    "s1",
    { perspective: "streamer", group: "lobby 7" },
    "Bob",
  );
  const hers = r.copy(
    "c1",
    {
      perspective: "cohost",
      group: "lobby 7",
      capabilities: ["events", "state", "control"],
    },
    "Mika",
  );
  r.adapter.poll();
  // The same hit, told by both copies: once as a teammate's, once as hers.
  streamer.event("hit", "teammate", { what: "slime", player_name: "Mika" });
  hers.event("hit", "cohost", { what: "slime" });
  // Bob's own hit, told by both: only the streamer's copy counts.
  streamer.event("hit", "player", { what: "worm" });
  hers.event("hit", "teammate", { what: "worm", player_name: "Bob" });
  // A third player, from the streamer's copy.
  streamer.event("hit", "teammate", { what: "crab", player_name: "Ana" });
  hers.event("decision_needed", "cohost", {
    decision_id: "d-1",
    prompt: "Your turn.",
  });
  r.adapter.poll();
  expect(r.told().sort()).toEqual(
    [
      "self: Mika hit the slime.",
      "user: Bob hit the worm.",
      "teammate: Ana hit the crab.",
      "self: Your turn.",
    ].sort(),
  );
  expect(r.adapter.resource("self")).toMatchObject({
    name: "Mika",
    partner: "Bob",
  });
});

test("her copy in another group isn't followed", () => {
  const r = rig();
  const streamer = r.copy(
    "s1",
    { perspective: "streamer", group: "lobby 7" },
    "Bob",
  );
  const hers = r.copy(
    "c1",
    { perspective: "cohost", group: "lobby 9" },
    "Mika",
  );
  r.adapter.poll();
  streamer.event("hit", "teammate", { what: "slime", player_name: "Mika" });
  hers.event("hit", "cohost", { what: "slime" });
  r.adapter.poll();
  expect(r.told()).toEqual(["teammate: Mika hit the slime."]);
});

test("with only her copy running, it narrates", () => {
  const r = rig();
  const hers = r.copy("c1", { perspective: "cohost" }, "Mika");
  r.adapter.poll();
  hers.event("hit", "cohost", { what: "slime" });
  r.adapter.poll();
  expect(r.told()).toEqual(["self: Mika hit the slime."]);
});

test("machine-only keys never reach the state she reads", () => {
  const r = rig();
  const game = r.copy(
    "a1",
    { speech: { machine_keys: ["id", "*_id", "args", "secret"] } },
    "Bob",
  );
  game.beat({
    hand: [{ id: "h1", label: "Strike", card_id: "c9" }],
    secret: 1,
    args: { x: 1 },
  });
  r.adapter.poll();
  const state = r.adapter.resource("state") as Record<string, unknown>;
  expect(state.hand).toEqual([{ label: "Strike" }]);
  expect(state).not.toHaveProperty("secret");
  expect(state).not.toHaveProperty("args");
});

test("a copy that starts after she's watching is read from its first line", () => {
  const r = rig();
  r.adapter.poll();
  r.tick(5_000);
  const game = r.copy("a1", {}, "Bob");
  game.event("hit", "player", { what: "door" });
  r.adapter.poll();
  expect(r.told()).toEqual(["user: Bob hit the door."]);
});
