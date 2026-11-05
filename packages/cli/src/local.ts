import {
  BRIDGE_PROTOCOL,
  bridgeClientMessageSchema,
  type BridgeClientMessage,
  type BridgeServerMessage,
} from "@swarmfu/connect-protocol";
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

/**
 * The socket the web app opens on this computer, so reflexes reach her
 * avatar without a round trip through the backend. Bound to 127.0.0.1 only.
 * A page must come from an allowed origin and send the per-run secret (which
 * it gets from the backend, signed in as the same user) before it hears
 * anything.
 */

const AUTH_TIMEOUT_MS = 3_000;
const MAX_MESSAGE_BYTES = 4_096;

export interface LocalServerOptions {
  port: number;
  secret: string;
  /** Origins allowed besides http://localhost and http://127.0.0.1 on any port. */
  origins: readonly string[];
  /** Sent to each client once it authenticates. */
  greeting(): Extract<BridgeServerMessage, { type: "ready" }>;
  onMessage(message: Exclude<BridgeClientMessage, { type: "auth" }>): void;
  log?(line: string): void;
}

export function originAllowed(
  origin: string | undefined,
  extra: readonly string[],
): boolean {
  if (!origin) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1")
  )
    return true;
  return extra.some((allowed) => {
    try {
      return new URL(allowed).origin === url.origin;
    } catch {
      return false;
    }
  });
}

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class LocalServer {
  readonly #wss: WebSocketServer;
  readonly #clients = new Set<WebSocket>();
  readonly #options: LocalServerOptions;

  private constructor(wss: WebSocketServer, options: LocalServerOptions) {
    this.#wss = wss;
    this.#options = options;
    wss.on("connection", (socket, request) => this.#accept(socket, request));
  }

  static start(options: LocalServerOptions): Promise<LocalServer> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({
        host: "127.0.0.1",
        port: options.port,
        maxPayload: MAX_MESSAGE_BYTES,
        verifyClient: ({ origin }: { origin: string }) => {
          const ok = originAllowed(origin, options.origins);
          if (!ok)
            options.log?.(`refused a page from ${origin || "no origin"}`);
          return ok;
        },
      });
      wss.once("listening", () => resolve(new LocalServer(wss, options)));
      wss.once("error", reject);
    });
  }

  get port(): number {
    const address = this.#wss.address();
    return typeof address === "object" && address
      ? address.port
      : this.#options.port;
  }

  get clientCount(): number {
    return this.#clients.size;
  }

  broadcast(message: BridgeServerMessage): void {
    const data = JSON.stringify(message);
    for (const socket of this.#clients)
      if (socket.readyState === socket.OPEN) socket.send(data);
  }

  close(): Promise<void> {
    for (const socket of this.#wss.clients)
      socket.close(1001, "bridge stopping");
    return new Promise((resolve) => this.#wss.close(() => resolve()));
  }

  #accept(socket: WebSocket, request: IncomingMessage): void {
    const from = request.headers.origin ?? "?";
    let authed = false;
    const timer = setTimeout(
      () => socket.close(4401, "auth timeout"),
      AUTH_TIMEOUT_MS,
    );
    const send = (message: BridgeServerMessage) =>
      socket.send(JSON.stringify(message));

    socket.on("message", (raw) => {
      let parsed;
      try {
        parsed = bridgeClientMessageSchema.safeParse(
          JSON.parse(raw.toString()),
        );
      } catch {
        parsed = null;
      }
      if (!parsed?.success) {
        if (!authed) socket.close(4400, "bad message");
        return;
      }
      const message = parsed.data;
      if (!authed) {
        if (
          message.type !== "auth" ||
          !sameSecret(message.secret, this.#options.secret)
        ) {
          socket.close(4401, "unauthorized");
          return;
        }
        if (message.protocol !== BRIDGE_PROTOCOL) {
          send({
            type: "error",
            message: `protocol ${message.protocol} isn't supported; update the bridge`,
          });
          socket.close(4426, "protocol mismatch");
          return;
        }
        clearTimeout(timer);
        authed = true;
        this.#clients.add(socket);
        this.#options.log?.(`page connected from ${from}`);
        send(this.#options.greeting());
        return;
      }
      if (message.type !== "auth") this.#options.onMessage(message);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      if (this.#clients.delete(socket))
        this.#options.log?.(`page disconnected (${from})`);
    });
    socket.on("error", () => socket.terminate());
  }
}
