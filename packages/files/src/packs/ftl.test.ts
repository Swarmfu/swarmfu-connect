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
 * Two logs: `ftl-run1` is FTL_HS.log from a real run (FTL 1.6.13, Hyperspace
 * 1.23.2, mod 0.1.0 before the fixes that run showed: a start beacon, three
 * jumps, a store, a mercenary turned enemy and destroyed). `ftl-sim` is the
 * current mod run in Lua 5.3 against the mod's mock of Hyperspace
 * (tools/sim), covering what that run didn't: a hit taken, a crew member
 * lost, the option taken, a new sector, back to the menu.
 */
const SIM = join(import.meta.dir, "../../fixtures/ftl-sim/FTL_HS.log");
const RUN = join(import.meta.dir, "../../fixtures/ftl-run1/FTL_HS.log");
/** A second real run, with the fixed mod: options taken, hits taken, two fights. */
const RUN2 = join(import.meta.dir, "../../fixtures/ftl-run2/FTL_HS.log");
const FIXTURE = SIM;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function fixture(file = FIXTURE) {
  const reader = new LogReader({
    file,
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
  // The start beacon's text is the run's, after its start.
  expect(lines.indexOf("The data you carry is vital to the remaining Federation fleet.")).toBe(
    lines.indexOf("A new FTL run: The Kestrel, a Kestrel Cruiser, on normal.") + 1,
  );
  expect(lines).toContain(
    "A damaged station hails you, asking for help with a fire in its engine room. Options: Send your crew to help, Ignore them and move on, (Medbay) Treat their wounded.",
  );
  expect(lines).toContain("The Kestrel chose: Ignore them and move on.");
  expect(lines).toContain("Another ship is here: a Pirate Rigger.");
  expect(lines).toContain("The Pirate Rigger is hostile now: a fight, 10 hull.");
  expect(lines).toContain("The hull took 3 damage: 27 of 30 left.");
  expect(lines).toContain("Lost Zed, the Engi. 2 crew left.");
  expect(lines).toContain("Destroyed the Pirate Rigger.");
  expect(lines).toContain(
    "Into sector 2: Mantis Homeworlds, a hostile sector.",
  );
  expect(lines).toContain("Back at FTL's main menu.");
});

test("the real run reads as hers, beginning to end", () => {
  const { events, manifest, heartbeat } = fixture(RUN);
  expect(manifest).toMatchObject({ source: "ftl", connector_version: "0.1.0" });
  expect(heartbeat).toMatchObject({ in_run: true });
  const lines = events.map((e) => translateEvent(ftl, e, { player: "The Kestrel" })!.summary);
  expect(lines).toHaveLength(34);
  expect(lines).toContain("There's a store here. A ship engineer has set up a small shop here. Options: Continue...");
  expect(lines).toContain(
    'A mercenary hails you: "Greetings, friend! We\'ve heard tell of your quest and are here to offer our valuable services." Options: Hire the mercenary to delay the Rebels, Hire the mercenary to scout the sector, Fight the ship, You have no need of his services.',
  );
  expect(lines).toContain("Another ship is here: a Pirate Rigger.");
  expect(lines).toContain("Hit the enemy for 2: 6 of 8 hull left.");
  expect(lines).toContain("Destroyed the Pirate Rigger.");
  expect(lines).toContain("Jumped to beacon 3 of the run, in sector 1.");
});

test("in the second real run, the options taken and the hits taken read right", () => {
  const { events } = fixture(RUN2);
  const lines = events.map((e) => translateEvent(ftl, e, { player: "The Kestrel" })!.summary);
  expect(lines).toContain("The Kestrel chose: Demand the surrender of their goods.");
  expect(lines).toContain("The Kestrel chose: (Missile Weapon) Bombard their key structures.");
  expect(lines).toContain("The hull took 1 damage: 29 of 30 left.");
  // The choice comes before the text it led to.
  expect(lines.indexOf("The Kestrel chose: Demand the surrender of their goods.")).toBeLessThan(
    lines.indexOf("You prepare to secure their cargo by force."),
  );
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
      class: "Rebel Fighter",
      hostile: true,
      hull: 6,
      max_hull: 10,
      crew: 1,
    },
  };
  expect(statusLine(ftl, inRun, { player: "The Kestrel" })).toBe(
    "The Kestrel in sector 1 (Civilian Sector), beacon 1 of the run: hull 27 of 30, 52 scrap, 16 fuel, 8 missiles, 2 drone parts.",
  );
  const more = Object.fromEntries(
    moreStatusLines(ftl, inRun, {}).map((l) => [l.kind, l.line]),
  );
  expect(more.enemy).toBe("Fighting a Rebel Fighter: 6 of 10 hull, 1 crew.");
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
