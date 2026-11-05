import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { EVENT_NOTIFICATION, gameEventSchema, resourceUri, type GameEvent } from "@swarmfu/connect-protocol";
import { MINECRAFT_MANIFEST } from "./manifest.ts";
import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Bot } from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { z } from "zod";
import { createMinecraftAdapter, type MinecraftAdapter } from "./adapter.ts";
import { dayPhase } from "./state.ts";

const { goals } = pathfinderPkg;

/** Just enough of a Mineflayer bot for the adapter; the world is a map of blocks. */
function fakeBot() {
  const bot = new EventEmitter() as EventEmitter & Record<string, any>;
  const blocks = new Map<string, string>();
  const key = (p: Vec3) =>
    `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
  const calls: { fn: string; args: unknown[] }[] = [];
  const record =
    (fn: string, result?: unknown) =>
    (...args: unknown[]) => {
      calls.push({ fn, args });
      return result;
    };
  Object.assign(bot, {
    username: "Kiri",
    version: "1.21.4",
    entity: {
      id: 1,
      type: "player",
      username: "Kiri",
      position: new Vec3(0, 64, 0),
      velocity: new Vec3(0, 0, 0),
      onGround: true,
    },
    entities: {} as Record<number, any>,
    players: {} as Record<string, any>,
    health: 20,
    food: 20,
    time: { timeOfDay: 6_000, day: 1 },
    isRaining: false,
    thunderState: 0,
    game: { dimension: "overworld", difficulty: "normal" },
    heldItem: null,
    getEquipmentDestSlot: (slot: string) => ({ head: 5, torso: 6, legs: 7, feet: 8, "off-hand": 45 })[slot] ?? 36,
    inventory: {
      slots: [] as ({ name: string } | null)[],
      items: () => [
        { name: "dirt", count: 12 },
        { name: "dirt", count: 3 },
      ],
    },
    registry: {
      blocksByName: {
        diamond_ore: { id: 1, name: "diamond_ore" },
        oak_log: { id: 2, name: "oak_log" },
      },
    },
    _client: new EventEmitter(),
    blockAt: (p: Vec3) => {
      const name = blocks.get(key(p)) ?? "air";
      return {
        name,
        position: p.floored(),
        boundingBox: name === "air" || name === "water" ? "empty" : "block",
        type: name === "diamond_ore" ? 1 : name === "oak_log" ? 2 : 0,
      };
    },
    findBlocks: ({
      matching,
      count,
    }: {
      matching: number | ((b: { type: number }) => boolean);
      count: number;
    }) => {
      const found: Vec3[] = [];
      for (const [k, name] of blocks) {
        const type = name === "diamond_ore" ? 1 : name === "oak_log" ? 2 : 0;
        if (
          typeof matching === "number" ? matching === type : matching({ type })
        ) {
          const [x, y, z] = k.split(",").map(Number);
          found.push(new Vec3(x!, y!, z!));
        }
      }
      return found.slice(0, count);
    },
    pathfinder: {
      // Like the real one: stop() only flags a stop, applied at the next path
      // reset (setGoal), which then clears the goal.
      goal: null as unknown,
      stopFlag: false,
      setGoal(goal: unknown) {
        calls.push({ fn: "setGoal", args: [goal] });
        this.goal = goal;
        if (this.stopFlag) {
          this.stopFlag = false;
          this.goal = null;
        }
      },
      stop() {
        calls.push({ fn: "stop", args: [] });
        this.stopFlag = true;
      },
      goto: (goal: unknown) => (
        calls.push({ fn: "goto", args: [goal] }),
        Promise.resolve()
      ),
    },
    collectBlock: {
      collect: (targets: unknown) => (
        calls.push({ fn: "collect", args: [targets] }),
        Promise.resolve()
      ),
      cancelTask: () => Promise.resolve(),
    },
    clearControlStates: record("clearControlStates"),
    chat: record("chat"),
    attack: record("attack"),
    equip: () => Promise.resolve(),
  });
  const addEntity = (id: number, props: Record<string, unknown>) => {
    const entity = { id, isValid: true, velocity: new Vec3(0, 0, 0), ...props };
    bot.entities[id] = entity;
    return entity;
  };
  const addPlayer = (id: number, username: string, at: Vec3) => {
    const entity = addEntity(id, { type: "player", username, position: at });
    bot.players[username] = { username, entity };
    return entity;
  };
  return {
    bot,
    blocks,
    calls,
    addEntity,
    addPlayer,
    asBot: bot as unknown as Bot,
  };
}

let adapter: MinecraftAdapter | null = null;
afterEach(() => {
  adapter?.close();
  adapter = null;
});

function setup(options: { partner?: string; oreScanEveryMs?: number } = {}) {
  const fake = fakeBot();
  const events: GameEvent[] = [];
  adapter = createMinecraftAdapter(fake.asBot, {
    partner: options.partner,
    movements: false,
    gatherMs: 20,
    statusEveryMs: 60_000,
    activityEveryMs: 60_000,
    oreScanEveryMs: options.oreScanEveryMs ?? 60_000,
    onEvent: (e) => events.push(e),
    log: () => {},
  });
  const kinds = () => events.map((e) => e.kind);
  return { ...fake, events, kinds, adapter };
}

test("chat and death messages become respond events, named by who they're about", () => {
  const { bot, events, addPlayer } = setup();
  addPlayer(2, "Steve", new Vec3(3, 64, 0));
  bot.emit("chat", "Steve", "hey Kiri, follow me");
  bot.emit("chat", "Kiri", "my own line");
  bot.emit("message", {
    translate: "death.attack.lava",
    toString: () => "Steve tried to swim in lava",
  });
  bot.emit("message", {
    translate: "chat.type.text",
    toString: () => "<Steve> hi",
  });
  expect(
    events.map(({ kind, lane, subject, summary }) => ({
      kind,
      lane,
      subject,
      summary,
    })),
  ).toEqual([
    {
      kind: "chat",
      lane: "respond",
      subject: "user",
      summary: 'Steve said in chat: "hey Kiri, follow me"',
    },
    {
      kind: "death",
      lane: "respond",
      subject: "user",
      summary: "Steve tried to swim in lava.",
    },
  ]);
});

test("taking damage is a reflex; near a mob she runs, unless she's paused", async () => {
  const { bot, events, calls, addEntity, adapter } = setup();
  bot.health = 14;
  bot.emit("health");
  expect(events.at(-1)).toMatchObject({
    kind: "hurt",
    lane: "reflex",
    reaction: "flinch",
    summary: "Kiri took 6 damage.",
  });
  expect(
    calls.some(
      (c) => c.fn === "setGoal" && c.args[0] instanceof goals.GoalInvert,
    ),
  ).toBe(false);

  addEntity(5, {
    type: "hostile",
    name: "zombie",
    position: new Vec3(2, 64, 0),
  });
  await new Promise((r) => setTimeout(r, 1_600)); // past the hurt cooldown
  bot.health = 5;
  bot.emit("health");
  expect(events.slice(-2).map((e) => e.kind)).toEqual(["hurt", "low_health"]);
  expect(events.at(-2)!.summary).toBe("Kiri took 9 damage from a zombie.");
  expect(
    calls.some(
      (c) => c.fn === "setGoal" && c.args[0] instanceof goals.GoalInvert,
    ),
  ).toBe(true);
  expect(adapter.actions.task?.tool).toBe("flee");

  await adapter.actions.run("stop", { paused: true });
  calls.length = 0;
  bot.health = 20;
  bot.emit("health");
  bot.health = 2;
  await new Promise((r) => setTimeout(r, 1_600));
  bot.emit("health");
  expect(
    calls.some(
      (c) => c.fn === "setGoal" && c.args[0] instanceof goals.GoalInvert,
    ),
  ).toBe(false);
}, 10_000);

test("a creeper close by startles her once, not every tick", () => {
  const { bot, events, addEntity } = setup();
  addEntity(7, {
    type: "hostile",
    name: "creeper",
    position: new Vec3(2, 64, 1),
  });
  for (let i = 0; i < 40; i++) bot.emit("physicsTick");
  expect(events.filter((e) => e.kind === "creeper_fuse")).toHaveLength(1);
  expect(events.find((e) => e.kind === "creeper_fuse")?.reaction).toBe(
    "startle",
  );
});

test("nightfall under open sky is worth a word; under a roof it's just the time", () => {
  const { bot, blocks, kinds } = setup();
  bot.emit("time"); // the time on arrival isn't news
  expect(kinds()).toEqual([]);
  bot.time.timeOfDay = 13_500;
  bot.emit("time");
  expect(kinds()).toEqual(["time_changed", "unsheltered_night"]);

  const roofed = setup();
  roofed.blocks.set("0,68,0", "oak_planks");
  roofed.bot.emit("time");
  roofed.bot.time.timeOfDay = 13_500;
  roofed.bot.emit("time");
  expect(roofed.kinds()).toEqual(["time_changed"]);
  expect(blocks.size).toBe(0);
  expect(
    [0, 999, 1_000, 11_999, 12_500, 13_000, 22_999, 23_000].map(dayPhase),
  ).toEqual(["dawn", "dawn", "day", "day", "dusk", "night", "night", "dawn"]);
});

test("pickups are gathered into one silent event", async () => {
  const { bot, events } = setup();
  const drop = (name: string, count: number) => ({
    getDroppedItem: () => ({ name, count }),
  });
  bot.emit("playerCollect", bot.entity, drop("oak_log", 2));
  bot.emit("playerCollect", bot.entity, drop("oak_log", 1));
  bot.emit("playerCollect", bot.entity, drop("apple", 1));
  bot.emit("playerCollect", { id: 99 }, drop("diamond", 1));
  await new Promise((r) => setTimeout(r, 50));
  expect(
    events.map(({ kind, lane, summary }) => ({ kind, lane, summary })),
  ).toEqual([
    {
      kind: "item_collected",
      lane: "silent",
      summary: "Kiri picked up 3 oak log, 1 apple.",
    },
  ]);
});

test("breaking blocks she placed is reported and blamed on the nearest player", async () => {
  const { bot, blocks, events, addPlayer, adapter } = setup({
    partner: "Steve",
  });
  addPlayer(2, "Steve", new Vec3(5, 64, 5));
  bot.inventory.items = () => [{ name: "dirt", count: 4 }];
  blocks.set("5,63,4", "stone");
  bot.placeBlock = async () => blocks.set("5,64,4", "dirt");
  expect(
    await adapter.actions.run("place_block", {
      block: "dirt",
      x: 5,
      y: 64,
      z: 4,
    }),
  ).toBe("Placed dirt at 5 64 4.");
  blocks.delete("5,64,4");
  bot.emit("blockUpdate", null, { position: new Vec3(5, 64, 4), name: "air" });
  await new Promise((r) => setTimeout(r, 50));
  expect(events.at(-1)).toMatchObject({
    kind: "build_damaged",
    subject: "user",
    summary: "Steve broke a block of Kiri's build.",
  });
});

test("ore in plain view is found once per vein; buried ore isn't", async () => {
  const { blocks, events } = setup({ oreScanEveryMs: 20 });
  blocks.set("2,60,0", "diamond_ore");
  blocks.set("2,59,0", "diamond_ore");
  // Stone all around: buried.
  for (const k of [
    "1,60,0",
    "3,60,0",
    "2,61,0",
    "2,60,1",
    "2,60,-1",
    "1,59,0",
    "3,59,0",
    "2,58,0",
    "2,59,1",
    "2,59,-1",
  ])
    blocks.set(k, "stone");
  await Bun.sleep(60);
  expect(events).toEqual([]);

  blocks.delete("2,61,0"); // the top one is in view now
  await Bun.sleep(60);
  expect(
    events.map(({ kind, subject, summary }) => ({ kind, subject, summary })),
  ).toEqual([
    {
      kind: "ore_found",
      subject: "self",
      summary: "A diamond ore in plain view near Kiri.",
    },
  ]);
  blocks.delete("2,58,0"); // the second one too, but it's the same vein
  await Bun.sleep(60);
  expect(events).toHaveLength(1);
});

test("tools: following needs a visible player, chat can't run commands, stop holds her", async () => {
  const { bot, calls, addPlayer, adapter } = setup();
  await expect(
    adapter.actions.run("follow_player", { player: "Steve" }),
  ).rejects.toThrow("I can't see Steve");
  addPlayer(2, "Steve", new Vec3(4, 64, 0));
  expect(
    await adapter.actions.run("follow_player", {
      player: "Steve",
      distance: 3,
    }),
  ).toBe("Following Steve.");
  // Her goal has to survive starting the task (a deferred stop used to wipe it).
  expect(bot.pathfinder.goal).toBeInstanceOf(goals.GoalFollow);
  expect(
    calls.find(
      (c) => c.fn === "setGoal" && c.args[0] instanceof goals.GoalFollow,
    ),
  ).toBeTruthy();

  expect(
    await adapter.actions.run("say_in_chat", { message: "/op Kiri" }),
  ).toBe("Said: op Kiri");
  expect(calls.filter((c) => c.fn === "chat").map((c) => c.args[0])).toEqual([
    "op Kiri",
  ]);
  // The next line waits its turn (two seconds apart) instead of failing; too many at once do fail.
  const started = Date.now();
  const next = adapter.actions.run("say_in_chat", { message: "again" });
  void adapter.actions
    .run("say_in_chat", { message: "and again" })
    .catch(() => {});
  void adapter.actions
    .run("say_in_chat", { message: "once more" })
    .catch(() => {});
  await expect(
    adapter.actions.run("say_in_chat", { message: "too many" }),
  ).rejects.toThrow("Slow down");
  expect(await next).toBe("Said: again");
  expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
  expect(calls.filter((c) => c.fn === "chat").map((c) => c.args[0])).toEqual([
    "op Kiri",
    "again",
  ]);

  await expect(
    adapter.actions.run("attack", { target: "zombie" }),
  ).rejects.toThrow("No hostile zombie");
  await expect(
    adapter.actions.run("collect_block", { block: "oak_log" }),
  ).rejects.toThrow("No oak_log");
  await expect(
    adapter.actions.run("collect_block", { block: "unobtanium" }),
  ).rejects.toThrow("no block called");

  expect(await adapter.actions.run("stop", {})).toContain("Stopped");
  expect(adapter.actions.held).toBe(true);
  expect(adapter.actions.task).toBeNull();
  void bot;
});

test("over MCP: the manifest's tools, her identity, and events as notifications", async () => {
  const { bot, addPlayer, adapter } = setup();
  addPlayer(2, "Steve", new Vec3(4, 64, 0));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-bridge", version: "0" });
  const received: GameEvent[] = [];
  client.setNotificationHandler(
    z.object({
      method: z.literal(EVENT_NOTIFICATION),
      params: gameEventSchema,
    }),
    (n) => void received.push(n.params),
  );
  await adapter.server.connect(serverSide);
  await client.connect(clientSide);

  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual(
    Object.keys(MINECRAFT_MANIFEST.tools).sort(),
  );
  expect(tools.map((t) => t.name)).toContain("craft_item");
  const self = await client.readResource({
    uri: resourceUri("minecraft", "self"),
  });
  const value = JSON.parse((self.contents[0] as { text: string }).text);
  expect(value).toMatchObject({
    name: "Kiri",
    partner: "Steve",
    health: 20,
    position: { x: 0, y: 64, z: 0 },
    held: null,
    task: null,
  });
  const inventory = await client.readResource({
    uri: resourceUri("minecraft", "inventory"),
  });
  expect(JSON.parse((inventory.contents[0] as { text: string }).text)).toEqual({
    dirt: 15,
  });

  const result = await client.callTool({
    name: "follow_player",
    arguments: { player: "Nobody" },
  });
  expect(result.isError).toBe(true);

  bot.emit("chat", "Steve", "hi");
  await Bun.sleep(10);
  expect(received.map((e) => e.kind)).toEqual(["chat"]);
  await client.close();
});

test("run first; hit again while running, she fights back, then goes back to following", async () => {
  const { bot, addPlayer, addEntity, adapter } = setup();
  addPlayer(2, "Steve", new Vec3(4, 64, 0));
  await adapter.actions.run("follow_player", { player: "Steve" });
  const zombie = addEntity(5, {
    type: "hostile",
    name: "zombie",
    position: new Vec3(2, 64, 0),
  });
  const hit = () => {
    bot.health -= 2;
    bot.emit("health");
  };
  hit();
  expect(adapter.actions.task?.tool).toBe("flee");
  hit();
  expect(adapter.actions.task?.tool).toBe("defend");
  expect(adapter.actions.target?.id).toBe(zombie.id);
  hit(); // already fighting: no change
  expect(adapter.actions.task?.tool).toBe("defend");

  zombie.isValid = false; // she won
  await Bun.sleep(250);
  expect(adapter.actions.task?.tool).toBe("follow_player");
  expect(bot.pathfinder.goal).toBeInstanceOf(goals.GoalFollow);
});

test("a spider is fought at once; a creeper is always run from", async () => {
  const { bot, addEntity, adapter } = setup();
  addEntity(6, {
    type: "hostile",
    name: "spider",
    position: new Vec3(1, 64, 1),
  });
  bot.health = 18;
  bot.emit("health");
  expect(adapter.actions.task?.tool).toBe("defend");

  const other = setup();
  other.addEntity(7, {
    type: "hostile",
    name: "creeper",
    position: new Vec3(1, 64, 0),
  });
  other.bot.health = 18;
  other.bot.emit("health");
  expect(other.adapter.actions.task?.tool).toBe("flee");
  other.adapter.close();
});

test("after running she goes back to her task, unless she was stopped", async () => {
  const { bot, addPlayer, addEntity, adapter } = setup();
  addPlayer(2, "Steve", new Vec3(4, 64, 0));
  await adapter.actions.run("follow_player", { player: "Steve" });
  addEntity(5, {
    type: "hostile",
    name: "zombie",
    position: new Vec3(2, 64, 0),
  });
  bot.health = 17;
  bot.emit("health");
  expect(adapter.actions.task?.tool).toBe("flee");
  await Bun.sleep(4_200);
  expect(adapter.actions.task?.tool).toBe("follow_player");

  bot.health = 14;
  bot.emit("health");
  expect(adapter.actions.task?.tool).toBe("flee");
  await adapter.actions.run("stop", {});
  await Bun.sleep(4_200);
  expect(adapter.actions.task).toBeNull();
}, 15_000);

test("crafting: says what's missing, crafts what it can, and needs no table for 2x2 recipes", async () => {
  const { bot, calls, adapter } = setup();
  const items = {
    oak_planks: { id: 10, name: "oak_planks" },
    stick: { id: 11, name: "stick" },
    wooden_axe: { id: 12, name: "wooden_axe" },
    crafting_table: { id: 13, name: "crafting_table" },
  };
  bot.registry.itemsByName = items;
  bot.registry.items = Object.fromEntries(
    Object.values(items).map((i) => [i.id, i]),
  );
  bot.registry.blocksByName.crafting_table = { id: 99, name: "crafting_table" };
  bot.findBlock = () => null;
  let inventory = [{ name: "oak_planks", type: 10, count: 1 }];
  bot.inventory.items = () => inventory;
  const stickRecipe = {
    requiresTable: false,
    result: { id: 11, count: 4 },
    delta: [
      { id: 10, count: -2 },
      { id: 11, count: 4 },
    ],
  };
  bot.recipesAll = () => [stickRecipe];
  bot.recipesFor = (id: number) =>
    id === 11 && inventory[0]!.count >= 2 ? [stickRecipe] : [];
  bot.craft = async (recipe: unknown, times: number) =>
    void calls.push({ fn: "craft", args: [recipe, times] });

  await expect(
    adapter.actions.run("craft_item", { item: "unobtainium" }),
  ).rejects.toThrow("no item called");
  await expect(
    adapter.actions.run("craft_item", { item: "stick", count: 4 }),
  ).rejects.toThrow(
    "Can't make stick yet: missing 1 more oak_planks (needs 2).",
  );
  inventory = [{ name: "oak_planks", type: 10, count: 4 }];
  expect(
    await adapter.actions.run("craft_item", { item: "stick", count: 6 }),
  ).toBe("Made 8 stick.");
  expect(calls.find((c) => c.fn === "craft")?.args[1]).toBe(2);
  expect(adapter.actions.task).toBeNull();

  // A 3x3 recipe with no table nearby and nothing to make one from.
  const axe = {
    requiresTable: true,
    result: { id: 12, count: 1 },
    delta: [
      { id: 10, count: -3 },
      { id: 11, count: -2 },
      { id: 12, count: 1 },
    ],
  };
  bot.recipesFor = (id: number, _m: unknown, _n: unknown, table: unknown) =>
    id === 12 && table ? [axe] : [];
  await expect(
    adapter.actions.run("craft_item", { item: "wooden_axe" }),
  ).rejects.toThrow("I need 4 planks to make one");
});

test("inventory, giving and picking up", async () => {
  const { bot, calls, addPlayer, adapter } = setup();
  bot.inventory.items = () => [
    { name: "oak_log", type: 5, count: 3 },
    { name: "oak_log", type: 5, count: 2 },
  ];
  bot.heldItem = { name: "oak_log" };
  expect(await adapter.actions.run("check_inventory", {})).toBe(
    "Carrying: 5 oak_log. Holding oak_log.",
  );

  addPlayer(2, "Steve", new Vec3(4, 64, 0));
  bot.lookAt = async () => {};
  bot.toss = async (type: number, _m: unknown, count: number) =>
    void calls.push({ fn: "toss", args: [type, count] });
  expect(
    await adapter.actions.run("give_item", {
      item: "oak_log",
      count: 9,
      player: "Steve",
    }),
  ).toBe("Gave Steve 5 oak_log.");
  expect(calls.find((c) => c.fn === "toss")?.args).toEqual([5, 5]);
  await expect(
    adapter.actions.run("give_item", { item: "diamond", player: "Steve" }),
  ).rejects.toThrow("I don't have any diamond");

  await expect(adapter.actions.run("pick_up_items", {})).rejects.toThrow(
    "nothing lying around",
  );
});

test("crafts asked for together run one after another, and any wood will do", async () => {
  const { bot, adapter } = setup();
  const items = {
    oak_planks: { id: 10, name: "oak_planks" },
    cherry_planks: { id: 14, name: "cherry_planks" },
    stick: { id: 11, name: "stick" },
  };
  bot.registry.itemsByName = items;
  bot.registry.items = Object.fromEntries(
    Object.values(items).map((i) => [i.id, i]),
  );
  bot.findBlock = () => null;
  bot.inventory.items = () => [];
  const sticksFrom = (planks: number) => ({
    requiresTable: false,
    result: { id: 11, count: 4 },
    delta: [
      { id: planks, count: -2 },
      { id: 11, count: 4 },
    ],
  });
  bot.recipesAll = () => [sticksFrom(14), sticksFrom(10)];
  bot.recipesFor = () => [];
  await expect(
    adapter.actions.run("craft_item", { item: "stick" }),
  ).rejects.toThrow(
    "Can't make stick yet: missing 2 more planks (any kind) (needs 2).",
  );

  const order: string[] = [];
  bot.recipesFor = () => [sticksFrom(10)];
  bot.craft = async () => {
    order.push("start");
    await Bun.sleep(30);
    order.push("end");
  };
  await Promise.all([
    adapter.actions.run("craft_item", { item: "stick" }),
    adapter.actions.run("craft_item", { item: "stick" }),
    adapter.actions.run("craft_item", { item: "stick" }),
  ]);
  expect(order).toEqual(["start", "end", "start", "end", "start", "end"]);
});

test("armor is worn, a shield goes to her off hand, and she says what she's wearing", async () => {
  const { bot, adapter } = setup();
  const equipped: [string, string][] = [];
  bot.inventory.items = () => [
    { name: "copper_chestplate", type: 1, count: 1 },
    { name: "iron_boots", type: 2, count: 1 },
    { name: "shield", type: 3, count: 1 },
    { name: "stone_pickaxe", type: 4, count: 1 },
  ];
  bot.equip = async (item: { name: string }, slot: string) => {
    equipped.push([item.name, slot]);
    bot.inventory.slots[bot.getEquipmentDestSlot(slot)] = { name: item.name };
  };
  expect(await adapter.actions.run("equip", { item: "copper_chestplate" })).toBe("Wearing the copper_chestplate.");
  expect(await adapter.actions.run("equip", { item: "iron_boots" })).toBe("Wearing the iron_boots.");
  expect(await adapter.actions.run("equip", { item: "shield" })).toBe("The shield is in my off hand.");
  expect(await adapter.actions.run("equip", { item: "stone_pickaxe" })).toBe("Holding the stone_pickaxe.");
  expect(equipped).toEqual([
    ["copper_chestplate", "torso"],
    ["iron_boots", "feet"],
    ["shield", "off-hand"],
    ["stone_pickaxe", "hand"],
  ]);
  expect(await adapter.actions.run("check_inventory", {})).toContain("Wearing copper_chestplate, iron_boots.");
});

test("the clock reads like a player would say it", async () => {
  const { clockText } = await import("./state.ts");
  expect(clockText(8_000, 3)).toBe("Day 4, afternoon, about 3 minutes until sunset");
  expect(clockText(14_000, 3)).toBe("Day 4, night, about 8 minutes until sunrise");
  expect(clockText(23_800, 0)).toBe("Day 1, dawn, about 10 minutes until sunset");
});

test("items a player throws her are a gift; what she finds isn't", async () => {
  const { bot, events, addPlayer, addEntity } = setup({ partner: "Steve" });
  addPlayer(2, "Steve", new Vec3(3, 64, 0));
  const thrown = addEntity(20, { name: "item", type: "object", position: new Vec3(3, 65.3, 0) });
  bot.emit("entitySpawn", thrown);
  const found = addEntity(21, { name: "item", type: "object", position: new Vec3(-10, 64, 0) });
  bot.emit("entitySpawn", found);
  bot.emit("playerCollect", bot.entity, { ...thrown, getDroppedItem: () => ({ name: "iron_boots", count: 1 }) });
  bot.emit("playerCollect", bot.entity, { ...found, getDroppedItem: () => ({ name: "apple", count: 2 }) });
  await Bun.sleep(50);
  expect(events.map(({ kind, lane, subject, summary }) => ({ kind, lane, subject, summary }))).toEqual([
    { kind: "items_received", lane: "respond", subject: "user", summary: "Steve gave Kiri 1 iron boots (threw it to her)." },
    { kind: "item_collected", lane: "silent", subject: "self", summary: "Kiri picked up 2 apple." },
  ]);
});

test("after dying she heads back to the user she was following, or to her things", async () => {
  const { bot, events, addPlayer, adapter } = setup({ partner: "Steve" });
  const steve = addPlayer(2, "Steve", new Vec3(4, 64, 0));
  await adapter.actions.run("follow_player", { player: "Steve" });
  for (let i = 0; i < 10; i++) bot.emit("physicsTick"); // she sees him
  bot.emit("death");
  expect(adapter.actions.task).toBeNull();
  // He's still in sight: straight back to following him.
  bot.emit("spawn");
  await Bun.sleep(1_600);
  expect(adapter.actions.task?.tool).toBe("follow_player");
  expect(events.at(-1)).toMatchObject({ kind: "respawned", summary: "Kiri came back and is heading to Steve." });

  // Out of sight: to where she last saw him.
  bot.emit("death");
  delete bot.players.Steve;
  void steve;
  bot.emit("spawn");
  await Bun.sleep(1_600);
  expect(events.filter((e) => e.kind === "respawned").at(-1)?.summary).toBe(
    "Kiri came back and is heading to where she last saw Steve (4 64 0).",
  );
  // (The fake pathfinder arrives at once, and he isn't there.)
  expect(events.at(-1)?.summary).toBe("Kiri got to where she last saw Steve, but they're not there.");

  // Not following anyone: back to where she died.
  await adapter.actions.run("stop", {});
  await adapter.actions.run("check_inventory", {});
  const other = setup();
  other.bot.entity.position = new Vec3(10, 60, -5);
  other.bot.emit("death");
  other.bot.emit("spawn");
  await Bun.sleep(1_600);
  expect(other.events.filter((e) => e.kind === "respawned").at(-1)?.summary).toBe(
    "Kiri came back and is heading to where she died (10 60 -5) to get her things.",
  );
  other.adapter.close();
}, 10_000);

test("paused, she stays put after dying", async () => {
  const { bot, events, adapter } = setup();
  await adapter.actions.run("stop", { paused: true });
  bot.emit("death");
  bot.emit("spawn");
  await Bun.sleep(1_600);
  expect(adapter.actions.task).toBeNull();
  expect(events.at(-1)?.summary).toBe("Kiri came back after dying and is staying put: she's paused.");
});

test("told to stay, she still runs from danger, and dying lets her go", async () => {
  const { bot, events, calls, addEntity, adapter } = setup();
  await adapter.actions.run("stop", {});
  expect(adapter.actions.held).toBe(true);
  expect(adapter.actions.paused).toBe(false);
  addEntity(5, { type: "hostile", name: "zombie", position: new Vec3(2, 64, 0) });
  bot.health = 5;
  bot.emit("health");
  expect(adapter.actions.task?.tool).toBe("flee");
  expect(adapter.actions.held).toBe(true); // a reflex keeps the hold

  calls.length = 0;
  bot.emit("death");
  expect(adapter.actions.held).toBe(false);
  bot.emit("spawn");
  await Bun.sleep(1_600);
  expect(events.find((e) => e.kind === "respawned")?.summary).toContain("came back and is heading to where she died");
});

test("she remembers a place where the user stands", async () => {
  const { events, addPlayer, adapter } = setup({ partner: "Steve" });
  addPlayer(2, "Steve", new Vec3(120.6, 64, -40.2));
  expect(await adapter.actions.run("remember_place", { name: "base", at: "user" })).toBe("Remembered base at 120 64 -41.");
  expect(events.at(-1)).toMatchObject({ kind: "place_marked", data: { name: "base", x: 120, y: 64, z: -41 } });
});

test("following but not getting anywhere, she says she's stuck and stops", async () => {
  const { events, addPlayer, adapter } = setup({ partner: "Steve" });
  addPlayer(2, "Steve", new Vec3(40, 64, 0));
  expect(await adapter.actions.run("follow_player", { player: "Steve", distance: 3 })).toBe("Following Steve.");
  await Bun.sleep(9_200);
  expect(events.at(-1)).toMatchObject({ kind: "stuck", lane: "respond", data: { task: "follow_player" } });
  expect(adapter.actions.task).toBeNull();
}, 15_000);
