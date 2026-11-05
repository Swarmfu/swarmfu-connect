import {
  HEARTBEAT_STALE_MS,
  packManifest,
  playerName,
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
import { ConnectorReader } from "./reader.ts";

/**
 * The file adapter: any game with a connector mod, through its pack. Each
 * poll turns the events added since the last into hers, and the heartbeat
 * (and the state file, if the mod writes one) into her picture of "right
 * now" and whether the game is still running. She watches; there are no
 * tools.
 */

export interface FileAdapterOptions {
  dir: string;
  fromStart?: boolean;
  now?: () => number;
  onEvent?: (event: GameEvent) => void;
  log?: (line: string) => void;
}

export interface FileAdapter extends AdapterServer {
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
]);

const withoutBookkeeping = (value: object) =>
  Object.fromEntries(
    Object.entries(value).filter(([key]) => !BOOKKEEPING.has(key)),
  );

const text = (value: unknown) =>
  typeof value === "string" && value.trim()
    ? value.trim().slice(0, 64)
    : undefined;

export function createFileAdapter(
  pack: GamePack,
  options: FileAdapterOptions,
): FileAdapter {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.error(line));
  const reader = new ConnectorReader({
    dir: options.dir,
    fromStart: options.fromStart,
    log,
  });
  let heartbeat: Heartbeat | null = null;
  let state: GameState | null = null;
  let player: string | undefined;
  let world: string | undefined;
  let alive: boolean | null = null;
  let paused: boolean | null = null;
  let status: { line: string; at: number } | null = null;

  const resource = (name: string): unknown => {
    if (name === "self")
      return {
        ...(player ? { partner: player } : {}),
        ...(world ? { world } : {}),
      };
    if (name === "state")
      return {
        running: alive === true,
        ...(heartbeat ? withoutBookkeeping(heartbeat) : {}),
        // The state file has more than the heartbeat, when the mod writes one.
        ...(state && state.session === heartbeat?.session
          ? withoutBookkeeping(state)
          : {}),
        ...(reader.lost ? { lost_events: reader.lost } : {}),
      };
    return null;
  };

  const adapter = createAdapterServer({
    manifest: packManifest(pack),
    toolInputs: {},
    name: `${pack.game} (file adapter)`,
    instructions: `${pack.game}, followed through its connector mod. She watches the user play; there's nothing to call.`,
    tool: () => {
      throw new Error(`${pack.game} has no tools.`);
    },
    resource,
    onEvent: options.onEvent,
    log,
  });
  const game = (
    summary: string,
    kind: RaisedEvent["kind"],
    subject: RaisedEvent["subject"] = "world",
  ) => adapter.emit({ kind, lane: "silent", subject, summary });

  const poll = () => {
    const read = reader.read();
    if (read.heartbeat) heartbeat = read.heartbeat;
    if (read.state) state = read.state;
    // The current session's state, else its heartbeat: where the name and "right now" come from.
    const current =
      state && heartbeat && state.session === heartbeat.session
        ? state
        : heartbeat;
    player = (current && playerName(pack, current)) ?? player;
    world =
      (read.manifest && pack.world
        ? text(valueAt(read.manifest, pack.world))
        : undefined) ?? world;

    for (const event of read.events) {
      // Before any heartbeat, the event's own copy of the character can name them.
      const translated = translateEvent(pack, event, {
        player: player ?? playerName(pack, event.data),
      });
      if (translated) adapter.emit(translated);
    }

    const t = now();
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
    if (paused !== null && isPaused !== paused)
      game(
        isPaused ? "The game is paused." : "The game is unpaused.",
        isPaused ? "game_paused" : "game_resumed",
      );
    paused = isPaused;

    if (pack.status && (!status || t - status.at >= pack.status.everyMs)) {
      const line = statusLine(pack, current, { player });
      if (line && line !== status?.line) {
        game(line, "status", "user");
        status = { line, at: t };
      }
    }
  };

  return { ...adapter, poll, resource };
}
