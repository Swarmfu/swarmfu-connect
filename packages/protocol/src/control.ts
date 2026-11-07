import { z } from "zod";
import { MAX_SUMMARY_CHARS } from "./protocol.ts";

/**
 * Playing, not only watching (docs/mod-guide.md, "Control"): a connector
 * with `control` in its manifest's capabilities puts a `decision` in its
 * state file whenever the player she drives has something to decide, and
 * reads commands from its `commands_file`. She gets one tool, `game_action`,
 * for every game: the decision says what she can do, and she answers with
 * one of its actions and options, by label. Nothing here knows any game.
 */

export const GAME_ACTION_TOOL = "game_action";

/** One choice for a parameter: an opaque id for the game, a label for her. */
export interface DecisionOption {
  id: string;
  label?: string;
  /** False for a choice listed but not open now (a card she can't afford); unset is open. */
  playable?: boolean;
  /** Why it isn't open ("needs 2 stars"). */
  why?: string;
  [key: string]: unknown;
}
export interface DecisionParam {
  options: DecisionOption[];
  /** When it's needed, in words ("the card needs a target"). */
  when?: string;
  optional?: boolean;
  [key: string]: unknown;
}
export interface DecisionAction {
  action: string;
  label?: string;
  params?: Record<string, DecisionParam>;
  [key: string]: unknown;
}
/** `state.json`'s `decision`: what the player she drives can do right now. */
export interface Decision {
  id: string;
  for?: string;
  kind?: string;
  /** False while the game is still busy (animations): wait. */
  ready?: boolean;
  prompt?: string;
  actions: DecisionAction[];
  [key: string]: unknown;
}

const optionSchema = z
  .object({
    id: z.string().min(1).max(64),
    label: z.string().max(400).optional(),
    playable: z.boolean().optional(),
    why: z.string().max(200).optional(),
  })
  .loose();
const paramSchema = z
  .object({
    options: z.array(optionSchema).max(64),
    when: z.string().max(200).optional(),
    optional: z.boolean().optional(),
  })
  .loose();
export const decisionSchema: z.ZodType<Decision> = z
  .object({
    id: z.string().min(1).max(64),
    for: z.string().max(32).optional(),
    kind: z.string().max(48).optional(),
    ready: z.boolean().optional(),
    prompt: z.string().max(400).optional(),
    actions: z
      .array(
        z
          .object({
            action: z.string().min(1).max(64),
            label: z.string().max(200).optional(),
            params: z.record(z.string(), paramSchema).optional(),
          })
          .loose(),
      )
      .max(32),
  })
  .loose();

/** A line of the commands file. */
export interface ConnectorCommand {
  v: number;
  id: string;
  ts: number;
  /** The decision it answers; a different one open now makes it stale. */
  decision: string;
  action: string;
  args: Record<string, string>;
  /** Her line about it, if any; shown, never run. */
  say?: string;
}

export const GAME_ACTION_DESCRIPTION =
  'Make a move in your own copy of the game. What you can do right now is the "Your move" line in your game notes: name one of its actions, and for each of its parameters (card, target, potion, room, option…) give the label of one of the choices listed, as written, or the start of it ("Bash"). Give a target when the card or potion needs one. The answer says how it went and what you can do next. `say` is a short line of yours shown in the game; leave it out unless it\'s worth saying.';

/** `game_action`'s input, as the adapter registers it. */
export const gameActionInput = {
  action: z
    .string()
    .min(1)
    .max(80)
    .describe(
      'One of the actions you can take now, e.g. "play card" or "end turn".',
    ),
  args: z
    .record(z.string(), z.string().max(200))
    .optional()
    .describe(
      'Each parameter of the action and the choice for it, by label: {"card": "Bash", "target": "Jaw Worm"}.',
    ),
  say: z
    .string()
    .max(200)
    .optional()
    .describe("A short line of yours shown in the game. Usually leave it out."),
};

/** Text as she reads it: one line, no underscores, no control characters. */
const plain = (text: string) =>
  text
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/_+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const optionText = (option: DecisionOption) => plain(option.label ?? option.id);
/** A choice as she reads it in "Your move": one she can't take now says so, and why. */
const shownOption = (option: DecisionOption) =>
  option.playable === false ? `${optionText(option)} [not now${option.why ? `: ${plain(option.why)}` : ""}]` : optionText(option);
const open = (option: DecisionOption) => option.playable !== false;

/**
 * The decision as a line she reads: what she's deciding and each action with
 * its choices, by label (ids are for the game, never for her). Long ones are
 * cut at the end, with "…".
 */
export function decisionLine(
  decision: Decision,
  max = MAX_SUMMARY_CHARS,
): string {
  const head = `Your move${decision.kind ? ` (${plain(decision.kind)})` : ""}: ${decision.prompt ? plain(decision.prompt) : "it's your turn to choose."}`;
  if (decision.ready === false)
    // Nothing of hers open (the enemies' turn, travelling, a run starting): what the game is doing, never "Your move".
    return decision.kind === "waiting" || !decision.actions.length
      ? `Nothing for you to decide yet: ${decision.prompt ? plain(decision.prompt) : "the game is busy."}`
      : `${head} The game is still busy; wait a moment.`;
  const actions = decision.actions.map((action) => {
    const name = plain(action.action);
    const params = Object.entries(action.params ?? {}).map(([param, spec]) => {
      const choices = spec.options.map(shownOption);
      const counted = [...new Set(choices)].map((choice) => {
        const n = choices.filter((c) => c === choice).length;
        return n > 1 ? `${n}× ${choice}` : choice;
      });
      return `${plain(param)}${spec.optional ? " (if needed)" : ""}: ${counted.join(" / ")}`;
    });
    return params.length ? `"${name}" with ${params.join("; ")}` : `"${name}"`;
  });
  const line = `${head} You can: ${actions.join(" | ")}.`;
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${space > max / 2 ? cut.slice(0, space) : cut}…`;
}

/** Lowercased, without the end punctuation a label may or may not have been written with ("…a random card."). */
const normal = (text: string) =>
  plain(text)
    .toLowerCase()
    .replace(/[\s.!,;:]+$/, "");
/** A label's name: the part before its details ("Bash (2 energy): Deal 8" → "bash"). */
const nameOf = (label: string) =>
  normal(label)
    .split(/\s*[(:,]/)[0]!
    .trim();

/** The option `wanted` names: its id, its label, the label's name, or the start of the label. */
export function findOption(
  options: readonly DecisionOption[],
  wanted: string,
): DecisionOption | undefined {
  const w = normal(wanted);
  if (!w) return undefined;
  // One she can take first, when two read the same (a playable Strike over one that isn't).
  options = [...options.filter(open), ...options.filter((o) => !open(o))];
  return (
    options.find((o) => o.id === wanted) ??
    options.find((o) => normal(o.label ?? "") === w) ??
    options.find((o) => nameOf(o.label ?? "") === w) ??
    options.find((o) => normal(o.label ?? "").startsWith(w)) ??
    options.find((o) => normal(o.label ?? "").includes(w))
  );
}

/**
 * Her move, checked against the decision and turned into what the game
 * takes: the action's name and each parameter's option id. An error says
 * what's wrong in words she can act on.
 */
export function resolveMove(
  decision: Decision,
  action: string,
  args: Record<string, string> = {},
): { action: string; args: Record<string, string> } | { error: string } {
  const wanted = normal(action);
  const chosen =
    decision.actions.find((a) => normal(a.action) === wanted) ??
    decision.actions.find((a) => a.label && normal(a.label) === wanted) ??
    decision.actions.find((a) => normal(a.action).startsWith(wanted));
  if (!chosen)
    return {
      error: `You can't "${action}" now. You can: ${decision.actions.map((a) => `"${plain(a.action)}"`).join(", ")}.`,
    };
  const params = chosen.params ?? {};
  const ids: Record<string, string> = {};
  for (const [key, value] of Object.entries(args)) {
    const param = Object.keys(params).find((p) => normal(p) === normal(key));
    if (!param) {
      const names = Object.keys(params);
      return {
        error: names.length
          ? `"${plain(chosen.action)}" takes ${names.map((n) => `"${n}"`).join(" and ")}, not "${key}".`
          : `"${plain(chosen.action)}" takes nothing; leave out "${key}".`,
      };
    }
    const option = findOption(params[param]!.options, value);
    if (!option)
      return {
        error: `There's no "${value}" to choose for ${param}. The choices: ${params[param]!.options.map(optionText).join(" / ")}.`,
      };
    if (!open(option)) {
      const others = params[param]!.options.filter(open).map(optionText);
      return {
        error: `${plain(option.label ?? option.id).split(/\s*[(:]/)[0] || option.id} can't be chosen now${option.why ? `: it ${plain(option.why)}` : ""}.${others.length ? ` You can choose: ${others.join(" / ")}.` : ""}`,
      };
    }
    ids[param] = option.id;
  }
  for (const [param, spec] of Object.entries(params)) {
    if (param in ids || spec.optional) continue;
    // A choice of one needs no asking.
    const live = spec.options.filter(open);
    if (live.length === 1) ids[param] = live[0]!.id;
    else
      return {
        error: `Say which ${param}: ${live.map(optionText).join(" / ")}.`,
      };
  }
  return { action: chosen.action, args: ids };
}
