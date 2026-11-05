import {
  BRIDGE_HEARTBEAT_MS,
  BRIDGE_PROTOCOL,
  type BridgeAdapterInfo,
  type BridgeServerMessage,
  type GameEvent,
} from "@swarmfu/connect-protocol";
import { randomBytes } from "node:crypto";
import { AdapterConnection } from "./adapter.ts";
import type { Backend, CommandId, Feed, SessionId } from "./backend.ts";
import type { AdapterEntry } from "./config.ts";
import { LocalServer } from "./local.ts";
import { EventRelay } from "./relay.ts";

/**
 * One bridge run: starts an adapter, opens the localhost socket, checks in
 * with the backend and starts a play session. Then every event goes to the
 * page at once and to the backend in batches, and tool calls the backend
 * queues run on the adapter. Pausing (from the page or the backend) stops
 * her bot and holds commands until resumed.
 */

export interface BridgeOptions {
  backend: Backend;
  adapter: { id: string; entry: AdapterEntry; args: string[] };
  /** Every adapter this bridge could run, for the web app to list. */
  adapterIds: string[];
  port: number;
  origins: readonly string[];
  allowDestructive?: ReadonlySet<string>;
  log?(line: string): void;
  /** For tests: a fixed socket secret. */
  secret?: string;
}

export class Bridge {
  readonly #options: BridgeOptions;
  readonly #log: (line: string) => void;
  readonly #secret: string;
  readonly #relay: EventRelay;
  readonly #inflight = new Set<CommandId>();
  #local: LocalServer | null = null;
  #adapter: AdapterConnection | null = null;
  #sessionId: SessionId | null = null;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #unwatch: (() => void) | null = null;
  #paused = false;
  #stopping: Promise<void> | null = null;
  #stopped!: () => void;
  /** Resolves when the bridge has shut down, for whatever reason. */
  readonly done: Promise<string>;
  #reason = "";

  constructor(options: BridgeOptions) {
    this.#options = options;
    this.#log = options.log ?? (() => {});
    this.#secret = options.secret ?? randomBytes(24).toString("base64url");
    this.#relay = new EventRelay(options.backend, this.#log);
    this.done = new Promise<void>((resolve) => (this.#stopped = resolve)).then(
      () => this.#reason,
    );
  }

  get sessionId(): SessionId | null {
    return this.#sessionId;
  }

  get paused(): boolean {
    return this.#paused;
  }

  get port(): number | null {
    return this.#local?.port ?? null;
  }

  async start(): Promise<void> {
    const { backend, adapter } = this.#options;
    try {
      this.#local = await LocalServer.start({
        port: this.#options.port,
        secret: this.#secret,
        origins: this.#options.origins,
        greeting: () => ({
          type: "ready",
          protocol: BRIDGE_PROTOCOL,
          adapter: this.#adapterInfo(),
          paused: this.#paused,
        }),
        onMessage: (message) =>
          void this.#setPaused(message.type === "pause", "page"),
        log: this.#log,
      });
    } catch (error) {
      throw new Error(
        (error as NodeJS.ErrnoException).code === "EADDRINUSE"
          ? `port ${this.#options.port} is taken; is another bridge running? Try --port`
          : String(error),
      );
    }

    this.#adapter = await AdapterConnection.start(
      adapter.entry,
      adapter.args,
      {
        event: (event) => this.#onEvent(event),
        closed: () => void this.stop("the game adapter exited"),
        log: (line) => this.#log(`[${adapter.id}] ${line}`),
      },
      this.#options.allowDestructive,
    );
    const { manifest } = this.#adapter;

    const checkIn = () =>
      backend.hello({
        port: this.#local!.port,
        secret: this.#secret,
        adapters: this.#options.adapterIds,
      });
    await checkIn();
    this.#heartbeat = setInterval(() => {
      checkIn().catch((error: unknown) =>
        this.#log(
          `heartbeat failed: ${error instanceof Error ? error.message : error}`,
        ),
      );
    }, BRIDGE_HEARTBEAT_MS);

    const { name: player, partner, world } = await this.#adapter.identity();
    this.#sessionId = await backend.startSession({
      ...(player ? { player } : {}),
      ...(partner ? { partner } : {}),
      ...(world ? { world } : {}),
      adapterId: manifest.id,
      game: manifest.game,
      adapterVersion: manifest.version,
      ...(manifest.role ? { role: manifest.role } : {}),
      tools: await this.#adapter.declaredTools(),
    });
    this.#relay.setSession(this.#sessionId);
    this.#unwatch = backend.watchFeed(
      this.#sessionId,
      (feed) => this.#onFeed(feed),
      (error) =>
        void this.stop(`the backend refused the bridge: ${error.message}`),
    );
    this.#broadcastStatus();
  }

  /** Ends the session and shuts down. Safe to call more than once. */
  stop(reason = "stopped"): Promise<void> {
    this.#stopping ??= this.#shutdown(reason);
    return this.#stopping;
  }

  async #shutdown(reason: string): Promise<void> {
    this.#reason = reason;
    this.#log(`stopping: ${reason}`);
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#unwatch?.();
    const { backend } = this.#options;
    const quietly = async (what: string, step: () => Promise<unknown>) => {
      try {
        await step();
      } catch (error) {
        this.#log(
          `${what} failed: ${error instanceof Error ? error.message : error}`,
        );
      }
    };
    // The adapter goes first, so no event arrives after the last batch.
    await quietly("stopping the adapter", async () => this.#adapter?.close());
    await quietly("sending the last events", () => this.#relay.flush());
    this.#relay.stop();
    await quietly("checking out", () => backend.goodbye());
    await quietly("closing the socket", async () => this.#local?.close());
    await quietly("disconnecting", () => backend.close());
    this.#stopped();
  }

  #adapterInfo(): BridgeAdapterInfo | null {
    const manifest = this.#adapter?.manifest;
    return manifest
      ? { id: manifest.id, game: manifest.game, version: manifest.version }
      : null;
  }

  #broadcast(message: BridgeServerMessage): void {
    this.#local?.broadcast(message);
  }

  #broadcastStatus(): void {
    this.#broadcast({
      type: "status",
      adapter: this.#adapterInfo(),
      paused: this.#paused,
    });
  }

  #onEvent(event: GameEvent): void {
    if (this.#stopping) return;
    this.#broadcast({ type: "event", event });
    this.#relay.push(event);
  }

  #onFeed(feed: Feed): void {
    if (feed.status === "ended") {
      void this.stop("the play session was ended from the app");
      return;
    }
    void this.#setPaused(feed.status === "paused", "backend");
    if (this.#paused) return;
    for (const command of feed.commands) {
      if (this.#inflight.has(command.id)) continue;
      this.#inflight.add(command.id);
      void this.#run(command).finally(() => this.#inflight.delete(command.id));
    }
  }

  async #run(command: Feed["commands"][number]): Promise<void> {
    let args: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(command.args);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        args = parsed as Record<string, unknown>;
    } catch {
      // the backend checks it's an object; treat anything else as no arguments
    }
    this.#log(`running ${command.tool} ${command.args}`);
    const { ok, result } = await this.#adapter!.callTool(command.tool, args);
    try {
      await this.#options.backend.completeCommand(command.id, ok, result);
    } catch (error) {
      this.#log(
        `couldn't report ${command.tool}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /** Pausing stops her bot at once; the backend is told when the page asked for it. */
  async #setPaused(paused: boolean, from: "page" | "backend"): Promise<void> {
    if (paused === this.#paused) return;
    this.#paused = paused;
    this.#log(
      paused ? `paused (from the ${from})` : `resumed (from the ${from})`,
    );
    this.#broadcastStatus();
    if (paused && this.#adapter && "stop" in this.#adapter.manifest.tools)
      void this.#adapter.callTool("stop", { paused: true });
    if (from === "page" && this.#sessionId)
      await this.#options.backend
        .setPaused(this.#sessionId, paused)
        .catch((error: unknown) => {
          this.#log(
            `couldn't save the pause: ${error instanceof Error ? error.message : error}`,
          );
        });
  }
}
