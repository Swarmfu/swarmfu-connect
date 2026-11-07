import type {
  EventRule,
  GamePack,
  Lane,
  Reaction,
} from "@swarmfu/connect-protocol";

/**
 * Slay the Spire 2, through its swarmfu-connector mod (Steam Workshop, C#).
 * A draft from the mod's design, before its first build: the event types
 * are the ones it plans to send, but the field names in `data` and the state
 * file are a guess until there's a real log to check them against. Each
 * type ends in a rule that needs no fields, so a field named differently
 * makes a plainer line rather than none.
 *
 * Co-op: she may run her own copy of the game, joined to the streamer's
 * lobby. The file adapter follows both (docs/mod-guide.md, "Co-op"), so an
 * event here can be the streamer's (`player`), hers (`cohost`) or another
 * player's (`teammate`, with `data.player_name`).
 *
 * There's no in-game clock: where they are is `run.act`, `run.floor` and
 * `run.room` on each event and in the state file.
 */

/** Who did it, as each subject is named in a line. An event with no subject is the streamer's. */
const WHO: { when: EventRule["when"]; name: string }[] = [
  { when: { subject: "cohost" }, name: "{cohost}" },
  { when: { subject: "teammate" }, name: "{data.player_name}" },
  { when: { subject: "player" }, name: "{player}" },
  { when: { subject: { exists: false } }, name: "{player}" },
];

/**
 * Rules for something a player does: each template (with `{who}` for whoever
 * it was) for each subject, then the same without the name, then `plain`.
 */
function byWho(
  templates: string[],
  plain: string,
  rule: { lane?: Lane; tally?: boolean; reaction?: Reaction } = {},
): EventRule[] {
  const named = WHO.flatMap(({ when, name }) =>
    templates.map((template) => ({
      ...rule,
      ...(when ? { when } : {}),
      summary: template.replaceAll("{who}", name),
    })),
  );
  return [
    ...named,
    ...templates.map((template) => ({
      ...rule,
      summary: template.replaceAll("{who}", "Someone"),
    })),
    { ...rule, summary: plain },
  ];
}

export const slaythespire2: GamePack = {
  id: "slaythespire2",
  game: "Slay the Spire 2",
  version: "0",
  role: "spectator",
  folder: {
    darwin: "~/Library/Application Support/SlayTheSpire2/swarmfu",
    win32: "~/AppData/Roaming/SlayTheSpire2/swarmfu",
    linux: "~/.local/share/SlayTheSpire2/swarmfu",
  },
  player: ["{player.name}", "{player.character}"],
  events: {
    run_started: {
      description: "A run began, with the character and the ascension.",
      rules: byWho(
        [
          "{who} started a run as the {data.character|words} on ascension {data.ascension}.",
          "{who} started a run as the {data.character|words}.",
        ],
        "A new run started.",
        { lane: "respond" },
      ),
    },
    run_ended: {
      description: "The run ended: won, or how far they got.",
      rules: [
        {
          when: { "data.victory": true },
          lane: "respond",
          reaction: "triumph",
          summary: "{player} won the run!",
        },
        {
          when: { "data.victory": true },
          lane: "respond",
          reaction: "triumph",
          summary: "The run was won!",
        },
        {
          lane: "respond",
          reaction: "concern",
          summary:
            "The run ended on floor {run.floor}, killed by {data.killed_by|words}.",
        },
        {
          lane: "respond",
          reaction: "concern",
          summary: "The run ended on floor {run.floor}.",
        },
        { lane: "respond", summary: "The run ended." },
      ],
    },
    room_entered: {
      description:
        "They went into the next room on the map: a fight, an elite, a shop, a rest site, an event, a chest.",
      rules: [
        {
          summary:
            "Floor {run.floor} of act {run.act}: a {data.room|words} room.",
        },
        { summary: "Floor {run.floor}: a {run.room|words} room." },
        { summary: "They went into the next room." },
      ],
    },
    combat_started: {
      description: "A fight began, against whom.",
      rules: [
        { summary: "A fight started against {data.enemies|list}." },
        { summary: "A fight started." },
      ],
    },
    combat_won: {
      description: "Every enemy in the fight is dead.",
      rules: [
        {
          lane: "respond",
          summary: "The fight is won, in {data.turns} turns.",
        },
        { lane: "respond", summary: "The fight is won." },
      ],
    },
    turn_started: {
      description: "A new turn in a fight.",
      rules: [
        { summary: "Turn {data.turn} of the fight." },
        { summary: "A new turn." },
      ],
    },
    card_played: {
      description: "A card was played, on what.",
      rules: byWho(
        [
          "{who} played {data.card} on {data.target}.",
          "{who} played {data.card}.",
        ],
        "A card was played.",
        {
          tally: true,
        },
      ),
    },
    damage_taken: {
      description: "A player lost HP, how much and from what.",
      rules: [
        // A big hit is worth a word; the rest is the pace of the fight.
        ...byWho(
          [
            "{who} took {data.amount} damage from {data.source}.",
            "{who} took {data.amount} damage.",
          ],
          "A big hit landed.",
          {
            lane: "respond",
            reaction: "flinch",
          },
        ).map((rule) => ({
          ...rule,
          when: { ...rule.when, "data.amount": { gte: 15 } },
        })),
        ...byWho(
          [
            "{who} took {data.amount} damage from {data.source}.",
            "{who} took {data.amount} damage.",
          ],
          "Someone took damage.",
          {
            tally: true,
          },
        ),
      ],
    },
    enemy_killed: {
      description: "An enemy died, and who killed it.",
      rules: byWho(["{who} killed the {data.enemy}."], "An enemy died.", {
        tally: true,
      }),
    },
    power_gained: {
      description: "A player gained a power or a buff (or a debuff).",
      rules: byWho(["{who} gained {data.power}."], "A power was gained."),
    },
    card_added: {
      description: "A card went into a deck.",
      rules: byWho(
        ["{who} added {data.card} to their deck."],
        "A card was added to a deck.",
      ),
    },
    card_removed: {
      description: "A card was taken out of a deck.",
      rules: byWho(
        ["{who} removed {data.card} from their deck."],
        "A card was removed from a deck.",
      ),
    },
    card_upgraded: {
      description: "A card was upgraded.",
      rules: byWho(["{who} upgraded {data.card}."], "A card was upgraded."),
    },
    relic_gained: {
      description: "A player got a relic.",
      rules: byWho(
        ["{who} got the {data.relic} relic.", "{who} got {data.relic}."],
        "A relic was found.",
        {
          lane: "respond",
        },
      ),
    },
    potion_used: {
      description: "A potion was used, on what.",
      rules: byWho(["{who} used a {data.potion}."], "A potion was used."),
    },
    gold_changed: {
      description: "A player's gold went up or down.",
      rules: [
        ...byWho(["{who} now has {data.gold} gold."], "Gold changed.", {
          tally: true,
        }),
      ],
    },
    event_choice: {
      description: "A choice at an event room, and what came of it.",
      rules: byWho(
        [
          "At {data.event}, {who} chose to {data.choice}.",
          "{who} chose to {data.choice}.",
        ],
        "A choice was made at an event.",
        {
          lane: "respond",
        },
      ),
    },
    shop_purchase: {
      description: "Something bought at a shop, and for how much.",
      rules: byWho(
        [
          "{who} bought {data.item} for {data.cost} gold.",
          "{who} bought {data.item}.",
        ],
        "Something was bought at the shop.",
      ),
    },
    rest_choice: {
      description:
        "What a player did at a rest site: rest, upgrade, or something else.",
      rules: byWho(
        ["{who} chose to {data.choice} at the rest site."],
        "A choice was made at the rest site.",
      ),
    },
    boss_reached: {
      description: "The act's boss fight is next.",
      rules: [
        {
          lane: "respond",
          reaction: "concern",
          summary: "The boss of act {run.act} is next: {data.boss}.",
        },
        { lane: "respond", reaction: "concern", summary: "The boss is next." },
      ],
    },
    control_changed: {
      description:
        "Whether she may act in the game changed, from the game's own switch.",
      rules: [
        {
          when: { "data.enabled": false },
          summary: "{player} turned off her control of the game.",
        },
        {
          when: { "data.enabled": true },
          summary: "{player} let her act in the game ({data.mode} mode).",
        },
      ],
    },
    // For when she plays (control); until then there's nothing she can do with them.
    decision_needed: { description: "It's her move.", rules: [{ drop: true }] },
    command_result: {
      description: "What came of a move she sent.",
      rules: [{ drop: true }],
    },
  },
  status: {
    everyMs: 5_000,
    summary: [
      "{player} is on floor {run.floor} of act {run.act}, with {player.hp} of {player.max_hp} HP and {player.gold} gold.",
      "{player} is on floor {run.floor} of act {run.act}.",
    ],
  },
};
