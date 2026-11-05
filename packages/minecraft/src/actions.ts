import type { RaisedEvent } from "@swarmfu/connect-protocol/adapter";
import type { Bot } from "mineflayer";
import type {} from "mineflayer-collectblock";
import pathfinderPkg from "mineflayer-pathfinder";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import { distanceTo, isDroppedItem, isHostile, nearestHostile } from "./state.ts";

const { Movements, goals } = pathfinderPkg;

/**
 * Her actions in the world: the v1 tools. One task at a time: a new one
 * cancels the last. Long tasks (walking somewhere, collecting) answer at
 * once and report how they ended as a task_finished event. `stop` holds her
 * in place: told to stay, she still fights back or runs, and dying lets her
 * go; paused (the bridge's pause), her reflexes leave her be as well.
 */

const ATTACK_RANGE = 3.2;
const ATTACK_COOLDOWN_MS = 600;
const ATTACK_GIVE_UP_MS = 30_000;
const FLEE_MS = 4_000;
/** A fight she didn't pick ends when the mob dies, runs off this far, or after this long. */
const DEFEND_GIVE_UP_MS = 15_000;
const DEFEND_RANGE = 16;
/** Tasks a reflex comes back to once the danger's over. */
const RESUMABLE = new Set(["follow_player", "go_to", "collect_block"]);
const REFLEXES = new Set(["flee", "defend", "surface", "escape_heat"]);
/** How often a walk is checked for progress, and how long without any counts as stuck. */
const STUCK_CHECK_MS = 1_000;
const STUCK_AFTER_MS = 8_000;
/** Common blocks she may pillar up on to climb out of a hole: hers, from her inventory. */
const CLIMB_BLOCKS = ["cobblestone", "cobbled_deepslate", "dirt", "netherrack", "andesite", "diorite", "granite", "tuff"];
/** Air left (of 20) when she gives up on what she's doing and swims for the surface. */
export const LOW_AIR = 12;
const SURFACE_MS = 8_000;
const ESCAPE_HEAT_MS = 5_000;
const CHAT_GAP_MS = 2_000;
const MAX_CHAT_WAITING = 3;

export interface Task {
  tool: string;
  args: Record<string, unknown>;
  startedAt: number;
}

export interface ActionsOptions {
  emit(event: RaisedEvent): void;
  /** The user's player name, for places marked where they stand. */
  partner?(): string | undefined;
  /** Blocks she placed, as "x,y,z"; the watcher reports it when someone breaks them. */
  placed: Set<string>;
}

/** How she gets around: never digging through or building over the world, since those could be the user's blocks. */
export function walkingMovements(bot: Bot): InstanceType<typeof Movements> {
  const movements = new Movements(bot);
  movements.canDig = false;
  movements.scafoldingBlocks = [];
  movements.allow1by1towers = false;
  return movements;
}

/** Walking, and when that's not enough, pillaring up on her own common blocks. Still never digging. */
export function climbingMovements(bot: Bot): InstanceType<typeof Movements> {
  const movements = walkingMovements(bot);
  movements.allow1by1towers = true;
  movements.scafoldingBlocks = CLIMB_BLOCKS.flatMap((name) => bot.registry.itemsByName[name]?.id ?? []);
  return movements;
}

/**
 * Her movement rules, for walking and for collecting. Collecting needs its
 * own copy: the collect-block plugin otherwise puts default movements on the
 * pathfinder, which dig through and build over anything in the way.
 */
export function setupMovements(bot: Bot): void {
  const movements = walkingMovements(bot);
  bot.pathfinder.setMovements(movements);
  if (bot.collectBlock) bot.collectBlock.movements = movements;
}

type Slot = "hand" | "head" | "torso" | "legs" | "feet" | "off-hand";
const WORN = ["head", "torso", "legs", "feet"] as const;

/** Where an item goes when she equips it. */
export function equipSlot(name: string): Slot {
  if (/_helmet$|^turtle_helmet$|^carved_pumpkin$|_head$|_skull$/.test(name)) return "head";
  if (/_chestplate$|^elytra$/.test(name)) return "torso";
  if (/_leggings$/.test(name)) return "legs";
  if (/_boots$/.test(name)) return "feet";
  if (name === "shield" || name === "totem_of_undying") return "off-hand";
  return "hand";
}

const PICK_UP_RANGE = 24;


export const blockKey = (p: { x: number; y: number; z: number }) =>
  `${p.x},${p.y},${p.z}`;

export class Actions {
  readonly #bot: Bot;
  readonly #options: ActionsOptions;
  #task: Task | null = null;
  /** Ends whatever loop the current task runs (attacking, fleeing). */
  #cancelLoop: (() => void) | null = null;
  /** Held in place: told to stay (`stop`), or paused from the app. */
  #held: false | "stay" | "paused" = false;
  /** What a reflex interrupted, to go back to when it's over. */
  #resume: Task | null = null;
  #lastChat = 0;
  #chatQueue: Promise<unknown> = Promise.resolve();
  #chatWaiting = 0;
  /** Inventory and crafting-window work, one at a time: two crafts at once fight over the window. */
  #busy: Promise<unknown> = Promise.resolve();
  /** The entity she's fighting, so the watcher can credit her with the kill. */
  target: Entity | null = null;

  constructor(bot: Bot, options: ActionsOptions) {
    this.#bot = bot;
    this.#options = options;
  }

  get task(): Task | null {
    return this.#task;
  }

  /** Held by `stop`: she stays where she is, and isn't taken back to what she was doing. */
  get held(): boolean {
    return this.#held !== false;
  }

  /** Paused from the app: her reflexes leave her be too. */
  get paused(): boolean {
    return this.#held === "paused";
  }

  async run(tool: string, args: Record<string, unknown>): Promise<string> {
    switch (tool) {
      case "follow_player":
        return this.#follow(String(args.player), Number(args.distance ?? 3));
      case "go_to":
        return this.#goTo(Number(args.x), Number(args.y), Number(args.z));
      case "collect_block":
        return this.#collect(String(args.block), Number(args.count ?? 8));
      case "attack":
        return this.#attack(String(args.target));
      case "flee":
        return this.flee() ?? "Nothing nearby to run from.";
      case "place_block":
        return this.#oneAtATime(() => this.#place(
          String(args.block),
          Number(args.x),
          Number(args.y),
          Number(args.z),
        ));
      case "break_block":
        return this.#oneAtATime(() => this.#break(Number(args.x), Number(args.y), Number(args.z)));
      case "equip":
        return this.#oneAtATime(() => this.#equip(String(args.item)));
      case "say_in_chat":
        return this.#say(String(args.message));
      case "craft_item":
        return this.#oneAtATime(() => this.#craft(String(args.item), Number(args.count ?? 1)));
      case "pick_up_items":
        return this.#pickUp();
      case "give_item":
        return this.#oneAtATime(() => this.#give(String(args.item), Number(args.count ?? 1), String(args.player)));
      case "check_inventory":
        return this.#inventory();
      case "remember_place":
        return this.#rememberPlace(String(args.name), args.at === "me" ? "me" : "user");
      case "stop":
        this.#cancel();
        this.#resume = null;
        this.#held = args.paused === true ? "paused" : "stay";
        return "Stopped. Staying right here.";
      default:
        throw new Error(`Unknown tool: ${tool}`);
    }
  }

  /** She died: whatever she was doing stops, and being told to stay ends with it (a pause doesn't). Returns what that was. */
  died(): Task | null {
    const task = this.#task && REFLEXES.has(this.#task.tool) ? this.#resume : this.#task;
    this.#cancel();
    this.#resume = null;
    if (this.#held === "stay") this.#held = false;
    return task;
  }

  /**
   * After she comes back, what a player would do: back to the user if she
   * was with them (to where she last saw them, if they're out of sight),
   * otherwise back to where she died to pick up her things. Returns what
   * she's doing, or null when she's held (paused).
   */
  recover(r: { diedAt: Vec3; following: string | null; lastSeen: Vec3 | null }): string | null {
    if (this.#held) return null;
    const me = this.#bot.username;
    const at = (p: Vec3) => `${Math.round(p.x)} ${Math.round(p.y)} ${Math.round(p.z)}`;
    if (r.following) {
      if (this.#bot.players[r.following]?.entity) {
        this.#follow(r.following, 3);
        return `${me} came back and is heading to ${r.following}.`;
      }
      if (r.lastSeen) {
        const target = r.lastSeen;
        this.#start("go_to", { x: Math.round(target.x), y: Math.round(target.y), z: Math.round(target.z) });
        const task = this.#task!;
        const player = r.following;
        this.#bot.pathfinder
          .goto(new goals.GoalNear(target.x, target.y, target.z, 3))
          .then(() => {
            if (this.#task !== task) return;
            if (this.#bot.players[player]?.entity) this.#follow(player, 3);
            else this.#finished(task, "failed", `${me} got to where she last saw ${player}, but they're not there.`);
          })
          .catch((error: unknown) => this.#finished(task, "failed", `${me} couldn't get back to ${player}: ${message(error)}`));
        return `${me} came back and is heading to where she last saw ${r.following} (${at(target)}).`;
      }
    }
    const spot = r.diedAt;
    this.#start("go_to", { x: Math.round(spot.x), y: Math.round(spot.y), z: Math.round(spot.z) });
    const task = this.#task!;
    this.#bot.pathfinder
      .goto(new goals.GoalNear(spot.x, spot.y, spot.z, 1))
      .then(() => {
        if (this.#task !== task) return;
        this.#task = null;
        try {
          this.#pickUp();
        } catch {
          this.#options.emit({
            kind: "task_finished",
            lane: "silent",
            subject: "self",
            summary: `${me} got back to where she died, but her things are gone.`,
            data: { task: "recover", outcome: "failed" },
          });
        }
      })
      .catch((error: unknown) => this.#finished(task, "failed", `${me} couldn't get back to where she died: ${message(error)}`));
    return `${me} came back and is heading to where she died (${at(spot)}) to get her things.`;
  }

  /** Waits its turn behind any inventory work already running, so calls made together run in order. */
  #oneAtATime<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#busy.then(work, work);
    this.#busy = run.catch(() => {});
    return run;
  }

  /** Runs from the nearest hostile mob for a few seconds. A reflex too, unless she's held. */
  flee(): string | null {
    const threat = nearestHostile(this.#bot, 16);
    if (!threat) return null;
    this.#startReflex("flee", {});
    this.#bot.pathfinder.setGoal(
      new goals.GoalInvert(new goals.GoalFollow(threat, 12)),
      true,
    );
    const timer = setTimeout(() => this.#reflexOver(), FLEE_MS);
    this.#cancelLoop = () => clearTimeout(timer);
    return `Running from the ${threat.name ?? "mob"}.`;
  }

  /** Turns on a mob that's hurting her when running doesn't work. A reflex, like fleeing. */
  fight(entity: Entity): string {
    this.#startReflex("defend", { target: entity.name });
    this.#swingAt(entity, DEFEND_GIVE_UP_MS, () => this.#reflexOver());
    return `Fighting the ${entity.name ?? "mob"}.`;
  }

  /** An order (or a new task): replaces whatever she was doing, reflexes included. */
  #start(tool: string, args: Record<string, unknown>): void {
    this.#cancel();
    this.#resume = null;
    this.#held = false;
    this.#task = { tool, args, startedAt: Date.now() };
  }

  /** A reflex: remembers the task it interrupts (or the one an earlier reflex did), and keeps her held if she was. */
  #startReflex(tool: string, args: Record<string, unknown>): void {
    const current = this.#task;
    const resume = current && REFLEXES.has(current.tool) ? this.#resume : current && RESUMABLE.has(current.tool) ? current : null;
    const held = this.#held;
    this.#start(tool, args);
    this.#resume = resume;
    this.#held = held;
  }

  /** The danger's over: back to what she was doing, if anything. */
  #reflexOver(): void {
    this.#finishLoop();
    const resume = this.#resume;
    this.#resume = null;
    if (!resume || this.#held) return;
    this.run(resume.tool, resume.args).catch((error: unknown) =>
      this.#options.emit({
        kind: "task_finished",
        lane: "silent",
        subject: "self",
        summary: `${this.#bot.username} couldn't go back to ${resume.tool.replace(/_/g, " ")}: ${message(error)}`,
        data: { task: resume.tool, outcome: "failed" },
      }),
    );
  }

  #cancel(): void {
    this.#cancelLoop?.();
    this.#cancelLoop = null;
    this.target = null;
    this.#task = null;
    // setGoal(null) halts her at once. Not pathfinder.stop(): that only flags a stop for the
    // next path reset, which the next task's setGoal is, so it would wipe the new goal.
    this.#bot.pathfinder.setGoal(null);
    void this.#bot.collectBlock?.cancelTask().catch(() => {});
    this.#bot.clearControlStates();
  }

  #finishLoop(): void {
    const cleanUp = this.#cancelLoop;
    this.#cancelLoop = null;
    cleanUp?.();
    this.#task = null;
    this.target = null;
    this.#bot.pathfinder.setGoal(null);
  }

  /** Reports how a long task ended, if it's still the current one. */
  #finished(task: Task, outcome: "done" | "failed", summary: string): void {
    if (this.#task !== task) return; // replaced or stopped: nothing to report
    this.#task = null;
    this.#options.emit({
      kind: "task_finished",
      lane: "silent",
      subject: "self",
      summary,
      data: { task: task.tool, outcome },
    });
  }

  /**
   * Watches a walk for progress. Stuck, she tries again allowed to pillar up
   * on her own blocks; still stuck, she says so (a "stuck" event) and stops.
   */
  #watchProgress(task: Task, where: string, target: () => Vec3 | null, range: number): void {
    let last = this.#bot.entity.position.clone();
    let still = 0;
    let climbing = false;
    const timer = setInterval(() => {
      if (this.#task !== task) return done();
      const goal = target();
      const at = this.#bot.entity.position;
      if (!goal || at.distanceTo(goal) <= range + 2 || at.distanceTo(last) > 1) {
        still = 0;
        last = at.clone();
        return;
      }
      still += STUCK_CHECK_MS;
      if (still < STUCK_AFTER_MS) return;
      still = 0;
      if (!climbing) {
        climbing = this.#useMovements(climbingMovements);
        if (climbing) return;
      }
      done();
      this.#cancel();
      this.#options.emit({
        kind: "stuck",
        lane: "respond",
        subject: "self",
        summary: `${this.#bot.username} is stuck: she can't find a way to ${where} without digging, so she stopped. She needs a hand or a way out.`,
        data: { task: task.tool, x: Math.round(at.x), y: Math.round(at.y), z: Math.round(at.z) },
      });
    }, STUCK_CHECK_MS);
    const done = () => {
      clearInterval(timer);
      if (climbing) this.#useMovements(walkingMovements);
      climbing = false;
    };
    this.#cancelLoop = done;
  }

  /** Puts movement rules on the pathfinder (which re-plans with them). False without game data, as in tests. */
  #useMovements(make: (bot: Bot) => InstanceType<typeof Movements>): boolean {
    try {
      this.#bot.pathfinder.setMovements(make(this.#bot));
      return true;
    } catch {
      return false;
    }
  }

  /** Out of air under water: swims up and makes for the nearest dry footing. A reflex. */
  surface(): string {
    this.#startReflex("surface", {});
    this.#bot.setControlState("jump", true);
    const land = this.#bot.findBlock({
      matching: (b) => b.boundingBox === "block" && !/ice$/.test(b.name),
      maxDistance: 8,
      useExtraInfo: (b) => this.#isOpen(b.position.offset(0, 1, 0)) && this.#isOpen(b.position.offset(0, 2, 0)),
    });
    if (land) this.#bot.pathfinder.setGoal(new goals.GoalBlock(land.position.x, land.position.y + 1, land.position.z));
    const timer = setTimeout(() => this.#reflexOver(), SURFACE_MS);
    this.#cancelLoop = () => {
      clearTimeout(timer);
      this.#bot.setControlState("jump", false);
    };
    return "Swimming up for air.";
  }

  /** In lava or fire: jumps and makes for the nearest safe footing. A reflex. */
  escapeHeat(): string {
    this.#startReflex("escape_heat", {});
    this.#bot.setControlState("jump", true);
    const safe = this.#bot.findBlock({
      matching: (b) => b.boundingBox === "block" && !/lava|fire|magma/.test(b.name),
      maxDistance: 6,
      useExtraInfo: (b) => {
        const above = this.#bot.blockAt(b.position.offset(0, 1, 0))?.name ?? "";
        return (above === "air" || above === "cave_air") && this.#isOpen(b.position.offset(0, 2, 0));
      },
    });
    if (safe) this.#bot.pathfinder.setGoal(new goals.GoalBlock(safe.position.x, safe.position.y + 1, safe.position.z));
    const timer = setTimeout(() => this.#reflexOver(), ESCAPE_HEAT_MS);
    this.#cancelLoop = () => {
      clearTimeout(timer);
      this.#bot.setControlState("jump", false);
    };
    return "Getting out of the heat.";
  }

  #isOpen(at: Vec3): boolean {
    const name = this.#bot.blockAt(at)?.name ?? "";
    return name === "air" || name === "cave_air" || name === "water";
  }

  #playerEntity(name: string): Entity {
    const entity = this.#bot.players[name]?.entity;
    if (!entity) throw new Error(`I can't see ${name} from here.`);
    return entity;
  }

  #follow(player: string, distance: number): string {
    const entity = this.#playerEntity(player);
    this.#start("follow_player", { player, distance });
    this.#bot.pathfinder.setGoal(new goals.GoalFollow(entity, distance), true);
    this.#watchProgress(this.#task!, player, () => this.#bot.players[player]?.entity?.position ?? null, distance);
    return `Following ${player}.`;
  }

  #goTo(x: number, y: number, z: number): string {
    this.#start("go_to", { x, y, z });
    const task = this.#task!;
    this.#watchProgress(task, `${x} ${y} ${z}`, () => new Vec3(x, y, z), 1);
    this.#bot.pathfinder
      .goto(new goals.GoalNear(x, y, z, 1))
      .then(() =>
        this.#finished(
          task,
          "done",
          `${this.#bot.username} got to ${x} ${y} ${z}.`,
        ),
      )
      .catch((error: unknown) =>
        this.#finished(
          task,
          "failed",
          `${this.#bot.username} couldn't get to ${x} ${y} ${z}: ${message(error)}`,
        ),
      );
    return `On my way to ${x} ${y} ${z}.`;
  }

  #collect(block: string, count: number): string {
    const type = this.#bot.registry.blocksByName[block];
    if (!type) throw new Error(`There's no block called ${block}.`);
    const found = this.#bot.findBlocks({
      matching: type.id,
      maxDistance: 32,
      count,
    });
    const targets = found
      .map((p) => this.#bot.blockAt(p))
      .filter((b) => b !== null);
    if (!targets.length) throw new Error(`No ${block} within 32 blocks.`);
    this.#start("collect_block", { block, count });
    const task = this.#task!;
    this.#bot.collectBlock
      .collect(targets)
      .then(() =>
        this.#finished(
          task,
          "done",
          `${this.#bot.username} collected ${targets.length} ${block}.`,
        ),
      )
      .catch((error: unknown) =>
        this.#finished(
          task,
          "failed",
          `${this.#bot.username} stopped collecting ${block}: ${message(error)}`,
        ),
      );
    return `Collecting ${targets.length} ${block}.`;
  }

  #attack(target: string): string {
    const entity = Object.values(this.#bot.entities)
      .filter(
        (e) =>
          e.name === target &&
          e.type !== "player" &&
          isHostile(e) &&
          distanceTo(this.#bot, e) <= 16,
      )
      .sort((a, b) => distanceTo(this.#bot, a) - distanceTo(this.#bot, b))[0];
    if (!entity) throw new Error(`No hostile ${target} within 16 blocks.`);
    this.#start("attack", { target });
    const task = this.#task!;
    this.#swingAt(entity, ATTACK_GIVE_UP_MS, (outcome) =>
      this.#finished(
        task,
        outcome,
        outcome === "done"
          ? `${this.#bot.username} beat the ${target}.`
          : `${this.#bot.username} gave up on the ${target}.`,
      ),
    );
    return `Going after the ${target}.`;
  }

  /** Chases an entity and hits it until it's dead ("done"), or gone or too long ("failed"). */
  #swingAt(entity: Entity, giveUpMs: number, end: (outcome: "done" | "failed") => void): void {
    this.target = entity;
    this.#bot.pathfinder.setGoal(new goals.GoalFollow(entity, 2), true);
    let lastSwing = 0;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const gone = !entity.isValid;
      const over = gone || Date.now() - startedAt > giveUpMs || distanceTo(this.#bot, entity) > DEFEND_RANGE;
      if (over) {
        clearInterval(timer);
        this.#cancelLoop = null;
        this.target = null;
        this.#bot.pathfinder.setGoal(null);
        end(gone ? "done" : "failed");
        return;
      }
      if (distanceTo(this.#bot, entity) <= ATTACK_RANGE && Date.now() - lastSwing >= ATTACK_COOLDOWN_MS) {
        lastSwing = Date.now();
        this.#bot.attack(entity);
      }
    }, 100);
    this.#cancelLoop = () => clearInterval(timer);
  }

  async #place(
    block: string,
    x: number,
    y: number,
    z: number,
  ): Promise<string> {
    const item = this.#bot.inventory.items().find((i) => i.name === block);
    if (!item) throw new Error(`I don't have any ${block}.`);
    const at = new Vec3(x, y, z);
    if (this.#bot.blockAt(at)?.boundingBox !== "empty")
      throw new Error(`Something's already at ${x} ${y} ${z}.`);
    // Place against any solid neighbour.
    const faces = [
      new Vec3(0, -1, 0),
      new Vec3(0, 1, 0),
      new Vec3(1, 0, 0),
      new Vec3(-1, 0, 0),
      new Vec3(0, 0, 1),
      new Vec3(0, 0, -1),
    ];
    const face = faces.find(
      (f) => this.#bot.blockAt(at.plus(f))?.boundingBox === "block",
    );
    if (!face)
      throw new Error(`There's nothing to place it against at ${x} ${y} ${z}.`);
    this.#start("place_block", { block, x, y, z });
    const task = this.#task!;
    await this.#bot.pathfinder.goto(new goals.GoalNear(x, y, z, 3));
    await this.#bot.equip(item, "hand");
    await this.#bot.placeBlock(
      this.#bot.blockAt(at.plus(face))!,
      face.scaled(-1),
    );
    this.#options.placed.add(blockKey(at));
    if (this.#task === task) this.#task = null;
    return `Placed ${block} at ${x} ${y} ${z}.`;
  }

  async #break(x: number, y: number, z: number): Promise<string> {
    const block = this.#bot.blockAt(new Vec3(x, y, z));
    if (!block || block.boundingBox === "empty")
      throw new Error(`There's nothing at ${x} ${y} ${z}.`);
    this.#start("break_block", { x, y, z });
    const task = this.#task!;
    await this.#bot.pathfinder.goto(new goals.GoalNear(x, y, z, 3));
    await this.#bot.dig(block);
    this.#options.placed.delete(blockKey(block.position));
    if (this.#task === task) this.#task = null;
    return `Broke the ${block.name} at ${x} ${y} ${z}.`;
  }

  /**
   * Crafts with what she carries. A recipe that needs a table uses one within
   * 32 blocks, or sets down the one she carries. When she can't, the answer
   * says exactly what's missing, so the model can make it first or ask.
   */
  async #craft(name: string, count: number): Promise<string> {
    const item = this.#bot.registry.itemsByName[name];
    if (!item) throw new Error(`There's no item called ${name}.`);
    const tableId = this.#bot.registry.blocksByName.crafting_table?.id;
    let table = tableId === undefined ? null : this.#bot.findBlock({ matching: tableId, maxDistance: 32 });
    const recipe =
      this.#bot.recipesFor(item.id, null, 1, null)[0] ??
      this.#bot.recipesFor(item.id, null, 1, table ?? true)[0];
    if (!recipe) throw new Error(this.#missingFor(name, item.id));
    if (recipe.requiresTable && !table) table = await this.#setDownTable();
    this.#start("craft_item", { item: name, count });
    const task = this.#task!;
    try {
      if (recipe.requiresTable && table) await this.#bot.pathfinder.goto(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2));
      const times = Math.ceil(count / recipe.result.count);
      await this.#bot.craft(recipe, times, recipe.requiresTable ? (table ?? undefined) : undefined);
      return `Made ${times * recipe.result.count} ${name}.`;
    } finally {
      if (this.#task === task) this.#task = null;
    }
  }

  /** What's missing for the closest recipe (any planks will do, so several may fit). */
  #missingFor(name: string, itemId: number): string {
    const recipes = this.#bot.recipesAll(itemId, null, true);
    if (!recipes.length) return `There's no crafting recipe for ${name} (it may need a furnace or another station).`;
    const have = new Map<number, number>();
    for (const i of this.#bot.inventory.items()) have.set(i.type, (have.get(i.type) ?? 0) + i.count);
    const shortfalls = recipes.map((r) =>
      r.delta
        .filter((d) => d.count < 0)
        .map((d) => ({ id: d.id, need: -d.count, short: Math.max(0, -d.count - (have.get(d.id) ?? 0)) }))
        .filter((d) => d.short > 0),
    );
    const total = (list: { short: number }[]) => list.reduce((n, d) => n + d.short, 0);
    shortfalls.sort((a, b) => total(a) - total(b));
    const best = shortfalls[0] ?? [];
    const label = (id: number) => this.#bot.registry.items[id]?.name ?? `item ${id}`;
    // Equally close recipes that differ only in the kind of wood: any of it will do, so say so.
    const tied = shortfalls.filter((list) => total(list) === total(best));
    const kind = (name: string) => name.slice(name.indexOf("_") + 1);
    const described = (id: number) => {
      const own = label(id);
      const variants = new Set(tied.flatMap((list) => list.map((d) => label(d.id)).filter((n) => kind(n) === kind(own))));
      return variants.size > 1 ? `${kind(own)} (any kind)` : own;
    };
    const list = best.map((d) => `${d.short} more ${described(d.id)} (needs ${d.need})`).join(", ");
    return list ? `Can't make ${name} yet: missing ${list}.` : `Can't make ${name} right now.`;
  }

  /** Sets her crafting table down beside her, or makes one first from 4 planks. */
  async #setDownTable(): Promise<NonNullable<ReturnType<Bot["blockAt"]>>> {
    let tableItem = this.#bot.inventory.items().find((i) => i.name === "crafting_table");
    if (!tableItem) {
      const id = this.#bot.registry.itemsByName.crafting_table!.id;
      const recipe = this.#bot.recipesFor(id, null, 1, null)[0];
      if (!recipe) throw new Error("That needs a crafting table, and there's none nearby: I need 4 planks to make one.");
      await this.#bot.craft(recipe, 1);
      tableItem = this.#bot.inventory.items().find((i) => i.name === "crafting_table");
      if (!tableItem) throw new Error("I couldn't make a crafting table.");
    }
    const here = this.#bot.entity.position.floored();
    const spots = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)].map((d) => here.plus(d));
    const spot = spots.find(
      (p) => this.#bot.blockAt(p)?.boundingBox === "empty" && this.#bot.blockAt(p.offset(0, -1, 0))?.boundingBox === "block",
    );
    if (!spot) throw new Error("There's no room here to set a crafting table down.");
    await this.#bot.equip(tableItem, "hand");
    await this.#bot.placeBlock(this.#bot.blockAt(spot.offset(0, -1, 0))!, new Vec3(0, 1, 0));
    this.#options.placed.add(blockKey(spot));
    const placed = this.#bot.blockAt(spot);
    if (!placed || placed.name !== "crafting_table") throw new Error("I couldn't set the crafting table down.");
    return placed;
  }

  /** Picks up items lying within 16 blocks, nearest first, for up to 20 seconds. */
  #pickUp(): string {
    const drops = () =>
      Object.values(this.#bot.entities)
        .filter((e) => isDroppedItem(e) && e.isValid && distanceTo(this.#bot, e) <= PICK_UP_RANGE)
        .sort((a, b) => distanceTo(this.#bot, a) - distanceTo(this.#bot, b));
    const found = drops();
    if (!found.length) throw new Error(`There's nothing lying around within ${PICK_UP_RANGE} blocks to pick up.`);
    this.#start("pick_up_items", {});
    const task = this.#task!;
    const deadline = Date.now() + 20_000;
    void (async () => {
      let picked = 0;
      for (;;) {
        const next = drops()[0];
        if (!next || Date.now() > deadline || this.#task !== task) break;
        await this.#bot.pathfinder.goto(new goals.GoalNear(next.position.x, next.position.y, next.position.z, 0.5)).catch(() => {});
        await new Promise((r) => setTimeout(r, 300));
        if (!next.isValid) picked++;
      }
      this.#finished(task, "done", `${this.#bot.username} picked up ${picked === 1 ? "an item" : `${picked} items`}.`);
    })();
    return `Picking up ${found.length === 1 ? "the item" : `${found.length} items`} nearby.`;
  }

  async #give(name: string, count: number, player: string): Promise<string> {
    const item = this.#bot.inventory.items().find((i) => i.name === name);
    if (!item) throw new Error(`I don't have any ${name}.`);
    const entity = this.#playerEntity(player);
    this.#start("give_item", { item: name, count, player });
    const task = this.#task!;
    try {
      await this.#bot.pathfinder.goto(new goals.GoalFollow(entity, 2));
      await this.#bot.lookAt(entity.position.offset(0, 1.6, 0), true);
      const have = this.#bot.inventory.items().filter((i) => i.name === name).reduce((n, i) => n + i.count, 0);
      const amount = Math.min(count, have);
      await this.#bot.toss(item.type, null, amount);
      return `Gave ${player} ${amount} ${name}.`;
    } finally {
      if (this.#task === task) this.#task = null;
    }
  }

  /** Where the user is standing (or she is), told to the backend to keep for this world. */
  #rememberPlace(name: string, at: "user" | "me"): string {
    const partner = this.#options.partner?.();
    const user = partner ? this.#bot.players[partner]?.entity : undefined;
    const spot = (at === "user" && user ? user.position : this.#bot.entity.position).floored();
    const label = name.trim().slice(0, 40);
    this.#options.emit({
      kind: "place_marked",
      lane: "silent",
      subject: "self",
      summary: `${this.#bot.username} will remember ${label} at ${spot.x} ${spot.y} ${spot.z}.`,
      data: { name: label, x: spot.x, y: spot.y, z: spot.z },
    });
    return `Remembered ${label} at ${spot.x} ${spot.y} ${spot.z}${at === "user" && !user ? " (where I am: I can't see them)" : ""}.`;
  }

  #inventory(): string {
    const counts = new Map<string, number>();
    for (const i of this.#bot.inventory.items()) counts.set(i.name, (counts.get(i.name) ?? 0) + i.count);
    const held = this.#bot.heldItem?.name;
    const wearing = WORN.map((slot) => this.#bot.inventory.slots[this.#bot.getEquipmentDestSlot(slot)]?.name).filter(Boolean);
    const parts = [
      counts.size ? `Carrying: ${[...counts].map(([n, c]) => `${c} ${n}`).join(", ")}.` : "Carrying nothing.",
      ...(held ? [`Holding ${held}.`] : []),
      ...(wearing.length ? [`Wearing ${wearing.join(", ")}.`] : []),
    ];
    return parts.join(" ");
  }

  /** Armor goes on, a shield or totem to her off hand, anything else in her hand. */
  async #equip(name: string): Promise<string> {
    const item = this.#bot.inventory.items().find((i) => i.name === name);
    if (!item) throw new Error(`I don't have a ${name}.`);
    const slot = equipSlot(name);
    await this.#bot.equip(item, slot);
    return slot === "hand" ? `Holding the ${name}.` : slot === "off-hand" ? `The ${name} is in my off hand.` : `Wearing the ${name}.`;
  }

  /** Chat lines wait their turn (one every two seconds) rather than fail; a few at most. */
  async #say(text: string): Promise<string> {
    // One line of chat, never a command: a leading "/" would run it with her permissions.
    const line = text
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^\/+/, "")
      .slice(0, 200);
    if (!line) throw new Error("Nothing to say.");
    if (this.#chatWaiting >= MAX_CHAT_WAITING) throw new Error("Slow down: too many chat lines at once.");
    this.#chatWaiting++;
    const turn = this.#chatQueue.then(async () => {
      const wait = this.#lastChat + CHAT_GAP_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.#lastChat = Date.now();
      this.#bot.chat(line);
    });
    this.#chatQueue = turn.catch(() => {});
    try {
      await turn;
    } finally {
      this.#chatWaiting--;
    }
    return `Said: ${line}`;
  }
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
