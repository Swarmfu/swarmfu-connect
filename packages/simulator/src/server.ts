import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createAdapterServer } from "@swarmfu/connect-protocol/adapter";
import { EVENT_NOTIFICATION, SELF_RESOURCE, type AdapterManifest, type GameEvent, type Recording } from "@swarmfu/connect-protocol";
import { MINECRAFT_MANIFEST, MINECRAFT_TOOL_INPUTS } from "@swarmfu/connect-minecraft/manifest";
import type { z } from "zod";
import { Replayer, type ReplayOptions } from "./replay.ts";

/**
 * A game adapter with no game: it serves a real adapter's manifest, tools and
 * resources, and replays a recording as that adapter's events. Tool calls
 * succeed without changing the recording; they're logged and shown as her
 * current task, so the bridge and decider can be built against it.
 */

const ADAPTERS: Record<
  string,
  { manifest: AdapterManifest; toolInputs: Record<string, z.ZodRawShape> }
> = {
  minecraft: {
    manifest: MINECRAFT_MANIFEST,
    toolInputs: MINECRAFT_TOOL_INPUTS,
  },
};

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
  at: number;
}

export interface Simulator {
  server: McpServer;
  replayer: Replayer;
  manifest: AdapterManifest;
  /** Current resource values, by name. */
  state: Map<string, unknown>;
  /** Every tool call so far, oldest first. */
  calls: ToolCall[];
}

export interface SimulatorOptions extends ReplayOptions {
  /** Called for each event as it's sent, e.g. to log it. */
  onEvent?(event: GameEvent): void;
}

export function createSimulator(
  recording: Recording,
  options: SimulatorOptions = {},
): Simulator {
  const adapter = ADAPTERS[recording.header.adapter];
  if (!adapter)
    throw new Error(`no adapter called ${recording.header.adapter}`);
  const { manifest, toolInputs } = adapter;
  const state = new Map<string, unknown>();
  const calls: ToolCall[] = [];

  const { server, emit } = createAdapterServer({
    manifest,
    toolInputs,
    name: `simulator (${manifest.id})`,
    instructions: `Simulated ${manifest.game}: replays "${recording.header.description}". Game events arrive as ${EVENT_NOTIFICATION} notifications.`,
    // Who's who comes from the recording; its state entries only carry the game's own fields.
    resource: (name) =>
      name === SELF_RESOURCE
        ? { name: recording.header.players.self, partner: recording.header.players.user, ...(state.get(name) as object) }
        : state.get(name),
    tool: (name, args) => {
      calls.push({ tool: name, args, at: Date.now() });
      const self = state.get("self");
      if (self && typeof self === "object")
        state.set("self", { ...self, task: name === "stop" ? null : { tool: name, args } });
      return `ok (simulated): ${name} ${JSON.stringify(args)}`;
    },
    onEvent: options.onEvent,
    log: (line) => console.error(`[simulator] ${line}`),
  });

  const replayer = new Replayer(
    recording,
    {
      state: (resource, value) => state.set(resource, value),
      event: (event) => void emit(event),
    },
    options,
  );

  // Play once the client has finished the handshake, so no event is missed.
  server.server.oninitialized = () => replayer.start();
  server.server.onclose = () => replayer.stop();

  return { server, replayer, manifest, state, calls };
}
