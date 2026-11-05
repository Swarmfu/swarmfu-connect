import { expect, test } from "bun:test";
import {
  connectorEventSchema,
  connectorManifestSchema,
  fillTemplate,
  packManifest,
  playerName,
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
    "read A book title",
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
