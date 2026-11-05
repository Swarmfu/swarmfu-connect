import { type GameEvent } from "@swarmfu/connect-protocol";
import { MINECRAFT_MANIFEST, MINECRAFT_TOOL_INPUTS } from "./manifest.ts";
import { createAdapterServer, type AdapterServer } from "@swarmfu/connect-protocol/adapter";
import type { Bot } from "mineflayer";
import { Actions, setupMovements } from "./actions.ts";
import { partnerName, resources } from "./state.ts";
import { watchBot, type WatchOptions } from "./watch.ts";

/**
 * The Minecraft adapter for a bot that has already joined: its MCP server
 * (manifest, tools, resources), the event watcher with her reflexes, and
 * her actions. Closing it stops watching; the bot itself is the caller's.
 */

export interface MinecraftAdapterOptions extends Pick<WatchOptions, "statusEveryMs" | "activityEveryMs" | "oreScanEveryMs" | "gatherMs"> {
  /** The user's player name; else the only other player online. */
  partner?: string;
  /** False skips setting up pathfinding (it needs real game data); for tests. */
  movements?: boolean;
  onEvent?(event: GameEvent): void;
  log?(line: string): void;
}

export interface MinecraftAdapter extends AdapterServer {
  actions: Actions;
  close(): void;
}

export function createMinecraftAdapter(bot: Bot, options: MinecraftAdapterOptions = {}): MinecraftAdapter {
  if (options.movements !== false) setupMovements(bot);
  const placed = new Set<string>();
  let emit: AdapterServer["emit"] = () => null;
  const actions = new Actions(bot, {
    emit: (event) => void emit(event),
    placed,
    partner: () => partnerName(bot, options.partner),
  });
  const state = resources(bot, { partner: options.partner, task: () => actions.task });
  const adapter = createAdapterServer({
    manifest: MINECRAFT_MANIFEST,
    toolInputs: MINECRAFT_TOOL_INPUTS,
    name: "minecraft",
    instructions: `${MINECRAFT_MANIFEST.game}, playing as ${bot.username}. Game events arrive as notifications.`,
    tool: (name, args) => actions.run(name, args),
    resource: (name) => state[name]?.() ?? null,
    onEvent: options.onEvent,
    log: options.log,
  });
  emit = adapter.emit;
  const unwatch = watchBot(bot, { ...options, emit: (event) => void emit(event), actions, placed });
  return {
    ...adapter,
    actions,
    close: () => {
      unwatch();
      void actions.run("stop", {}).catch(() => {});
    },
  };
}
