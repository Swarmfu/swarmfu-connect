import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  EVENT_NOTIFICATION,
  gameEventSchema,
  parseRecording,
  resourceUri,
  type GameEvent,
} from "@swarmfu/connect-protocol";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { Replayer, type Clock } from "./replay.ts";
import { createSimulator } from "./server.ts";

/** A clock that only moves when told, running due timers in order. */
function fakeClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: Clock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      timers.set(++nextId, { at: now + ms, fn });
      return nextId;
    },
    clearTimeout: (id) => void timers.delete(id as number),
  };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = [...timers]
        .filter(([, t]) => t.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = until;
  };
  return { clock, advance };
}

const tiny = parseRecording(
  [
    '{"type":"header","adapter":"minecraft","description":"tiny","players":{"self":"Kiri","user":"Steve"}}',
    '{"type":"state","t":0,"resource":"self","value":{"health":20}}',
    '{"type":"event","t":0,"event":{"kind":"player_joined","lane":"respond","subject":"self","summary":"Kiri joined."}}',
    '{"type":"event","t":1000,"event":{"kind":"creeper_fuse","lane":"reflex","subject":"self","summary":"Hiss."}}',
    '{"type":"event","t":3000,"event":{"kind":"death","lane":"respond","subject":"user","summary":"Steve died."}}',
  ].join("\n"),
);

test("the bundled recording parses and stays within the manifest", () => {
  const recording = parseRecording(
    readFileSync(
      join(import.meta.dir, "../recordings/minecraft-first-night.jsonl"),
      "utf8",
    ),
  );
  const dropped: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void dropped.push(args.join(" "));
  try {
    const { clock, advance } = fakeClock();
    const events: GameEvent[] = [];
    const sim = createSimulator(recording, {
      clock,
      onEvent: (e) => events.push(e),
    });
    sim.replayer.start();
    advance(recording.durationMs);
    expect(dropped).toEqual([]);
    expect(events.length).toBe(
      recording.entries.filter((e) => e.type === "event").length,
    );
    for (const lane of ["reflex", "respond", "silent"])
      expect(events.some((e) => e.lane === lane)).toBe(true);
  } finally {
    console.error = original;
  }
});

test("replays on time, faster with speed, and resumes where it paused", () => {
  const { clock, advance } = fakeClock();
  const kinds: string[] = [];
  const replayer = new Replayer(
    tiny,
    { event: (e) => kinds.push(e.kind), state: () => {} },
    { clock, speed: 2 },
  );
  replayer.start();
  expect(kinds).toEqual(["player_joined"]);
  advance(499);
  expect(kinds).toEqual(["player_joined"]);
  advance(1);
  expect(kinds).toEqual(["player_joined", "creeper_fuse"]);
  replayer.pause();
  advance(10_000);
  expect(kinds).toHaveLength(2);
  expect(replayer.position).toBe(1000);
  replayer.resume();
  advance(999);
  expect(kinds).toHaveLength(2);
  advance(1);
  expect(kinds).toEqual(["player_joined", "creeper_fuse", "death"]);
  expect(replayer.playing).toBe(false);
});

test("events get fresh ids and times, and looping starts over", () => {
  const { clock, advance } = fakeClock();
  const events: GameEvent[] = [];
  const replayer = new Replayer(
    tiny,
    { event: (e) => events.push(e), state: () => {} },
    { clock, loop: true },
  );
  replayer.start();
  advance(3000 + 1000);
  expect(events.map((e) => e.kind)).toEqual([
    "player_joined",
    "creeper_fuse",
    "death",
    "player_joined",
  ]);
  expect(new Set(events.map((e) => e.id)).size).toBe(4);
  expect(events.map((e) => e.at)).toEqual([0, 1000, 3000, 4000]);
  replayer.stop();
});

test("over MCP: events arrive as notifications, tools and resources work", async () => {
  const { clock, advance } = fakeClock();
  const sim = createSimulator(tiny, { clock });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-bridge", version: "0" });
  const received: GameEvent[] = [];
  client.setNotificationHandler(
    z.object({
      method: z.literal(EVENT_NOTIFICATION),
      params: gameEventSchema,
    }),
    (n) => void received.push(n.params),
  );
  await sim.server.connect(serverSide);
  await client.connect(clientSide);
  await Bun.sleep(0);

  advance(1000);
  await Bun.sleep(0);
  expect(received.map((e) => e.kind)).toEqual([
    "player_joined",
    "creeper_fuse",
  ]);
  expect(received[1]!.reaction).toBe("startle");

  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name)).toContain("follow_player");
  expect(
    tools.find((t) => t.name === "break_block")?.annotations?.destructiveHint,
  ).toBe(true);

  const result = await client.callTool({
    name: "follow_player",
    arguments: { player: "Steve" },
  });
  expect(result.isError).toBeFalsy();
  expect(sim.calls).toEqual([
    {
      tool: "follow_player",
      args: { player: "Steve", distance: 3 },
      at: expect.any(Number),
    },
  ]);

  const self = await client.readResource({
    uri: resourceUri("minecraft", "self"),
  });
  const first = self.contents[0];
  expect(first && "text" in first ? JSON.parse(first.text) : null).toEqual({
    name: "Kiri",
    partner: "Steve",
    health: 20,
    task: { tool: "follow_player", args: { player: "Steve", distance: 3 } },
  });

  const bad = await client.callTool({
    name: "say_in_chat",
    arguments: { message: "" },
  });
  expect(bad.isError).toBe(true);

  await client.close();
  expect(sim.replayer.playing).toBe(false);
});
