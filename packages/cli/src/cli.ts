#!/usr/bin/env bun
import {
  BRIDGE_DEFAULT_PORT,
  BRIDGE_PROTOCOL,
  DEFAULT_SITE,
} from "@swarmfu/connect-protocol";
import { hostname } from "node:os";
import { parseArgs } from "node:util";
import { builtinAdapters } from "./adapter.ts";
import { runAdapter } from "./adapters.ts";
import { convexBackend, redeemPairingCode } from "./backend.ts";
import { Bridge } from "./bridge.ts";
import {
  allowedOrigins,
  configPath,
  deleteConfig,
  loadConfig,
  saveConfig,
  tryLoadConfig,
  type BridgeConfig,
} from "./config.ts";
import { installedGames } from "./games.ts";
import { ask, interactive, waitToClose } from "./prompt.ts";
import { resolveSite } from "./site.ts";
import { newerRelease, VERSION } from "./version.ts";

/**
 * swarmfu: lets your Swarmfu co-host follow the game you're playing.
 *
 *   swarmfu                    Pair if needed, find your game, start it.
 *   swarmfu pair <CODE>        Pair with the code from the app.
 *   swarmfu start [game]       Start a game's adapter and connect it.
 */

const USAGE = `swarmfu ${VERSION}: lets your Swarmfu co-host follow the game you're playing.

Usage:
  swarmfu                       Pair if needed, find your game and start it.
  swarmfu pair <CODE> [--site <url>] [--name <label>]
      Pair with the code from the app's Game card.
  swarmfu start [game] [--port ${BRIDGE_DEFAULT_PORT}] [-- adapter args…]
      Start a game (default: the one installed here) and connect it to her.
  swarmfu games                 List the games swarmfu can follow.
  swarmfu status                Show what this computer is paired with.
  swarmfu unpair                Forget the pairing on this computer.
  swarmfu version

  --site <url>        The Swarmfu site to pair through (default ${DEFAULT_SITE}).
  --convex-url <url>  Skip the site and use this backend (for development).`;

const log = (line: string) =>
  console.error(`${new Date().toLocaleTimeString()} ${line}`);

class Exit extends Error {}

function fail(message: string): never {
  console.error(message);
  throw new Exit(message);
}

function requireConfig(): BridgeConfig {
  try {
    return (
      loadConfig() ??
      fail(
        "This computer isn't paired yet. Run `swarmfu pair <CODE>`, or just `swarmfu`.",
      )
    );
  } catch (error) {
    if (error instanceof Exit) throw error;
    fail(
      `${configPath()} is unreadable: ${error instanceof Error ? error.message : error}`,
    );
  }
}

const adaptersOf = (config: BridgeConfig | null) => ({
  ...builtinAdapters(),
  ...config?.adapters,
});

/** Pairs this computer with the code from the app, through a site (or straight to a backend). */
async function pairWith(
  code: string,
  options: { site?: string; convexUrl?: string; name?: string },
) {
  const previous = tryLoadConfig();
  let site: string | undefined;
  let convexUrl = options.convexUrl ?? process.env.SWARMFU_CONVEX_URL;
  if (!convexUrl) {
    try {
      ({ site, convexUrl } = await resolveSite(
        options.site ?? process.env.SWARMFU_SITE ?? DEFAULT_SITE,
      ));
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
  const machineId = previous?.machineId ?? crypto.randomUUID();
  let paired;
  try {
    paired = await redeemPairingCode(
      convexUrl,
      code,
      options.name ?? hostname(),
      machineId,
    );
  } catch (error) {
    fail(
      `Pairing failed: ${error instanceof Error ? error.message.replace(/^.*Uncaught ConvexError: /s, "").split("\n")[0] : error}`,
    );
  }
  const config: BridgeConfig = {
    ...(site ? { site } : {}),
    convexUrl,
    token: paired.token,
    name: paired.name,
    machineId,
    origins: previous?.origins ?? [],
    adapters: previous?.adapters ?? {},
    allowDestructive: previous?.allowDestructive ?? [],
  };
  saveConfig(config);
  console.log(`Paired as "${paired.name}".`);
  return config;
}

async function pair(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      site: { type: "string" },
      "convex-url": { type: "string" },
      name: { type: "string" },
    },
  });
  const code = positionals[0] ?? fail(USAGE);
  await pairWith(code, {
    site: values.site,
    convexUrl: values["convex-url"],
    name: values.name,
  });
  console.log("Start your game with: swarmfu");
}

/** Runs one game's adapter, connected to her, until Ctrl+C. */
async function run(
  config: BridgeConfig,
  id: string,
  adapterArgs: string[],
  port = BRIDGE_DEFAULT_PORT,
) {
  const adapters = adaptersOf(config);
  const entry =
    adapters[id] ?? fail(`No game called "${id}". Try: swarmfu games`);
  const bridge = new Bridge({
    backend: convexBackend(config.convexUrl, config.token),
    adapter: { id, entry, args: adapterArgs },
    adapterIds: Object.keys(adapters),
    port,
    origins: allowedOrigins(config),
    allowDestructive: new Set(config.allowDestructive),
    log,
  });
  const shutdown = () => void bridge.stop("interrupted");
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    await bridge.start();
  } catch (error) {
    await bridge.stop(
      `couldn't start: ${error instanceof Error ? error.message : error}`,
    );
    fail(
      `Couldn't start ${id}: ${error instanceof Error ? error.message : error}`,
    );
  }
  log(
    `"${config.name}" is following ${id}. Open Swarmfu to see her react; Ctrl+C to stop.`,
  );
  const reason = await bridge.done;
  if (reason !== "interrupted") fail(`Stopped: ${reason}`);
}

async function start(argv: string[]) {
  const split = argv.indexOf("--");
  const own = split >= 0 ? argv.slice(0, split) : argv;
  const adapterArgs = split >= 0 ? argv.slice(split + 1) : [];
  const { values, positionals } = parseArgs({
    args: own,
    allowPositionals: true,
    options: { port: { type: "string", default: String(BRIDGE_DEFAULT_PORT) } },
  });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    fail("--port must be between 1024 and 65535");
  const config = requireConfig();
  const id =
    positionals[0] ??
    (await chooseGame()) ??
    fail("No supported game found here. Name one: swarmfu games");
  await run(config, id, adapterArgs, port);
}

/** The game to follow: the one installed here, or the user's pick of several. Null if there are none. */
async function chooseGame(): Promise<string | null> {
  const games = installedGames();
  if (games.length <= 1) return games[0]?.id ?? null;
  if (!interactive())
    fail(
      `Several games are installed here; name one: ${games.map((g) => g.id).join(", ")}`,
    );
  console.log("Which game are you playing?");
  games.forEach((game, i) => console.log(`  ${i + 1}. ${game.name}`));
  for (;;) {
    const picked = games[Number(await ask("Number: ")) - 1];
    if (picked) return picked.id;
  }
}

/** `swarmfu` on its own, or double-clicked: pair if needed, find the game, follow it. */
async function guided() {
  console.log(`swarmfu ${VERSION}`);
  let config = tryLoadConfig();
  if (!config) {
    console.log(
      "Pair this computer with Swarmfu: open the app, and on the Game card, pick Pair this computer.",
    );
    for (;;) {
      const code = (await ask("Pairing code: ")).trim();
      if (!code) continue;
      try {
        config = await pairWith(code, {});
        break;
      } catch (error) {
        if (!(error instanceof Exit)) throw error;
      }
    }
  } else console.log(`Paired as "${config.name}".`);
  const id = await chooseGame();
  if (!id) {
    console.log(
      "No supported game found on this computer. Install its connector mod and run the game once, then try again.",
    );
    console.log("Games swarmfu can follow:");
    games();
    fail("Nothing to follow yet.");
  }
  await run(config, id, []);
}

function games() {
  for (const [id, entry] of Object.entries(adaptersOf(tryLoadConfig())))
    console.log(
      `  ${id.padEnd(16)} ${entry.description ?? `${entry.command} ${entry.args.join(" ")}`}`,
    );
}

function status() {
  const config = requireConfig();
  console.log(
    `Paired as "${config.name}" through ${config.site ?? config.convexUrl}`,
  );
  const origins = allowedOrigins(config);
  if (origins.length)
    console.log(`Pages allowed besides localhost: ${origins.join(", ")}`);
  console.log(`Config: ${configPath()}`);
}

async function main(argv: string[]) {
  const [command, ...rest] = argv;
  // An adapter the bridge started from this same binary: no notices, stdout is its MCP channel.
  if (command === "adapter") return await runAdapter(rest);
  if (command !== "version")
    void newerRelease().then(
      (newer) => newer && console.error(`A newer swarmfu is out: ${newer}`),
    );
  switch (command) {
    case undefined:
      return await guided();
    case "pair":
      return await pair(rest);
    case "start":
      return await start(rest);
    case "games":
    case "adapters":
      return games();
    case "status":
      return status();
    case "unpair":
      deleteConfig();
      return console.log(
        "Forgotten on this computer. Remove it on the app's Game card too.",
      );
    case "version":
    case "--version":
      return console.log(
        `swarmfu ${VERSION} (bridge protocol ${BRIDGE_PROTOCOL})`,
      );
    case "help":
    case "--help":
    case "-h":
      return console.log(USAGE);
    default:
      console.log(USAGE);
      throw new Exit(`unknown command: ${command}`);
  }
}

try {
  await main(process.argv.slice(2));
  process.exit(0);
} catch (error) {
  if (!(error instanceof Exit))
    console.error(error instanceof Error ? error.message : error);
  // Double-clicked, the window would close before they could read why.
  if (process.argv.length <= 2) await waitToClose();
  process.exit(1);
}
