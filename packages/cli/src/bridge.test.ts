import { BRIDGE_PROTOCOL, type BridgeServerMessage } from "@swarmfu/connect-protocol";
import { afterEach, expect, test } from "bun:test";
import { builtinAdapters } from "./adapter.ts";
import type {
  Backend,
  CommandId,
  Feed,
  RelayedEvent,
  SessionId,
} from "./backend.ts";
import { Bridge } from "./bridge.ts";
import { originAllowed } from "./local.ts";

const SECRET = "test-secret-0123456789";
const SESSION = "session1" as SessionId;

function fakeBackend() {
  const calls: { fn: string; args: unknown }[] = [];
  const events: RelayedEvent[] = [];
  const completed: { id: string; ok: boolean; result: string }[] = [];
  let feed: ((feed: Feed) => void) | null = null;
  const backend: Backend = {
    hello: async (args) => (
      calls.push({ fn: "hello", args }),
      { name: "Desk" }
    ),
    goodbye: async () => void calls.push({ fn: "goodbye", args: null }),
    startSession: async (args) => (
      calls.push({ fn: "startSession", args }),
      SESSION
    ),
    endSession: async () => {},
    ingest: async (_, batch) => (
      events.push(...batch),
      { accepted: batch.length }
    ),
    completeCommand: async (id, ok, result) =>
      void completed.push({ id, ok, result }),
    setPaused: async (_, paused) =>
      void calls.push({ fn: "setPaused", args: paused }),
    watchFeed: (_, onFeed) => ((feed = onFeed), () => (feed = null)),
    close: async () => {},
  };
  return { backend, calls, events, completed, push: (f: Feed) => feed?.(f) };
}

async function until(check: () => boolean, ms = 3_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

/** A page on the local socket; collects what the bridge sends it. Bun's WebSocket can set Origin. */
async function page(port: number, secret = SECRET, origin = "http://localhost:5179") {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Origin: origin } } as unknown as string[]);
  const received: BridgeServerMessage[] = [];
  const closed = new Promise<number>((resolve) => socket.addEventListener("close", (e) => resolve(e.code)));
  socket.addEventListener("message", (e) => received.push(JSON.parse(String(e.data)) as BridgeServerMessage));
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("refused")), { once: true });
  });
  socket.send(JSON.stringify({ type: "auth", secret, protocol: BRIDGE_PROTOCOL }));
  return { socket, received, closed };
}

let bridge: Bridge | null = null;
afterEach(async () => {
  await bridge?.stop("test over");
  bridge = null;
});

async function started() {
  const fake = fakeBackend();
  bridge = new Bridge({
    backend: fake.backend,
    adapter: {
      id: "simulator",
      entry: builtinAdapters().simulator!,
      args: ["--speed", "20", "--quiet"],
    },
    adapterIds: ["simulator"],
    port: 0,
    origins: ["https://swarmfu.example"],
    secret: SECRET,
  });
  await bridge.start();
  return { ...fake, bridge, port: bridge.port! };
}

test("events reach the page at once and the backend in batches", async () => {
  const { calls, events, port } = await started();
  expect(calls.map((c) => c.fn)).toEqual(["hello", "startSession"]);
  // Each tool comes with what it does and its input's JSON Schema, so the backend needn't know the game.
  const follow = (calls[1]!.args as { tools: { name: string; description?: string; inputSchema?: string }[] }).tools.find(
    (t) => t.name === "follow_player",
  );
  expect(follow?.description).toContain("Follow a player");
  expect(JSON.parse(follow!.inputSchema!)).toMatchObject({ type: "object", required: ["player"] });
  expect(calls[1]!.args).toMatchObject({
    player: "Kiri",
    partner: "Steve",
    adapterId: "minecraft",
    tools: expect.arrayContaining([
      expect.objectContaining({ name: "break_block", destructive: true }),
    ]),
  });

  const p = await page(port);
  await until(() =>
    p.received.some((m) => m.type === "event" && m.event.lane === "reflex"),
  );
  expect(p.received[0]).toMatchObject({
    type: "ready",
    adapter: { id: "minecraft" },
    paused: false,
  });
  const reflex = p.received.find(
    (m) => m.type === "event" && m.event.lane === "reflex",
  );
  expect(reflex).toMatchObject({
    event: { kind: "creeper_fuse", reaction: "startle" },
  });
  await until(() => events.some((e) => e.kind === "creeper_fuse"));
  expect(events[0]).toMatchObject({
    eventId: "sim-1",
    kind: "player_joined",
    lane: "respond",
  });
  expect(typeof events[0]!.data).toBe("string");
  p.socket.close();
}, 15_000);

test("the socket wants the secret and an allowed origin", async () => {
  const { port } = await started();
  const wrong = await page(port, "not-it");
  expect(await wrong.closed).toBe(4401);
  expect(wrong.received).toEqual([]);
  await expect(page(port, SECRET, "https://evil.example")).rejects.toThrow();
  const hosted = await page(port, SECRET, "https://swarmfu.example");
  await until(() => hosted.received.length > 0);
  hosted.socket.close();
  expect(originAllowed("http://127.0.0.1:5173", [])).toBe(true);
  expect(originAllowed("https://localhost:5173", [])).toBe(false);
  expect(originAllowed(undefined, [])).toBe(false);
});

test("queued commands run on the adapter; disallowed ones are refused", async () => {
  const { push, completed } = await started();
  push({
    status: "active",
    commands: [
      {
        id: "c1" as CommandId,
        tool: "follow_player",
        args: '{"player":"Steve"}',
      },
      {
        id: "c2" as CommandId,
        tool: "break_block",
        args: '{"x":1,"y":2,"z":3}',
      },
    ],
  });
  // The same feed again (a re-render) doesn't run them twice.
  push({
    status: "active",
    commands: [
      {
        id: "c1" as CommandId,
        tool: "follow_player",
        args: '{"player":"Steve"}',
      },
    ],
  });
  await until(() => completed.length === 2);
  await Bun.sleep(50);
  expect(completed).toHaveLength(2);
  expect(completed.find((c) => c.id === "c1")).toMatchObject({
    ok: true,
    result: expect.stringContaining("follow_player"),
  });
  expect(completed.find((c) => c.id === "c2")).toEqual({
    id: "c2",
    ok: false,
    result: "not allowed: break_block",
  });
});

test("pausing from the page tells the backend and holds commands", async () => {
  const { calls, push, completed, port } = await started();
  const p = await page(port);
  await until(() => p.received.length > 0);
  p.socket.send(JSON.stringify({ type: "pause" }));
  await until(() => calls.some((c) => c.fn === "setPaused"));
  expect(calls.find((c) => c.fn === "setPaused")!.args).toBe(true);
  await until(() => p.received.some((m) => m.type === "status" && m.paused));
  push({
    status: "paused",
    commands: [{ id: "c3" as CommandId, tool: "follow_player", args: "{}" }],
  });
  await Bun.sleep(100);
  expect(completed).toEqual([]);
  push({ status: "active", commands: [] });
  await until(() => p.received.some((m) => m.type === "status" && !m.paused));
  p.socket.close();
});

test("a session ended from the app shuts the bridge down", async () => {
  const { push, calls } = await started();
  push({ status: "ended", commands: [] });
  expect(await bridge!.done).toBe("the play session was ended from the app");
  expect(calls.at(-1)?.fn).toBe("goodbye");
});
