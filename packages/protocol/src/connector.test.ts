import { expect, test } from "bun:test";
import {
  clockOf,
  connectorEventSchema,
  connectorManifestSchema,
  fillTemplate,
  moreStatusLines,
  packManifest,
  playerName,
  statusLine,
  translateEvent,
  type ConnectorEvent,
  type GamePack,
} from "./connector.ts";

const pack: GamePack = {
  id: "testgame",
  game: "Test Game",
  version: "1",
  role: "spectator",
  folder: {},
  player: ["{player.username}", "{player.forename} {player.surname}"],
  events: {
    zombie_killed: {
      description: "A zombie died.",
      rules: [
        { when: { "data.by_local_player": false }, drop: true },
        {
          when: { "data.distance": { lte: 0.3 } },
          lane: "respond",
          tally: true,
          summary: "{player} got one at {data.distance|1} m.",
        },
        {
          tally: true,
          summary: "{player} killed a zombie with the {data.weapon}.",
        },
        { tally: true, summary: "{player} killed a zombie." },
      ],
    },
    hit: {
      description: "Something hit them.",
      rules: [
        { lane: "reflex", reaction: "flinch", summary: "{player} took a hit." },
      ],
    },
  },
};

const event = (over: Partial<ConnectorEvent>): ConnectorEvent => ({
  v: 1,
  session: "s1",
  seq: 1,
  ts: 1_000,
  type: "zombie_killed",
  ...over,
});

test("the first rule that fits, and has everything it needs, makes the event", () => {
  const close = translateEvent(
    pack,
    event({ data: { distance: 0.24, weapon: "Machete" } }),
    { player: "Bob" },
  );
  expect(close).toMatchObject({
    kind: "zombie_killed",
    lane: "respond",
    tally: true,
    subject: "user",
    summary: "Bob got one at 0.2 m.",
    at: 1_000,
  });
  // No weapon: that rule can't fill, so the next one is used.
  expect(
    translateEvent(pack, event({ data: { distance: 2 } }), { player: "Bob" })
      ?.summary,
  ).toBe("Bob killed a zombie.");
  expect(
    translateEvent(
      pack,
      event({ data: { distance: 2, by_local_player: false } }),
      { player: "Bob" },
    ),
  ).toBeNull();
  // A type the pack doesn't know is dropped.
  expect(
    translateEvent(pack, event({ type: "horde_seen" }), { player: "Bob" }),
  ).toBeNull();
  // The connector's subject maps onto hers.
  expect(
    translateEvent(pack, event({ subject: "world", data: {} }), {
      player: "Bob",
    })?.subject,
  ).toBe("world");
});

test("game text is one short line in her instructions", () => {
  expect(fillTemplate("read {t}", { t: "A\nbook\u0007 title" })).toBe(
    "Read A book title",
  );
  expect(fillTemplate("{t}", { t: "x".repeat(200) })).toHaveLength(60);
  expect(fillTemplate("{a|words}", { a: "hang-sheet" })).toBe("hang sheet");
  // A voice would read an underscore out, so there's never one.
  expect(fillTemplate("loaded {a}", { a: "ARK_v1.10_2026-10-18" })).toBe("loaded ARK v1.10 2026-10-18");
  expect(fillTemplate("{a}", { a: { nested: true } })).toBeNull();
});

test("the character's name comes from the first template that fills", () => {
  expect(
    playerName(pack, { player: { username: "Bob", forename: "Carl" } }),
  ).toBe("Bob");
  expect(
    playerName(pack, { player: { forename: "Carlton", surname: "O'Connell" } }),
  ).toBe("Carlton O'Connell");
  expect(playerName(pack, {})).toBeUndefined();
});

test("a pack's manifest declares its kinds and the connector's own, with no tools", () => {
  const manifest = packManifest(pack);
  expect(manifest.role).toBe("spectator");
  expect(manifest.tools).toEqual({});
  expect(manifest.events.zombie_killed?.lane).toBe("respond");
  expect(manifest.events.hit).toMatchObject({
    lane: "reflex",
    reaction: "flinch",
  });
  expect(manifest.events.game_closed).toBeDefined();
  expect(Object.keys(manifest.resources)).toEqual(["self", "state"]);
});

test("the manifest's events file has to be a file in the folder", () => {
  const manifest = {
    v: 1,
    source: "testgame",
    session: "s1",
    events_file: "events-s1-1.log",
  };
  expect(connectorManifestSchema.safeParse(manifest).success).toBe(true);
  for (const events_file of ["../secrets.txt", "/etc/passwd", "a/b.log", ".."])
    expect(
      connectorManifestSchema.safeParse({ ...manifest, events_file }).success,
    ).toBe(false);
  expect(
    connectorEventSchema.safeParse(event({ type: "Bad Type" })).success,
  ).toBe(false);
});

test("the game's clock reads the way it's said", () => {
  expect(clockOf({ hour: 15, minute: 5 })).toBe("3:05 pm");
  expect(clockOf({ hour: 0, minute: 30 })).toBe("12:30 am");
  expect(clockOf({ hour: 12 })).toBe("12:00 pm");
  expect(clockOf({ hour: 9, minute: 5 })).toBe("9:05 am");
  expect(clockOf(undefined)).toBeUndefined();
});

test("a list shows its first few, an object its entries, and an empty one nothing", () => {
  expect(fillTemplate("took {items|list}", { items: ["20 Nails", "Rolling_Papers"] })).toBe("Took 20 Nails, Rolling Papers");
  expect(fillTemplate("{m|list}", { m: { stress: 2, heavy_load: 1 } })).toBe("stress 2, heavy load 1");
  expect(fillTemplate("{xs|list}", { xs: Array.from({ length: 12 }, (_, i) => `${i}`) })).toBe("0, 1, 2, 3, 4, 5, 6, 7");
  expect(fillTemplate("{xs|list}", { xs: [] })).toBeNull();
  // Things in a list read as their label, else their name; an id never.
  expect(fillTemplate("{xs|list}", { xs: [{ id: "h1", label: "Strike (1 energy)" }, { name: "Anchor" }, { id: "x" }] })).toBe(
    "Strike (1 energy), Anchor",
  );
  expect(fillTemplate("{m|list}", { m: {} })).toBeNull();
});

test("status templates can have conditions, and a pack's other lines come by kind", () => {
  const withStatus: GamePack = {
    ...pack,
    status: {
      everyMs: 1,
      summary: [{ when: { floor: { gte: 1 } }, summary: "Up {floor} floors." }, "On the ground."],
      more: [{ kind: "carrying", description: "What they carry.", summary: ["Carrying {kg|1} kg."] }],
    },
  };
  const source = { v: 1, session: "s", ts: 1, floor: 0, kg: 7.25 };
  expect(statusLine(withStatus, source)).toBe("On the ground.");
  expect(statusLine(withStatus, { ...source, floor: 2 })).toBe("Up 2 floors.");
  expect(moreStatusLines(withStatus, source)).toEqual([{ kind: "carrying", line: "Carrying 7.3 kg." }]);
  expect(moreStatusLines(withStatus, { v: 1, session: "s", ts: 1 })).toEqual([]);
  expect(packManifest(withStatus).events.carrying).toEqual({ lane: "silent", description: "What they carry." });
});
