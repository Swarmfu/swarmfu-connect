import type {
  EventRule,
  GamePack,
  Lane,
  Reaction,
} from "@swarmfu/connect-protocol";

/**
 * Slay the Spire 2, through its swarmfu-connector mod (Steam Workshop, C#),
 * v0.1.0: she watches. Written from the mod's list of events and fields
 * before its first build, so it's checked against a real log next. Each
 * type ends in a rule that needs no fields, so a field that's missing or
 * named differently makes a plainer line rather than none.
 *
 * Co-op: she may run her own copy of the game, joined to the streamer's
 * lobby. The file adapter follows both (docs/mod-guide.md, "Co-op"), so an
 * event here can be the streamer's (`player`), hers (`cohost`) or another
 * player's (`teammate`, named by `data.player_name` or `data.name`).
 *
 * There's no in-game clock: where they are is `run` (`act`, `floor`,
 * `room`) on each event, absent outside a run, and in the state file.
 */

/** Who did it, as each subject is named in a line. An event with no subject is the streamer's. */
const WHO: { subject: string; when: EventRule["when"]; name: string }[] = [
  { subject: "cohost", when: { subject: "cohost" }, name: "{cohost}" },
  {
    subject: "teammate",
    when: { subject: "teammate" },
    name: "{data.player_name}",
  },
  { subject: "teammate", when: { subject: "teammate" }, name: "{data.name}" },
  { subject: "player", when: { subject: "player" }, name: "{player}" },
  { subject: "player", when: { subject: { exists: false } }, name: "{player}" },
  // Before their name or character is known.
  { subject: "player", when: { subject: "player" }, name: "the player" },
  { subject: "player", when: { subject: { exists: false } }, name: "the player" },
];

interface ByWho {
  lane?: Lane;
  tally?: boolean;
  reaction?: Reaction;
  /** Only when this fits too. */
  when?: EventRule["when"];
  /**
   * Her picture keeps the newest of each kind, so a teammate's (or her own)
   * would replace the streamer's: give each whose it is (`turn_ended`,
   * `turn_ended_hers`, `turn_ended_teammate`).
   */
  kind?: string;
}

/**
 * Rules for something a player does: each template (`{who}` for whoever it
 * was) for each subject, then the same without the name, then `plain`.
 */
function byWho(
  templates: string[],
  plain: string,
  rule: ByWho = {},
): EventRule[] {
  const { when: also, kind, ...rest } = rule;
  const kindFor = (subject: string) =>
    kind
      ? {
          kind:
            subject === "player"
              ? kind
              : `${kind}_${subject === "cohost" ? "hers" : subject}`,
        }
      : {};
  const named = WHO.flatMap(({ subject, when, name }) =>
    templates.map((template) => ({
      ...rest,
      ...kindFor(subject),
      when: { ...when, ...also },
      summary: template.replaceAll("{who}", name),
    })),
  );
  const unnamed = [
    ...templates.map((template) => template.replaceAll("{who}", "Someone")),
    plain,
  ].map((summary) => ({
    ...rest,
    ...kindFor("player"),
    ...(also ? { when: also } : {}),
    summary,
  }));
  return [...named, ...unnamed];
}

export const slaythespire2: GamePack = {
  id: "slaythespire2",
  game: "Slay the Spire 2",
  version: "1",
  role: "spectator",
  folder: {
    darwin: "~/Library/Application Support/SlayTheSpire2/swarmfu",
    win32: "~/AppData/Roaming/SlayTheSpire2/swarmfu",
    linux: "~/.local/share/SlayTheSpire2/swarmfu",
  },
  // The character's name already has its article ("The Ironclad"); before the game knows it, it's "unknown".
  control: true,
  player: ["{player.name}", { when: { "run.character": "unknown" }, summary: "the player" }, "{run.character}"],
  events: {
    session_start: {
      description: "The game opened with the connector running.",
      rules: [{ summary: "Slay the Spire 2 is open." }],
    },
    run_started: {
      description:
        "A run began or was picked up again: the character, the ascension, and in co-op who's playing.",
      rules: [
        // The mod's first build sent "unknown" for the character.
        { when: { "data.character": "unknown" }, lane: "respond", summary: "A new run started, on ascension {data.ascension}." },
        {
          when: { "data.continued": true },
          lane: "respond",
          summary: "{player} picked up their run: act {run.act}, floor {run.floor}.",
        },
        {
          when: { "data.players": { exists: true } },
          lane: "respond",
          summary:
            "A co-op run started on ascension {data.ascension}: {data.players|list}.",
        },
        {
          when: { "data.players": { exists: true } },
          lane: "respond",
          summary: "A co-op run started: {data.players|list}.",
        },
        {
          lane: "respond",
          summary:
            "A run started as {data.character}, on ascension {data.ascension}.",
        },
        { lane: "respond", summary: "A run started as {data.character}." },
        { lane: "respond", summary: "A new run started." },
      ],
    },
    run_ended: {
      description: "The run ended: won, lost (and to what), or abandoned.",
      rules: [
        {
          when: { "data.result": "victory" },
          lane: "respond",
          reaction: "triumph",
          summary: "The run is won, as {data.character}!",
        },
        {
          when: { "data.result": "victory" },
          lane: "respond",
          reaction: "triumph",
          summary: "The run is won!",
        },
        {
          when: { "data.result": "defeat" },
          lane: "respond",
          reaction: "concern",
          summary:
            "The run is over: killed by {data.killed_by} on act {data.act}, floor {data.floor}.",
        },
        {
          when: { "data.result": "defeat" },
          lane: "respond",
          reaction: "concern",
          summary: "The run is over, on floor {data.floor}.",
        },
        {
          when: { "data.result": "abandoned" },
          lane: "respond",
          summary: "The run was abandoned on floor {data.floor}.",
        },
        { lane: "respond", summary: "The run ended." },
      ],
    },
    act_started: {
      description: "A new act began.",
      rules: [
        { lane: "respond", summary: "Act {data.act} begins: {data.act_name}." },
        { lane: "respond", summary: "Act {data.act} begins." },
      ],
    },
    room_entered: {
      description:
        "They went into the next room on the map: a monster fight, an elite fight, the boss fight, an event, a shop, a rest site or treasure.",
      rules: [
        {
          when: { "data.room": "boss fight" },
          lane: "respond",
          reaction: "concern",
          summary: "Floor {data.floor}: the boss, {data.name}.",
        },
        {
          when: { "data.room": "boss fight" },
          lane: "respond",
          reaction: "concern",
          summary: "Floor {data.floor}: the boss.",
        },
        {
          when: { "data.room": "elite fight" },
          lane: "respond",
          summary: "Floor {data.floor}: an elite, {data.name}.",
        },
        { summary: "Floor {data.floor}: {data.room}, {data.name}." },
        { summary: "Floor {data.floor}: {data.room}." },
        { summary: "They went into the next room." },
      ],
    },
    combat_started: {
      description: "A fight began, against whom.",
      rules: [
        { summary: "A fight started: {data.enemies|list}." },
        { summary: "A fight started: {data.encounter}." },
        { summary: "A fight started." },
      ],
    },
    turn_started: {
      description:
        "A new turn in a fight: energy, HP, block, what's on them, the enemies and what they mean to do, and the hand. One she weighs in on.",
      rules: byWho(
        [
          "Turn {data.turn} for {who}: {data.energy} energy, {data.hp} of {data.max_hp} HP[[, {data.block} block]][[, with {data.powers|list}]]. Enemies: {data.enemies|list}.[[ Hand: {data.hand|list}.]]",
          // Before connector 0.3.0: the enemies' intents only.
          "Turn {data.turn} for {who}: {data.energy} energy, {data.hp} of {data.max_hp} HP[[, {data.block} block]].[[ Enemies: {data.enemy_intents|list}.]][[ Hand: {data.hand|list}.]]",
        ],
        "A new turn.",
        { kind: "turn_started", lane: "respond" },
      ),
    },
    turn_ended: {
      description:
        "A turn's end: the cards played, damage dealt, HP lost and block.",
      rules: byWho(
        [
          "{who}'s turn {data.turn}: played {data.cards_played|list}; dealt {data.damage_dealt}, lost {data.hp_lost} HP.",
          "{who}'s turn {data.turn}: played {data.cards_played|list}.",
          "{who} ended turn {data.turn} without playing a card.",
        ],
        "A turn ended.",
        { kind: "turn_ended" },
      ),
    },
    damage_taken: {
      description:
        "What a player took on an enemy turn: damage, how much was blocked, from whom, and the HP left.",
      rules: [
        // A big hit is worth a word; the rest is the pace of the fight.
        ...byWho(
          [
            "{who} took {data.damage} from {data.from|list}, down to {data.hp} of {data.max_hp} HP.",
            "{who} took {data.damage} damage.",
          ],
          "A big hit landed.",
          {
            lane: "respond",
            reaction: "flinch",
            when: { "data.damage": { gte: 15 } },
          },
        ),
        ...byWho(
          [
            "{who} took {data.damage} from {data.from|list} ({data.blocked} blocked), {data.hp} of {data.max_hp} HP left.",
            "{who} took {data.damage} damage.",
          ],
          "Someone took damage.",
          { tally: true },
        ),
      ],
    },
    enemy_killed: {
      description: "An enemy died, and who landed the last hit.",
      rules: [
        {
          when: { subject: "other" },
          summary: "The {data.enemy} died.",
          tally: true,
        },
        ...byWho(["{who} killed the {data.enemy}."], "An enemy died.", {
          tally: true,
        }),
      ],
    },
    player_died: {
      description:
        "A teammate died (their own death ends the run for the streamer: run_ended).",
      rules: [
        { lane: "respond", reaction: "concern", summary: "{data.name} died." },
        { lane: "respond", reaction: "concern", summary: "A teammate died." },
      ],
    },
    combat_won: {
      description:
        "Every enemy in the fight is dead: how long it took and what it cost.",
      rules: [
        {
          when: { "data.room": "boss fight" },
          lane: "respond",
          reaction: "triumph",
          summary:
            "Beat the boss, {data.encounter}, in {data.turns} turns: lost {data.hp_lost} HP, {data.hp} of {data.max_hp} left.",
        },
        {
          when: { "data.room": "boss fight" },
          lane: "respond",
          reaction: "triumph",
          summary: "The boss is beaten!",
        },
        // A cheer: a win always gets a word from her (they noticed when one didn't).
        {
          lane: "respond",
          reaction: "cheer",
          summary:
            "Won the fight against {data.encounter} in {data.turns} turns: lost {data.hp_lost} HP, {data.hp} of {data.max_hp} left.",
        },
        { lane: "respond", reaction: "cheer", summary: "Won the fight against {data.encounter}." },
        { lane: "respond", reaction: "cheer", summary: "The fight is won." },
      ],
    },
    card_added: {
      description:
        "A card went into a deck: from a reward, the shop, an event, treasure or a rest site.",
      rules: [
        ...byWho(
          ["{who} bought {data.card} for {data.price} gold."],
          "A card was bought.",
          { when: { "data.price": { exists: true } } },
        ),
        ...byWho(
          [
            "{who} took {data.card} ({data.source}).",
            "{who} took {data.card}.",
          ],
          "A card was added to a deck.",
        ),
      ],
    },
    card_removed: {
      description: "A card was taken out of a deck.",
      rules: byWho(
        [
          "{who} removed {data.card} from their deck ({data.source}).",
          "{who} removed {data.card} from their deck.",
        ],
        "A card was removed.",
      ),
    },
    card_upgraded: {
      description: "A card was upgraded.",
      rules: byWho(
        [
          "{who} upgraded {data.card} ({data.source}).",
          "{who} upgraded {data.card}.",
        ],
        "A card was upgraded.",
      ),
    },
    relic_gained: {
      description: "A relic gained: what it does, and where from.",
      rules: [
        ...byWho(
          [
            "{who} bought {data.relic} for {data.price} gold: {data.description}",
          ],
          "A relic was bought.",
          {
            lane: "respond",
            when: { "data.price": { exists: true } },
          },
        ),
        ...byWho(
          [
            "{who} got {data.relic}: {data.description}",
            "{who} got {data.relic}.",
          ],
          "A relic was found.",
          { lane: "respond", reaction: "cheer" },
        ),
      ],
    },
    relic_lost: {
      description: "A relic lost.",
      rules: byWho(["{who} lost {data.relic}."], "A relic was lost."),
    },
    potion_gained: {
      description: "A potion gained, and where from.",
      rules: [
        ...byWho(
          ["{who} bought a {data.potion} for {data.price} gold."],
          "A potion was bought.",
          { when: { "data.price": { exists: true } } },
        ),
        ...byWho(["{who} got a {data.potion}."], "A potion was found."),
      ],
    },
    potion_used: {
      description: "A potion drunk or thrown, on what.",
      rules: byWho(
        [
          "{who} used a {data.potion} on {data.target}.",
          "{who} used a {data.potion}.",
        ],
        "A potion was used.",
      ),
    },
    potion_discarded: {
      description: "A potion thrown away.",
      rules: byWho(
        ["{who} threw away a {data.potion}."],
        "A potion was thrown away.",
      ),
    },
    gold_changed: {
      description:
        "Gold went up or down (summed until it's quiet for a moment), and why.",
      rules: byWho(
        [
          "{who} has {data.gold} gold now ({data.change} from {data.source}).",
          "{who} has {data.gold} gold now.",
        ],
        "Gold changed.",
        {
          kind: "gold_changed",
        },
      ),
    },
    max_hp_changed: {
      description: "Max HP went up or down, and why.",
      rules: byWho(
        [
          "{who}'s max HP is now {data.max_hp} ({data.change}, from {data.source}).",
          "{who}'s max HP is now {data.max_hp}.",
        ],
        "Max HP changed.",
      ),
    },
    rested: {
      description: "A player rested at a rest site.",
      rules: byWho(
        ["{who} rested: {data.hp} of {data.max_hp} HP."],
        "Someone rested.",
      ),
    },
    reward_offered: {
      description: "The rewards after a fight, before they pick: gold, cards to choose from, potions, relics. One she weighs in on.",
      rules: [
        {
          when: { "data.source": "treasure" },
          lane: "respond",
          summary: "A treasure chest:[[ {data.relics|list};]][[ potions: {data.potions|list}]]",
        },
        {
          lane: "respond",
          summary:
            "Rewards:[[ {data.gold} gold;]][[ pick a card: {data.cards|list};]][[ potions: {data.potions|list};]][[ relics: {data.relics|list};]][[ also {data.other|list}]]",
        },
      ],
    },
    shop_entered: {
      description: "What the shop sells, with prices. One she weighs in on.",
      rules: [
        {
          lane: "respond",
          summary:
            "The shop has[[ cards: {data.cards|list};]][[ relics: {data.relics|list};]][[ potions: {data.potions|list};]][[ card removal for {data.card_removal}]]",
        },
        { lane: "respond", summary: "They went into the shop." },
      ],
    },
    choice_offered: {
      description:
        "A choice to make: an event, the map, a rest site, a card to pick, upgrade, transform or remove. One she weighs in on.",
      rules: [
        {
          when: { "data.kind": "map" },
          lane: "respond",
          summary: "Where next on the map: {data.options|list}.[[ The boss is {data.boss}.]]",
        },
        {
          lane: "respond",
          summary: "[[{data.name}: ]][[{data.prompt|text} ]]Choices ({data.kind}): {data.options|list}.",
        },
        { lane: "respond", summary: "A choice to make: {data.kind}." },
      ],
    },
    power_gained: {
      description: "A power, buff or debuff landed on someone.",
      rules: [
        { summary: "{data.on} got {data.label|text}.", tally: true },
        { summary: "{data.on} got {data.power} {data.amount}.", tally: true },
        { summary: "Someone got {data.power}.", tally: true },
      ],
    },
    power_changed: {
      description: "A power, buff or debuff grew.",
      rules: [
        { summary: "{data.on}'s {data.power} is now {data.amount}.", tally: true },
        { summary: "A power grew.", tally: true },
      ],
    },
    power_lost: {
      description: "A power, buff or debuff wore off.",
      rules: [
        { summary: "{data.on} lost {data.power}.", tally: true },
        { summary: "A power wore off.", tally: true },
      ],
    },
    returned_to_menu: {
      description: "They left a run without it ending; it's saved.",
      rules: [
        { summary: "Back at the menu; the run is saved on act {data.act}, floor {data.floor}." },
        { summary: "Back at the menu; the run is saved." },
      ],
    },
    session_end: {
      description: "The game was closed.",
      rules: [{ summary: "Slay the Spire 2 was closed." }],
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
        { summary: "Her control of the game changed." },
      ],
    },
    // Her playing (connector 0.4.0): always her, whichever copy she drives.
    decision_needed: {
      description: "It's her move in the copy of the game she plays: the backend gives her a turn.",
      rules: [
        { lane: "respond", subject: "self", summary: "Your move ({data.kind}): {data.prompt|text}" },
        { lane: "respond", subject: "self", summary: "Your move." },
      ],
    },
    command_result: {
      description: "What came of a move she made.",
      rules: [
        { when: { "data.status": "applied" }, subject: "self", tally: true, summary: "You {data.summary|text}." },
        { when: { "data.status": "applied" }, subject: "self", tally: true, summary: "Your move ({data.action}) went through." },
        { subject: "self", tally: true, summary: "Your move ({data.action}) didn't happen: {data.reason|text}." },
        { subject: "self", tally: true, summary: "Your move ({data.action}) didn't happen." },
      ],
    },
    cohost_said: {
      description: "A line of hers shown in the game with a move.",
      rules: [{ subject: "self", summary: "You said in the game: \"{data.text|text}\"" }],
    },
  },
  status: {
    everyMs: 5_000,
    summary: [
      { when: { in_run: false }, summary: "Not in a run: at the menu." },
      "{player} is on act {run.act} ({run.act_name}), floor {run.floor}, in {run.room}: {player.hp} of {player.max_hp} HP, {player.gold} gold.",
      "{player} is on act {run.act}, floor {run.floor}: {player.hp} of {player.max_hp} HP, {player.gold} gold.",
      // No state file yet: the heartbeat's own line.
      "Right now: {summary}.",
    ],
    more: [
      {
        kind: "kit",
        description: "Their relics, potions and deck.",
        summary: [
          "Relics: {player.relics|list}. Potions: {player.potions|list}. {player.deck_size} cards in the deck.",
          "Relics: {player.relics|list}. {player.deck_size} cards in the deck.",
        ],
      },
      {
        kind: "screen",
        description: "The choice open on screen right now, if any: what it is and its options.",
        summary: [
          {
            when: { "screen.kind": "map" },
            summary: "On the map, choosing where next: {screen.options|list}.[[ The boss is {screen.boss}.]]",
          },
          {
            when: { screen: { exists: true } },
            summary: "On screen ({screen.kind}): [[{screen.name}: ]][[{screen.prompt|text} ]][[{screen.text|text} ]]Options: {screen.options|list}.",
          },
          { when: { screen: { exists: true } }, summary: "On screen: {screen.kind}." },
          { when: { in_run: true }, summary: "No choice open." },
        ],
      },
      {
        kind: "fight",
        description: "The fight they're in: the round, their energy and block.",
        summary: [
          {
            when: { combat: { exists: true } },
            summary: "Fight, round {combat.round}: {combat.energy} of {combat.max_energy} energy, {combat.block} block.",
          },
          { when: { combat: { exists: true } }, summary: "Fight, round {combat.round}: {combat.energy} of {combat.max_energy} energy." },
          { when: { in_run: true }, summary: "Not in a fight." },
        ],
      },
      // Each its own line: with what the cards and enemies do, they don't fit in one.
      {
        kind: "enemies",
        description: "The enemies in the fight: their HP, block and what they mean to do.",
        summary: [
          { when: { "combat.enemies": { exists: true } }, summary: "Enemies: {combat.enemies|list}." },
          { when: { in_run: true }, summary: "No enemies: not in a fight." },
        ],
      },
      {
        kind: "hand",
        description: "The cards in their hand, with what each costs and does.",
        summary: [
          { when: { "combat.hand": { exists: true } }, summary: "Hand: {combat.hand|list}." },
          { when: { combat: { exists: true } }, summary: "Hand: empty." },
          { when: { in_run: true }, summary: "No hand: not in a fight." },
        ],
      },
      {
        kind: "effects",
        description: "The powers, buffs and debuffs on them in a fight (Strength, Vulnerable, Shrink).",
        summary: [
          { when: { "combat.powers": { exists: true } }, summary: "On {player}: {combat.powers|list}." },
          { when: { combat: { exists: true } }, summary: "Nothing on {player} right now." },
          { when: { in_run: true }, summary: "No fight, so nothing on {player}." },
        ],
      },
    ],
  },
};
