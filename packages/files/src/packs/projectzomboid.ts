import type { GamePack } from "@swarmfu/connect-protocol";

/**
 * Project Zomboid (Build 42), through the swarmfu-connector mod. Milestone 1:
 * sessions, spawning, kills, skill ups and deaths; milestone 2 (connector
 * 0.2.0) adds fights, chases, kill streaks, jump scares, moodles, buildings,
 * rooms, activities, weather, and a state file with threat, condition, place
 * and weather; 0.3.0 adds hits, near misses, grabs, other hurts, injuries,
 * near death, health bands, hordes, sleep, vehicles and the time of day, and
 * names distances in metres (`distance_m`); 0.4.0 adds items taken, stored
 * and dropped, doors, windows and barricades, sounds heard, the TV and
 * radio, body build, and what they carry and weigh in the state file.
 *
 * Every kill and every hit is its own event, tallied, so she follows the
 * pace of a fight. A kill's distance isn't danger (a machete kill is always
 * under a metre): close calls are the mod's hits and near misses.
 */

export const projectzomboid: GamePack = {
  id: "projectzomboid",
  game: "Project Zomboid",
  version: "4",
  role: "spectator",
  folder: {
    darwin: "~/Zomboid/Lua/swarmfu-connector",
    win32: "~/Zomboid/Lua/swarmfu-connector",
    linux: "~/Zomboid/Lua/swarmfu-connector",
  },
  player: [
    "{player.username}",
    "{player.forename} {player.surname}",
    "{player.forename}",
  ],
  world: "game.save",
  events: {
    session_start: {
      description: "The user loaded into a save.",
      rules: [
        {
          summary: "{player} loaded into their {data.mode} save, {data.save}.",
        },
        { summary: "{player} loaded into a save." },
      ],
    },
    player_spawned: {
      description: "Their character spawned, with who they are so far.",
      rules: [
        {
          summary:
            "{player} spawned: a {data.player.profession}, {data.player.hours_survived|0} hours survived, {data.player.zombie_kills} kills so far.",
        },
        { summary: "{player} spawned." },
      ],
    },
    zombie_killed: {
      description:
        "A zombie died near the player; whether they killed it, with what, and how close.",
      rules: [
        // Not their kill, and nothing they did: noise for commentary.
        { when: { "data.by_local_player": false }, drop: true },
        // distance_m from connector 0.3.0; distance before it.
        {
          tally: true,
          summary:
            "{player} killed a zombie with the {data.weapon}, {data.distance_m|1} m away.",
        },
        {
          tally: true,
          summary:
            "{player} killed a zombie with the {data.weapon}, {data.distance|1} m away.",
        },
        // Bare-handed kills come without a weapon.
        {
          tally: true,
          summary: "{player} killed a zombie, {data.distance_m|1} m away.",
        },
        {
          tally: true,
          summary: "{player} killed a zombie, {data.distance|1} m away.",
        },
        { tally: true, summary: "{player} killed a zombie." },
      ],
    },
    fight_end: {
      description:
        "A fight ended: how long, kills, hits landed, the most attacking at once, and health lost.",
      rules: [
        // Hurt, or outnumbered: the moments worth a word.
        {
          when: { "data.health_lost": { gt: 0 } },
          lane: "respond",
          tally: true,
          summary:
            "{player} came out of a {data.duration_s|0} s fight hurt (lost {data.health_lost|1} health): {data.kills} down, up to {data.peak_attackers} on them at once.",
        },
        {
          when: { "data.peak_attackers": { gte: 3 } },
          lane: "respond",
          tally: true,
          summary:
            "{player} fought off {data.peak_attackers} at once in {data.duration_s|0} s, {data.kills} down, unhurt.",
        },
        {
          tally: true,
          summary:
            "{player} won a {data.duration_s|0} s fight unhurt, {data.kills} down in {data.hits} hits.",
        },
      ],
    },
    kill_streak: {
      description: "Several kills in a few seconds.",
      rules: [
        {
          lane: "respond",
          summary:
            "{player} killed {data.kills} in {data.window_s|0} s with the {data.weapon}.",
        },
        {
          lane: "respond",
          summary: "{player} killed {data.kills} in {data.window_s|0} s.",
        },
      ],
    },
    jump_scare: {
      description:
        "A zombie was suddenly revealed close by (a door opened, a corner turned).",
      rules: [
        {
          lane: "reflex",
          reaction: "startle",
          summary:
            "A zombie appeared out of nowhere {data.distance_m|1} m from {player}!",
        },
        {
          lane: "reflex",
          reaction: "startle",
          summary:
            "A zombie appeared out of nowhere {data.distance|1} m from {player}!",
        },
        {
          lane: "reflex",
          reaction: "startle",
          summary: "A zombie appeared out of nowhere next to {player}!",
        },
      ],
    },
    chase_start: {
      description: "Zombies started chasing the player.",
      rules: [
        {
          when: { "data.pursuers": { gte: 3 } },
          lane: "reflex",
          reaction: "panic",
          summary: "{data.pursuers} zombies are chasing {player}.",
        },
        {
          lane: "reflex",
          reaction: "concern",
          summary: "{data.pursuers} zombies are chasing {player}.",
        },
      ],
    },
    chase_end: {
      description:
        "A chase ended: escaped or fought off, how long, the most chasing, kills and health lost.",
      rules: [
        {
          when: { "data.outcome": "escaped" },
          lane: "respond",
          summary:
            "{player} got away after a {data.duration_s|0} s chase, up to {data.peak_pursuers} behind them, {data.kills_during} down on the way, {data.health_lost|1} health lost.",
        },
        {
          lane: "respond",
          summary:
            "{player}'s {data.duration_s|0} s chase ended ({data.outcome|words}): up to {data.peak_pursuers} behind them, {data.kills_during} down.",
        },
      ],
    },
    moodle_increased: {
      description:
        "One of the player's moodles (panic, stress, hunger, endurance…) went up a level, of 4.",
      rules: [
        // Worth a word: real panic, or anything at its worst. (Heavy load at 3 isn't.)
        {
          when: { "data.moodle": "panic", "data.level": { gte: 3 } },
          lane: "respond",
          summary:
            "{player}'s panic is at level {data.level} of 4.",
        },
        {
          when: { "data.level": { gte: 4 } },
          lane: "respond",
          summary:
            "{player}'s {data.moodle|words} is at its worst, level 4 of 4.",
        },
        {
          summary:
            "{player}'s {data.moodle|words} went up to level {data.level} of 4.",
        },
      ],
    },
    moodle_decreased: {
      description: "One of the player's moodles eased a level.",
      rules: [
        { summary: "{player}'s {data.moodle|words} eased to level {data.level} of 4." },
      ],
    },
    player_hit: {
      description:
        "A zombie's attack connected: the wound it left (or none, if clothing stopped it), from behind or not, health lost.",
      rules: [
        // A bite is the moment of a run: always worth words.
        {
          when: { "data.wounded": true, "data.injury": "bite" },
          lane: "respond",
          tally: true,
          summary: "A zombie bit {player} on the {data.body_part|words}!",
        },
        {
          when: { "data.wounded": true, "data.bleeding": true },
          lane: "respond",
          tally: true,
          summary:
            "A zombie got {player}: a {data.injury|words} on the {data.body_part|words}, bleeding.",
        },
        {
          when: { "data.wounded": true },
          lane: "respond",
          tally: true,
          summary:
            "A zombie got {player}: a {data.injury|words} on the {data.body_part|words}.",
        },
        {
          when: { "data.from_behind": true },
          lane: "reflex",
          reaction: "flinch",
          tally: true,
          summary: "A zombie hit {player} from behind, but their clothes stopped it.",
        },
        {
          lane: "reflex",
          reaction: "flinch",
          tally: true,
          summary: "A zombie hit {player}, but their clothes stopped it.",
        },
      ],
    },
    near_miss: {
      description: "A zombie attacked the player and missed, or was interrupted mid-attack.",
      rules: [
        {
          when: { "data.outcome": "interrupted" },
          lane: "reflex",
          reaction: "startle",
          tally: true,
          summary: "A zombie went for {player} but was cut off, {data.distance_m|1} m away.",
        },
        {
          when: { "data.from_behind": true },
          lane: "reflex",
          reaction: "startle",
          tally: true,
          summary: "A zombie went for {player} from behind and {data.outcome}, {data.distance_m|1} m away.",
        },
        {
          lane: "reflex",
          reaction: "startle",
          tally: true,
          summary: "A zombie went for {player} and {data.outcome}, {data.distance_m|1} m away.",
        },
      ],
    },
    player_grabbed: {
      description: "Something grabbed the player.",
      rules: [
        {
          lane: "reflex",
          reaction: "panic",
          summary: "Something grabbed {player}!",
        },
      ],
    },
    grab_escaped: {
      description: "The player broke free of a grab.",
      rules: [
        {
          lane: "respond",
          summary: "{player} broke free after {data.duration_s|1} s.",
        },
      ],
    },
    player_hurt: {
      description: "The player got hurt by something other than a zombie: a fall, fire, a car, a weapon.",
      rules: [
        {
          when: { "data.cause": "fire" },
          lane: "respond",
          summary: "{player} got burned for {data.duration_s|0} s and lost {data.health_lost|1} health.",
        },
        {
          when: { "data.cause": "fall" },
          lane: "respond",
          summary: "{player} fell and lost {data.health_lost|1} health.",
        },
        {
          lane: "respond",
          summary: "{player} got hurt ({data.cause|words}) and lost {data.health_lost|1} health.",
        },
      ],
    },
    injury: {
      description: "A new wound on the player that didn't come from a zombie's hit.",
      rules: [
        {
          when: { "data.bleeding": true },
          lane: "respond",
          summary: "{player} has a new {data.injury|words} on the {data.body_part|words}, bleeding.",
        },
        {
          lane: "respond",
          summary: "{player} has a new {data.injury|words} on the {data.body_part|words}.",
        },
      ],
    },
    near_death: {
      description: "The player's health fell close to zero.",
      rules: [
        {
          lane: "respond",
          summary:
            "{player} is close to death: {data.health|0} health, {data.bleeding_parts} parts bleeding, {data.chasing} zombies chasing.",
        },
        { lane: "respond", summary: "{player} is close to death." },
      ],
    },
    health_changed: {
      description: "The player's overall health moved to another band: healthy, hurt, badly hurt, critical.",
      rules: [
        {
          when: { "data.band": "healthy" },
          summary: "{player} is healthy again ({data.health|0} health).",
        },
        {
          when: { "data.band": "hurt" },
          summary: "{player} is hurt ({data.health|0} health).",
        },
        {
          lane: "respond",
          summary: "{player} is {data.band|words} now ({data.health|0} health).",
        },
      ],
    },
    horde_sighted: {
      description: "A crowd of zombies came into the player's view.",
      rules: [
        {
          lane: "respond",
          summary:
            "{player} can see {data.visible} zombies, the nearest {data.nearest_visible_m|0} m away; {data.chasing} chasing.",
        },
        {
          lane: "respond",
          summary: "{player} can see {data.visible} zombies.",
        },
      ],
    },
    sleep_started: {
      description: "The player went to sleep.",
      rules: [
        { summary: "{player} went to sleep in the {data.room|words}." },
        { summary: "{player} went to sleep." },
      ],
    },
    woke_up: {
      description: "The player woke up.",
      rules: [
        { summary: "{player} woke up after {data.slept_hours|1} hours." },
        { summary: "{player} woke up." },
      ],
    },
    vehicle_entered: {
      description: "The player got into a vehicle.",
      rules: [
        {
          when: { "data.driver": true },
          summary: "{player} got behind the wheel of the {data.vehicle|words}.",
        },
        { summary: "{player} got into the {data.vehicle|words}." },
        { summary: "{player} got into a vehicle." },
      ],
    },
    vehicle_exited: {
      description: "The player got out of a vehicle.",
      rules: [
        { summary: "{player} got out of the {data.vehicle|words}." },
        { summary: "{player} got out of a vehicle." },
      ],
    },
    day_phase_changed: {
      description: "The time of day moved on: dawn, day, dusk, night.",
      rules: [{ summary: "It's {data.phase|words} now." }],
    },
    building_entered: {
      description: "The player went into a building.",
      rules: [
        {
          when: { "data.first_visit_this_session": true },
          summary:
            "{player} went into a building they haven't been in yet, through the {data.room|words}.",
        },
        { summary: "{player} went back into a building, through the {data.room|words}." },
      ],
    },
    building_exited: {
      description: "The player left a building.",
      rules: [
        {
          when: { "data.to_building": false },
          summary: "{player} went outside.",
        },
        { summary: "{player} left the building." },
      ],
    },
    weather_changed: {
      description: "The weather changed.",
      rules: [
        {
          subject: "world",
          summary:
            "The weather turned {data.weather|words} (it was {data.previous|words}), {data.temperature_c|0} °C.",
        },
        { subject: "world", summary: "The weather turned {data.weather|words}." },
      ],
    },
    skill_up: {
      description: "One of the player's skills went up a level.",
      rules: [
        {
          lane: "respond",
          summary: "{player}'s {data.skill} went up to level {data.level}.",
        },
      ],
    },
    player_died: {
      description: "The player's character died.",
      rules: [
        // `death` skips her cooldowns: always worth a moment.
        {
          kind: "death",
          lane: "respond",
          summary: "{player} died, in the {data.room}.",
        },
        { kind: "death", lane: "respond", summary: "{player} died." },
      ],
    },
    room_entered: {
      description: "The player walked into another room of a building.",
      rules: [{ summary: "{player} went into the {data.room|words}." }],
    },
    activity: {
      description:
        "The player finished doing something: reading, crafting, gathering, eating.",
      rules: [
        {
          when: { "data.activity": "read" },
          summary: "{player} read {data.title}.",
        },
        // What they ate, and what they moved or put on: the second play test asked.
        { when: { "data.activity": "eat" }, summary: "{player} ate {data.item}." },
        { when: { "data.activity": "eat" }, summary: "{player} ate." },
        {
          when: { "data.activity": "craft" },
          summary: "{player} finished crafting: {data.recipe}.",
        },
        { summary: "{player} finished: {data.activity|words}, a {data.furniture}." },
        { summary: "{player} finished: {data.activity|words}, the {data.item}." },
        { summary: "{player} finished: {data.activity|words} ({data.category|words})." },
      ],
    },
    items_taken: {
      description: "The player took items from somewhere: a fridge, a crate, a corpse, the ground.",
      rules: [
        {
          when: { "data.more_kinds": { gt: 0 } },
          tally: true,
          summary: "{player} took {data.items|list} and {data.more_kinds} more kinds of things from the {data.from}.",
        },
        { tally: true, summary: "{player} took {data.items|list} from the {data.from}." },
        { tally: true, summary: "{player} took {data.items|list}." },
      ],
    },
    items_stored: {
      description: "The player put items into a container that isn't theirs.",
      rules: [
        {
          when: { "data.more_kinds": { gt: 0 } },
          tally: true,
          summary: "{player} put {data.items|list} and {data.more_kinds} more kinds of things in the {data.into}.",
        },
        { tally: true, summary: "{player} put {data.items|list} in the {data.into}." },
      ],
    },
    items_dropped: {
      description: "The player dropped or placed items on the floor.",
      rules: [{ tally: true, summary: "{player} dropped {data.items|list}." }],
    },
    body_build_changed: {
      description: "The player's build changed: underweight, normal, overweight and so on.",
      rules: [
        {
          lane: "respond",
          summary: "{player} went from {data.previous} to {data.build}, {data.weight_kg|0} kg.",
        },
        { lane: "respond", summary: "{player} is {data.build} now." },
      ],
    },
    door_opened: {
      description: "The player opened a door.",
      rules: [{ summary: "{player} opened the {data.door}." }],
    },
    door_closed: {
      description: "The player closed a door.",
      rules: [{ summary: "{player} closed the {data.door}." }],
    },
    door_locked: {
      description: "The player locked a door.",
      rules: [{ summary: "{player} locked the {data.door}." }],
    },
    door_unlocked: {
      description: "The player unlocked a door.",
      rules: [{ summary: "{player} unlocked the {data.door}." }],
    },
    window_opened: {
      description: "The player opened a window.",
      rules: [{ summary: "{player} opened a window." }],
    },
    window_closed: {
      description: "The player closed a window.",
      rules: [{ summary: "{player} closed a window." }],
    },
    curtains_opened: {
      description: "The player opened curtains.",
      rules: [{ summary: "{player} opened the curtains." }],
    },
    curtains_closed: {
      description: "The player closed curtains.",
      rules: [{ summary: "{player} closed the curtains." }],
    },
    window_smashed: {
      description: "The player smashed a window, of a house or a car.",
      rules: [{ summary: "{player} smashed a {data.window}." }, { summary: "{player} smashed a window." }],
    },
    barricade_added: {
      description: "The player barricaded a window or door.",
      rules: [
        { summary: "{player} barricaded a {data.target} with {data.material}." },
        { summary: "{player} barricaded a {data.target}." },
      ],
    },
    barricade_removed: {
      description: "The player took a barricade down.",
      rules: [{ summary: "{player} took the barricade off a {data.target}." }],
    },
    sound_heard: {
      description: "The player heard something: banging, a window breaking, a gunshot, an alarm, a helicopter, a scream.",
      rules: [
        // What draws a crowd, or is at their own walls, is worth a word; distant dogs aren't.
        {
          when: { "data.sound": "banging", "data.distance_m": { lte: 15 } },
          lane: "respond",
          summary: "{player} hears banging on a {data.on}, {data.where}, {data.distance_m|0} m away.",
        },
        {
          when: { "data.sound": "banging", "data.distance_m": { lte: 15 } },
          lane: "respond",
          summary: "{player} hears banging on a {data.on}, {data.distance_m|0} m away.",
        },
        ...["helicopter", "house alarm", "car alarm", "gunshot", "window breaking"].flatMap((sound) => [
          {
            when: { "data.sound": sound, "data.distance_m": { lte: 300 } },
            lane: "respond" as const,
            summary: "{player} heard a {data.sound} to the {data.direction}, {data.distance_m|0} m away.",
          },
          {
            when: { "data.sound": sound, "data.distance_m": { lte: 300 } },
            lane: "respond" as const,
            summary: "{player} heard a {data.sound}, {data.distance_m|0} m away.",
          },
        ]),
        { summary: "{player} heard {data.sound} to the {data.direction}, {data.distance_m|0} m away." },
        { summary: "{player} heard {data.sound}, {data.distance_m|0} m away." },
        { summary: "{player} heard {data.sound}." },
      ],
    },
    media_started: {
      description: "The player started watching TV or listening to the radio, or put on a tape or disc.",
      rules: [
        { summary: "{player} put on {data.show} on the {data.device}." },
        { summary: "{player} turned on the {data.device}: {data.channel}." },
        { summary: "{player} turned on the {data.device}." },
      ],
    },
    media_skill_gained: {
      description: "The player learned something from a show: the first of a skill's experience from it.",
      rules: [
        { summary: "{player} is picking up {data.skill} from {data.channel} on the {data.device}." },
        { summary: "{player} is picking up {data.skill} from the {data.device}." },
      ],
    },
    media_stopped: {
      description: "The TV or radio show they were following stopped: it ended, changed or was turned off.",
      rules: [
        {
          summary: "{player}'s {data.channel} on the {data.device} {data.reason}; it trained {data.skills_trained|list}.",
        },
        { summary: "{player}'s {data.channel} on the {data.device} {data.reason}." },
        { summary: "{player}'s {data.device} {data.reason}." },
      ],
    },
    session_end: {
      description: "The player quit to the menu or disconnected.",
      rules: [
        {
          when: { "data.reason": "main_menu" },
          summary: "{player} quit to the main menu.",
        },
        { summary: "{player} left the game." },
      ],
    },
  },
  status: {
    everyMs: 30_000,
    summary: [
      // From the state file (connector 0.2.0 and up); floor 0 is the ground floor.
      {
        when: { "place.floor": { gte: 1 } },
        summary:
          "{player} is in the {place.room|words}, {place.floor} floors up, {condition.band}; {threat.nearby} zombies nearby, {threat.chasing} chasing. {weather.label}, {day_phase}, {time}.",
      },
      "{player} is in the {place.room|words}, {condition.band}; {threat.nearby} zombies nearby, {threat.chasing} chasing. {weather.label}, {day_phase}, {time}.",
      "{player} is outdoors, {condition.band}; {threat.nearby} zombies nearby, {threat.chasing} chasing. {weather.label}, {day_phase}, {time}.",
      // From the heartbeat alone.
      "{player}, a {player.profession}, has survived {player.hours_survived|0} hours with {player.zombie_kills} kills; in the game it's {time}.",
    ],
    // Connector 0.4.0: what the second play test asked her and she couldn't say.
    more: [
      {
        kind: "carrying",
        description: "How much the player carries, and what kinds of things.",
        summary: [
          "{player} carries {carrying.weight_kg|1} of {carrying.capacity_kg|0} kg: {inventory.item_count} things ({inventory.categories|list}).",
          "{player} carries {carrying.weight_kg|1} of {carrying.capacity_kg|0} kg.",
        ],
      },
      {
        kind: "gear",
        description: "The player's weapons, ammo, worn bags and what's in hand.",
        summary: [
          "{player}'s weapons: {inventory.weapons|list}; ammo: {inventory.ammo|list}; bags: {inventory.bags|list}; in hand: {equipped.primary}.",
          "{player}'s weapons: {inventory.weapons|list}; bags: {inventory.bags|list}; in hand: {equipped.primary}.",
          "{player}'s weapons: {inventory.weapons|list}; ammo: {inventory.ammo|list}; bags: {inventory.bags|list}.",
          "{player}'s weapons: {inventory.weapons|list}; bags: {inventory.bags|list}.",
          "{player}'s bags: {inventory.bags|list}.",
        ],
      },
      {
        kind: "body",
        description: "The player's body: weight, build, moodles, sneaking.",
        summary: [
          { when: { "movement.sneaking": true }, summary: "{player} weighs {body.weight_kg|0} kg ({body.build}, {body.trend}), is sneaking; moodles (of 4): {condition.moodles|list}." },
          "{player} weighs {body.weight_kg|0} kg ({body.build}, {body.trend}); moodles (of 4): {condition.moodles|list}.",
          { when: { "movement.sneaking": true }, summary: "{player} weighs {body.weight_kg|0} kg ({body.build}, {body.trend}), is sneaking, and has no moodles." },
          "{player} weighs {body.weight_kg|0} kg ({body.build}, {body.trend}) and has no moodles.",
          "{player} weighs {body.weight_kg|0} kg ({body.build}); moodles (of 4): {condition.moodles|list}.",
          "{player} weighs {body.weight_kg|0} kg ({body.build}) and has no moodles.",
        ],
      },
      {
        kind: "watching",
        description: "The TV or radio the player is following.",
        summary: [
          "{player} has {media.channel} on the {media.device}: {media.show}, {media.minutes|0} min in.",
          "{player} has {media.channel} on the {media.device}, {media.minutes|0} min in.",
          // Only a connector that reports media (0.4.0, which also reports carrying) can say nothing's on.
          {
            when: { "media.device": { exists: false }, "carrying.weight_kg": { exists: true } },
            summary: "Nothing's on the TV or radio.",
          },
        ],
      },
    ],
  },
};
