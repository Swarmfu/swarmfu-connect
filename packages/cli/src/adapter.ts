import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  EVENT_NOTIFICATION,
  MANIFEST_RESOURCE,
  acceptEvent,
  parseResourceUri,
  readIdentity,
  resourceUri,
  SELF_RESOURCE,
  toolAllowed,
  MAX_TOOL_DESCRIPTION_CHARS,
  MAX_TOOL_SCHEMA_CHARS,
  type AdapterManifest,
  type DeclaredTool,
  type GameEvent,
  type SelfIdentity,
} from "@swarmfu/connect-protocol";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { z } from "zod";
import { PACKS } from "@swarmfu/connect-files/packs";
import type { AdapterEntry } from "./config.ts";

/**
 * A running game adapter: an MCP server on the adapter process's stdio.
 * Events it sends are checked against its manifest before anything sees
 * them, and only tools it declared (destructive ones only if allowed) can be
 * called.
 */

/** Whether this is the compiled `swarmfu-connect` binary rather than the source run under Bun. */
export const compiled = (): boolean => /[/\\](\$bunfs|~BUN)[/\\]/.test(import.meta.path);

/** The built-in adapters, as `swarmfu-connect adapter <name>` runs them (adapters.ts). */
export const ADAPTER_MAINS = {
  files: "@swarmfu/connect-files/main",
  minecraft: "@swarmfu/connect-minecraft/main",
  simulator: "@swarmfu/connect-simulator/main",
} as const;
export type AdapterMain = keyof typeof ADAPTER_MAINS;

/**
 * How to start a built-in adapter: the compiled binary runs itself
 * (`swarmfu-connect adapter files …`), since it carries no scripts; from source,
 * Bun runs the adapter's main file.
 */
function launch(main: AdapterMain, args: string[]): Pick<AdapterEntry, "command" | "args"> {
  if (compiled()) return { command: process.execPath, args: ["adapter", main, ...args] };
  const bun = process.versions.bun ? process.execPath : "bun";
  return { command: bun, args: [createRequire(import.meta.url).resolve(ADAPTER_MAINS[main]), ...args] };
}

/**
 * How to start Minecraft, if this swarmfu-connect can: from source, or a build with it
 * in (`swarmfu-connect-minecraft`); from the everyday build, through a
 * `swarmfu-connect-minecraft` binary next to it. Null when there's neither.
 */
function minecraftLaunch(): Pick<AdapterEntry, "command" | "args"> | null {
  if (!compiled() || process.env.SWARMFU_WITH_MINECRAFT !== "0") return launch("minecraft", []);
  const dir = dirname(process.execPath);
  const sibling = readdirSync(dir).find((file) => /^swarmfu(-connect)?-minecraft(-[a-z0-9-]+)?(\.exe)?$/.test(file));
  return sibling ? { command: join(dir, sibling), args: ["adapter", "minecraft"] } : null;
}

/** Adapters that ship with the bridge. More can be added in the config file. */
export function builtinAdapters(): Record<string, AdapterEntry> {
  return {
    // Games with a connector mod, one per pack: she watches through the mod's files.
    ...Object.fromEntries(
      Object.values(PACKS).map((pack) => [
        pack.id,
        {
          ...launch("files", ["--pack", pack.id]),
          description: `Follows ${pack.game} through its connector mod; she watches. Pass --dir after -- if the mod's folder is elsewhere.`,
        },
      ]),
    ),
    ...(minecraftLaunch()
      ? {
          minecraft: {
            ...minecraftLaunch()!,
            description: "Joins a Minecraft: Java Edition world as her player. Pass --port, --partner and --auth after --.",
          },
        }
      : {}),
    simulator: {
      ...launch("simulator", []),
      description: "Replays a recorded Minecraft session; no game needed.",
    },
  };
}

const TOOL_TIMEOUT_MS = 30_000;

export interface AdapterHandlers {
  event(event: GameEvent): void;
  /** The adapter process exited or its pipe broke. */
  closed(): void;
  log?(line: string): void;
}

export class AdapterConnection {
  readonly manifest: AdapterManifest;
  readonly #client: Client;
  readonly #allowDestructive: ReadonlySet<string>;

  private constructor(
    client: Client,
    manifest: AdapterManifest,
    allowDestructive: ReadonlySet<string>,
  ) {
    this.#client = client;
    this.manifest = manifest;
    this.#allowDestructive = allowDestructive;
  }

  static async start(
    entry: AdapterEntry,
    extraArgs: string[],
    handlers: AdapterHandlers,
    allowDestructive: ReadonlySet<string> = new Set(),
  ): Promise<AdapterConnection> {
    const transport = new StdioClientTransport({
      command: entry.command,
      args: [...entry.args, ...extraArgs],
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n"))
        if (line.trim()) handlers.log?.(line);
    });
    const client = new Client({ name: "swarmfu-connect", version: "0.1.0" });
    let manifest: AdapterManifest | null = null;
    // Events can arrive as soon as the handshake ends, before the manifest is read; hold them.
    const early: unknown[] = [];
    client.setNotificationHandler(
      z.object({ method: z.literal(EVENT_NOTIFICATION), params: z.unknown() }),
      ({ params }) => {
        if (!manifest) return void early.push(params);
        const accepted = acceptEvent(manifest, params);
        if ("error" in accepted)
          handlers.log?.(`dropped event: ${accepted.error}`);
        else handlers.event(accepted.event);
      },
    );
    client.onclose = () => handlers.closed();
    await client.connect(transport);

    manifest = await readManifest(client);
    const connection = new AdapterConnection(
      client,
      manifest,
      allowDestructive,
    );
    for (const params of early.splice(0)) {
      const accepted = acceptEvent(manifest, params);
      if ("event" in accepted) handlers.event(accepted.event);
    }
    return connection;
  }

  /** Runs a tool if the manifest allows it; the adapter's text answer comes back as `result`. */
  async callTool(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; result: string }> {
    if (!toolAllowed(this.manifest, tool, this.#allowDestructive))
      return { ok: false, result: `not allowed: ${tool}` };
    try {
      const response = await this.#client.callTool(
        { name: tool, arguments: args },
        undefined,
        {
          timeout: TOOL_TIMEOUT_MS,
        },
      );
      const content = Array.isArray(response.content) ? response.content : [];
      const text = content
        .map((part) =>
          part && typeof part === "object" && "text" in part
            ? String(part.text)
            : "",
        )
        .filter(Boolean)
        .join("\n");
      return { ok: !response.isError, result: text };
    } catch (error) {
      return {
        ok: false,
        result: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Its tools as the backend is told about them: each one the manifest
   * declares, with the description and input schema the adapter registered,
   * so her brain can call it without knowing the game. Oversized ones go
   * without.
   */
  async declaredTools(): Promise<DeclaredTool[]> {
    const listed = new Map<string, { description?: string; inputSchema?: unknown }>();
    try {
      for (const tool of (await this.#client.listTools()).tools) listed.set(tool.name, tool);
    } catch {
      // An adapter with no tools may not answer the list at all.
    }
    return Object.entries(this.manifest.tools).map(([name, spec]) => {
      const tool = listed.get(name);
      const description = (tool?.description ?? spec.description).slice(0, MAX_TOOL_DESCRIPTION_CHARS);
      const schema = tool?.inputSchema ? JSON.stringify(tool.inputSchema) : undefined;
      return {
        name,
        destructive: spec.destructive ?? false,
        description,
        ...(schema && schema.length <= MAX_TOOL_SCHEMA_CHARS ? { inputSchema: schema } : {}),
      };
    });
  }

  /** Who she and the user are in the game, from the adapter's `self` resource if it has one. */
  async identity(): Promise<SelfIdentity> {
    if (!(SELF_RESOURCE in this.manifest.resources)) return {};
    try {
      const { contents } = await this.#client.readResource({ uri: resourceUri(this.manifest.id, SELF_RESOURCE) });
      const first = contents[0];
      return first && "text" in first ? readIdentity(JSON.parse(first.text)) : {};
    } catch {
      return {};
    }
  }

  async close(): Promise<void> {
    await this.#client.close();
  }
}

async function readManifest(client: Client): Promise<AdapterManifest> {
  const { resources } = await client.listResources();
  const entry = resources.find(
    (r) => parseResourceUri(r.uri)?.name === MANIFEST_RESOURCE,
  );
  if (!entry) throw new Error("the adapter has no manifest resource");
  const { contents } = await client.readResource({ uri: entry.uri });
  const first = contents[0];
  if (!first || !("text" in first))
    throw new Error("the adapter's manifest is empty");
  const manifest = JSON.parse(first.text) as AdapterManifest;
  if (!manifest.id || !manifest.events || !manifest.tools)
    throw new Error("the adapter's manifest is malformed");
  return manifest;
}
