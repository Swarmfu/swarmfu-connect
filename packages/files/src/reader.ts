import {
  connectorEventSchema,
  connectorManifestSchema,
  heartbeatSchema,
  stateSchema,
  type GameState,
  type ConnectorEvent,
  type ConnectorManifest,
  type Heartbeat,
} from "@swarmfu/connect-protocol";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";

/**
 * Follows a connector's folder (docs/game-connectors/mod-guide.md): the
 * manifest says which events file is being written, so a new session or a
 * file rolled to its next part is followed to its first line, after the rest
 * of the last one. Each read hands back the lines added since the last.
 */

/** A line longer than this isn't an event; it's skipped. */
const MAX_LINE_BYTES = 16_384;
const NEWLINE = 0x0a;

export interface ReaderOptions {
  dir: string;
  /** Read a session already being written from its first line, not just what's added from now. */
  fromStart?: boolean;
  /** A session the manifest says started at or after this is read from its first line: it began while we watched. */
  since?: number;
  log?: (line: string) => void;
}

export interface ReadResult {
  manifest: ConnectorManifest | null;
  events: ConnectorEvent[];
  heartbeat: Heartbeat | null;
  /** The connector's state file, if it writes one. */
  state: GameState | null;
}

function readJson<T extends z.ZodType>(
  path: string,
  schema: T,
): z.infer<T> | null {
  try {
    const parsed = schema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    // Missing, or caught mid-write: the next read gets it.
    return null;
  }
}

function sizeOf(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

export class ConnectorReader {
  readonly #dir: string;
  readonly #fromStart: boolean;
  readonly #since: number | undefined;
  readonly #log: (line: string) => void;
  #manifest: ConnectorManifest | null = null;
  #session: string | null = null;
  #file: string | null = null;
  #offset = 0;
  #partial: Buffer = Buffer.alloc(0);
  #lastSeq = 0;
  #attached = false;
  /** Lines lost, by the gaps in `seq`. */
  lost = 0;

  constructor(options: ReaderOptions) {
    this.#dir = options.dir;
    this.#fromStart = options.fromStart ?? false;
    this.#since = options.since;
    this.#log = options.log ?? ((line) => console.error(line));
  }

  read(): ReadResult {
    const events: ConnectorEvent[] = [];
    this.#manifest =
      readJson(join(this.#dir, "manifest.json"), connectorManifestSchema) ??
      this.#manifest;
    const manifest = this.#manifest;
    if (manifest) {
      if (
        manifest.session !== this.#session ||
        manifest.events_file !== this.#file
      ) {
        // The rest of the file being left, then the new one from its start.
        if (this.#file) events.push(...this.#drain(this.#file));
        const newSession = manifest.session !== this.#session;
        this.#file = manifest.events_file;
        this.#partial = Buffer.alloc(0);
        if (newSession) {
          this.#session = manifest.session;
          this.#lastSeq = 0;
        }
        // Attaching to a session already running: only what's added from now, unless asked for all of it.
        const begunSince = this.#since !== undefined && (manifest.started_at ?? -Infinity) >= this.#since;
        const skip = !this.#attached && !this.#fromStart && !begunSince;
        this.#offset = skip ? (sizeOf(join(this.#dir, this.#file)) ?? 0) : 0;
      }
      this.#attached = true;
      events.push(...this.#drain(this.#file!));
    }
    const heartbeat = readJson(
      join(this.#dir, "heartbeat.json"),
      heartbeatSchema,
    );
    const state = readJson(join(this.#dir, "state.json"), stateSchema);
    return { manifest, events, heartbeat, state };
  }

  #drain(file: string): ConnectorEvent[] {
    const path = join(this.#dir, file);
    const size = sizeOf(path);
    if (size === null) return [];
    if (size < this.#offset) {
      this.#log(`${file} got shorter; reading it again from the start`);
      this.#offset = 0;
      this.#partial = Buffer.alloc(0);
    }
    if (size === this.#offset) return [];
    const chunk = Buffer.alloc(size - this.#offset);
    const fd = openSync(path, "r");
    try {
      readSync(fd, chunk, 0, chunk.length, this.#offset);
    } finally {
      closeSync(fd);
    }
    this.#offset = size;
    // Whole lines only; a line still being written waits for the next read.
    const bytes = Buffer.concat([this.#partial, chunk]);
    const end = bytes.lastIndexOf(NEWLINE);
    if (end < 0) {
      this.#partial = bytes.length > MAX_LINE_BYTES ? Buffer.alloc(0) : bytes;
      return [];
    }
    this.#partial = bytes.subarray(end + 1);
    const events: ConnectorEvent[] = [];
    for (const line of bytes.subarray(0, end).toString("utf8").split("\n")) {
      const event = this.#parse(line);
      if (event) events.push(event);
    }
    return events;
  }

  #parse(line: string): ConnectorEvent | null {
    if (!line.trim() || line.length > MAX_LINE_BYTES) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      this.#log("skipped a line that isn't JSON");
      return null;
    }
    const parsed = connectorEventSchema.safeParse(raw);
    if (!parsed.success) {
      this.#log(
        `skipped an event: ${parsed.error.issues[0]?.message ?? "invalid"}`,
      );
      return null;
    }
    const event = parsed.data;
    if (event.session !== this.#session || event.seq <= this.#lastSeq)
      return null;
    if (this.#lastSeq && event.seq > this.#lastSeq + 1) {
      this.lost += event.seq - this.#lastSeq - 1;
      this.#log(
        `lost ${event.seq - this.#lastSeq - 1} event(s) before seq ${event.seq}`,
      );
    }
    this.#lastSeq = event.seq;
    return event;
  }
}
