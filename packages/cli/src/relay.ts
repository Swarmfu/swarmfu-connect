import {
  MAX_EVENT_DATA_CHARS,
  MAX_EVENTS_PER_BATCH,
  type GameEvent,
} from "@swarmfu/connect-protocol";
import type { Backend, RelayedEvent, SessionId } from "./backend.ts";

/**
 * Sends game events to the backend in small batches. Respond events go at
 * once (she may want to say something); the rest wait a beat to share a
 * batch. A failed batch is retried with backoff, and if the backend stays
 * away the queue drops silent events first.
 */

const BATCH_DELAY_MS = 250;
const MAX_QUEUE = 500;
const MAX_BACKOFF_MS = 10_000;

export function toRelayed(event: GameEvent): RelayedEvent {
  const data = event.data ? JSON.stringify(event.data) : undefined;
  return {
    eventId: event.id,
    kind: event.kind,
    lane: event.lane,
    subject: event.subject,
    summary: event.summary,
    ...(event.reaction ? { reaction: event.reaction } : {}),
    ...(event.tally ? { tally: true } : {}),
    // Oversized detail is dropped rather than the whole event.
    ...(data && data.length <= MAX_EVENT_DATA_CHARS ? { data } : {}),
    at: event.at,
  };
}

export class EventRelay {
  readonly #backend: Backend;
  readonly #log: (line: string) => void;
  #sessionId: SessionId | null = null;
  #queue: RelayedEvent[] = [];
  #timer: ReturnType<typeof setTimeout> | null = null;
  #sending: Promise<void> | null = null;
  #failures = 0;

  constructor(backend: Backend, log: (line: string) => void = () => {}) {
    this.#backend = backend;
    this.#log = log;
  }

  /** Events queued before this wait for it. */
  setSession(sessionId: SessionId): void {
    this.#sessionId = sessionId;
    this.#schedule(0);
  }

  get queued(): number {
    return this.#queue.length;
  }

  push(event: GameEvent): void {
    this.#queue.push(toRelayed(event));
    if (this.#queue.length > MAX_QUEUE) {
      const silent = this.#queue.findIndex((e) => e.lane === "silent");
      this.#queue.splice(silent >= 0 ? silent : 0, 1);
    }
    this.#schedule(event.lane === "respond" ? 0 : BATCH_DELAY_MS);
  }

  /** Sends whatever is queued; for shutdown. */
  async flush(): Promise<void> {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    await this.#sending;
    while (this.#sessionId && this.#queue.length) {
      const before = this.#queue.length;
      await this.#send();
      if (this.#queue.length >= before) break; // the backend is failing; give up
    }
  }

  stop(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #schedule(delay: number): void {
    if (!this.#sessionId || this.#sending || !this.#queue.length) return;
    if (this.#timer) {
      if (delay > 0) return; // already due
      clearTimeout(this.#timer);
    }
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#sending = this.#send().finally(() => {
        this.#sending = null;
        const backoff = this.#failures
          ? Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.#failures)
          : 0;
        this.#schedule(backoff || BATCH_DELAY_MS);
      });
    }, delay);
  }

  async #send(): Promise<void> {
    const sessionId = this.#sessionId;
    if (!sessionId) return;
    const batch = this.#queue.slice(0, MAX_EVENTS_PER_BATCH);
    if (!batch.length) return;
    try {
      await this.#backend.ingest(sessionId, batch);
      this.#queue.splice(0, batch.length);
      this.#failures = 0;
    } catch (error) {
      this.#failures++;
      this.#log(
        `couldn't relay ${batch.length} events (${error instanceof Error ? error.message : error}); retrying`,
      );
    }
  }
}
