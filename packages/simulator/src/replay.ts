import type { GameEvent, Recording } from "@swarmfu/connect-protocol";

/**
 * Plays a recording back in real time (or faster), one timer at a time.
 * Events go out with a fresh id and the current time; state entries replace
 * a resource's value. Pausing keeps the position, so resuming carries on
 * where the recording stopped.
 */

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface ReplayHandlers {
  event(event: GameEvent): void;
  state(resource: string, value: unknown): void;
  /** The recording finished and isn't looping. */
  end?(): void;
}

export interface ReplayOptions {
  /** 2 plays twice as fast. */
  speed?: number;
  loop?: boolean;
  clock?: Clock;
}

export class Replayer {
  readonly #recording: Recording;
  readonly #handlers: ReplayHandlers;
  readonly #speed: number;
  readonly #loop: boolean;
  readonly #clock: Clock;
  /** The next entry to play. */
  #index = 0;
  /** Recording time (ms) at the last start or resume. */
  #offset = 0;
  /** Wall time at the last start or resume. */
  #resumedAt = 0;
  #timer: unknown = null;
  #playing = false;
  #sent = 0;

  constructor(
    recording: Recording,
    handlers: ReplayHandlers,
    options: ReplayOptions = {},
  ) {
    if (options.speed !== undefined && !(options.speed > 0))
      throw new Error("speed must be positive");
    this.#recording = recording;
    this.#handlers = handlers;
    this.#speed = options.speed ?? 1;
    this.#loop = options.loop ?? false;
    this.#clock = options.clock ?? systemClock;
  }

  get playing(): boolean {
    return this.#playing;
  }

  /** Where playback is, in recording ms. */
  get position(): number {
    if (!this.#playing) return this.#offset;
    return this.#offset + (this.#clock.now() - this.#resumedAt) * this.#speed;
  }

  start(): void {
    this.#index = 0;
    this.#offset = 0;
    this.resume();
  }

  resume(): void {
    if (this.#playing) return;
    this.#playing = true;
    this.#resumedAt = this.#clock.now();
    this.#tick();
  }

  pause(): void {
    if (!this.#playing) return;
    this.#offset = this.position;
    this.#playing = false;
    this.#clear();
  }

  stop(): void {
    this.pause();
    this.#index = 0;
    this.#offset = 0;
  }

  #clear(): void {
    if (this.#timer !== null) this.#clock.clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** Plays every entry that's due, then waits for the next one. */
  #tick(): void {
    this.#timer = null;
    const { entries, durationMs } = this.#recording;
    const now = this.position;
    while (
      this.#playing &&
      this.#index < entries.length &&
      entries[this.#index]!.t <= now
    ) {
      const entry = entries[this.#index++]!;
      if (entry.type === "state")
        this.#handlers.state(entry.resource, entry.value);
      else
        this.#handlers.event({
          ...entry.event,
          id: `sim-${++this.#sent}`,
          at: this.#clock.now(),
        });
    }
    if (!this.#playing) return;
    const next = entries[this.#index];
    if (next) {
      this.#timer = this.#clock.setTimeout(
        () => this.#tick(),
        (next.t - now) / this.#speed,
      );
      return;
    }
    if (this.#loop && entries.length > 0) {
      // Start over from the top, a beat after the last entry.
      this.#index = 0;
      this.#offset = 0;
      this.#resumedAt = this.#clock.now() + 1_000 / this.#speed;
      this.#timer = this.#clock.setTimeout(
        () => this.#tick(),
        1_000 / this.#speed,
      );
      return;
    }
    this.#offset = durationMs;
    this.#playing = false;
    this.#handlers.end?.();
  }
}
