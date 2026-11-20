import type { GamePack } from "@swarmfu/connect-protocol";

/**
 * FTL: Faster Than Light, through the Swarmfu Connector, a Hyperspace Lua
 * mod (v0.1.0): she watches. Hyperspace's Lua can't write files, so the mod
 * writes its lines into Hyperspace's own log, FTL_HS.log, which is in the
 * folder the game runs in: FasterThanLight's save folder on macOS (where
 * Hyperspace's launcher starts it), the game's folder on Windows, and its
 * `data` folder on Linux (Steam's paths).
 *
 * There's no in-game clock: where they are is `run` (`sector`,
 * `sector_name`, `sector_type`, `jumps`, `environment`) on each event in a
 * run, and `location` in the state. Each type ends in a rule that needs no
 * fields, so a missing one makes a plainer line rather than none.
 */
export const ftl: GamePack = {
  id: "ftl",
  game: "FTL: Faster Than Light",
  version: "1",
  role: "spectator",
  folder: {
    darwin: "~/Library/Application Support/FasterThanLight",
    win32:
      "C:/Program Files (x86)/Steam/steamapps/common/FTL Faster Than Light",
    linux: "~/.local/share/Steam/steamapps/common/FTL Faster Than Light/data",
  },
  log: { file: "FTL_HS.log", prefix: "[swarmfu] " },
  // Their ship stands in for a character: "The Kestrel".
  player: [
    "{player.ship}",
    "{player.ship_class}",
    { when: { in_run: false }, summary: "the player" },
  ],
  events: {
    session_start: {
      description:
        "FTL opened with the connector running, or a run started or was loaded.",
      rules: [
        {
          when: { "data.in_run": false },
          summary: "FTL is open, at the main menu.",
        },
        {
          when: { "data.new_run": true },
          lane: "respond",
          summary:
            "A new FTL run: {data.ship}, a {data.ship_class}, on {data.difficulty}.",
        },
        {
          when: { "data.new_run": true },
          lane: "respond",
          summary: "A new FTL run with {data.ship}.",
        },
        {
          lane: "respond",
          summary:
            "Back to an FTL run: {data.ship}, a {data.ship_class}, in sector {data.sector}.",
        },
        { lane: "respond", summary: "An FTL run started." },
      ],
    },
    session_end: {
      description: "They left the run for the main menu.",
      rules: [{ summary: "Back at FTL's main menu." }],
    },
    jumped: {
      description:
        "The ship jumped to a new beacon: where, and whether it's dangerous there.",
      rules: [
        {
          when: { "data.fleet_here": true },
          lane: "respond",
          reaction: "concern",
          summary: "Jumped into a beacon the rebel fleet has already reached.",
        },
        {
          when: { "data.environment": { exists: true } },
          lane: "respond",
          tally: true,
          summary:
            "Jumped to a new beacon in sector {data.sector}: {data.environment}.",
        },
        {
          tally: true,
          summary:
            "Jumped to a new beacon in sector {data.sector} ({data.jumps} jumps this run).",
        },
        { tally: true, summary: "Jumped to a new beacon." },
      ],
    },
    sector_entered: {
      description: "The ship reached a new sector.",
      rules: [
        {
          lane: "respond",
          summary:
            "Into sector {data.sector}: {data.name}, a {data.type} sector.",
        },
        { lane: "respond", summary: "Into sector {data.sector}: {data.name}." },
        { lane: "respond", summary: "Into a new sector." },
      ],
    },
    event_text: {
      description:
        "An event's text at a beacon and the choices it offers, as the player reads it.",
      rules: [
        {
          when: { "data.store": true },
          lane: "respond",
          summary:
            "There's a store here. {data.text|text} Options: {data.options|list}.",
        },
        {
          lane: "respond",
          summary: "{data.text|text} Options: {data.options|list}.",
        },
        { lane: "respond", summary: "{data.text|text}" },
      ],
    },
    choice_made: {
      description: "The option they took in an event.",
      rules: [
        { summary: "{player} chose: {data.choice}" },
        { summary: "They made a choice." },
      ],
    },
    ship_encountered: {
      description:
        "Another ship is at the beacon: whether it's hostile, and how tough.",
      rules: [
        {
          when: { "data.boss": true },
          lane: "reflex",
          reaction: "startle",
          summary: "The Rebel flagship is here: {data.max_hull} hull.",
        },
        {
          when: { "data.hostile": true },
          lane: "respond",
          summary:
            "A hostile ship: {data.name}, {data.max_hull} hull[[, {data.crew} crew]].",
        },
        {
          when: { "data.hostile": true },
          lane: "respond",
          summary: "A hostile ship is here.",
        },
        { summary: "Another ship is here: {data.name}." },
        { summary: "Another ship is here." },
      ],
    },
    hull_hit: {
      description:
        "Their ship's hull took damage: how much, and how much is left.",
      rules: [
        {
          when: { "data.hull": { lte: 5 } },
          lane: "reflex",
          reaction: "panic",
          tally: true,
          summary:
            "The hull took {data.lost} damage: only {data.hull} of {data.max_hull} left!",
        },
        {
          lane: "reflex",
          reaction: "flinch",
          tally: true,
          summary:
            "The hull took {data.lost} damage: {data.hull} of {data.max_hull} left.",
        },
        {
          lane: "reflex",
          reaction: "flinch",
          tally: true,
          summary: "The hull took damage.",
        },
      ],
    },
    hull_repaired: {
      description: "Their hull was repaired.",
      rules: [
        {
          summary:
            "Hull repaired by {data.gained}: {data.hull} of {data.max_hull}.",
        },
        { summary: "Hull repaired." },
      ],
    },
    system_damaged: {
      description: "One of their ship's systems took damage.",
      rules: [
        {
          lane: "respond",
          tally: true,
          summary: "Their {data.system} took damage.",
        },
        { tally: true, summary: "A system took damage." },
      ],
    },
    enemy_hit: {
      description: "The other ship's hull took damage.",
      rules: [
        {
          tally: true,
          summary:
            "Hit the enemy for {data.lost}: {data.hull} of {data.max_hull} hull left.",
        },
        { tally: true, summary: "Hit the enemy." },
      ],
    },
    enemy_system_damaged: {
      description: "One of the other ship's systems took damage.",
      rules: [
        { tally: true, summary: "Hit the enemy's {data.system}." },
        { tally: true, summary: "Hit an enemy system." },
      ],
    },
    ship_destroyed: {
      description: "The other ship was destroyed.",
      rules: [
        {
          when: { "data.boss": true },
          lane: "reflex",
          reaction: "triumph",
          summary: "The Rebel flagship is destroyed!",
        },
        {
          lane: "reflex",
          reaction: "cheer",
          summary: "Destroyed the {data.name}.",
        },
        {
          lane: "reflex",
          reaction: "cheer",
          summary: "Destroyed the enemy ship.",
        },
      ],
    },
    ship_left: {
      description:
        "The other ship jumped away or the encounter ended without destroying it.",
      rules: [
        { summary: "The {data.name} is gone." },
        { summary: "The other ship is gone." },
      ],
    },
    crew_lost: {
      description: "A crew member died.",
      rules: [
        {
          lane: "reflex",
          reaction: "concern",
          summary:
            "Lost {data.name}, the {data.species}. {data.crew_left} crew left.",
        },
        { lane: "reflex", reaction: "concern", summary: "Lost {data.name}." },
        { lane: "reflex", reaction: "concern", summary: "A crew member died." },
      ],
    },
    crew_joined: {
      description: "Someone joined the crew.",
      rules: [
        {
          lane: "respond",
          summary: "{data.name}, a {data.species}, joined the crew.",
        },
        { lane: "respond", summary: "Someone joined the crew." },
      ],
    },
    scrap_gained: {
      description: "Scrap collected.",
      rules: [
        { tally: true, summary: "+{data.amount} scrap, {data.scrap} now." },
        { tally: true, summary: "Collected scrap." },
      ],
    },
    scrap_spent: {
      description: "Scrap spent, at a store or on upgrades.",
      rules: [
        {
          tally: true,
          summary: "Spent {data.amount} scrap, {data.scrap} left.",
        },
        { tally: true, summary: "Spent scrap." },
      ],
    },
    out_of_fuel: {
      description: "The ship has run out of fuel.",
      rules: [
        { lane: "respond", reaction: "concern", summary: "Out of fuel." },
      ],
    },
    run_lost: {
      description:
        "The run is over: the ship was destroyed or the crew all died.",
      rules: [
        {
          lane: "reflex",
          reaction: "cringe",
          summary: "The run is over: {data.cause}.",
        },
        { lane: "reflex", reaction: "cringe", summary: "The run is over." },
      ],
    },
  },
  status: {
    everyMs: 30_000,
    summary: [
      { when: { in_run: false }, summary: "At FTL's main menu." },
      "{player} in sector {location.sector} ({location.sector_name}), {location.jumps} jumps in: hull {player.hull} of {player.max_hull}, {player.scrap} scrap, {player.fuel} fuel, {player.missiles} missiles, {player.drone_parts} drone parts.",
      // From the heartbeat, before a state arrives.
      "{player.ship}: hull {player.hull} of {player.max_hull}.",
    ],
    more: [
      {
        kind: "crew",
        description: "Their crew, each with their species and health.",
        summary: [
          { when: { crew: { exists: true } }, summary: "Crew: {crew|list}." },
          { when: { in_run: true }, summary: "No crew aboard." },
        ],
      },
      {
        kind: "systems",
        description: "Their ship's systems: power and damage.",
        summary: [
          {
            when: { systems: { exists: true } },
            summary: "Systems: {systems|list}.",
          },
        ],
      },
      {
        kind: "enemy",
        description:
          "The other ship at this beacon, if any: hull and whether it's hostile.",
        summary: [
          {
            when: { "enemy.hostile": true },
            summary:
              "Fighting the {enemy.name}: {enemy.hull} of {enemy.max_hull} hull, {enemy.crew} crew.",
          },
          {
            when: { enemy: { exists: true } },
            summary: "Another ship here: the {enemy.name}.",
          },
          { when: { in_run: true }, summary: "No other ship here." },
        ],
      },
      {
        kind: "event",
        description:
          "The event open on screen right now, if any: its text and choices.",
        summary: [
          {
            when: { event: { exists: true } },
            summary:
              "On screen: {event.text|text} Options: {event.options|list}.",
          },
          { when: { in_run: true }, summary: "No event open." },
        ],
      },
    ],
  },
};
