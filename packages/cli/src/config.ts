import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

/**
 * What pairing leaves on this computer: the Swarmfu site and the backend it
 * pointed to, the bridge token, this computer's id, and any adapters added by
 * hand. One file, readable only by the user, in ~/.swarmfu (or $SWARMFU_HOME).
 */

const adapterEntrySchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  description: z.string().optional(),
});
export type AdapterEntry = z.infer<typeof adapterEntrySchema>;

export const configSchema = z.object({
  /** The Swarmfu site it was paired through (its pages may open the local socket). */
  site: z.url().optional(),
  convexUrl: z.url(),
  token: z.string().startsWith("wb_"),
  name: z.string(),
  /** Stays the same across pairings, so pairing again replaces this computer's entry. */
  machineId: z.string().default(() => randomUUID()),
  /** Pages besides localhost (and the site) allowed to open the local socket. */
  origins: z.array(z.url()).default([]),
  adapters: z.record(z.string(), adapterEntrySchema).default({}),
  /** Destructive tools the user turned on, by name. */
  allowDestructive: z.array(z.string()).default([]),
});
export type BridgeConfig = z.infer<typeof configSchema>;

export function configDir(): string {
  return process.env.SWARMFU_HOME ?? join(homedir(), ".swarmfu");
}

export const configPath = () => join(configDir(), "config.json");

/** Where the bridge kept its pairing before it was called swarmfu. */
const legacyPath = () => join(homedir(), ".waifu-bridge", "config.json");

/** Moves an old ~/.waifu-bridge pairing over, once, if there's none here yet. */
function migrateLegacy(): void {
  if (
    process.env.SWARMFU_HOME ||
    existsSync(configPath()) ||
    !existsSync(legacyPath())
  )
    return;
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  renameSync(legacyPath(), configPath());
  rmSync(dirname(legacyPath()), { recursive: true, force: true });
}

export function loadConfig(): BridgeConfig | null {
  migrateLegacy();
  const path = configPath();
  if (!existsSync(path)) return null;
  return configSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** The config, or null if there's none or it can't be read. */
export function tryLoadConfig(): BridgeConfig | null {
  try {
    return loadConfig();
  } catch {
    return null;
  }
}

export function saveConfig(config: BridgeConfig): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const path = configPath();
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function deleteConfig(): void {
  rmSync(configPath(), { force: true });
}

/** The pages allowed to open the local socket: the site it was paired through, and any added by hand. */
export function allowedOrigins(config: BridgeConfig): string[] {
  return [
    ...new Set([
      ...(config.site ? [new URL(config.site).origin] : []),
      ...config.origins,
    ]),
  ];
}
