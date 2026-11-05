import { z } from "zod";
import type { AdapterManifest } from "@swarmfu/connect-protocol";

/**
 * Minecraft (Java Edition), v1: what the Mineflayer adapter emits and
 * accepts. The simulator replays recordings against the same manifest, so
 * the decider and avatar can be built without the game running.
 */

export const MINECRAFT_EVENTS = {
  // Reflex: the adapter flees or blocks on its own, the avatar reacts.
  hurt: {
    lane: "reflex",
    description: "She took damage from a mob, a fall, fire or a player.",
    reaction: "flinch",
  },
  creeper_fuse: {
    lane: "reflex",
    description: "A creeper near her started hissing.",
    reaction: "startle",
  },
  explosion: {
    lane: "reflex",
    description: "Something exploded close by.",
    reaction: "startle",
  },
  falling: {
    lane: "reflex",
    description: "She's falling far enough to get hurt.",
    reaction: "panic",
  },
  burning: {
    lane: "reflex",
    description: "She's on fire or in lava.",
    reaction: "panic",
  },
  low_health: {
    lane: "reflex",
    description: "Her health dropped below a third; she backs off.",
    reaction: "concern",
  },
  drowning: {
    lane: "reflex",
    description: "She's running out of air under water and swims for the surface.",
    reaction: "panic",
  },
  escaped: {
    lane: "reflex",
    description: "The danger she fled from is gone.",
    reaction: "relief",
  },
  // Respond: the decider picks speak, gesture or quiet.
  death: {
    lane: "respond",
    description: "She or the user died; the summary says how.",
  },
  stuck: {
    lane: "respond",
    description: "She can't get where she's going, even pillaring up with her own blocks, without digging through the world.",
  },
  ore_found: {
    lane: "respond",
    description:
      "Diamonds, emeralds or ancient debris came into view or were mined.",
  },
  mob_killed: {
    lane: "respond",
    description: "She or the user killed a hostile mob.",
  },
  boss_killed: {
    lane: "respond",
    description: "The Ender Dragon or the Wither died.",
  },
  build_damaged: {
    lane: "respond",
    description: "Someone broke blocks she placed.",
  },
  unsheltered_night: {
    lane: "respond",
    description: "Night fell and they're out in the open.",
  },
  player_joined: {
    lane: "respond",
    description: "A player joined the world.",
  },
  player_left: {
    lane: "respond",
    description: "A player left the world.",
  },
  chat: {
    lane: "respond",
    description: "Someone said something in game chat.",
  },
  items_received: {
    lane: "respond",
    description: "She picked up items a player had just thrown to her.",
  },
  // Silent: her rolling picture of the game.
  status: {
    lane: "silent",
    description:
      "Her health, food, position and what she's holding, every few seconds.",
  },
  user_activity: {
    lane: "silent",
    description:
      "What the user is doing near her: mining, building, fighting, exploring.",
  },
  time_changed: {
    lane: "silent",
    description: "Dawn, noon, dusk or midnight passed.",
  },
  weather_changed: {
    lane: "silent",
    description: "Rain or a thunderstorm started or stopped.",
  },
  item_collected: {
    lane: "silent",
    description: "She picked up items.",
  },
  task_finished: {
    lane: "silent",
    description: "A task she was given finished, failed or was interrupted.",
  },
  respawned: {
    lane: "silent",
    description: "She came back after dying, and where she's heading: to the user, or to her things.",
  },
  place_marked: {
    lane: "silent",
    description: "She was asked to remember a place; its data has the name and position.",
  },
} as const satisfies AdapterManifest["events"];

const block = z
  .string()
  .regex(/^[a-z_]+$/)
  .describe("Block id, e.g. oak_log");
const coord = z.number().int();

/** Tool inputs, shared by the real adapter and the simulator. */
export const MINECRAFT_TOOL_INPUTS = {
  follow_player: {
    player: z.string().min(1).max(16).describe("The player's username"),
    distance: z.number().min(1).max(16).default(3),
  },
  go_to: { x: coord, y: coord, z: coord },
  collect_block: {
    block,
    count: z.number().int().min(1).max(64).default(8),
  },
  attack: {
    target: z
      .string()
      .regex(/^[a-z_]+$/)
      .describe("Hostile mob type, e.g. zombie"),
  },
  flee: {},
  place_block: { block, x: coord, y: coord, z: coord },
  break_block: { x: coord, y: coord, z: coord },
  equip: { item: z.string().regex(/^[a-z_]+$/).describe("Item id, e.g. iron_sword, copper_chestplate, shield") },
  say_in_chat: { message: z.string().min(1).max(200) },
  stop: {
    paused: z.boolean().optional().describe("Set only by the app's pause button; leave it out."),
  },
  craft_item: {
    item: z.string().regex(/^[a-z_]+$/).describe("Item id to make, e.g. wooden_axe, stick, oak_planks"),
    count: z.number().int().min(1).max(64).default(1),
  },
  pick_up_items: {},
  give_item: {
    item: z.string().regex(/^[a-z_]+$/).describe("Item id from her inventory, e.g. oak_log"),
    count: z.number().int().min(1).max(64).default(1),
    player: z.string().min(1).max(16).describe("Who to give it to"),
  },
  check_inventory: {},
  remember_place: {
    name: z.string().min(1).max(40).describe('What to call it, e.g. "base" or "the mine"'),
    at: z.enum(["user", "me"]).default("user").describe("Where the user is standing (default), or where she is"),
  },
} satisfies Record<string, z.ZodRawShape>;

export type MinecraftTool = keyof typeof MINECRAFT_TOOL_INPUTS;

export const MINECRAFT_MANIFEST = {
  id: "minecraft",
  game: "Minecraft: Java Edition",
  version: "0.1.0",
  events: MINECRAFT_EVENTS,
  tools: {
    follow_player: {
      description: "Follow a player, staying a few blocks behind them.",
    },
    go_to: { description: "Walk to a position." },
    collect_block: {
      description: "Find and mine blocks of a type nearby, then pick them up.",
    },
    attack: { description: "Fight the nearest hostile mob of a type." },
    flee: { description: "Run from nearby danger." },
    place_block: { description: "Place a block from her inventory." },
    break_block: {
      description: "Break the block at a position, even one a player placed.",
      destructive: true,
    },
    equip: {
      description:
        "Hold an item from her inventory, or put on armor (helmet, chestplate, leggings, boots go in their slots; a shield in her off hand).",
    },
    say_in_chat: {
      description: "Say something in game chat.",
    },
    stop: {
      description: "Stop whatever she's doing and stay put. She still fights back or runs if something attacks her, and a death ends it.",
    },
    craft_item: {
      description:
        "Craft an item from what she's carrying, at a crafting table when the recipe needs one (she uses one nearby or sets hers down). If ingredients are missing it says which, so she can make them first or ask the user for them.",
    },
    pick_up_items: {
      description:
        "Walk over and pick up items lying nearby, e.g. ones the user dropped for her (they press Q to drop what they're holding).",
    },
    give_item: {
      description: "Walk to a player and drop items from her inventory for them.",
    },
    check_inventory: {
      description: "List what she's carrying, holding and wearing.",
    },
    remember_place: {
      description:
        'Remember a place by name, e.g. when the user says "this is our base". She keeps it for this world and can walk back there later (go_to its coordinates).',
    },
  } satisfies Record<MinecraftTool, AdapterManifest["tools"][string]>,
  resources: {
    self: {
      description: "Her health, food, position, held item and current task.",
    },
    inventory: { description: "Everything she's carrying, by item." },
    nearby_entities: {
      description: "Players and mobs within 32 blocks, nearest first.",
    },
    nearby_blocks: {
      description: "Notable blocks within 16 blocks: ores, chests, beds, lava.",
    },
    world: { description: "Time of day, weather, dimension and difficulty." },
  },
} as const satisfies AdapterManifest;

/** Every adapter the app knows, by manifest id, with its tool inputs: what her models can be offered. */
export const KNOWN_ADAPTERS = {
  minecraft: { manifest: MINECRAFT_MANIFEST, toolInputs: MINECRAFT_TOOL_INPUTS },
} as const satisfies Record<string, { manifest: AdapterManifest; toolInputs: Record<string, z.ZodRawShape> }>;

export interface ModelGameTool {
  name: string;
  description: string;
  input: z.ZodRawShape;
}

/**
 * The tools her chat and voice models may call for an adapter: everything it
 * declares except destructive ones (those wait for a per-user allowlist).
 * Only tools the play session reported are offered, when it did report them.
 */
export function modelGameTools(adapterId: string, declared?: readonly string[]): ModelGameTool[] {
  const known = KNOWN_ADAPTERS[adapterId as keyof typeof KNOWN_ADAPTERS];
  if (!known) return [];
  const inputs: Record<string, z.ZodRawShape> = known.toolInputs;
  return Object.entries(known.manifest.tools as AdapterManifest["tools"])
    .filter(([name, spec]) => !spec.destructive && (!declared || declared.includes(name)) && inputs[name])
    .map(([name, spec]) => ({
      name,
      description: `In ${known.manifest.game}: ${spec.description}`,
      input: inputs[name]!,
    }));
}

/** A game's everyday name ("Minecraft"), for her notes and memories; the adapter id for games the app doesn't know. */
export function gameLabel(adapterId: string): string {
  const known = KNOWN_ADAPTERS[adapterId as keyof typeof KNOWN_ADAPTERS];
  return (known?.manifest as AdapterManifest | undefined)?.game.split(":")[0]?.trim() || adapterId;
}
