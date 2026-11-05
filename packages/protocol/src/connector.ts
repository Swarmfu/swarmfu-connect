import { z } from "zod";
import {
  MAX_SUMMARY_CHARS,
  type AdapterManifest,
  type EventKindSpec,
  type GameEvent,
  type Lane,
  type Reaction,
  type Role,
  type Subject,
} from "./protocol.ts";

/**
 * Game connectors: a mod that writes what happens in its game to a few files
 * (docs/game-connectors/mod-guide.md), and a game pack, the data that says
 * what each of its event types means to her. The file adapter
 * (packages/adapter-files) reads any connector's files through its pack, so
 * a new game is a mod and a pack, no adapter code.
 */

export const CONNECTOR_PROTOCOL = 1;

/** Whose an event is, as a connector says it: the person playing, someone else, or the world. */
export const CONNECTOR_SUBJECTS = ["player", "other", "world"] as const;
const SUBJECT_OF: Record<(typeof CONNECTOR_SUBJECTS)[number], Subject> = {
  player: "user",
  other: "other",
  world: "world",
};

/** The in-game clock, as much of it as the game has. */
export const gameTimeSchema = z
  .object({
    year: z.number(),
    month: z.number(),
    day: z.number(),
    hour: z.number(),
    minute: z.number(),
  })
  .partial()
  .loose();
export type GameTime = z.infer<typeof gameTimeSchema>;

/** A bare file name in the connector's folder: never a path out of it. */
const fileName = z
  .string()
  .regex(/^[\w-][\w.-]{0,127}$/)
  .refine((name) => !name.includes(".."), "not a file name");

/** `manifest.json`: the session and the events file being written. */
export const connectorManifestSchema = z
  .object({
    v: z.number(),
    source: z.string().min(1).max(48),
    connector: z.string().max(64).optional(),
    connector_version: z.string().max(40).optional(),
    session: z.string().min(1).max(128),
    started_at: z.number().optional(),
    events_file: fileName,
    game: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();
export type ConnectorManifest = z.infer<typeof connectorManifestSchema>;

/** One line of the events file. */
export const connectorEventSchema = z
  .object({
    v: z.number(),
    source: z.string().optional(),
    session: z.string().min(1).max(128),
    seq: z.number().int().nonnegative(),
    ts: z.number(),
    game_time: gameTimeSchema.optional(),
    type: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .max(48),
    subject: z.enum(CONNECTOR_SUBJECTS).optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();
export type ConnectorEvent = z.infer<typeof connectorEventSchema>;

/** `state.json`, if the connector writes one: everything about "right now", for her to read on demand. */
export const stateSchema = z
  .object({
    v: z.number(),
    session: z.string().min(1).max(128),
    ts: z.number(),
    game_time: gameTimeSchema.optional(),
  })
  .loose();
export type GameState = z.infer<typeof stateSchema>;

/** `heartbeat.json`: liveness, and how things are right now. */
export const heartbeatSchema = z
  .object({
    v: z.number(),
    session: z.string().min(1).max(128),
    ts: z.number(),
    seq: z.number().optional(),
    paused: z.boolean().optional(),
    game_speed: z.number().optional(),
    game_time: gameTimeSchema.optional(),
  })
  .loose();
export type Heartbeat = z.infer<typeof heartbeatSchema>;

/** A heartbeat older than this means the game has closed or crashed. */
export const HEARTBEAT_STALE_MS = 10_000;

/** A condition on one field: a value it must equal, or a range, or whether it's there at all. */
export type Condition =
  | string
  | number
  | boolean
  | { lt?: number; lte?: number; gt?: number; gte?: number; exists?: boolean };

/** What an event type means to her, when its `when` fits. */
export interface EventRule {
  /** Dotted paths into the event (`data.distance`) and what they must be. */
  when?: Record<string, Condition>;
  /** Ignore events that fit. */
  drop?: boolean;
  /** The name she sees for it; the type if unset. */
  kind?: string;
  lane?: Lane;
  /** Whose it is, if the event's own subject (or the player) isn't right. */
  subject?: Subject;
  reaction?: Reaction;
  tally?: boolean;
  /** The sentence she reads, `{path}` filled in from the event (`{player}`, `{time}`); `{path|1}` rounds a number, `{path|words}` turns an id into words. */
  summary?: string;
}

export interface PackEventType {
  /** When the connector sends it, for people and the decider. */
  description: string;
  /** Tried in order; the first that fits is used. None fitting drops the event. */
  rules: EventRule[];
}

export type PackOs = "darwin" | "win32" | "linux";

/** A game a connector mod plays: data only, no code runs from it. */
export interface GamePack {
  /** The connector's `source`, and the adapter id. */
  id: string;
  game: string;
  /** The pack's own version. */
  version: string;
  role: Role;
  /** The connector's folder on each OS, `~` for the home directory. */
  folder: Partial<Record<PackOs, string>>;
  /**
   * The character's name, from the heartbeat (or the state file): templates
   * tried in order, e.g. `["{player.username}", "{player.forename} {player.surname}"]`.
   */
  player?: string[];
  /** Where the manifest keeps what tells one world from another (`game.save`). */
  world?: string;
  events: Record<string, PackEventType>;
  /**
   * Her picture of "right now", from the state file if the connector writes
   * one, else the heartbeat: the first template that fills, sent at most
   * every `everyMs`, and only when it changes.
   */
  status?: { everyMs: number; summary: string[] };
}

/** Kinds the file adapter sends for any game, besides the pack's. */
export const CONNECTOR_KINDS = {
  status: {
    lane: "silent",
    description: "How things are right now, from the game's heartbeat.",
  },
  game_paused: { lane: "silent", description: "The game was paused." },
  game_resumed: { lane: "silent", description: "The game was unpaused." },
  game_closed: {
    lane: "silent",
    description: "The game stopped sending: it was closed or crashed.",
  },
  game_opened: {
    lane: "silent",
    description: "The game is running again after being closed.",
  },
} as const satisfies Record<string, EventKindSpec>;

/** The adapter manifest for a pack: its kinds and the connector's own, no tools, the state as resources. */
export function packManifest(pack: GamePack): AdapterManifest {
  const events: Record<string, EventKindSpec> = { ...CONNECTOR_KINDS };
  for (const [type, spec] of Object.entries(pack.events))
    for (const rule of spec.rules) {
      if (rule.drop) continue;
      const kind = rule.kind ?? type;
      events[kind] ??= {
        lane: rule.lane ?? "silent",
        description: spec.description,
        ...(rule.reaction ? { reaction: rule.reaction } : {}),
      };
    }
  return {
    id: pack.id,
    game: pack.game,
    version: pack.version,
    role: pack.role,
    events,
    tools: {},
    resources: {
      self: { description: "Who the user plays as, and which world." },
      state: {
        description:
          "How things are in the game right now, from its latest heartbeat.",
      },
    },
  };
}

/** The value at a dotted path, or undefined. */
export function valueAt(source: unknown, path: string): unknown {
  let value: unknown = source;
  for (const key of path.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key))
      return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function fits(source: unknown, when: EventRule["when"]): boolean {
  for (const [path, condition] of Object.entries(when ?? {})) {
    const value = valueAt(source, path);
    if (condition === null || typeof condition !== "object") {
      if (value !== condition) return false;
      continue;
    }
    if (
      condition.exists !== undefined &&
      (value !== undefined) !== condition.exists
    )
      return false;
    const ranged = ["lt", "lte", "gt", "gte"].some((op) => op in condition);
    if (!ranged) continue;
    if (typeof value !== "number") return false;
    if (condition.lt !== undefined && !(value < condition.lt)) return false;
    if (condition.lte !== undefined && !(value <= condition.lte)) return false;
    if (condition.gt !== undefined && !(value > condition.gt)) return false;
    if (condition.gte !== undefined && !(value >= condition.gte)) return false;
  }
  return true;
}

/** Longest a filled-in value may be: game text (a name, a book title) is the player's, not ours. */
const MAX_VALUE_CHARS = 60;

/** "14:05" from the in-game clock, if it has the hour. */
export function clockOf(time: GameTime | undefined): string | undefined {
  if (time?.hour === undefined) return undefined;
  return `${String(time.hour).padStart(2, "0")}:${String(time.minute ?? 0).padStart(2, "0")}`;
}

/**
 * A value as text, with underscores as spaces. `filter` is digits to round
 * a number to, or `words` for an id as words, hyphens too (`hang-sheet` →
 * "hang sheet").
 */
function shown(value: unknown, filter: string | undefined): string | undefined {
  const digits = filter && /^\d$/.test(filter) ? Number(filter) : undefined;
  if (typeof value === "number" && Number.isFinite(value))
    return digits === undefined
      ? String(value)
      : String(Number(value.toFixed(digits)));
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value !== "string") return undefined;
  // One line of plain text, short: it ends up in her instructions. Never an
  // underscore: whatever she repeats is spoken, and a voice reads it out.
  const text = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(filter === "words" ? /[_-]+/g : /_+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, MAX_VALUE_CHARS) : undefined;
}

/**
 * A template with `{path}` filled in from `source`; `extra` names come
 * first (`{player}`). Null if a placeholder has nothing to show, so the
 * caller can try another rule.
 */
export function fillTemplate(
  template: string,
  source: unknown,
  extra: Record<string, string | undefined> = {},
): string | null {
  let missing = false;
  const text = template.replace(
    /\{([A-Za-z_][\w.]*)(?:\|(\d|words))?\}/g,
    (_, path: string, filter?: string) => {
      const value = Object.hasOwn(extra, path)
        ? extra[path]
        : shown(valueAt(source, path), filter);
      if (value === undefined) missing = true;
      return value ?? "";
    },
  );
  return missing ? null : text.trim().slice(0, MAX_SUMMARY_CHARS);
}

/** A small stable hash, to keep event ids short. */
function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++)
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(36);
}

/** What the adapter knows besides the event: the character's name. */
export interface TranslateContext {
  player?: string;
}

/**
 * A connector event as she gets it, through the pack: the first rule that
 * fits and has everything its summary needs. Null if it's dropped (a type
 * the pack doesn't know, a rule saying drop, or nothing fitting).
 */
export function translateEvent(
  pack: GamePack,
  event: ConnectorEvent,
  context: TranslateContext = {},
): GameEvent | null {
  const spec = pack.events[event.type];
  if (!spec) return null;
  const extra = { player: context.player, time: clockOf(event.game_time) };
  for (const rule of spec.rules) {
    if (!fits(event, rule.when)) continue;
    if (rule.drop) return null;
    const summary = fillTemplate(
      rule.summary ?? event.type.replaceAll("_", " "),
      event,
      extra,
    );
    if (!summary) continue;
    return {
      id: `${shortHash(event.session)}-${event.seq}`,
      kind: rule.kind ?? event.type,
      lane: rule.lane ?? "silent",
      subject:
        rule.subject ?? (event.subject ? SUBJECT_OF[event.subject] : "user"),
      summary,
      ...(rule.reaction ? { reaction: rule.reaction } : {}),
      ...(rule.tally ? { tally: true } : {}),
      ...(event.data ? { data: event.data } : {}),
      at: event.ts,
    };
  }
  return null;
}

/** The first of `templates` that fills from `source`, or null. */
export function firstFilled(
  templates: readonly string[],
  source: unknown,
  extra: Record<string, string | undefined> = {},
): string | null {
  for (const template of templates) {
    const text = fillTemplate(template, source, extra);
    if (text) return text;
  }
  return null;
}

/** The character's name from a heartbeat or state, through the pack. */
export function playerName(pack: GamePack, source: unknown): string | undefined {
  return firstFilled(pack.player ?? [], source)?.slice(0, 32) || undefined;
}

/** Her "right now" from the state (or heartbeat), or null if the pack has none or it can't be filled in. */
export function statusLine(
  pack: GamePack,
  source: Heartbeat | GameState,
  context: TranslateContext = {},
): string | null {
  if (!pack.status) return null;
  return firstFilled(pack.status.summary, source, {
    player: context.player,
    time: clockOf(source.game_time),
  });
}
