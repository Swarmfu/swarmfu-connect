# Writing a game connector

A connector is a mod (or plugin, or script) that lets Swarmfu's co-host follow
a game: it writes what happens in the game to a few files, and Swarmfu's file
adapter reads them. You don't write any Swarmfu code. To add a game:

1. Write the mod, following the file protocol below.
2. Write a **game pack**: a short declarative file that tells the adapter what
   each of your event types means to her (see [Game packs](#game-packs)).
3. Add the pack to `PACKS` in `packages/files/src/packs/index.ts`, with a
   fixture of real output from your mod and a test (see CONTRIBUTING.md), and
   open a PR. Once it's released, `swarmfu` finds the game for anyone who has
   the mod installed.

The Project Zomboid connector (`swarmfu-connector`) is the reference
implementation, and `packages/files/src/packs/projectzomboid.ts` is
its pack.

## What she needs from you

She's a co-host watching the stream with the player. She can't see the
screen, so your events are her eyes. What makes her good is the same thing that
makes a friend on the couch good: she notices the close calls, how many are
left, that it's getting dark, that you've been reading for an hour. Aim for
that, not for a complete log of the game.

### The rules we've learned so far

These came from real sample data. Add to them when you find a new one.

- **One moment, one event.** A kill, a hit taken, a skill up, a door opened
  onto three zombies: each is its own line, written when it happens. Don't
  replace them with "12 kills this fight". She uses the pace and the detail
  ("that one was close", "two left"), and the adapter shows her how often
  each kind is happening.
- **Put what makes the moment interesting in `data`.** For a kill that's how
  close it was and with what; for a hit, where and how bad. A field she'd never
  mention is a field to drop.
- **Send the danger itself, not a proxy for it.** In the Project Zomboid
  sample half the machete kills were under 0.3 m: that's melee range, not a
  close call. "It nearly got me" is a hit, a grab or a lunge the player
  escaped, so send those as events of their own.
- **Small and flat.** `data` is a handful of fields, not a nested dump of the
  game object. Numbers in real units (metres, in-game minutes, percent), named
  in the key (`distance_m` is better than `distance`).
- **Say whose it is.** Set `subject` on every event: `player` (the person
  playing), `other` (another player or character), or `world` (weather, time,
  a horde passing). An event about something the player didn't do is still
  useful when it says so.
- **Only what the player could know.** Leave out hidden information (an
  infection the game hasn't shown, enemies behind walls) unless a mod setting
  turns it on. She shouldn't spoil the game.
- **Names stay put.** Pick one field for the character's name and keep it the
  same for the whole session. Don't send placeholders before the character has
  loaded.
- **State is the heartbeat, changes are events.** The heartbeat says how things
  are right now. When something worth noticing changes (a moodle goes up a
  level, the player goes indoors, night falls), write an event for the change.
  Don't copy heartbeats into the events stream.
- **Derived moments are welcome, alongside.** A chase starting, a jump scare
  when a door opens, a kill streak, a fight's end: send them as events of their
  own, as well as the moments they're made of, never instead of them. Packs
  are data and can't count, so a streak or a fight summary only exists if the
  mod sends it, and it's what lets her say something about the fight as a
  whole.
- **Changes go both ways.** If you report a level going up, report it going
  down too, so `previous` always matches the last event. (In the Zomboid
  sample, panic went 0→2 twice with no drop in between.)
- **One spelling per value.** The same weapon shouldn't come as both
  "Bare Hands" and "bare hands"; a list shouldn't repeat an item.
- **Natural language, because she says it out loud.** Any value that can end
  up in one of her sentences (a name, an item, a room, a weather, a cause)
  should be plain words, as the player sees them: "Chevalier Nyala", not
  `Base.CarNormal`; "left forearm", not `ForeArm_L`; "garage storage", not
  `garagestorage`; "heavy rain", not `heavy_rain`. Her lines go to a voice
  model, which reads symbols aloud: an underscore comes out as "underscore",
  and dotted or camel-case ids come out as gibberish. Use the game's own
  display names where it has them. The adapter turns underscores into spaces
  as a safety net, but that's all it can fix.
- **Ids are for matching, not for reading.** Keep a stable id next to the
  name when a pack might need it in a `when` (`skill_id: "LongBlade"` beside
  `skill: "Long Blade"`). Summaries use the name.
- **Debounce noisy signals.** A stat that flickers between two levels, or a
  count that changes every tick, should be written when it settles, or at most
  every few seconds.

## The file protocol

All files go in one folder the game lets mods write to, e.g.
`~/Zomboid/Lua/swarmfu-connector/`. The pack says where it is on each OS. A
game that can write anywhere also leaves a pointer to it (see "Finding the
files").

| File | Written | Holds |
| --- | --- | --- |
| `manifest.json` | when a session starts, and when the events file changes | the session and the name of the events file being written |
| `events-<session>-<part>.log` | appended | the event stream, one JSON object per line (JSON Lines; any extension the game allows) |
| `heartbeat.json` | every 2 s, overwritten | liveness and the current state |

Write each overwritten file in one go (to a temporary name and then rename it,
if the game lets you). If it can't, that's fine: the adapter ignores a file it
catches half-written and reads it again on its next look, half a second later.

### `manifest.json`

```json
{
  "v": 1,
  "source": "projectzomboid",
  "connector": "swarmfu-connector",
  "connector_version": "0.1.0",
  "session": "1793850179137-44708",
  "started_at": 1793850179137,
  "events_file": "events-1793850179137-44708-1.log",
  "game": { "version": "42.21.0", "mode": "Apocalypse", "save": "My save", "multiplayer": false }
}
```

- `source` is the game's id, the same as the pack's `id`.
- `session` is new every time the player loads in. A new session starts a new
  events file.
- `events_file` is the file being written now. Roll to a new part (and
  rewrite the manifest) when a file gets big; 10 MB is a good limit. The
  adapter follows the manifest, so name the files however you like.
- `game.save` (or whatever tells one world from another) lets her keep things
  she learns per world.

### Events

```json
{"v":1,"source":"projectzomboid","connector":"swarmfu-connector","session":"1793850179137-44708",
 "seq":3,"ts":1793850318661,"game_time":{"year":1993,"month":11,"day":16,"hour":14,"minute":30},
 "type":"zombie_killed","subject":"player",
 "data":{"weapon":"Machete","distance_m":0.2,"total_kills":104}}
```

| Field | |
| --- | --- |
| `v` | the protocol version, 1 |
| `source`, `connector`, `session` | as in the manifest |
| `seq` | 1, 2, 3… within the session. A gap tells the adapter lines were lost. |
| `ts` | real time, epoch milliseconds |
| `game_time` | the in-game clock, if the game has one: any of `year`, `month`, `day`, `hour`, `minute` |
| `type` | snake_case, declared in your pack |
| `subject` | `player` (the person streaming), `cohost` (her own character, in co-op), `teammate` (another human on the team, with `data.player_name`), `other` (someone or something not on the team) or `world` |
| `data` | the event's detail, small and flat |

Always send `session_start` first in a session (with the game version and the
player's character) and `session_end` when the player quits to the menu, if
the game tells you. The adapter doesn't rely on `session_end`: a game that
crashes never sends it, so the heartbeat is what says it's gone.

### `heartbeat.json`

```json
{
  "v": 1, "session": "1793850179137-44708", "ts": 1793850663511, "seq": 15,
  "paused": false, "game_speed": 1,
  "game_time": { "year": 1993, "month": 11, "day": 16, "hour": 16, "minute": 5 },
  "player": { "username": "Bob", "profession": "veteran", "hours_survived": 166.9, "zombie_kills": 114 },
  "buffered": 0, "dropped": 0, "write_errors": 0
}
```

- `ts` every 2 seconds. A heartbeat older than 10 seconds means the game has
  closed or crashed.
- `paused` and `game_speed`, if the game has them.
- `seq` is the last event's `seq`.
- Anything else is the current state, for her to answer "what's happening right
  now?": the character, their condition, where they are. The pack decides which
  of it she reads.
- `buffered`, `dropped` and `write_errors` say whether the mod is keeping up.

Debug files (every heartbeat of a session, say) are fine while you build, as
long as they have other names and are off in a release.

### Finding the files

A game that can only write inside its own folder (Project Zomboid) needs
nothing more: the pack names the folder. A game that can write anywhere also
leaves a **pointer file**, so swarmfu finds it wherever it is and can tell
two running copies apart.

Pointers go in `~/.swarmfu/connectors/` (`%USERPROFILE%\.swarmfu\connectors\`
on Windows), one per running copy of the game, named `<source>-<instance>.json`.
Write it when the game starts and remove it when it closes cleanly:

```json
{ "v": 1, "source": "mygame", "connector": "swarmfu-connector",
  "instance": "a91f", "root": "/Users/me/Library/Application Support/MyGame/swarmfu",
  "pid": 48213, "updated": 1762300123456 }
```

- `root` is the folder holding that copy's `manifest.json`, as an absolute path.
- A pointer whose folder's heartbeat has stopped is treated as closed, so a
  crash that leaves one behind does no harm.

### More in the manifest

All optional. Without them she watches a single copy of the game.

```json
{
  "capabilities": ["events", "state", "control"],
  "instance": "a91f",
  "perspective": "cohost",
  "group": "run 7F3K2",
  "commands_file": "commands-1762300000000-48213.log",
  "speech": { "machine_keys": ["id", "*_id", "args"] }
}
```

- `capabilities`: what the connector does. `control` means it reads commands
  from `commands_file` (coming with control; she only watches for now).
- `instance`: unique per running copy of the game, as in its pointer.
- `perspective`: whose copy this is. `streamer` (the default) or `cohost`, her
  own copy, joined to the streamer's game as another player.
- `group`: copies with the same group are in one shared session, a co-op lobby.
- `commands_file`: where commands will go, a bare file name, new each session.
- `speech.machine_keys`: keys that are for machines and never read to her:
  exact names, or `*_id` for any ending in `_id`. The default is
  `id`, `*_id` and `args`. Give every value a person would read its own
  `label` or name instead.

### Co-op

When she plays her own copy of the game in the streamer's lobby, both copies
describe the same run. swarmfu follows the streamer's copy and hers in the
same `group` as one play session:

- What happens comes from the **streamer's** copy. Mark her character there as
  a `teammate` with its `data.player_name` (or `data.name`), like any other player.
- From **her** copy, swarmfu reads only events whose `subject` is `cohost`,
  plus `decision_needed`, `command_result` and `control_changed`. Her copy
  should send her own character's events as `cohost`.
- swarmfu drops the streamer copy's `teammate` events whose `player_name` is
  her character's name (from her copy's heartbeat, through the pack's
  `player` templates), since her copy tells those.
- With only her copy running, it tells everything.

In a pack, `{cohost}` is her character's name and `{player}` the streamer's.

## Game packs

A pack is data: no code runs from it. It lives in
`packages/files/src/packs/`, one file per game.

```ts
export const projectzomboid: GamePack = {
  id: "projectzomboid",           // the connector's `source`
  game: "Project Zomboid",
  version: "1",
  role: "spectator",              // she watches; "player" if she plays in the game herself
  folder: { darwin: "~/Zomboid/Lua/swarmfu-connector", win32: "~/Zomboid/Lua/swarmfu-connector", linux: "~/Zomboid/Lua/swarmfu-connector" },
  player: "player.username",      // where the heartbeat keeps the character's name, `{player}` in summaries
  world: "game.save",             // where the manifest keeps what tells worlds apart
  events: {
    zombie_killed: {
      description: "A zombie died near the player: theirs or not, with what, how close.",
      rules: [
        { when: { "data.by_local_player": false }, drop: true },
        { tally: true, summary: "{player} killed a zombie with the {data.weapon}, {data.distance_m|1} m away." },
        { tally: true, summary: "{player} killed a zombie." },
      ],
    },
    player_hit: {
      description: "A zombie hit or grabbed the player.",
      rules: [{ lane: "reflex", reaction: "flinch", tally: true, summary: "A zombie got {player} in the {data.body_part}." }],
    },
  },
  status: { everyMs: 30000, summary: "{player} has survived {player.hours_survived|0} hours with {player.zombie_kills} kills; it's {time}." },
};
```

For each event `type`, a `description` (for people, and for her decider) and
a list of `rules`; the first that fits is used:

- `when` (optional): conditions on the event's fields, by dotted path. A plain
  value must match; `{ lte, gte, lt, gt }` compare numbers; `{ exists: false }`
  matches a missing field.
- `lane`: how it reaches her.
  - `reflex`: her avatar reacts at once, without a model (give a `reaction`:
    startle, flinch, panic, cringe, cheer, triumph, relief or concern). For
    sudden moments: a jump scare, a hit.
  - `respond`: she may say something. Most of these she lets pass; it's the
    candidates for "that was close!".
  - `silent`: she knows, and uses it when it comes up.
- `tally: true`: she sees how often it happens. Recent ones are listed
  together, with how long ago each was, instead of only the latest.
- `summary`: the sentence she reads, with `{path}` filled in from the event
  (`{player}` is the character's name, `{time}` the in-game clock as it's
  said, "3:05 pm"; `{path|1}` rounds a number to one decimal, `{path|words}`
  turns an id like `hang_sheet` into "hang sheet", and `{path|list}` joins a
  list, or an object's entries, with commas: "20 Nails, Rolling Papers",
  "stress 2, unhappy 1"; items that are objects read as their `label` or
  `name`, a list in a list reads with "or" between its items, and items with
  commas of their own are kept apart with semicolons; `{path|text}` keeps a
  longer passage, up to 300 characters, where a plain value is cut at 60).
  A rule whose placeholders aren't all there doesn't fit, so the next one is
  tried; an empty list doesn't fill. A part in `[[…]]` is left out instead
  when something in it is missing: `"Rewards:[[ {data.gold} gold;]][[ potions:
  {data.potions|list}]]"`. A summary is at most 600 characters.
- `drop: true`: ignore events that fit.
- `kind` (optional): the name she sees for it, if not the `type`.

A type the pack doesn't list is dropped (and logged), so a newer mod with more
events still works with an older pack.

`status` is a sentence from the state file (or the heartbeat), sent as her
picture of "right now" at most every `everyMs`, and only when it has changed.
A template can be `{ when, summary }` to apply only when its `when` fits the
state, as in event rules. `status.more` adds other "right now" lines, each
with its own `kind` (`carrying`, `body`), so she keeps the latest of each: put
what a player might ask about there (what they carry, how much they weigh),
and give each a last template that still fills when there's nothing to say
("has no moodles"), or her last line of that kind stays as it was.

### Preprocessing (planned)

Templates are instant and free, so every event goes through them. For games
where single events say little and a window of them says a lot, a pack will be
able to add a `preprocess` prompt: every so often, a small model reads the
latest window of events and writes one or two lines for her. It never sits in
front of reflexes, and it reads the game's text as data, never as
instructions.
