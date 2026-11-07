import {
  DEFAULT_MACHINE_KEYS,
  GAME_ACTION_TOOL,
  HEARTBEAT_STALE_MS,
  decisionLine,
  decisionSchema,
  gameActionInput,
  resolveMove,
  stateSchema,
  type ConnectorCommand,
  type Decision,
  withoutMachineKeys,
  type ConnectorEvent,
  type ConnectorManifest,
  packManifest,
  playerName,
  moreStatusLines,
  statusLine,
  translateEvent,
  valueAt,
  type GameEvent,
  type GamePack,
  type GameState,
  type Heartbeat,
} from "@swarmfu/connect-protocol";
import {
  createAdapterServer,
  type AdapterServer,
  type RaisedEvent,
} from "@swarmfu/connect-protocol/adapter";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { packFolder } from "./packs/index.ts";
import { pointersFolder, readPointers } from "./pointers.ts";
import { ConnectorReader } from "./reader.ts";

/**
 * How long the game must stay paused before she's told: the second play test
 * had 107 pauses and resumes in an hour, from menus and switching windows.
 */
export const PAUSE_HOLD_MS = 5_000;

/**
 * The file adapter: any game with a connector mod, through its pack. Each
 * poll turns the events added since the last into hers, and the heartbeat
 * (and the state file, if the mod writes one) into her picture of "right
 * now" and whether the game is still running. She watches; there are no
 * tools.
 */

export interface FileAdapterOptions {
  /** The connector's folder. Unset, it's found: the pack's folder and the pointer files. */
  dir?: string;
  /** Where pointer files are; ~/.swarmfu/connectors unless set (tests). */
  pointers?: string;
  /** The home folder a pack's `~` folder is under; the user's unless set (tests). */
  home?: string;
  fromStart?: boolean;
  now?: () => number;
  onEvent?: (event: GameEvent) => void;
  log?: (line: string) => void;
  /** How long a move waits for the game's answer (tests make it short). */
  moveWaitMs?: number;
}

export interface FileAdapter extends AdapterServer {
  /** Her move, as `game_action` makes it: the answer she reads. */
  act(input: { action: string; args?: Record<string, string>; say?: string }): Promise<string>;
  /** Reads what's new and sends it. The caller runs it on a timer. */
  poll(): void;
  /** A resource's current value, as the MCP server serves it. */
  resource(name: string): unknown;
}

/** Fields that are the mod's own bookkeeping, not the game's state. */
const BOOKKEEPING = new Set([
  "v",
  "session",
  "seq",
  "events_file",
  "buffered",
  "dropped",
  "write_errors",
  "last_command_id",
]);

const withoutBookkeeping = (value: object) =>
  Object.fromEntries(
    Object.entries(value).filter(([key]) => !BOOKKEEPING.has(key)),
  );

const text = (value: unknown) =>
  typeof value === "string" && value.trim()
    ? value.trim().slice(0, 64)
    : undefined;

/** How often the pointer files are looked at again for a copy of the game starting or closing. */
const FIND_EVERY_MS = 2_000;

/**
 * What her own copy of the game sends besides events about her character:
 * the rest of what happens there, the streamer's copy already tells.
 */
const COHOST_TYPES = new Set(["decision_needed", "command_result", "control_changed", "cohost_said"]);

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** A connector's control switch, from its heartbeat. */
const controlOf = (heartbeat: Heartbeat | null) => {
  const control = heartbeat?.control as { enabled?: unknown; mode?: unknown } | undefined;
  return { enabled: control?.enabled === true, mode: typeof control?.mode === "string" ? control.mode : "off" };
};

/** One copy of the game, followed through its folder. */
interface Instance {
  root: string;
  reader: ConnectorReader;
  manifest: ConnectorManifest | null;
  heartbeat: Heartbeat | null;
  state: GameState | null;
  events: ConnectorEvent[];
}

/** An instance's current state if it's this session's, else its heartbeat. */
const currentOf = (instance: Instance | undefined): Heartbeat | GameState | null => {
  if (!instance) return null;
  const { state, heartbeat } = instance;
  return state && heartbeat && (state.session ?? heartbeat.session) === heartbeat.session ? state : heartbeat;
};

const isCohost = (instance: Instance) => instance.manifest?.perspective === "cohost";

export function createFileAdapter(
  pack: GamePack,
  options: FileAdapterOptions,
): FileAdapter {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.error(line));
  const startedAt = now();
  const instances = new Map<string, Instance>();
  let foundAt = -Infinity;
  /** The folders to follow: the one given, else the pack's (if it's there) and every pointer's for this game. */
  const find = (t: number) => {
    if (t - foundAt < FIND_EVERY_MS) return;
    foundAt = t;
    const roots = new Set<string>();
    if (options.dir) roots.add(resolve(options.dir));
    else {
      const folder = packFolder(pack, process.platform, options.home);
      if (folder && existsSync(folder)) roots.add(resolve(folder));
      for (const pointer of readPointers(options.pointers ?? pointersFolder(options.home), pack.id))
        roots.add(resolve(pointer.root));
    }
    for (const root of roots)
      if (!instances.has(root))
        instances.set(root, {
          root,
          reader: new ConnectorReader({ dir: root, fromStart: options.fromStart, since: startedAt, log }),
          manifest: null,
          heartbeat: null,
          state: null,
          events: [],
        });
    // A copy whose pointer is gone and whose heartbeat stopped has closed for good.
    for (const [root, instance] of instances)
      if (!roots.has(root) && !(instance.heartbeat && t - instance.heartbeat.ts < HEARTBEAT_STALE_MS)) instances.delete(root);
  };
  /**
   * Which copies she follows: the streamer's (the freshest), and hers in the
   * same co-op group if she's joined. With only hers running, hers is the main one.
   */
  const pick = (t: number): { main?: Instance; cohost?: Instance } => {
    const fresh = (i: Instance) => !!i.heartbeat && t - i.heartbeat.ts < HEARTBEAT_STALE_MS;
    const newest = (list: Instance[]) =>
      list.sort((a, b) => (b.heartbeat?.ts ?? 0) - (a.heartbeat?.ts ?? 0))[0];
    const all = [...instances.values()].filter((i) => i.manifest);
    const streamers = all.filter((i) => !isCohost(i));
    const main = newest(streamers.filter(fresh)) ?? newest(all.filter((i) => isCohost(i) && fresh(i))) ?? newest(streamers) ?? newest(all);
    if (!main || isCohost(main)) return { main };
    // Her copy in the same co-op group; without groups, hers on this computer.
    const group = main.manifest?.group;
    const cohost = newest(
      all.filter((i) => isCohost(i) && fresh(i) && (!group || !i.manifest?.group || i.manifest.group === group)),
    );
    return { main, cohost };
  };

  let heartbeat: Heartbeat | null = null;
  let state: GameState | null = null;
  let player: string | undefined;
  let cohostName: string | undefined;
  let machineKeys: readonly string[] = DEFAULT_MACHINE_KEYS;
  let following: { main?: Instance; cohost?: Instance } = {};
  let decisionShown: string | undefined;
  let world: string | undefined;
  let alive: boolean | null = null;
  let paused: boolean | null = null;
  // A pause only counts once it has held PAUSE_HOLD_MS: menus and alt-tabs flicker.
  let pauseSeen: number | null = null;
  let status: { line: string; at: number } | null = null;
  const more = new Map<string, string>();
  const lost = () => [...instances.values()].reduce((sum, i) => sum + i.reader.lost, 0);

  const resource = (name: string): unknown => {
    if (name === "self")
      return {
        ...(cohostName ? { name: cohostName } : {}),
        ...(player ? { partner: player } : {}),
        ...(world ? { world } : {}),
      };
    if (name === "state") {
      const hers = following.cohost;
      const hersNow = currentOf(hers);
      return withoutMachineKeys(
        {
          running: alive === true,
          ...(heartbeat ? withoutBookkeeping(heartbeat) : {}),
          // The state file has more than the heartbeat, when the mod writes one.
          ...(state && (state.session ?? heartbeat?.session) === heartbeat?.session
            ? withoutBookkeeping(state)
            : {}),
          // Her own copy of the game, in co-op: what only she can see there.
          ...(hersNow ? { her_game: withoutBookkeeping(hersNow) } : {}),
          ...(lost() ? { lost_events: lost() } : {}),
        },
        machineKeys,
      );
    }
    return null;
  };

  const adapter = createAdapterServer({
    manifest: packManifest(pack),
    toolInputs: pack.control ? { [GAME_ACTION_TOOL]: gameActionInput } : {},
    name: `${pack.game} (file adapter)`,
    instructions: pack.control
      ? `${pack.game}, followed through its connector mod. She can play her own copy of the game with ${GAME_ACTION_TOOL}.`
      : `${pack.game}, followed through its connector mod. She watches the user play; there's nothing to call.`,
    tool: async (name, args) => {
      if (name !== GAME_ACTION_TOOL || !pack.control) throw new Error(`${pack.game} has no tool called ${name}.`);
      return act(args as { action: string; args?: Record<string, string>; say?: string });
    },
    resource,
    onEvent: options.onEvent,
    log,
  });
  /**
   * The copy she plays: hers in co-op, else the streamer's when its connector
   * takes commands. Whether she may is the streamer's say on the site ("Let
   * her play") and the game's own control setting, not swarmfu's.
   */
  const controlled = (): Instance | undefined => {
    const { main, cohost } = following;
    const takes = (i: Instance | undefined) => !!i?.manifest?.capabilities?.includes("control") && !!i.manifest.commands_file;
    if (takes(cohost)) return cohost;
    if (takes(main)) return main;
    return undefined;
  };
  /** The decision open in a copy now, read straight from its state file. */
  const decisionIn = (instance: Instance): Decision | null => {
    try {
      const state = stateSchema.safeParse(JSON.parse(readFileSync(join(instance.root, "state.json"), "utf8")));
      const decision = state.success ? decisionSchema.safeParse(state.data.decision) : null;
      return decision?.success ? decision.data : null;
    } catch {
      return null;
    }
  };
  const results = new Map<string, Record<string, unknown>>();
  let commands = 0;
  // Under the backend's 25 s wait for a tool, with room for the next decision.
  const moveWaitMs = options.moveWaitMs ?? 15_000;

  const act = async (input: { action: string; args?: Record<string, string>; say?: string }): Promise<string> => {
    const instance = controlled();
    if (!instance)
      return following.cohost
        ? "You can't play right now: the game you'd play isn't taking moves."
        : "You aren't playing: there's no copy of the game for you to play.";
    const control = controlOf(instance.heartbeat);
    if (!control.enabled || control.mode === "off") return "Control is off in the game, so you can't move right now.";
    let decision = decisionIn(instance);
    // Still busy (animations): give it a moment.
    for (let i = 0; i < 10 && decision?.ready === false; i++) {
      await sleep(300);
      decision = decisionIn(instance);
    }
    if (!decision) return "There's nothing for you to decide right now.";
    if (decision.ready === false) return decisionLine(decision);
    const move = resolveMove(decision, input.action, input.args ?? {});
    if ("error" in move) return move.error;
    const command: ConnectorCommand = {
      v: 1,
      id: `c-${startedAt.toString(36)}-${++commands}`,
      ts: Date.now(),
      decision: decision.id,
      action: move.action,
      args: move.args,
      ...(input.say?.trim() ? { say: input.say.trim().slice(0, 200) } : {}),
    };
    appendFileSync(join(instance.root, instance.manifest!.commands_file!), `${JSON.stringify(command)}\n`);
    log(`move: ${command.action} ${JSON.stringify(command.args)}`);
    // The game answers in its events; poll() files each answer here.
    const deadline = Date.now() + moveWaitMs;
    let result: Record<string, unknown> | undefined;
    while (!(result = results.get(command.id)) && Date.now() < deadline) await sleep(150);
    if (!result) return "The game hasn't answered yet; check what you can do now before moving again.";
    results.delete(command.id);
    const text = (key: string) => (typeof result![key] === "string" ? (result![key] as string) : undefined);
    if (result.status !== "applied")
      return `That didn't happen (${text("status") ?? "rejected"}): ${text("reason") ?? "no reason given"}.`;
    // What comes next: the next decision, once the game has settled.
    let next = decisionIn(instance);
    for (let i = 0; i < 20 && (!next || next.id === decision.id || next.ready === false); i++) {
      await sleep(200);
      next = decisionIn(instance);
    }
    // The game says what happens after the move (connector 0.5.1's "next"), or the decision does.
    const done = `Done: ${text("summary") ?? command.action}.${text("next") ? ` ${text("next")}` : ""}`;
    if (!next) return text("next") ? done : `${done} Nothing more for you to decide right now.`;
    if (next.id === decision.id) return `${done} The game hasn't moved on yet.`;
    if (next.ready === false) return text("next") ? done : `${done} ${decisionLine(next)}`;
    return `${done} ${decisionLine(next)}`;
  };

  const game = (
    summary: string,
    kind: RaisedEvent["kind"],
    subject: RaisedEvent["subject"] = "world",
  ) => adapter.emit({ kind, lane: "silent", subject, summary });

  const poll = () => {
    const t = now();
    find(t);
    for (const instance of instances.values()) {
      const read = instance.reader.read();
      instance.manifest = read.manifest ?? instance.manifest;
      if (read.heartbeat) instance.heartbeat = read.heartbeat;
      if (read.state) instance.state = read.state;
      instance.events = read.events;
    }
    following = pick(t);
    const { main, cohost } = following;
    heartbeat = main?.heartbeat ?? null;
    state = main?.state ?? null;
    // The current session's state, else its heartbeat: where the names and "right now" come from.
    const current = currentOf(main);
    const mainIsHers = !!main && isCohost(main);
    const mainName = current ? playerName(pack, current) : undefined;
    if (mainIsHers) cohostName = mainName ?? cohostName;
    else player = mainName ?? player;
    const hersNow = currentOf(cohost);
    if (hersNow) cohostName = playerName(pack, hersNow) ?? cohostName;
    machineKeys = main?.manifest?.speech?.machine_keys ?? DEFAULT_MACHINE_KEYS;
    world =
      (main?.manifest && pack.world
        ? text(valueAt(main.manifest, pack.world))
        : undefined) ?? world;

    // Her copy, in co-op, tells what's hers; the streamer's tells the rest.
    // Each says what the other does about her character, so one is left out.
    const told = [
      ...(main?.events ?? []).filter(
        (event) =>
          !cohost ||
          (event.subject !== "cohost" &&
            !(event.subject === "teammate" && cohostName && (valueAt(event, "data.player_name") ?? valueAt(event, "data.name")) === cohostName)),
      ),
      ...(cohost?.events ?? []).filter((event) => event.subject === "cohost" || COHOST_TYPES.has(event.type)),
    ];
    // The game's answers to her moves, for act() waiting on them.
    const hers = controlled();
    for (const event of hers?.events ?? [])
      if (event.type === "command_result" && typeof event.data?.command_id === "string")
        results.set(event.data.command_id, event.data);
    // What she can do now, when she plays: a "right now" line of its own.
    if (hers) {
      const decision = decisionIn(hers);
      const line = decision ? decisionLine(decision) : "Nothing for you to decide in your game right now.";
      if (line !== decisionShown) {
        adapter.emit({ kind: "decision", lane: "silent", subject: "self", summary: line });
        decisionShown = line;
      }
    }

    for (const event of told) {
      // Before any heartbeat, the event's own copy of the character can name them.
      const translated = translateEvent(pack, event, {
        player: player ?? (mainIsHers ? undefined : playerName(pack, event.data)),
        cohost: cohostName,
      });
      if (translated) adapter.emit(translated);
    }

    const running = !!heartbeat && t - heartbeat.ts < HEARTBEAT_STALE_MS;
    if (alive !== null && running !== alive)
      game(
        running
          ? `${pack.game} is running again.`
          : `${pack.game} has closed (or crashed).`,
        running ? "game_opened" : "game_closed",
      );
    alive = running;
    if (!running || !heartbeat || !current) return;

    const isPaused = heartbeat.paused === true;
    pauseSeen = isPaused ? (pauseSeen ?? t) : null;
    const held = isPaused && t - (pauseSeen ?? t) >= PAUSE_HOLD_MS;
    if (paused === null) paused = isPaused;
    else if (held && !paused) {
      game("The game is paused.", "game_paused");
      paused = true;
    } else if (!isPaused && paused) {
      game("The game is unpaused.", "game_resumed");
      paused = false;
    }

    if (pack.status && (!status || t - status.at >= pack.status.everyMs)) {
      const line = statusLine(pack, current, { player, cohost: cohostName });
      if (line && line !== status?.line) {
        game(line, "status", "user");
        status = { line, at: t };
      }
      for (const { kind, line: extra } of moreStatusLines(pack, current, { player, cohost: cohostName }))
        if (more.get(kind) !== extra) {
          game(extra, kind as RaisedEvent["kind"], "user");
          more.set(kind, extra);
        }
    }
  };

  return { ...adapter, poll, resource, act };
}
