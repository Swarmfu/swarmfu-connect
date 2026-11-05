import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import {
  EVENT_NOTIFICATION,
  MANIFEST_RESOURCE,
  acceptEvent,
  resourceUri,
  type AdapterManifest,
  type GameEvent,
} from "./protocol.ts";

/**
 * The MCP side of a game adapter, shared by every adapter: the manifest and
 * its resources, the declared tools with their inputs, and game events as
 * notifications. An adapter supplies what its tools do and what its
 * resources hold; this checks events against the manifest before they go out.
 *
 * Imported as `@swarmfu/connect-protocol/adapter`, apart from the package's main
 * entry, so the backend never bundles the MCP SDK.
 */

/** An event as an adapter raises it; the id and time are filled in if missing. */
export type RaisedEvent = Omit<GameEvent, "id" | "at"> &
  Partial<Pick<GameEvent, "id" | "at">>;

export interface AdapterDefinition {
  manifest: AdapterManifest;
  toolInputs: Record<string, z.ZodRawShape>;
  /** MCP server name, e.g. "simulator (minecraft)". */
  name: string;
  instructions?: string;
  /** Runs a declared tool; its answer goes back to the caller. Throw to report a failure. */
  tool(name: string, args: Record<string, unknown>): Promise<string> | string;
  /** A resource's current value, as JSON. */
  resource(name: string): unknown;
  /** Called for each event as it goes out, e.g. to log it. */
  onEvent?(event: GameEvent): void;
  log?(line: string): void;
}

export interface AdapterServer {
  server: McpServer;
  /** Sends an event, if it fits the manifest. Returns it, or null if it was dropped. */
  emit(event: RaisedEvent): GameEvent | null;
}

export function createAdapterServer(def: AdapterDefinition): AdapterServer {
  const { manifest } = def;
  const log = def.log ?? ((line: string) => console.error(line));
  const server = new McpServer(
    { name: def.name, version: manifest.version },
    {
      capabilities: { resources: {}, tools: {} },
      instructions:
        def.instructions ??
        `${manifest.game}. Game events arrive as ${EVENT_NOTIFICATION} notifications.`,
    },
  );

  const json = (uri: URL, value: unknown) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(value ?? null),
      },
    ],
  });
  server.registerResource(
    MANIFEST_RESOURCE,
    resourceUri(manifest.id, MANIFEST_RESOURCE),
    {
      description: "The adapter's events, tools and resources.",
      mimeType: "application/json",
    },
    (uri) => json(uri, manifest),
  );
  for (const [name, spec] of Object.entries(manifest.resources))
    server.registerResource(
      name,
      resourceUri(manifest.id, name),
      { description: spec.description, mimeType: "application/json" },
      (uri) => json(uri, def.resource(name)),
    );

  for (const [name, spec] of Object.entries(manifest.tools))
    server.registerTool(
      name,
      {
        description: spec.description,
        inputSchema: def.toolInputs[name] ?? {},
        annotations: { destructiveHint: spec.destructive ?? false },
      },
      async (args: Record<string, unknown>) => {
        try {
          return {
            content: [
              { type: "text" as const, text: await def.tool(name, args) },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: error instanceof Error ? error.message : String(error),
              },
            ],
            isError: true,
          };
        }
      },
    );

  let sent = 0;
  const emit = (raw: RaisedEvent): GameEvent | null => {
    const accepted = acceptEvent(manifest, {
      id: `${manifest.id}-${++sent}`,
      at: Date.now(),
      ...raw,
    });
    if ("error" in accepted) {
      log(`dropped event: ${accepted.error}`);
      return null;
    }
    def.onEvent?.(accepted.event);
    if (server.isConnected())
      void server.server
        .notification({ method: EVENT_NOTIFICATION, params: accepted.event })
        .catch((error: unknown) =>
          log(
            `notify failed: ${error instanceof Error ? error.message : error}`,
          ),
        );
    return accepted.event;
  };

  return { server, emit };
}
