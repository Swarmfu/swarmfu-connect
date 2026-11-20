import { afterEach, expect, test } from "bun:test";
import {
  moreStatusLines,
  statusLine,
  translateEvent,
  type GameEvent,
} from "@swarmfu/connect-protocol";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileAdapter } from "../adapter.ts";
import { LogReader } from "../logReader.ts";
import { ftl } from "./ftl.ts";

/**
 * The fixture is the connector's own output: its Lua run in Lua 5.3 against
 * a mock of Hyperspace's API and a scripted run (the mod's tools/sim), as
 * Hyperspace writes FTL_HS.log. To be replaced by a log from a real run.
 */
const FIXTURE = join(import.meta.dir, "../../fixtures/ftl-sim/FTL_HS.log");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const reader = new LogReader({
    file: FIXTURE,
    prefix: ftl.log!.prefix,
    fromStart: true,
    now: () => 1,
    log: () => {},
  });
  return reader.read();
}

test("every event in the run reads as a line of hers", () => {
  const { events } = fixture();
  const said = events.map((event) =>
    translateEvent(ftl, event, { player: "The Kestrel" }),
  );
  expect(said.every(Boolean)).toBe(true);
  const lines = said.map((s) => s!.summary);
  expect(lines).toContain("FTL is open, at the main menu.");
  expect(lines).toContain(
    "A new FTL run: The Kestrel, a Kestrel Cruiser, on normal.",
  );
  expect(lines).toContain(
    "A damaged station hails you, asking for help with a fire in its engine room. Options: Send your crew to help, Ignore them and move on, (Medbay) Treat their wounded.",
  );
  expect(lines).toContain("The Kestrel chose: Ignore them and move on.");
  expect(lines).toContain("A hostile ship: Rebel Fighter, 10 hull, 1 crew.");
  expect(lines).toContain("The hull took 3 damage: 27 of 30 left.");
  expect(lines).toContain("Lost Zed, the Engi. 2 crew left.");
  expect(lines).toContain("Destroyed the Rebel Fighter.");
  expect(lines).toContain(
    "Into sector 2: Mantis Homeworlds, a hostile sector.",
  );
  expect(lines).toContain("Back at FTL's main menu.");
});

test("a hit with little hull left is a reflex", () => {
  const event = {
    v: 1,
    session: "s",
    seq: 1,
    ts: 1,
    type: "hull_hit",
    data: { lost: 4, hull: 3, max_hull: 30 },
  };
  expect(translateEvent(ftl, event, {})).toMatchObject({
    lane: "reflex",
    reaction: "panic",
  });
});

test("her picture of right now: ship, sector and supplies, then crew, systems and the enemy", () => {
  const { state } = fixture();
  expect(state).toBeTruthy();
  // The last state is from the menu, after the run.
  expect(statusLine(ftl, state!, { player: "The Kestrel" })).toBe(
    "At FTL's main menu.",
  );
  const inRun = {
    ts: 1,
    in_run: true,
    player: {
      ship: "The Kestrel",
      hull: 27,
      max_hull: 30,
      scrap: 52,
      fuel: 16,
      missiles: 8,
      drone_parts: 2,
    },
    location: { sector: 1, sector_name: "Civilian Sector", jumps: 1 },
    crew: [{ name: "Ripley", species: "Human", health: 100 }],
    enemy: {
      name: "Rebel Fighter",
      hostile: true,
      hull: 6,
      max_hull: 10,
      crew: 1,
    },
  };
  expect(statusLine(ftl, inRun, { player: "The Kestrel" })).toBe(
    "The Kestrel in sector 1 (Civilian Sector), 1 jumps in: hull 27 of 30, 52 scrap, 16 fuel, 8 missiles, 2 drone parts.",
  );
  const more = Object.fromEntries(
    moreStatusLines(ftl, inRun, {}).map((l) => [l.kind, l.line]),
  );
  expect(more.enemy).toBe("Fighting the Rebel Fighter: 6 of 10 hull, 1 crew.");
  expect(more.crew).toStartWith("Crew: ");
});

test("the adapter follows the game's log from the pack's folder", () => {
  const dir = mkdtempSync(join(tmpdir(), "ftl-"));
  dirs.push(dir);
  copyFileSync(FIXTURE, join(dir, "FTL_HS.log"));
  const events: GameEvent[] = [];
  const adapter = createFileAdapter(ftl, {
    dir,
    fromStart: true,
    now: () => Date.now(),
    onEvent: (e) => events.push(e),
    log: () => {},
  });
  adapter.poll();
  const kinds = events.map((e) => e.kind);
  expect(kinds).toContain("ship_destroyed");
  expect(kinds).toContain("crew_lost");
});
