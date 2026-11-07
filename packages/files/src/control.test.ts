import { afterEach, expect, test } from "bun:test";
import type { GameEvent, GamePack } from "@swarmfu/connect-protocol";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileAdapter } from "./adapter.ts";

/** A made-up turn-based game she can play: nothing here is any real game's. */
const pack: GamePack = {
  id: "testcards",
  game: "Test Cards",
  version: "1",
  role: "spectator",
  folder: {},
  control: true,
  player: ["{player.name}"],
  events: {
    decision_needed: { description: "Her move.", rules: [{ lane: "respond", subject: "self", summary: "Your move: {data.prompt}" }] },
    command_result: { description: "A move's result.", rules: [{ subject: "self", summary: "You {data.summary}." }] },
  },
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const decision = (id: string, prompt: string) => ({
  id,
  for: "cohost",
  kind: "combat",
  ready: true,
  prompt,
  actions: [
    {
      action: "play card",
      params: {
        card: { options: [{ id: "c12", label: "Bash (2 energy): Deal 8 damage" }, { id: "c13", label: "Strike (1 energy): Deal 6 damage" }] },
        target: { options: [{ id: "e3", label: "Jaw Worm, 40 of 44 HP" }], optional: true },
      },
    },
    { action: "end turn" },
  ],
});

/** The streamer's copy and hers, in one lobby, each writing its folder and pointer. */
function rig({ hersControl = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), "swarmfu-play-"));
  dirs.push(home);
  const pointers = join(home, ".swarmfu", "connectors");
  mkdirSync(pointers, { recursive: true });
  const copy = (instance: string, perspective: string, name: string, control: boolean) => {
    const root = join(home, instance);
    mkdirSync(root);
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
        perspective,
        capabilities: control ? ["events", "state", "control"] : ["events", "state"],
        ...(control ? { commands_file: `commands-${session}.log` } : {}),
      }),
    );
    writeFileSync(join(pointers, `${pack.id}-${instance}.json`), JSON.stringify({ v: 1, source: pack.id, instance, root }));
    const beat = () =>
      writeFileSync(
        join(root, "heartbeat.json"),
        JSON.stringify({ v: 1, session, ts: Date.now(), player: { name }, control: { enabled: control, mode: control ? "play" : "off" } }),
      );
    const state = (value: object) => writeFileSync(join(root, "state.json"), JSON.stringify({ v: 1, session, ts: Date.now(), ...value }));
    const event = (type: string, subject: string, data: object) =>
      appendFileSync(join(root, "events.log"), `${JSON.stringify({ v: 1, session, seq: ++seq, ts: Date.now(), type, subject, data })}\n`);
    const commands = () => {
      const file = join(root, `commands-${session}.log`);
      return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
    };
    beat();
    return { root, beat, state, event, commands };
  };
  const streamer = copy("s1", "streamer", "Bob", false);
  const hers = copy("c1", "cohost", "Mika", hersControl);
  const events: GameEvent[] = [];
  const adapter = createFileAdapter(pack, { pointers, home, onEvent: (e) => events.push(e), log: () => {}, moveWaitMs: 2_000 });
  return { streamer, hers, adapter, events };
}

test("she makes a move in her own copy, by label, and hears how it went and what's next", async () => {
  const r = rig();
  r.hers.state({ decision: decision("d41", "3 energy, 2 cards.") });
  r.adapter.poll();
  expect(r.events.find((e) => e.kind === "decision")).toMatchObject({ subject: "self" });
  expect(r.events.find((e) => e.kind === "decision")?.summary).toStartWith("Your move (combat): 3 energy, 2 cards. You can:");

  // The game, a moment after the command lands: the result, then the next decision.
  const game = setInterval(() => {
    const [command] = r.hers.commands();
    if (!command || r.hers.commands().length > 1) return;
    r.hers.event("command_result", "cohost", { command_id: command.id, status: "applied", action: "play card", summary: "played Bash on Jaw Worm" });
    r.hers.state({ decision: decision("d42", "1 energy, 1 card.") });
    r.adapter.poll();
  }, 50);
  const answer = await r.adapter.act({ action: "play card", args: { card: "Bash", target: "Jaw Worm" }, say: "Bash first." });
  clearInterval(game);

  const [command] = r.hers.commands();
  expect(command).toMatchObject({ v: 1, decision: "d41", action: "play card", args: { card: "c12", target: "e3" }, say: "Bash first." });
  expect(answer).toStartWith("Done: played Bash on Jaw Worm. Your move (combat): 1 energy, 1 card.");
  expect(r.events.map((e) => e.summary)).toContain("You played Bash on Jaw Worm.");
});

test("after a move that hands the turn over, she hears what the game is doing, not \"nothing to decide\"", async () => {
  const r = rig();
  r.hers.state({ decision: decision("d41", "0 energy.") });
  r.adapter.poll();
  // Connector 0.5.1: the result says what's next, and the decision waits while the enemies act.
  const game = setInterval(() => {
    const [command] = r.hers.commands();
    if (!command || r.hers.commands().length > 1) return;
    r.hers.event("command_result", "cohost", {
      command_id: command.id,
      status: "applied",
      action: "end turn",
      summary: "ended the turn",
      next: "The enemies' turn is playing out.",
    });
    r.hers.state({ decision: { id: "d42", kind: "waiting", ready: false, prompt: "The enemies' turn is playing out.", actions: [] } });
    r.adapter.poll();
  }, 50);
  const answer = await r.adapter.act({ action: "end turn" });
  clearInterval(game);
  expect(answer).toBe("Done: ended the turn. The enemies' turn is playing out.");
  expect(r.events.filter((e) => e.kind === "decision").at(-1)?.summary).toBe("Nothing for you to decide yet: The enemies' turn is playing out.");
}, 10_000);

test("a move the decision doesn't allow is never written", async () => {
  const r = rig();
  r.hers.state({ decision: decision("d41", "3 energy.") });
  r.adapter.poll();
  expect(await r.adapter.act({ action: "play card", args: { card: "Bludgeon" } })).toContain('There\'s no "Bludgeon"');
  expect(r.hers.commands()).toEqual([]);
});

test("a rejection comes back with its reason", async () => {
  const r = rig();
  r.hers.state({ decision: decision("d41", "1 energy.") });
  r.adapter.poll();
  const game = setInterval(() => {
    const [command] = r.hers.commands();
    if (!command) return;
    r.hers.event("command_result", "cohost", { command_id: command.id, status: "rejected", action: "play card", reason: "not enough energy" });
    r.adapter.poll();
  }, 50);
  const answer = await r.adapter.act({ action: "play card", args: { card: "Bash" } });
  clearInterval(game);
  expect(answer).toBe("That didn't happen (rejected): not enough energy.");
});

test("with control off in the game, or nothing to decide, she's told so", async () => {
  const off = rig({ hersControl: false });
  off.adapter.poll();
  expect(await off.adapter.act({ action: "end turn" })).toContain("isn't taking moves");
  const idle = rig();
  idle.adapter.poll();
  expect(await idle.adapter.act({ action: "end turn" })).toBe("There's nothing for you to decide right now.");
});
