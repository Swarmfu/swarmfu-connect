import type { RaisedEvent } from "@swarmfu/connect-protocol/adapter";
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import { LOW_AIR, blockKey, type Actions } from "./actions.ts";
import {
  clockText,
  dayPhase,
  distanceTo,
  isDroppedItem,
  isHostile,
  nearbyEntities,
  nearestHostile,
  partnerName,
  position,
  weather,
  type DayPhase,
} from "./state.ts";

/**
 * Turns what happens around her bot into game events (see MINECRAFT_EVENTS).
 * Reflexes run here too: on danger she flees (or fights back) at once,
 * before any model is asked, unless she's held (paused). Everything is rate-limited so a long
 * fight is a few events, not hundreds.
 */

export interface WatchOptions {
  emit(event: RaisedEvent): void;
  actions: Actions;
  placed: Set<string>;
  partner?: string;
  /** How often silent status and the user's activity go out, and how often to look for ores. */
  statusEveryMs?: number;
  activityEveryMs?: number;
  oreScanEveryMs?: number;
  /** How long a burst (items picked up, blocks broken) is gathered into one event. */
  gatherMs?: number;
}

const LOW_HEALTH = 6;
const CREEPER_RANGE = 4;
const EXPLOSION_RANGE = 10;
const FALL_BLOCKS = 4;
const SAFE_AFTER_MS = 4_000;
/** "Got clear" only once nothing hostile is this close. */
const CLEAR_RANGE = 16;
/** Too quick (and climbing) to outrun: she fights these straight away. */
const SWIFT = new Set(["spider", "cave_spider"]);
const FIGHTING = new Set(["attack", "defend"]);
const ORES = [
  "diamond_ore",
  "deepslate_diamond_ore",
  "emerald_ore",
  "deepslate_emerald_ore",
  "ancient_debris",
];
const BOSSES = new Set(["ender_dragon", "wither"]);
const OPEN = new Set(["air", "cave_air", "void_air", "water"]);
const FIRE = new Set(["lava", "fire", "soul_fire"]);
/** An item that appears this close to a player was thrown by them. */
const THROWN_WITHIN = 2.5;
/** After respawning, a moment for the world to load around her before she sets off. */
const RESPAWN_SETTLE_MS = 1_500;

const name = (e: Entity) =>
  e.type === "player"
    ? (e.username ?? "a player")
    : (e.name ?? "something").replace(/_/g, " ");
const pretty = (s: string) => s.replace(/_/g, " ");

export function watchBot(bot: Bot, options: WatchOptions): () => void {
  const { emit, actions } = options;
  const gatherMs = options.gatherMs ?? 2_000;
  const me = () => bot.username;
  const partner = () => partnerName(bot, options.partner);
  const subjectOf = (player: string) =>
    player === me() ? "self" : player === partner() ? "user" : "other";
  const cleanups: (() => void)[] = [];
  const on = <E extends Parameters<Bot["on"]>[0]>(
    event: E,
    fn: Parameters<Bot["on"]>[1],
  ) => {
    bot.on(event, fn as never);
    cleanups.push(() => bot.removeListener(event, fn as never));
  };
  const every = (ms: number, fn: () => void) => {
    const timer = setInterval(fn, ms);
    cleanups.push(() => clearInterval(timer));
  };

  // Each kind of reflex at most this often.
  const lastAt = new Map<string, number>();
  const cooled = (key: string, ms: number) => {
    const now = Date.now();
    if (now - (lastAt.get(key) ?? 0) < ms) return false;
    lastAt.set(key, now);
    return true;
  };

  // --- Danger and reflexes ---

  // Running is the first answer to danger. A mob that keeps hurting her while
  // she runs, or one too quick to outrun, she turns and fights instead. A
  // creeper she always runs from. Paused, she does neither (told to stay, she still does).
  let dangerAt: number | null = null;
  const fighting = () => FIGHTING.has(actions.task?.tool ?? "");
  const danger = (fleeToo: boolean, always = false) => {
    dangerAt = Date.now();
    if (fleeToo && !actions.paused && (always || !fighting())) actions.flee();
  };
  const struck = (threat: Entity) => {
    dangerAt = Date.now();
    if (actions.paused || fighting()) return;
    if (threat.name === "creeper") actions.flee();
    else if (SWIFT.has(threat.name ?? "") || actions.task?.tool === "flee") actions.fight(threat);
    else actions.flee();
  };

  let lastHealth = bot.health;
  on("health", () => {
    const health = bot.health;
    const lost = lastHealth - health;
    const wasLow = lastHealth <= LOW_HEALTH;
    lastHealth = health;
    if (lost <= 0.5) return;
    const threat = nearestHostile(bot, 5);
    if (cooled("hurt", 1_500))
      emit({
        kind: "hurt",
        lane: "reflex",
        subject: "self",
        summary: `${me()} took ${Math.round(lost)} damage${threat ? ` from a ${name(threat)}` : ""}.`,
        data: {
          amount: Math.round(lost),
          health: Math.round(health),
          ...(threat ? { source: threat.name } : {}),
        },
      });
    if (threat) struck(threat);
    if (health <= LOW_HEALTH && !wasLow && health > 0) {
      emit({
        kind: "low_health",
        lane: "reflex",
        subject: "self",
        summary: `${me()} is down to ${Math.round(health)}/20 health${threat ? " and backing off" : ""}.`,
        data: { health: Math.round(health) },
      });
      // Low, she backs off, unless she's fighting something she can't outrun.
      if (!(fighting() && SWIFT.has(actions.target?.name ?? ""))) danger(true, true);
    }
  });

  const creeperClose = () => {
    const creeper = nearbyEntities(bot, CREEPER_RANGE).find(
      (e) => e.name === "creeper",
    );
    if (creeper && cooled(`creeper:${creeper.id}`, 8_000)) {
      emit({
        kind: "creeper_fuse",
        lane: "reflex",
        subject: "self",
        summary: `A creeper is right next to ${me()}.`,
        data: { distance: Math.round(distanceTo(bot, creeper)) },
      });
      danger(true, true);
    }
  };
  on("soundEffectHeard", (sound: string, at: Vec3) => {
    if (
      sound.includes("creeper.primed") &&
      bot.entity.position.distanceTo(at) <= 6 &&
      cooled("creeper-sound", 4_000)
    ) {
      emit({
        kind: "creeper_fuse",
        lane: "reflex",
        subject: "self",
        summary: `A creeper started hissing right behind ${me()}.`,
      });
      danger(true, true);
    }
  });

  // Explosions only come as a raw packet; its name and fields vary by version.
  const onExplosion = (packet: Record<string, unknown>) => {
    const center = (packet.center ?? packet) as {
      x?: number;
      y?: number;
      z?: number;
    };
    const near =
      typeof center.x === "number" &&
      typeof center.y === "number" &&
      typeof center.z === "number"
        ? bot.entity.position.distanceTo(
            new Vec3(center.x, center.y, center.z),
          ) <= EXPLOSION_RANGE
        : true;
    if (near && cooled("explosion", 2_000)) {
      emit({
        kind: "explosion",
        lane: "reflex",
        subject: "world",
        summary: `Something exploded right next to ${me()}.`,
      });
      danger(false);
    }
  };
  for (const packet of ["explosion", "explode"]) {
    bot._client.on(packet, onExplosion);
    cleanups.push(() => bot._client.removeListener(packet, onExplosion));
  }

  let groundY = bot.entity.position.y;
  let falling = false;
  let tick = 0;
  on("physicsTick", () => {
    const entity = bot.entity;
    if (entity.onGround || bot.blockAt(entity.position)?.name === "water") {
      groundY = entity.position.y;
      falling = false;
    } else if (
      !falling &&
      groundY - entity.position.y >= FALL_BLOCKS &&
      entity.velocity.y < -0.5
    ) {
      falling = true;
      if (cooled("falling", 3_000))
        emit({
          kind: "falling",
          lane: "reflex",
          subject: "self",
          summary: `${me()} is falling.`,
          data: { height: Math.round(groundY - entity.position.y) },
        });
    }
    if (++tick % 10) return; // the rest twice a second
    creeperClose();
    const seen = partner() ? bot.players[partner()!]?.entity : undefined;
    if (seen) lastSeenPartner = seen.position.clone();
    const feet = bot.blockAt(entity.position)?.name;
    const head = bot.blockAt(entity.position.offset(0, 1, 0))?.name;
    if (FIRE.has(feet ?? "") || FIRE.has(head ?? "")) {
      if (cooled("burning", 5_000))
        emit({
          kind: "burning",
          lane: "reflex",
          subject: "self",
          summary:
            feet === "lava" || head === "lava"
              ? `${me()} is in lava!`
              : `${me()} is on fire!`,
        });
      danger(false);
      if (!actions.paused && actions.task?.tool !== "escape_heat") actions.escapeHeat();
    }
    // Under water and short of air, she drops what she's doing and swims up.
    const air = (bot as Bot & { oxygenLevel?: number }).oxygenLevel ?? 20;
    if (head === "water" && air <= LOW_AIR && !actions.paused && actions.task?.tool !== "surface") {
      if (cooled("drowning", 6_000))
        emit({
          kind: "drowning",
          lane: "reflex",
          subject: "self",
          summary: `${me()} is running out of air and swimming up.`,
          data: { air },
        });
      dangerAt = Date.now();
      actions.surface();
    }
    if (
      dangerAt &&
      Date.now() - dangerAt > SAFE_AFTER_MS &&
      !nearestHostile(bot, CLEAR_RANGE)
    ) {
      dangerAt = null;
      emit({
        kind: "escaped",
        lane: "reflex",
        subject: "self",
        summary: `${me()} got clear; nothing hostile nearby.`,
      });
    }
  });

  // --- Things worth a word ---

  // Death messages name everyone's deaths in the game's own words.
  let selfDeathReported = 0;
  on("message", (message: { translate?: string; toString(): string }) => {
    if (!message.translate?.startsWith("death.")) return;
    const text = message.toString();
    const who = text.split(" ")[0] ?? "";
    const subject = subjectOf(who);
    // Where she died, so she (and her context) can find her things again.
    const where = subject === "self" ? (died?.at ?? bot.entity.position).floored() : null;
    if (subject === "self") selfDeathReported = Date.now();
    emit({
      kind: "death",
      lane: "respond",
      subject,
      summary: where ? `${text}, at ${where.x} ${where.y} ${where.z}.` : `${text}.`,
      data: { player: who, cause: message.translate, ...(where ? { x: where.x, y: where.y, z: where.z } : {}) },
    });
  });
  // When she dies: what she was doing and where, for when she comes back.
  let died: { at: Vec3; task: ReturnType<Actions["died"]> } | null = null;
  let lastSeenPartner: Vec3 | null = null;
  on("death", () => {
    died = { at: bot.entity.position.clone(), task: actions.died() };
    setTimeout(() => {
      if (Date.now() - selfDeathReported > 3_000)
        emit({
          kind: "death",
          lane: "respond",
          subject: "self",
          summary: `${me()} died.`,
          data: { player: me() },
        });
    }, 1_500);
  });

  // Back after dying: what a player would do (actions.recover), unless she's paused.
  on("spawn", () => {
    const was = died;
    if (!was) return;
    died = null;
    setTimeout(() => {
      const following = was.task?.tool === "follow_player" ? String(was.task.args.player ?? "") || null : null;
      const plan = actions.recover({ diedAt: was.at, following, lastSeen: lastSeenPartner });
      emit({
        kind: "respawned",
        lane: "silent",
        subject: "self",
        summary: plan ?? `${me()} came back after dying and is staying put: she's paused.`,
      });
    }, RESPAWN_SETTLE_MS);
  });

  on("chat", (username: string, text: string) => {
    if (username === me()) return;
    emit({
      kind: "chat",
      lane: "respond",
      subject: subjectOf(username),
      summary: `${username} said in chat: "${text.slice(0, 200)}"`,
      data: { player: username, message: text.slice(0, 200) },
    });
  });

  // The tab list arrives right after joining; only later joins are news.
  const joinedAt = Date.now();
  on("playerJoined", (player: { username: string }) => {
    if (player.username === me() || Date.now() - joinedAt < 3_000) return;
    emit({
      kind: "player_joined",
      lane: "respond",
      subject: subjectOf(player.username),
      summary: `${player.username} joined the game.`,
      data: { player: player.username },
    });
  });
  on("playerLeft", (player: { username: string }) => {
    if (player.username === me()) return;
    emit({
      kind: "player_left",
      lane: "respond",
      subject: subjectOf(player.username),
      summary: `${player.username} left the game.`,
      data: { player: player.username },
    });
  });

  on("entityDead", (entity: Entity) => {
    if (BOSSES.has(entity.name ?? "")) {
      emit({
        kind: "boss_killed",
        lane: "respond",
        subject: "world",
        summary: `The ${name(entity)} is dead!`,
        data: { mob: entity.name },
      });
      return;
    }
    if (
      !isHostile(entity) ||
      distanceTo(bot, entity) > 10 ||
      !cooled("mob_killed", 5_000)
    )
      return;
    const hers = actions.target?.id === entity.id;
    emit({
      kind: "mob_killed",
      lane: "respond",
      subject: hers ? "self" : "other",
      summary: hers
        ? `${me()} killed a ${name(entity)}.`
        : `A ${name(entity)} was killed near ${me()}.`,
      data: { mob: entity.name },
    });
  });

  // Someone breaking blocks she placed: gathered, then blamed on whoever's closest.
  let broken: Vec3[] = [];
  let brokenTimer: ReturnType<typeof setTimeout> | null = null;
  on(
    "blockUpdate",
    (_old: unknown, block: { position: Vec3; name: string }) => {
      const key = blockKey(block.position);
      if (!options.placed.has(key) || !OPEN.has(block.name)) return;
      options.placed.delete(key);
      broken.push(block.position);
      brokenTimer ??= setTimeout(() => {
        const at = broken[0]!;
        const culprit = nearbyEntities(bot, 32)
          .filter((e) => e.type === "player")
          .sort(
            (a, b) => a.position.distanceTo(at) - b.position.distanceTo(at),
          )[0];
        const who = culprit?.username ?? "Someone";
        emit({
          kind: "build_damaged",
          lane: "respond",
          subject: culprit?.username ? subjectOf(culprit.username) : "other",
          summary: `${who} broke ${broken.length === 1 ? "a block" : `${broken.length} blocks`} of ${me()}'s build.`,
          data: {
            blocks: broken.length,
            ...(culprit?.username ? { player: culprit.username } : {}),
          },
        });
        broken = [];
        brokenTimer = null;
      }, gatherMs);
    },
  );
  cleanups.push(() => brokenTimer && clearTimeout(brokenTimer));

  // Ore in plain view (touching air or water), once per vein.
  const seenOre = new Set<string>();
  const oreIds = () =>
    new Set(
      ORES.map((o) => bot.registry.blocksByName[o]?.id).filter(
        (id) => id !== undefined,
      ),
    );
  const scanOre = () => {
    const ids = oreIds();
    const found = bot.findBlocks({
      matching: (b) => ids.has(b.type),
      maxDistance: 8,
      count: 32,
    });
    const fresh = found.filter((p) => {
      const key = blockKey(p);
      if (seenOre.has(key)) return false;
      const exposed = [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0, 0, 1],
        [0, 0, -1],
      ].some(([dx, dy, dz]) =>
        OPEN.has(bot.blockAt(p.offset(dx!, dy!, dz!))?.name ?? ""),
      );
      return exposed;
    });
    if (!fresh.length) return;
    // A whole vein counts as seen, exposed or not.
    for (const p of found) seenOre.add(blockKey(p));
    const ore = bot.blockAt(fresh[0]!)?.name ?? "ore";
    const who = partner();
    const userNear =
      who &&
      bot.players[who]?.entity &&
      bot.players[who].entity.position.distanceTo(fresh[0]!) < 8;
    emit({
      kind: "ore_found",
      lane: "respond",
      subject: userNear ? "user" : "self",
      summary: `${fresh.length === 1 ? `A ${pretty(ore)}` : `${fresh.length} ${pretty(ore)}`} in plain view near ${me()}${userNear ? ` and ${who}` : ""}.`,
      data: { block: ore, count: fresh.length },
    });
  };
  every(options.oreScanEveryMs ?? 3_000, scanOre);

  // The first time update only says what time it is on arrival; changes come after it.
  let phase: DayPhase | null = null;
  on("time", () => {
    const next = dayPhase(bot.time.timeOfDay);
    const first = phase === null;
    if (next === phase) return;
    phase = next;
    if (first) return;
    const said = {
      dawn: "The sun is coming up.",
      day: "It's full day.",
      dusk: "The sun is setting.",
      night: "Night has fallen.",
    }[next];
    emit({
      kind: "time_changed",
      lane: "silent",
      subject: "world",
      summary: `Day ${bot.time.day + 1}: ${said}`,
      data: { time: next, day: bot.time.day + 1 },
    });
    if (next === "night" && underOpenSky(bot))
      emit({
        kind: "unsheltered_night",
        lane: "respond",
        subject: "world",
        summary: `Night fell and ${me()}${partner() ? ` and ${partner()}` : ""} are out in the open with no shelter.`,
      });
  });

  on("rain", () => {
    const now = weather(bot);
    emit({
      kind: "weather_changed",
      lane: "silent",
      subject: "world",
      summary:
        now === "clear"
          ? "The rain stopped."
          : now === "thunder"
            ? "A thunderstorm started."
            : "It started to rain.",
      data: { weather: now },
    });
  });

  // Items a player throws: an item entity that appears right at a player
  // (not her) was thrown by them, so picking it up is a gift, worth a word.
  const thrownBy = new Map<number, { player: string; at: number }>();
  on("entitySpawn", (entity: Entity) => {
    if (!isDroppedItem(entity)) return;
    const thrower = nearbyEntities(bot, 32)
      .filter((e) => e.type === "player" && e.username && e.username !== me())
      .find((e) => e.position.distanceTo(entity.position) <= THROWN_WITHIN);
    if (thrower?.username) thrownBy.set(entity.id, { player: thrower.username, at: Date.now() });
    for (const [id, t] of thrownBy) if (Date.now() - t.at > 120_000) thrownBy.delete(id);
  });

  // Pickups, gathered per item: gifts apart from what she finds herself.
  const picked = new Map<string, number>();
  const gifts = new Map<string, Map<string, number>>();
  let pickedTimer: ReturnType<typeof setTimeout> | null = null;
  const listOf = (items: Map<string, number>) =>
    [...items].map(([item, count]) => `${count} ${pretty(item)}`).join(", ");
  on("playerCollect", (collector: Entity, collected: Entity) => {
    if (collector !== bot.entity) return;
    const item = (
      collected as Entity & {
        getDroppedItem?(): { name: string; count: number } | null;
      }
    ).getDroppedItem?.();
    if (!item) return;
    const giver = thrownBy.get(collected.id)?.player;
    thrownBy.delete(collected.id);
    const into = giver ? (gifts.get(giver) ?? gifts.set(giver, new Map()).get(giver)!) : picked;
    into.set(item.name, (into.get(item.name) ?? 0) + item.count);
    pickedTimer ??= setTimeout(() => {
      for (const [player, items] of gifts)
        emit({
          kind: "items_received",
          lane: "respond",
          subject: subjectOf(player),
          summary: `${player} gave ${me()} ${listOf(items)} (threw it to her).`,
          data: { player, ...Object.fromEntries(items) },
        });
      if (picked.size)
        emit({
          kind: "item_collected",
          lane: "silent",
          subject: "self",
          summary: `${me()} picked up ${listOf(picked)}.`,
          data: Object.fromEntries(picked),
        });
      picked.clear();
      gifts.clear();
      pickedTimer = null;
    }, gatherMs);
  });
  cleanups.push(() => pickedTimer && clearTimeout(pickedTimer));

  // --- Her rolling picture: status and what the user is up to ---

  every(options.statusEveryMs ?? 10_000, () => {
    const { x, y, z } = position(bot);
    emit({
      kind: "status",
      lane: "silent",
      subject: "self",
      summary: `${me()}: ${Math.round(bot.health)}/20 health, ${bot.food}/20 food, ${bot.heldItem ? `holding ${pretty(bot.heldItem.name)}` : "empty-handed"}, at ${x} ${y} ${z}${actions.task ? `, busy with ${actions.task.tool.replace(/_/g, " ")}` : ""}. ${clockText(bot.time.timeOfDay, bot.time.day)}.`,
      data: { health: Math.round(bot.health), food: bot.food },
    });
  });
  every(options.activityEveryMs ?? 15_000, () => {
    const who = partner();
    const entity = who ? bot.players[who]?.entity : undefined;
    if (!who) return;
    if (!entity) {
      emit({
        kind: "user_activity",
        lane: "silent",
        subject: "user",
        summary: `${who} is out of sight.`,
      });
      return;
    }
    const held = (entity as Entity & { heldItem?: { name: string } | null })
      .heldItem?.name;
    emit({
      kind: "user_activity",
      lane: "silent",
      subject: "user",
      summary: `${who} is ${Math.round(distanceTo(bot, entity))} blocks away${held ? `, holding ${pretty(held)}` : ""}.`,
      data: { distance: Math.round(distanceTo(bot, entity)) },
    });
  });

  return () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  };
}

/** Nothing solid in the ten blocks above her head. */
export function underOpenSky(bot: Bot): boolean {
  const top = bot.entity.position.floored();
  for (let dy = 2; dy <= 11; dy++) {
    const block = bot.blockAt(top.offset(0, dy, 0));
    if (block && block.boundingBox === "block") return false;
  }
  return true;
}
