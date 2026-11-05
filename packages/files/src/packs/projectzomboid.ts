import type { GamePack } from "@swarmfu/connect-protocol";

/**
 * Project Zomboid (Build 42), through the swarmfu-connector mod. Milestone 1:
 * sessions, spawning, kills, skill ups and deaths; milestone 2 (connector
 * 0.2.0) adds fights, chases, kill streaks, jump scares, moodles, buildings,
 * rooms, activities, weather, and a state file with threat, condition, place
 * and weather; 0.3.0 adds hits, near misses, grabs, other hurts, injuries,
 * near death, health bands, hordes, sleep, vehicles and the time of day, and
 * names distances in metres (`distance_m`).
 *
 * Every kill and every hit is its own event, tallied, so she follows the
 * pace of a fight. A kill's distance isn't danger (a machete kill is always
 * under a metre): close calls are the mod's hits and near misses.
 */

export const projectzomboid: GamePack = {
  id: "projectzomboid",
  game: "Project Zomboid",
  version: "3",
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
        { when: { "data.activity": "eat" }, summary: "{player} ate." },
        {
          when: { "data.activity": "craft" },
          summary: "{player} finished crafting: {data.recipe}.",
        },
        { summary: "{player} finished: {data.activity|words} ({data.category|words})." },
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
      // From the state file (connector 0.2.0 and up).
      "{player} is in the {place.room|words}, {condition.band}; {threat.nearby} zombies nearby, {threat.chasing} chasing. {weather.label}, {day_phase}, {time}.",
      "{player} is outdoors, {condition.band}; {threat.nearby} zombies nearby, {threat.chasing} chasing. {weather.label}, {day_phase}, {time}.",
      // From the heartbeat alone.
      "{player}, a {player.profession}, has survived {player.hours_survived|0} hours with {player.zombie_kills} kills; in the game it's {time}.",
    ],
  },
};
