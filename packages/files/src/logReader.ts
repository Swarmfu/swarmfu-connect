import {
  connectorEventSchema,
  connectorManifestSchema,
  heartbeatSchema,
  stateSchema,
  type ConnectorEvent,
  type ConnectorManifest,
  type GameState,
  type Heartbeat,
} from "@swarmfu/connect-protocol";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { ReadResult } from "./reader.ts";

/**
 * Follows a connector that writes into a log the game keeps instead of files
 * of its own (FTL's Hyperspace Lua can only `log()`): its lines carry a
 * prefix and one JSON object each, whose `t` says whether it's the manifest,
 * a heartbeat, the state or an event (docs/mod-guide.md, "A log instead of
 * files"). Each read hands back what ConnectorReader's does.
 *
 * The mod can't tell the time, so a line is stamped as it's read. A session
 * id is made unique here too: the game can't see a clock to make one, so the
 * mod's is joined to when its manifest was first read.
 *
 * The game starts a new log each launch (FTL_HS.log is moved aside and
 * written again), so a different file, or one that got shorter, is read
 * from its start, as lines that are new.
 */

/** A line longer than this isn't one of ours; it's skipped. */
const MAX_LINE_BYTES = 65_536;
const NEWLINE = 0x0a;

export interface LogReaderOptions {
  /** The log's full path. */
  file: string;
  prefix: string;
  /** Hand back a session's events already in the log when it's first read, not just what's added from now. */
  fromStart?: boolean;
  now?: () => number;
  log?: (line: string) => void;
}

type Kind = "manifest" | "heartbeat" | "state" | "event";
const KINDS = new Set<string>(["manifest", "heartbeat", "state", "event"]);

export class LogReader {
  readonly #file: string;
  readonly #prefix: string;
  readonly #fromStart: boolean;
  readonly #now: () => number;
  readonly #log: (line: string) => void;
  #identity: string | null = null;
  #offset = 0;
  #partial: Buffer = Buffer.alloc(0);
  #manifest: ConnectorManifest | null = null;
  #heartbeat: Heartbeat | null = null;
  #state: GameState | null = null;
  /** The mod's session ids, as made unique here. */
  #sessions = new Map<string, string>();
  #lastSeq = 0;
  /** Lines lost, by the gaps in `seq`. */
  lost = 0;

  constructor(options: LogReaderOptions) {
    this.#file = options.file;
    this.#prefix = options.prefix;
    this.#fromStart = options.fromStart ?? false;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? ((line) => console.error(line));
  }

  read(): ReadResult {
    const events: ConnectorEvent[] = [];
    let stat: { size: number; mtimeMs: number; identity: string } | null = null;
    try {
      const s = statSync(this.#file);
      stat = {
        size: s.size,
        mtimeMs: s.mtimeMs,
        identity: `${s.dev}:${s.ino}:${s.birthtimeMs}`,
      };
    } catch {
      // Not there (yet): nothing to read.
    }
    if (stat) {
      // The first look catches up on what's there: its sessions and state, but
      // its events only if asked, and stamped with the file's last write so a
      // game that's closed doesn't look as if it were running.
      const first = this.#identity === null;
      if (
        !first &&
        (stat.identity !== this.#identity || stat.size < this.#offset)
      ) {
        this.#log(
          `${basename(this.#file)} was started again; reading it from the start`,
        );
        this.#offset = 0;
        this.#partial = Buffer.alloc(0);
      }
      this.#identity = stat.identity;
      const at = first ? Math.min(stat.mtimeMs, this.#now()) : this.#now();
      for (const line of this.#lines(stat.size)) {
        const event = this.#take(line, at);
        if (event && (!first || this.#fromStart)) events.push(event);
      }
    }
    return {
      manifest: this.#manifest,
      events,
      heartbeat: this.#heartbeat,
      state: this.#state,
    };
  }

  #lines(size: number): string[] {
    if (size <= this.#offset) return [];
    const chunk = Buffer.alloc(size - this.#offset);
    const fd = openSync(this.#file, "r");
    try {
      readSync(fd, chunk, 0, chunk.length, this.#offset);
    } finally {
      closeSync(fd);
    }
    this.#offset = size;
    const bytes = Buffer.concat([this.#partial, chunk]);
    const end = bytes.lastIndexOf(NEWLINE);
    if (end < 0) {
      this.#partial = bytes.length > MAX_LINE_BYTES ? Buffer.alloc(0) : bytes;
      return [];
    }
    this.#partial = bytes.subarray(end + 1);
    return bytes.subarray(0, end).toString("utf8").split("\n");
  }

  /** One line: what it says is kept, and an event handed back. */
  #take(line: string, at: number): ConnectorEvent | null {
    const start = line.indexOf(this.#prefix);
    if (start < 0 || line.length > MAX_LINE_BYTES) return null;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line.slice(start + this.#prefix.length).trim());
    } catch {
      return null;
    }
    if (!raw || typeof raw !== "object" || !KINDS.has(raw.t as string))
      return null;
    const { t, ...body } = raw;
    const kind = t as Kind;
    if (kind === "manifest") {
      const session = typeof body.session === "string" ? body.session : "";
      const unique = `${at}-${session}`;
      this.#sessions.set(session, unique);
      const parsed = connectorManifestSchema.safeParse({
        started_at: at,
        ...body,
        session: unique,
        // The manifest names an events file; here it's the log.
        events_file: basename(this.#file),
      });
      if (parsed.success) {
        this.#manifest = parsed.data;
        this.#lastSeq = 0;
      } else
        this.#log(
          `skipped a manifest: ${parsed.error.issues[0]?.message ?? "invalid"}`,
        );
      return null;
    }
    const session = this.#sessions.get(String(body.session));
    // Lines from a session whose manifest came before the log did: nothing to tie them to.
    if (!session) return null;
    const stamped = { ts: at, ...body, session };
    if (kind === "heartbeat") {
      const parsed = heartbeatSchema.safeParse(stamped);
      if (parsed.success) this.#heartbeat = parsed.data;
      return null;
    }
    if (kind === "state") {
      const parsed = stateSchema.safeParse(stamped);
      if (parsed.success) this.#state = parsed.data;
      return null;
    }
    const parsed = connectorEventSchema.safeParse(stamped);
    if (!parsed.success) {
      this.#log(
        `skipped an event: ${parsed.error.issues[0]?.message ?? "invalid"}`,
      );
      return null;
    }
    const event = parsed.data;
    if (session !== this.#manifest?.session || event.seq <= this.#lastSeq)
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
