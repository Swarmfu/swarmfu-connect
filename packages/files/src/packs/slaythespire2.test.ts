import { expect, test } from "bun:test";
import { packManifest, translateEvent, type ConnectorEvent } from "@swarmfu/connect-protocol";
import { slaythespire2 } from "./slaythespire2.ts";

const event = (type: string, over: Partial<ConnectorEvent> = {}): ConnectorEvent => ({
  v: 1,
  session: "s1",
  seq: 1,
  ts: 1,
  type,
  run: { act: 1, floor: 3, room: "monster" },
  ...over,
});
const said = (e: ConnectorEvent) =>
  translateEvent(slaythespire2, e, { player: "Ironclad Bob", cohost: "Mika" });

test("each player's moves are named for whoever made them", () => {
  const play = { card: "Bash", target: "Jaw Worm" };
  expect(said(event("card_played", { data: play }))?.summary).toBe("Ironclad Bob played Bash on Jaw Worm.");
  expect(said(event("card_played", { subject: "cohost", data: play }))).toMatchObject({
    subject: "self",
    summary: "Mika played Bash on Jaw Worm.",
  });
  expect(said(event("card_played", { subject: "teammate", data: { ...play, player_name: "Ana" } }))).toMatchObject({
    subject: "teammate",
    summary: "Ana played Bash on Jaw Worm.",
  });
});

test("her move with no name for her never names the streamer", () => {
  const line = translateEvent(slaythespire2, event("card_played", { subject: "cohost", data: { card: "Bash" } }), {
    player: "Ironclad Bob",
  });
  expect(line?.summary).toBe("Someone played Bash.");
});

test("fields named differently still make a plainer line", () => {
  expect(said(event("relic_gained", { data: { name: "Anchor" } }))?.summary).toBe("A relic was found.");
  expect(said(event("room_entered", { run: undefined }))?.summary).toBe("They went into the next room.");
});

test("a big hit is worth a word; small ones are tallied", () => {
  const big = said(event("damage_taken", { data: { amount: 18, source: "Gremlin Nob" } }));
  expect(big).toMatchObject({ lane: "respond", reaction: "flinch", summary: "Ironclad Bob took 18 damage from Gremlin Nob." });
  expect(said(event("damage_taken", { data: { amount: 4 } }))).toMatchObject({ lane: "silent", tally: true });
});

test("her moves and their results wait for control", () => {
  expect(said(event("decision_needed", { subject: "cohost" }))).toBeNull();
  expect(said(event("command_result", { subject: "cohost" }))).toBeNull();
  expect(Object.keys(packManifest(slaythespire2).events)).toContain("run_started");
});
