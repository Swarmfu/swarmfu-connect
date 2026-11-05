import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";

/**
 * What she can read about the game: the values behind the adapter's
 * resources, and the small helpers the event watcher and tools share.
 */

/** Hostile by category in newer game data; the names cover versions that don't say. */
const HOSTILE_NAMES = new Set([
  "zombie",
  "husk",
  "drowned",
  "zombie_villager",
  "skeleton",
  "stray",
  "bogged",
  "wither_skeleton",
  "creeper",
  "spider",
  "cave_spider",
  "enderman",
  "witch",
  "slime",
  "magma_cube",
  "phantom",
  "blaze",
  "ghast",
  "pillager",
  "vindicator",
  "evoker",
  "ravager",
  "vex",
  "guardian",
  "elder_guardian",
  "silverfish",
  "endermite",
  "shulker",
  "hoglin",
  "zoglin",
  "piglin_brute",
  "warden",
  "breeze",
  "creaking",
  "ender_dragon",
  "wither",
]);

export function isHostile(entity: Entity): boolean {
  return entity.type === "hostile" || HOSTILE_NAMES.has(entity.name ?? "");
}

export function distanceTo(bot: Bot, entity: Entity): number {
  return bot.entity.position.distanceTo(entity.position);
}

/** Other entities within `range`, nearest first. */
export function nearbyEntities(bot: Bot, range: number): Entity[] {
  return Object.values(bot.entities)
    .filter(
      (e) => e !== bot.entity && e.position && distanceTo(bot, e) <= range,
    )
    .sort((a, b) => distanceTo(bot, a) - distanceTo(bot, b));
}

export function nearestHostile(bot: Bot, range: number): Entity | null {
  return nearbyEntities(bot, range).find(isHostile) ?? null;
}

/** The player she plays with: the one named on the command line, else the only other player online. */
export function partnerName(bot: Bot, configured?: string): string | undefined {
  if (configured) return configured;
  const others = Object.keys(bot.players).filter(
    (name) => name !== bot.username,
  );
  return others.length === 1 ? others[0] : undefined;
}

export type DayPhase = "dawn" | "day" | "dusk" | "night";

/** Ticks since sunrise (0–24000) to the part of the day a player would name. */
export function dayPhase(timeOfDay: number): DayPhase {
  const t = ((timeOfDay % 24_000) + 24_000) % 24_000;
  if (t < 1_000) return "dawn";
  if (t < 12_000) return "day";
  if (t < 13_000) return "dusk";
  if (t < 23_000) return "night";
  return "dawn";
}

const round = (n: number) => Math.round(n);
export const position = (bot: Bot) => {
  const { x, y, z } = bot.entity.position;
  return { x: round(x), y: round(y), z: round(z) };
};

export function weather(bot: Bot): "clear" | "rain" | "thunder" {
  if (bot.thunderState > 0) return "thunder";
  return bot.isRaining ? "rain" : "clear";
}

const NOTABLE_BLOCKS = [
  "diamond_ore",
  "deepslate_diamond_ore",
  "emerald_ore",
  "deepslate_emerald_ore",
  "ancient_debris",
  "gold_ore",
  "deepslate_gold_ore",
  "iron_ore",
  "deepslate_iron_ore",
  "lava",
  "chest",
  "crafting_table",
  "furnace",
  "spawner",
];
const BED = /_bed$/;

export interface StateOptions {
  partner?: string;
  task: () => unknown;
}

export function resources(
  bot: Bot,
  options: StateOptions,
): Record<string, () => unknown> {
  return {
    self: () => ({
      name: bot.username,
      partner: partnerName(bot, options.partner),
      // The spawn point tells one world from another, for places kept per world.
      ...(bot.spawnPoint
        ? {
            world: `spawn ${[bot.spawnPoint.x, bot.spawnPoint.y, bot.spawnPoint.z].map(Math.round).join(",")}`,
          }
        : {}),
      health: Math.round(bot.health),
      food: bot.food,
      position: position(bot),
      held: bot.heldItem?.name ?? null,
      task: options.task(),
    }),
    inventory: () => {
      const items: Record<string, number> = {};
      for (const item of bot.inventory.items())
        items[item.name] = (items[item.name] ?? 0) + item.count;
      return items;
    },
    nearby_entities: () =>
      nearbyEntities(bot, 32)
        .slice(0, 20)
        .map((e) => ({
          type: e.type === "player" ? "player" : (e.name ?? e.type),
          ...(e.type === "player" ? { name: e.username } : {}),
          hostile: isHostile(e),
          distance: Math.round(distanceTo(bot, e)),
        })),
    nearby_blocks: () => {
      const ids = new Set(
        Object.values(bot.registry.blocksByName)
          .filter((b) => NOTABLE_BLOCKS.includes(b.name) || BED.test(b.name))
          .map((b) => b.id),
      );
      const found = bot.findBlocks({
        matching: (b) => ids.has(b.type),
        maxDistance: 16,
        count: 64,
      });
      const byName = new Map<
        string,
        { block: string; count: number; distance: number }
      >();
      for (const pos of found) {
        const name = bot.blockAt(pos)?.name;
        if (!name) continue;
        const distance = Math.round(bot.entity.position.distanceTo(pos));
        const entry = byName.get(name);
        if (entry) {
          entry.count++;
          entry.distance = Math.min(entry.distance, distance);
        } else byName.set(name, { block: name, count: 1, distance });
      }
      return [...byName.values()].sort((a, b) => a.distance - b.distance);
    },
    world: () => ({
      time: dayPhase(bot.time.timeOfDay),
      clock: clockText(bot.time.timeOfDay, bot.time.day),
      day: bot.time.day,
      weather: weather(bot),
      dimension: bot.game.dimension,
      difficulty: bot.game.difficulty,
    }),
  };
}

/** Ticks in a Minecraft day, and per real minute. */
const DAY_TICKS = 24_000;
const TICKS_PER_MINUTE = 1_200;
const SUNSET = 12_000;
const SUNRISE = 23_500;

/**
 * The game's clock as a player would say it: which day, the part of it, and
 * how long until the light changes, e.g. "Day 4, afternoon, about 3 minutes
 * until sunset". Days count from 1.
 */
export function clockText(timeOfDay: number, day: number): string {
  const t = ((timeOfDay % DAY_TICKS) + DAY_TICKS) % DAY_TICKS;
  const part =
    t < 1_000
      ? "early morning"
      : t < 5_000
        ? "morning"
        : t < 7_000
          ? "midday"
          : t < 11_000
            ? "afternoon"
            : t < 13_000
              ? "evening"
              : t < 17_000
                ? "night"
                : t < 19_000
                  ? "midnight"
                  : t < SUNRISE
                    ? "late night"
                    : "dawn";
  const daylight = t < SUNSET || t >= SUNRISE;
  const until = daylight
    ? SUNSET - t + (t >= SUNRISE ? DAY_TICKS : 0)
    : SUNRISE - t;
  const minutes = Math.max(1, Math.round(until / TICKS_PER_MINUTE));
  return `Day ${day + 1}, ${part}, about ${minutes} minute${minutes === 1 ? "" : "s"} until ${daylight ? "sunset" : "sunrise"}`;
}

/** A dropped item on the ground, however this game version names its entity. */
export function isDroppedItem(entity: Entity): boolean {
  if (entity.name === "item" || entity.displayName === "Item") return true;
  const dropped = (entity as Entity & { getDroppedItem?(): unknown })
    .getDroppedItem;
  try {
    return typeof dropped === "function" && !!dropped.call(entity);
  } catch {
    return false;
  }
}
