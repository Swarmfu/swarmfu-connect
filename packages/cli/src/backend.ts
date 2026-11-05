import { ConvexClient } from "convex/browser";
import { makeFunctionReference, type FunctionReference } from "convex/server";
import type {
  DeclaredTool,
  Lane,
  Reaction,
  Role,
  Subject,
} from "@swarmfu/connect-protocol";

/**
 * The bridge's calls to Swarmfu's backend (its `bridge` module), every one
 * carrying the bridge token. They're named rather than imported, so this
 * repo needs nothing from the backend's code. An interface, so the bridge
 * can be tested without a backend.
 */

/** A game session's id, as the backend gave it. */
export type SessionId = string & { readonly __kind: "game session" };
/** A queued command's id. */
export type CommandId = string & { readonly __kind: "game command" };

export interface RelayedEvent {
  eventId: string;
  kind: string;
  lane: Lane;
  subject: Subject;
  summary: string;
  reaction?: Reaction;
  tally?: boolean;
  data?: string;
  at: number;
}

export interface Feed {
  status: "active" | "paused" | "ended";
  commands: { id: CommandId; tool: string; args: string }[];
}

export type StartSessionArgs = {
  adapterId: string;
  game: string;
  adapterVersion: string;
  tools: DeclaredTool[];
  player?: string;
  partner?: string;
  world?: string;
  role?: Role;
};

export interface Backend {
  hello(args: {
    port: number;
    secret: string;
    adapters: string[];
  }): Promise<{ name: string }>;
  goodbye(): Promise<void>;
  startSession(args: StartSessionArgs): Promise<SessionId>;
  endSession(sessionId: SessionId): Promise<void>;
  ingest(
    sessionId: SessionId,
    events: RelayedEvent[],
  ): Promise<{ accepted: number }>;
  completeCommand(
    commandId: CommandId,
    ok: boolean,
    result: string,
  ): Promise<void>;
  setPaused(sessionId: SessionId, paused: boolean): Promise<void>;
  /** Calls back on every change; returns an unsubscribe. */
  watchFeed(
    sessionId: SessionId,
    onFeed: (feed: Feed) => void,
    onError: (error: Error) => void,
  ): () => void;
  close(): Promise<void>;
}

type Args = Record<string, unknown>;
const mutation = <A extends Args, R>(name: string) =>
  makeFunctionReference<"mutation", A, R>(name) as FunctionReference<
    "mutation",
    "public",
    A,
    R
  >;
const query = <A extends Args, R>(name: string) =>
  makeFunctionReference<"query", A, R>(name) as FunctionReference<
    "query",
    "public",
    A,
    R
  >;

/** The backend's bridge functions, by name. */
const fn = {
  pair: mutation<
    { code: string; name: string; machineId: string },
    { ok: true; token: string; name: string } | { ok: false; error: string }
  >("bridge:pair"),
  hello: mutation<
    { token: string; port: number; secret: string; adapters: string[] },
    { name: string }
  >("bridge:hello"),
  goodbye: mutation<{ token: string }, null>("bridge:goodbye"),
  startSession: mutation<StartSessionArgs & { token: string }, SessionId>(
    "bridge:startSession",
  ),
  endSession: mutation<{ token: string; sessionId: SessionId }, null>(
    "bridge:endGameSession",
  ),
  ingest: mutation<
    { token: string; sessionId: SessionId; events: RelayedEvent[] },
    { accepted: number }
  >("bridge:ingest"),
  completeCommand: mutation<
    { token: string; commandId: CommandId; ok: boolean; result: string },
    null
  >("bridge:completeCommand"),
  setPaused: mutation<
    { token: string; sessionId: SessionId; paused: boolean },
    null
  >("bridge:setPaused"),
  feed: query<{ token: string; sessionId: SessionId }, Feed>("bridge:feed"),
};

export function convexBackend(url: string, token: string): Backend {
  const client = new ConvexClient(url);
  return {
    hello: (args) => client.mutation(fn.hello, { token, ...args }),
    goodbye: async () => {
      await client.mutation(fn.goodbye, { token });
    },
    startSession: (args) =>
      client.mutation(fn.startSession, { token, ...args }),
    endSession: async (sessionId) => {
      await client.mutation(fn.endSession, { token, sessionId });
    },
    ingest: (sessionId, events) =>
      client.mutation(fn.ingest, { token, sessionId, events }),
    completeCommand: async (commandId, ok, result) => {
      await client.mutation(fn.completeCommand, {
        token,
        commandId,
        ok,
        result,
      });
    },
    setPaused: async (sessionId, paused) => {
      await client.mutation(fn.setPaused, { token, sessionId, paused });
    },
    watchFeed: (sessionId, onFeed, onError) =>
      client.onUpdate(fn.feed, { token, sessionId }, onFeed, onError),
    close: () => client.close(),
  };
}

/** Pairing happens before there's a token. `machineId` lets pairing again replace this computer's old entry. */
export async function redeemPairingCode(
  url: string,
  code: string,
  name: string,
  machineId: string,
) {
  const client = new ConvexClient(url);
  try {
    const paired = await client.mutation(fn.pair, { code, name, machineId });
    if (!paired.ok) throw new Error(paired.error);
    return paired;
  } finally {
    await client.close();
  }
}
