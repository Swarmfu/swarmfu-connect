import { z } from "zod";

/**
 * The game adapter contract. Each supported game has an adapter: an MCP
 * server that streams game events to her, exposes the actions she can take as
 * tools and the state she can read as resources. The bridge, backend and
 * avatar only ever see these shapes, so adding a game means writing an
 * adapter and nothing else (docs/game-companion-prd.md).
 */

/**
 * How an event reaches her. Reflex: the adapter has already acted and the
 * avatar plays a reaction at once, no model. Respond: the backend's decider
 * picks speak, gesture or quiet. Silent: folded into her rolling state
 * summary, never speech on its own.
 */
export const LANES = ["reflex", "respond", "silent"] as const;
export type Lane = (typeof LANES)[number];

/**
 * Game-agnostic reactions an adapter can ask the avatar for. The director
 * maps each to an animation and face once, so a new game never touches the
 * avatar.
 */
export const REACTIONS = [
  "startle", // a sudden scare: a hiss, a jump scare, an explosion nearby
  "flinch", // took a hit
  "panic", // real danger right now: on fire, falling, cornered
  "cringe", // can't bear to look: the user about to do something dumb
  "cheer", // a quick win: a rare find, a kill
  "triumph", // a big win: a boss down, a finished build
  "relief", // the danger passed
  "concern", // things look bad: low health, lost, night with no shelter
] as const;
export type Reaction = (typeof REACTIONS)[number];

/**
 * Whose event it is: hers, the user's (the player she's with), another human
 * on their team (co-op), someone or something else, or nobody in particular.
 */
export const SUBJECTS = ["self", "user", "teammate", "other", "world"] as const;
export type Subject = (typeof SUBJECTS)[number];

export const MAX_SUMMARY_CHARS = 280;

/**
 * How she's in the game: as a player of her own (Minecraft: her bot, with
 * tools to act), or watching the user play (a connector mod's events, no
 * tools). Unset means player.
 */
export const ROLES = ["player", "spectator"] as const;
export type Role = (typeof ROLES)[number];

/**
 * One game event, as an adapter emits it. `kind` is adapter-defined
 * (`death`, `ore_found`, …) and declared in its manifest; `lane` is the
 * adapter's suggestion, which the backend may override per kind.
 */
/** A type, not an interface, so it passes as MCP notification params. */
export type GameEvent = {
  /** Unique per adapter run, so a retried relay is recorded once. */
  id: string;
  kind: string;
  lane: Lane;
  subject: Subject;
  /** What happened, in a sentence she can be handed as is. */
  summary: string;
  /** For reflex events: what the avatar should do. */
  reaction?: Reaction;
  /**
   * She sees how often this happens: recent ones are listed together, with
   * how long ago each was, rather than only the latest (a kill, a hit).
   */
  tally?: boolean;
  /** Kind-specific detail (who, what, where), kept small. */
  data?: Record<string, unknown>;
  /** Unix ms when it happened in the game. */
  at: number;
};

const gameEventObject = z.object({
  id: z.string().min(1).max(64),
  kind: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .max(48),
  lane: z.enum(LANES),
  subject: z.enum(SUBJECTS),
  summary: z.string().min(1).max(MAX_SUMMARY_CHARS),
  reaction: z.enum(REACTIONS).optional(),
  tally: z.boolean().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  at: z.number(),
});
export const gameEventSchema: z.ZodType<GameEvent> = gameEventObject;
/** An event before the adapter gives it an id and a time, as a recording holds it. */
export const gameEventBodySchema: z.ZodType<Omit<GameEvent, "id" | "at">> = gameEventObject.omit({ id: true, at: true });

/** An event kind an adapter may emit, with its default lane. */
export interface EventKindSpec {
  lane: Lane;
  /** When it fires, for people and for the decider's prompt. */
  description: string;
  /** The avatar reaction a reflex of this kind plays by default. */
  reaction?: Reaction;
  /** Whether its events are tallied (GameEvent.tally) by default. */
  tally?: boolean;
}

/**
 * An action she can take. The adapter registers it as an MCP tool; the
 * manifest repeats it so the backend can apply allowlists before calling.
 */
export interface ToolSpec {
  description: string;
  /**
   * Breaks player-placed blocks, hurts players, spends shared items… Off
   * unless the user allows it for this game.
   */
  destructive?: boolean;
}

/** State she can read on demand, as an MCP resource under `game://<adapter>/<name>`. */
export interface ResourceSpec {
  description: string;
}

export interface AdapterManifest {
  /** Stable id, also the resource URI host: `minecraft`, `simulator`. */
  id: string;
  /** The game it plays, shown to the user. */
  game: string;
  version: string;
  /** How she's in the game; unset is player. */
  role?: Role;
  events: Record<string, EventKindSpec>;
  tools: Record<string, ToolSpec>;
  resources: Record<string, ResourceSpec>;
}

/** MCP notification an adapter sends for each event; params are a GameEvent. */
export const EVENT_NOTIFICATION = "notifications/game/event";
/** MCP resource holding the adapter's manifest as JSON. */
export const MANIFEST_RESOURCE = "manifest";

/**
 * Her own state, if the adapter has it. Besides game-specific fields it
 * should carry who she is in the game and who the user is, when known, so
 * she knows the player events name as her is her.
 */
export const SELF_RESOURCE = "self";
export interface SelfIdentity {
  /** Her player's name in the game. */
  name?: string;
  /** The user's player name, when the adapter knows it. */
  partner?: string;
  /** Tells one world from another (places she's told about are kept per world). */
  world?: string;
}

/** The identity fields of a `self` resource value, if they look right. */
export function readIdentity(value: unknown): SelfIdentity {
  if (!value || typeof value !== "object") return {};
  const pick = (key: "name" | "partner" | "world") => {
    const field = (value as Record<string, unknown>)[key];
    return typeof field === "string" && field.trim() && field.length <= 32 ? field.trim() : undefined;
  };
  const name = pick("name");
  const partner = pick("partner");
  const world = pick("world");
  return { ...(name ? { name } : {}), ...(partner ? { partner } : {}), ...(world ? { world } : {}) };
}

export function resourceUri(adapterId: string, name: string): string {
  return `game://${adapterId}/${name}`;
}

/** The resource name in a `game://<adapter>/<name>` URI, or null if it's not one. */
export function parseResourceUri(
  uri: string,
): { adapterId: string; name: string } | null {
  const match = /^game:\/\/([a-z0-9-]+)\/([a-z0-9_]+)$/.exec(uri);
  return match ? { adapterId: match[1]!, name: match[2]! } : null;
}

/**
 * Checks an event against the adapter's manifest: a declared kind, a known
 * reaction, and a reflex always carrying one (its own or the kind's default).
 */
export function acceptEvent(
  manifest: AdapterManifest,
  raw: unknown,
): { event: GameEvent } | { error: string } {
  const parsed = gameEventSchema.safeParse(raw);
  if (!parsed.success)
    return { error: parsed.error.issues[0]?.message ?? "invalid event" };
  const event = parsed.data;
  const spec = manifest.events[event.kind];
  if (!spec) return { error: `undeclared event kind: ${event.kind}` };
  const reaction = event.reaction ?? spec.reaction;
  if (event.lane === "reflex" && !reaction)
    return { error: `reflex without a reaction: ${event.kind}` };
  const tally = event.tally ?? spec.tally;
  return {
    event: { ...event, ...(reaction ? { reaction } : {}), ...(tally ? { tally } : {}) },
  };
}

/**
 * The lane an event ends up in: a per-kind override from the backend or the
 * user wins over the adapter's suggestion.
 */
export function routeLane(
  event: Pick<GameEvent, "kind" | "lane">,
  overrides: Partial<Record<string, Lane>> = {},
): Lane {
  return overrides[event.kind] ?? event.lane;
}

/** Whether a tool may be called: declared, and not destructive unless allowed. */
export function toolAllowed(
  manifest: AdapterManifest,
  tool: string,
  allowDestructive: ReadonlySet<string> = new Set(),
): boolean {
  const spec = manifest.tools[tool];
  if (!spec) return false;
  return !spec.destructive || allowDestructive.has(tool);
}
