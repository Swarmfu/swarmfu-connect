import { expect, test } from "bun:test";
import {
  moreStatusLines,
  packManifest,
  statusLine,
  translateEvent,
  type ConnectorEvent,
  type GameState,
} from "@swarmfu/connect-protocol";
import { slaythespire2 } from "./slaythespire2.ts";

const event = (
  type: string,
  over: Partial<ConnectorEvent> = {},
): ConnectorEvent => ({
  v: 1,
  session: "s1",
  seq: 1,
  ts: 1,
  type,
  run: { act: 1, floor: 3, room: "monster fight" },
  ...over,
});
const said = (e: ConnectorEvent) =>
  translateEvent(slaythespire2, e, { player: "Bob", cohost: "Mika" });

test("each player's moves are named for whoever made them, and kept apart", () => {
  const turn = {
    turn: 2,
    cards_played: ["Bash on Jaw Worm", "Strike on Jaw Worm"],
    damage_dealt: 14,
    hp_lost: 3,
  };
  expect(said(event("turn_ended", { data: turn }))).toMatchObject({
    kind: "turn_ended",
    subject: "user",
    summary:
      "Bob's turn 2: played Bash on Jaw Worm, Strike on Jaw Worm; dealt 14, lost 3 HP.",
  });
  expect(
    said(event("turn_ended", { subject: "cohost", data: turn })),
  ).toMatchObject({
    kind: "turn_ended_hers",
    subject: "self",
    summary:
      "Mika's turn 2: played Bash on Jaw Worm, Strike on Jaw Worm; dealt 14, lost 3 HP.",
  });
  expect(
    said(
      event("turn_ended", {
        subject: "teammate",
        data: { ...turn, name: "Ana" },
      }),
    ),
  ).toMatchObject({
    kind: "turn_ended_teammate",
    subject: "teammate",
    summary:
      "Ana's turn 2: played Bash on Jaw Worm, Strike on Jaw Worm; dealt 14, lost 3 HP.",
  });
});

test("her move with no name for her never names the streamer", () => {
  const line = translateEvent(
    slaythespire2,
    event("relic_gained", { subject: "cohost", data: { relic: "Anchor" } }),
    {
      player: "Bob",
    },
  );
  expect(line?.summary).toBe("Someone got Anchor.");
});

test("a turn's start says what she'd need to follow the fight", () => {
  const data = {
    turn: 1,
    energy: 3,
    hp: 62,
    max_hp: 80,
    block: 0,
    hand: [
      { id: "h1", label: "Strike" },
      { id: "h2", label: "Bash" },
    ],
    enemy_intents: ["Jaw Worm: attack for 11"],
  };
  expect(said(event("turn_started", { data }))?.summary).toBe(
    "Turn 1 for Bob: 3 energy, 62 of 80 HP, 0 block. Enemies: Jaw Worm: attack for 11.",
  );
});

test("a big hit is worth a word; small ones are tallied", () => {
  const big = said(
    event("damage_taken", {
      data: {
        damage: 18,
        blocked: 2,
        from: ["Gremlin Nob"],
        hp: 44,
        max_hp: 80,
      },
    }),
  );
  expect(big).toMatchObject({
    lane: "respond",
    reaction: "flinch",
    summary: "Bob took 18 from Gremlin Nob, down to 44 of 80 HP.",
  });
  expect(
    said(
      event("damage_taken", {
        data: { damage: 4, blocked: 6, from: ["Louse"], hp: 76, max_hp: 80 },
      }),
    ),
  ).toMatchObject({
    lane: "silent",
    tally: true,
    summary: "Bob took 4 from Louse (6 blocked), 76 of 80 HP left.",
  });
});

test("a run's end says how it went", () => {
  expect(
    said(
      event("run_ended", {
        data: {
          result: "defeat",
          killed_by: "The Guardian",
          act: 1,
          floor: 16,
        },
      }),
    )?.summary,
  ).toBe("The run is over: killed by The Guardian on act 1, floor 16.");
  expect(
    said(
      event("run_ended", {
        data: { result: "victory", character: "Ironclad" },
      }),
    )?.reaction,
  ).toBe("triumph");
});

test("fields missing still make a plainer line", () => {
  expect(
    said(event("relic_gained", { data: { name: "Anchor" } }))?.summary,
  ).toBe("A relic was found.");
  expect(said(event("room_entered", { data: {} }))?.summary).toBe(
    "They went into the next room.",
  );
});

test("right now: where they are, their kit and the fight", () => {
  const state: GameState = {
    v: 1,
    session: "s1",
    ts: 1,
    in_run: true,
    run: {
      character: "Ironclad",
      act: 1,
      act_name: "Overgrowth",
      floor: 5,
      room: "monster fight",
    },
    player: {
      hp: 62,
      max_hp: 80,
      gold: 99,
      relics: ["Burning Blood"],
      potions: ["Fire Potion"],
      deck_size: 11,
    },
    combat: {
      round: 2,
      energy: 3,
      max_energy: 3,
      block: 5,
      enemies: [{ name: "Jaw Worm", hp: 30 }],
      hand: ["Strike", "Defend"],
    },
  };
  expect(statusLine(slaythespire2, state, { player: "Bob" })).toBe(
    "Bob is on act 1 (Overgrowth), floor 5, in monster fight: 62 of 80 HP, 99 gold.",
  );
  expect(moreStatusLines(slaythespire2, state, { player: "Bob" })).toEqual([
    {
      kind: "kit",
      line: "Relics: Burning Blood. Potions: Fire Potion. 11 cards in the deck.",
    },
    { kind: "fight", line: "Fight, round 2: 3 of 3 energy, 5 block." },
    { kind: "enemies", line: "Enemies: Jaw Worm." },
    { kind: "hand", line: "Hand: Strike, Defend." },
    { kind: "effects", line: "Nothing on Bob right now." },
  ]);
  expect(
    statusLine(slaythespire2, { v: 1, session: "s1", ts: 1, in_run: false }),
  ).toBe("Not in a run: at the menu.");
});

test("her moves and their results wait for control", () => {
  expect(said(event("decision_needed", { subject: "cohost" }))).toBeNull();
  expect(said(event("command_result", { subject: "cohost" }))).toBeNull();
  const kinds = Object.keys(packManifest(slaythespire2).events);
  expect(kinds).toContain("turn_ended_hers");
  expect(kinds).toContain("kit");
});

test("before their name is known they're the player, and an unknown character isn't named", () => {
  const plain = (e: ConnectorEvent) => translateEvent(slaythespire2, e, {});
  expect(
    plain(
      event("card_added", {
        subject: "player",
        data: { card: "Inflame", source: "combat reward" },
      }),
    )?.summary,
  ).toBe("The player took Inflame (combat reward).");
  expect(
    plain(
      event("run_started", {
        subject: "player",
        data: { character: "unknown", ascension: 0 },
      }),
    )?.summary,
  ).toBe("A new run started, on ascension 0.");
});

test("the character is named as the game names it, and an unknown one isn't", async () => {
  const { playerName } = await import("@swarmfu/connect-protocol");
  expect(
    playerName(slaythespire2, { run: { character: "The Ironclad" } }),
  ).toBe("The Ironclad");
  expect(playerName(slaythespire2, { run: { character: "unknown" } })).toBe(
    "The player",
  );
  expect(
    playerName(slaythespire2, {
      player: { name: "Zac" },
      run: { character: "The Ironclad" },
    }),
  ).toBe("Zac");
});

test("a turn with no block still shows the enemies", () => {
  const data = {
    turn: 1,
    energy: 3,
    hp: 63,
    max_hp: 80,
    hand: ["Defend", "Bash"],
    enemy_intents: ["Shrinker Beetle: strong debuff"],
  };
  expect(said(event("turn_started", { data }))?.summary).toBe(
    "Turn 1 for Bob: 3 energy, 63 of 80 HP. Enemies: Shrinker Beetle: strong debuff.",
  );
});
