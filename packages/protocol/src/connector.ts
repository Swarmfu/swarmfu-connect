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

/**
 * Whose an event is, as a connector says it: the person streaming, her own
 * character (her copy of the game, in co-op), another human on the team,
 * someone or something not on the team, or the world.
 */
export const CONNECTOR_SUBJECTS = ["player", "cohost", "teammate", "other", "world"] as const;
export type ConnectorSubject = (typeof CONNECTOR_SUBJECTS)[number];
const SUBJECT_OF: Record<(typeof CONNECTOR_SUBJECTS)[number], Subject> = {
  player: "user",
  cohost: "self",
  teammate: "teammate",
  other: "other",
  world: "world",
};

/** What a connector can do, from its manifest: write events, a state file, and read commands. */
export const CONNECTOR_CAPABILITIES = ["events", "state", "control"] as const;
export type ConnectorCapability = (typeof CONNECTOR_CAPABILITIES)[number];

/** Whose copy of the game a connector is in: the person streaming, or hers, joined as another player. */
export const PERSPECTIVES = ["streamer", "cohost"] as const;
export type Perspective = (typeof PERSPECTIVES)[number];

/** Keys that are for machines and never read aloud, unless a manifest says otherwise. */
export const DEFAULT_MACHINE_KEYS = ["id", "*_id", "args"] as const;

/** The in-game clock, as much of it as the game has. */
export interface GameTime {
  year?: number;
  month?: number;
  day?: number;
  hour?: number;
  minute?: number;
  [key: string]: unknown;
}
export const gameTimeSchema: z.ZodType<GameTime> = z
  .object({
    year: z.number(),
    month: z.number(),
    day: z.number(),
    hour: z.number(),
    minute: z.number(),
  })
  .partial()
  .loose();

/** A bare file name in the connector's folder: never a path out of it. */
const fileName = z
  .string()
  .regex(/^[\w-][\w.-]{0,127}$/)
  .refine((name) => !name.includes(".."), "not a file name");

/**
 * `manifest.json`: the session and the events file being written. The rest
 * is optional, and missing means a single copy of the game she only watches.
 */
export interface ConnectorManifest {
  v: number;
  source: string;
  connector?: string;
  connector_version?: string;
  session: string;
  started_at?: number;
  /** A bare file name in this folder. */
  events_file: string;
  game?: Record<string, unknown>;
  /** What it does; `control` means it reads commands from `commands_file`. */
  capabilities?: string[];
  /** Unique per running copy of the game. */
  instance?: string;
  /** Whose copy this is; unset is the streamer's. */
  perspective?: Perspective;
  /** Copies with the same group are in one shared session, a co-op lobby. */
  group?: string;
  /** Where commands go: a bare file name in this folder, new each session. */
  commands_file?: string;
  speech?: {
    /** Keys never read aloud: exact, or `*_id` for any ending in `_id`. */
    machine_keys?: string[];
  };
  [key: string]: unknown;
}
export const connectorManifestSchema: z.ZodType<ConnectorManifest> = z
  .object({
    v: z.number(),
    source: z.string().min(1).max(48),
    connector: z.string().max(64).optional(),
    connector_version: z.string().max(40).optional(),
    session: z.string().min(1).max(128),
    started_at: z.number().optional(),
    events_file: fileName,
    game: z.record(z.string(), z.unknown()).optional(),
    capabilities: z.array(z.string().max(32)).max(16).optional(),
    instance: z.string().min(1).max(64).optional(),
    perspective: z.enum(PERSPECTIVES).optional(),
    group: z.string().min(1).max(128).optional(),
    commands_file: fileName.optional(),
    speech: z
      .object({ machine_keys: z.array(z.string().min(1).max(64)).max(32).optional() })
      .loose()
      .optional(),
  })
  .loose();

/** Where a connector that can write anywhere leaves its pointers: `connectors` in swarmfu's folder. */
export const POINTERS_FOLDER = "connectors";

/**
 * A pointer file, `<source>-<instance>.json` in the pointers folder: one per
 * running copy of a game, saying which folder holds its manifest. For games
 * that can write outside their own folder; the others keep their pack's.
 */
export interface ConnectorPointer {
  v: number;
  source: string;
  connector?: string;
  instance: string;
  /** The folder holding that copy's manifest.json: an absolute path. */
  root: string;
  pid?: number;
  updated?: number;
  [key: string]: unknown;
}
export const connectorPointerSchema: z.ZodType<ConnectorPointer> = z
  .object({
    v: z.number(),
    source: z.string().min(1).max(48),
    connector: z.string().max(64).optional(),
    instance: z.string().min(1).max(64),
    root: z
      .string()
      .min(1)
      .max(1024)
      .refine((path) => /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(path), "not an absolute path"),
    pid: z.number().int().optional(),
    updated: z.number().optional(),
  })
  .loose();

/** Whether `key` is one the manifest (or the default) marks as for machines only. */
export function isMachineKey(key: string, patterns: readonly string[] = DEFAULT_MACHINE_KEYS): boolean {
  return patterns.some((pattern) =>
    pattern.startsWith("*") ? key.endsWith(pattern.slice(1)) : pattern.endsWith("*") ? key.startsWith(pattern.slice(0, -1)) : key === pattern,
  );
}

/** A value with every machine-only key taken out, at any depth: what she may read. */
export function withoutMachineKeys(value: unknown, patterns: readonly string[] = DEFAULT_MACHINE_KEYS): unknown {
  if (Array.isArray(value)) return value.map((item) => withoutMachineKeys(item, patterns));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isMachineKey(key, patterns))
      .map(([key, item]) => [key, withoutMachineKeys(item, patterns)]),
  );
}

/** One line of the events file. */
export interface ConnectorEvent {
  v: number;
  source?: string;
  session: string;
  seq: number;
  ts: number;
  game_time?: GameTime;
  type: string;
  subject?: ConnectorSubject;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}
export const connectorEventSchema: z.ZodType<ConnectorEvent> = z
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

/**
 * `state.json`, if the connector writes one: everything about "right now",
 * for her to read on demand. `session` says which session it's from; one
 * without it is taken to be the heartbeat's.
 */
export interface GameState {
  v?: number;
  session?: string;
  ts: number;
  game_time?: GameTime;
  [key: string]: unknown;
}
export const stateSchema: z.ZodType<GameState> = z
  .object({
    v: z.number().optional(),
    session: z.string().min(1).max(128).optional(),
    ts: z.number(),
    game_time: gameTimeSchema.optional(),
  })
  .loose();

/** `heartbeat.json`: liveness, and how things are right now. */
export interface Heartbeat {
  v: number;
  session: string;
  ts: number;
  seq?: number;
  paused?: boolean;
  game_speed?: number;
  game_time?: GameTime;
  [key: string]: unknown;
}
export const heartbeatSchema: z.ZodType<Heartbeat> = z
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
  /** The sentence she reads, `{path}` filled in from the event (`{player}`, `{cohost}`, `{time}`); `{path|1}` rounds a number, `{path|words}` turns an id into words, `{path|list}` joins a list. */
  summary?: string;
}

export interface PackEventType {
  /** When the connector sends it, for people and the decider. */
  description: string;
  /** Tried in order; the first that fits is used. None fitting drops the event. */
  rules: EventRule[];
}

export type PackOs = "darwin" | "win32" | "linux";

/** A "right now" template, or one that only applies when its `when` fits the state. */
export type StatusTemplate = string | { when: Record<string, Condition>; summary: string };

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
  player?: StatusTemplate[];
  /** Where the manifest keeps what tells one world from another (`game.save`). */
  world?: string;
  events: Record<string, PackEventType>;
  /**
   * Her picture of "right now", from the state file if the connector writes
   * one, else the heartbeat: the first template that fills, sent at most
   * every `everyMs`, and only when it changes.
   */
  status?: {
    everyMs: number;
    summary: StatusTemplate[];
    /**
     * More of "right now", each its own kind so she keeps the latest of each
     * (what they carry, their body): sent with the status, each only when it
     * changes. A line none of whose templates fill is left out.
     */
    more?: { kind: string; description: string; summary: StatusTemplate[] }[];
  };
}

/** Kinds the file adapter sends for any game, besides the pack's. */
export type ConnectorKind = "status" | "game_paused" | "game_resumed" | "game_closed" | "game_opened";
export const CONNECTOR_KINDS: Record<ConnectorKind, EventKindSpec> = {
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
};

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
  for (const line of pack.status?.more ?? [])
    events[line.kind] ??= { lane: "silent", description: line.description };
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
/** Longest a list item may be: a label says what a thing is and does ("Bash (2 energy): Deal 8 damage. Apply 2 Vulnerable."). */
const MAX_ITEM_CHARS = 120;
/** Longest a whole list may be, so a line keeps room for its words around it. */
const MAX_LIST_CHARS = 220;

/** Text cut to `max` at a word, with "…" when it's cut: never half a word. */
function clipWords(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, "")}…`;
}

/**
 * "3:05 pm" from the in-game clock, if it has the hour: the way it's said.
 * As "15:05" she once took a mid-afternoon for the middle of the night.
 */
export function clockOf(time: GameTime | undefined): string | undefined {
  if (time?.hour === undefined) return undefined;
  const hour = ((time.hour % 24) + 24) % 24;
  const minute = String(time.minute ?? 0).padStart(2, "0");
  return `${hour % 12 || 12}:${minute} ${hour < 12 ? "am" : "pm"}`;
}

/** Most items a `list` shows; the rest are left out. */
const MAX_LIST_ITEMS = 8;

/**
 * A value as text, with underscores as spaces. `filter` is digits to round
 * a number to, `words` for an id as words, hyphens too (`hang-sheet` →
 * "hang sheet"), or `list` for a list (or an object's entries) joined with
 * commas (an item that's an object shows its `label` or `name`); an empty
 * one has nothing to show.
 */
function shown(value: unknown, filter: string | undefined): string | undefined {
  if (filter === "list") {
    // A list, or an object as its entries ("stress 2, unhappy 1").
    // A list's items are text, or things with a `label` (or a `name`) a person reads.
    const entries = Array.isArray(value)
      ? value.map((item) =>
          item && typeof item === "object" && !Array.isArray(item)
            ? shown((item as Record<string, unknown>).label ?? (item as Record<string, unknown>).name, "item")
            : shown(item, "item"),
        )
      : value && typeof value === "object"
        ? Object.entries(value).map(([key, v]) => {
            const shownValue = shown(v, undefined);
            return shownValue === undefined ? undefined : `${shown(key, "words")} ${shownValue}`;
          })
        : undefined;
    if (!entries) return undefined;
    const items = entries.filter((item): item is string => !!item).slice(0, MAX_LIST_ITEMS);
    // Whole items while they fit; the rest are counted.
    let joined = "";
    let shownCount = 0;
    for (const item of items) {
      // An item's own full stop would meet the list's comma: "Deal 6 damage., Defend".
      const next = (joined ? `${joined}, ` : "") + item.replace(/\.$/, "");
      if (next.length > MAX_LIST_CHARS && shownCount) break;
      joined = clipWords(next, MAX_LIST_CHARS);
      shownCount++;
    }
    const rest = entries.filter(Boolean).length - shownCount;
    return joined ? (rest > 0 ? `${joined} and ${rest} more` : joined) : undefined;
  }
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
  return text ? clipWords(text, filter === "item" ? MAX_ITEM_CHARS : MAX_VALUE_CHARS) : undefined;
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
    /\{([A-Za-z_][\w.]*)(?:\|(\d|words|list))?\}/g,
    (_, path: string, filter?: string) => {
      const value = Object.hasOwn(extra, path)
        ? extra[path]
        : shown(valueAt(source, path), filter);
      if (value === undefined) missing = true;
      return value ?? "";
    },
  );
  // A line starts with a capital, whatever it starts with ("the Ironclad took…"),
  // and a value's own full stop doesn't double the template's ("heal 6 HP..").
  const line = clipWords(text.trim().replace(/(?<!\.)\.\.(?!\.)/g, "."), MAX_SUMMARY_CHARS);
  return missing ? null : line.charAt(0).toUpperCase() + line.slice(1);
}

/** A small stable hash, to keep event ids short. */
function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++)
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(36);
}

/** What the adapter knows besides the event: the streamer's character's name, and hers in co-op. */
export interface TranslateContext {
  player?: string;
  cohost?: string;
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
  const extra = { player: context.player, cohost: context.cohost, time: clockOf(event.game_time) };
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

/** The first of `templates` that fits and fills from `source`, or null. */
export function firstFilled(
  templates: readonly StatusTemplate[],
  source: unknown,
  extra: Record<string, string | undefined> = {},
): string | null {
  for (const template of templates) {
    if (typeof template !== "string" && !fits(source, template.when)) continue;
    const text = fillTemplate(typeof template === "string" ? template : template.summary, source, extra);
    if (text) return text;
  }
  return null;
}

/** The character's name from a heartbeat or state, through the pack. */
export function playerName(pack: GamePack, source: unknown): string | undefined {
  return firstFilled(pack.player ?? [], source)?.slice(0, 32) || undefined;
}

/** The pack's other "right now" lines (status.more) that fill from the state, by kind. */
export function moreStatusLines(
  pack: GamePack,
  source: Heartbeat | GameState,
  context: TranslateContext = {},
): { kind: string; line: string }[] {
  const extra = { player: context.player, cohost: context.cohost, time: clockOf(source.game_time) };
  return (pack.status?.more ?? []).flatMap(({ kind, summary }) => {
    const line = firstFilled(summary, source, extra);
    return line ? [{ kind, line }] : [];
  });
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
    cohost: context.cohost,
    time: clockOf(source.game_time),
  });
}
