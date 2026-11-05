import { z } from "zod";
import type { GameEvent } from "./protocol.ts";

/**
 * The local bridge: a program on the player's computer that runs one game
 * adapter, relays its events to the backend and the backend's tool calls to
 * it, and serves a WebSocket on localhost so reflexes reach the avatar
 * without a round trip. These are the shapes the bridge, the backend and the
 * web app agree on.
 */

export const BRIDGE_PROTOCOL = 1;
export const BRIDGE_DEFAULT_PORT = 47615;
/** The bridge checks in this often; the web app calls it offline after a few misses. */
export const BRIDGE_HEARTBEAT_MS = 20_000;
export const BRIDGE_OFFLINE_AFTER_MS = 3 * BRIDGE_HEARTBEAT_MS;

/** Pairing codes: 8 characters with no look-alikes, shown as XXXX-XXXX. */
export const PAIRING_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const PAIRING_CODE_LENGTH = 8;
export const PAIRING_TTL_MS = 10 * 60_000;

/** Upper-cases and drops separators, so "abcd-efgh" and "ABCDEFGH" match. */
export function normalizePairingCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function formatPairingCode(code: string): string {
  const half = Math.ceil(code.length / 2);
  return `${code.slice(0, half)}-${code.slice(half)}`;
}

/** Events per relay batch, and the cap on an event's data once serialized. */
export const MAX_EVENTS_PER_BATCH = 50;
export const MAX_EVENT_DATA_CHARS = 2_000;

/**
 * A tool as the bridge declares it when a game session starts: what it does
 * and the JSON Schema of its input (from the adapter's MCP tool list), so her
 * brain can call it without the backend knowing anything about the game.
 */
export interface DeclaredTool {
  name: string;
  destructive: boolean;
  description?: string;
  /** The input's JSON Schema, serialized. */
  inputSchema?: string;
}
/** Caps on a declared tool's description and input schema. */
export const MAX_TOOL_DESCRIPTION_CHARS = 500;
export const MAX_TOOL_SCHEMA_CHARS = 4_000;

/**
 * Where a Swarmfu site says its backend is: `<site>/connect.json`, written by
 * each web build. The bridge is pointed at a site (the production one unless
 * told otherwise), reads this, then talks to that backend directly.
 */
export const DEFAULT_SITE = "https://www.swarmfu.com";
export const CONNECT_INFO_PATH = "/connect.json";
export interface ConnectInfo {
  /** The Convex deployment's client URL. */
  convexUrl: string;
  /** BRIDGE_PROTOCOL of the site's backend. */
  protocol: number;
}
export const connectInfoSchema: z.ZodType<ConnectInfo> = z.object({
  convexUrl: z.url(),
  protocol: z.number().int(),
});

/** Browser → bridge, over the localhost socket. `auth` comes first. */
export type BridgeClientMessage =
  | { type: "auth"; secret: string; protocol: number }
  | { type: "pause" }
  | { type: "resume" };
export const bridgeClientMessageSchema: z.ZodType<BridgeClientMessage> = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("auth"),
    secret: z.string().min(1).max(200),
    protocol: z.number().int(),
  }),
  z.object({ type: z.literal("pause") }),
  z.object({ type: z.literal("resume") }),
]);

export interface BridgeAdapterInfo {
  id: string;
  game: string;
  version: string;
}

/** Bridge → browser. */
export type BridgeServerMessage =
  | {
      type: "ready";
      protocol: number;
      adapter: BridgeAdapterInfo | null;
      paused: boolean;
    }
  | { type: "status"; adapter: BridgeAdapterInfo | null; paused: boolean }
  | { type: "event"; event: GameEvent }
  | { type: "error"; message: string };
