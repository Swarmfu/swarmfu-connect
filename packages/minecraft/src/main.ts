#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

/**
 * Joins a Minecraft (Java) world as her player and serves the adapter on
 * stdio, the way the bridge runs it:
 *
 *   swarmfu-connect start minecraft -- --port 51234 --partner Steve
 *
 * For a world opened to LAN, the port is the one the game prints in chat.
 * `--auth offline` (the default) joins servers in offline mode; LAN worlds
 * and most servers check accounts, so use `--auth microsoft` there with a
 * Microsoft account that owns Minecraft: the first run prints a sign-in code.
 */

// stdout is the MCP channel: anything else that writes to it (Mineflayer does) goes to stderr.
console.log =
  console.info =
  console.warn =
  console.debug =
    (...args: unknown[]) => console.error(...args);

const { values } = parseArgs({
  options: {
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "25565" },
    username: { type: "string", default: "Companion" },
    auth: { type: "string", default: "offline" },
    version: { type: "string" },
    partner: { type: "string" },
    quiet: { type: "boolean", default: false },
  },
});

const log = (line: string) => console.error(`[minecraft] ${line}`);
const fail = (line: string): never => {
  log(line);
  process.exit(1);
};

const auth = values.auth;
if (auth !== "offline" && auth !== "microsoft")
  fail("--auth is offline or microsoft");
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  fail("--port must be a port number");

// Loaded after console is redirected, so nothing they print at load reaches stdout.
const { createBot } = await import("mineflayer");
const { pathfinder } = (await import("mineflayer-pathfinder")).default;
const { plugin: collectBlock } = await import("mineflayer-collectblock");
const { createMinecraftAdapter } = await import("./adapter.ts");

log(`joining ${values.host}:${port} as ${values.username} (${auth})…`);
const bot = createBot({
  host: values.host,
  port,
  username: values.username!,
  auth: auth as "offline" | "microsoft",
  // Unset: ask the server which version it runs.
  ...(values.version ? { version: values.version } : {}),
  profilesFolder: join(
    process.env.SWARMFU_HOME ?? join(homedir(), ".swarmfu"),
    "minecraft-auth",
  ),
  onMsaCode: (code: { user_code: string; verification_uri: string }) =>
    log(
      `sign her account in: open ${code.verification_uri} and enter ${code.user_code}`,
    ),
  hideErrors: true,
});
bot.loadPlugin(pathfinder);
bot.loadPlugin(collectBlock);

const joinTimeoutMs = auth === "microsoft" ? 5 * 60_000 : 45_000;
try {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out joining the world")),
      joinTimeoutMs,
    );
    bot.once("spawn", () => {
      clearTimeout(timer);
      resolve();
    });
    bot.once("kicked", (reason) =>
      reject(
        new Error(
          `kicked: ${typeof reason === "string" ? reason : JSON.stringify(reason)}`,
        ),
      ),
    );
    bot.once("error", reject);
  });
} catch (error) {
  const text = error instanceof Error ? error.message : String(error);
  fail(
    text.includes("ECONNREFUSED")
      ? `nothing is listening on ${values.host}:${port}. Is the world open to LAN, and is that its port?`
      : `couldn't join: ${text}`,
  );
}
log(`joined Minecraft ${bot.version} as ${bot.username}`);

const adapter = createMinecraftAdapter(bot, {
  partner: values.partner,
  log,
  onEvent: values.quiet
    ? undefined
    : (event) => log(`[${event.lane}] ${event.kind}: ${event.summary}`),
});
bot.on("kicked", (reason) =>
  log(
    `kicked: ${typeof reason === "string" ? reason : JSON.stringify(reason)}`,
  ),
);
let leaving = false;
bot.on("end", (reason) => {
  log(`left the world (${reason})`);
  adapter.close();
  // Leaving because we were asked to is a clean exit; being dropped isn't.
  process.exit(leaving ? 0 : 1);
});
const shutdown = () => {
  leaving = true;
  adapter.close();
  bot.quit();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
process.stdin.once("end", shutdown);

await adapter.server.connect(new StdioServerTransport());
adapter.emit({
  kind: "player_joined",
  lane: "respond",
  subject: "self",
  summary: `${bot.username} joined the world.`,
  data: { player: bot.username },
});
