import { z } from "zod";
import { gameEventBodySchema, type GameEvent } from "./protocol.ts";

/**
 * A recorded play session, replayed by the simulator adapter. JSON Lines: a
 * header, then entries in time order, each at `t` ms from the start. An
 * entry is an event (emitted with a fresh id and timestamp) or a state
 * update (replaces one resource's value from then on).
 */

export interface RecordingHeader {
  type: "header";
  /** The adapter it was recorded from; the simulator serves that manifest. */
  adapter: string;
  description: string;
  /** Usernames in the recording: hers and the user's. */
  players: { self: string; user: string };
}
export const recordingHeaderSchema: z.ZodType<RecordingHeader> = z.object({
  type: z.literal("header"),
  adapter: z.string().min(1),
  description: z.string(),
  players: z.object({ self: z.string(), user: z.string() }),
});

export type RecordingEntry =
  | { type: "event"; t: number; event: Omit<GameEvent, "id" | "at"> }
  | { type: "state"; t: number; resource: string; value: unknown };
export const recordingEntrySchema: z.ZodType<RecordingEntry> = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("event"),
    t: z.number().nonnegative(),
    event: gameEventBodySchema,
  }),
  z.object({
    type: z.literal("state"),
    t: z.number().nonnegative(),
    resource: z.string().regex(/^[a-z0-9_]+$/),
    value: z.unknown(),
  }),
]);

export interface Recording {
  header: RecordingHeader;
  entries: RecordingEntry[];
  /** When the last entry plays, in ms from the start. */
  durationMs: number;
}

/** Parses a JSONL recording; errors name the line. Entries must be in time order. */
export function parseRecording(text: string): Recording {
  const lines = text
    .split("\n")
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => line && !line.startsWith("//"));
  const [first, ...rest] = lines;
  if (!first) throw new Error("empty recording");
  const header = recordingHeaderSchema.parse(JSON.parse(first.line));
  const entries: RecordingEntry[] = [];
  let last = 0;
  for (const { line, n } of rest) {
    const parsed = recordingEntrySchema.safeParse(JSON.parse(line));
    if (!parsed.success)
      throw new Error(
        `line ${n}: ${parsed.error.issues[0]?.message ?? "invalid entry"}`,
      );
    if (parsed.data.t < last)
      throw new Error(`line ${n}: out of order (t=${parsed.data.t})`);
    last = parsed.data.t;
    entries.push(parsed.data);
  }
  return { header, entries, durationMs: last };
}
