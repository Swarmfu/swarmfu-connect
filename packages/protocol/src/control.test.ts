import { expect, test } from "bun:test";
import { decisionLine, resolveMove, type Decision } from "./control.ts";

const decision: Decision = {
  id: "d41",
  for: "cohost",
  kind: "combat",
  ready: true,
  prompt: "Your turn: 3 energy, 3 cards in hand.",
  actions: [
    {
      action: "play card",
      label: "Play a card",
      params: {
        card: {
          options: [
            { id: "c12", label: "Bash (2 energy): Deal 8 damage. Apply 2 Vulnerable", target: "enemy" },
            { id: "c13", label: "Strike (1 energy): Deal 6 damage", target: "enemy" },
            { id: "c14", label: "Strike (1 energy): Deal 6 damage", target: "enemy" },
            { id: "c15", label: "Strike+ (1 energy): Deal 9 damage", target: "enemy" },
          ],
        },
        target: {
          options: [
            { id: "e3", label: "Jaw Worm, 40 of 44 HP, attack 11" },
            { id: "e4", label: "Louse, 10 of 12 HP, debuff (Weak)" },
          ],
          optional: true,
        },
      },
    },
    { action: "end turn", label: "End your turn" },
  ],
};

test("a decision reads as what she can do, by label, never by id", () => {
  const line = decisionLine(decision);
  expect(line).toStartWith("Your move (combat): Your turn: 3 energy, 3 cards in hand. You can: \"play card\" with card: Bash");
  expect(line).toContain("2× Strike (1 energy): Deal 6 damage");
  expect(line).toContain("target (if needed): Jaw Worm, 40 of 44 HP, attack 11 / Louse");
  expect(line).toEndWith('| "end turn".');
  expect(line).not.toMatch(/\bc1\d\b|\be3\b/);
  expect(decisionLine({ ...decision, ready: false })).toBe(
    "Your move (combat): Your turn: 3 energy, 3 cards in hand. The game is still busy; wait a moment.",
  );
  expect(decisionLine(decision, 120).length).toBeLessThanOrEqual(120);
});

test("her move by name or label becomes the game's ids", () => {
  expect(resolveMove(decision, "play card", { card: "Bash", target: "Jaw Worm" })).toEqual({
    action: "play card",
    args: { card: "c12", target: "e3" },
  });
  // A name picks that card, not one that only starts the same; the label as written works too.
  expect(resolveMove(decision, "Play a card", { card: "strike" })).toEqual({ action: "play card", args: { card: "c13" } });
  expect(resolveMove(decision, "play card", { Card: "Strike+ (1 energy): Deal 9 damage" })).toEqual({
    action: "play card",
    args: { card: "c15" },
  });
  expect(resolveMove(decision, "end turn")).toEqual({ action: "end turn", args: {} });
});

test("a move that doesn't fit says why, in words she can use", () => {
  expect(resolveMove(decision, "use potion")).toEqual({ error: 'You can\'t "use potion" now. You can: "play card", "end turn".' });
  expect(resolveMove(decision, "play card", { card: "Bludgeon" })).toMatchObject({ error: expect.stringContaining('There\'s no "Bludgeon"') });
  expect(resolveMove(decision, "play card", { who: "Louse" })).toEqual({ error: '"play card" takes "card" and "target", not "who".' });
  expect(resolveMove(decision, "play card", {})).toMatchObject({ error: expect.stringContaining("Say which card:") });
  expect(resolveMove(decision, "end turn", { card: "Bash" })).toEqual({ error: '"end turn" takes nothing; leave out "card".' });
});

test("a label written with or without its end punctuation is the same choice", () => {
  const event: Decision = {
    id: "d9",
    kind: "event",
    actions: [
      {
        action: "choose",
        params: {
          option: {
            options: [
              { id: "o0", label: "Smash: Heal 20 HP" },
              { id: "o1", label: "Decipher: Lose 3 Max HP. Upgrade a random card" },
            ],
          },
        },
      },
    ],
  };
  // Seventh Slay the Spire 2 test: refused twice for the period at the end.
  expect(resolveMove(event, "choose", { option: "Decipher: Lose 3 Max HP. Upgrade a random card." })).toEqual({
    action: "choose",
    args: { option: "o1" },
  });
});

test("a card she can't play now is shown with why, refused with why, and never picked for her", () => {
  // Connector 0.5.1: every card in hand, the ones not open marked (seventh Slay the Spire 2 test's Falling Star).
  const fight: Decision = {
    id: "d3",
    kind: "combat",
    prompt: "Your turn: 3 energy.",
    actions: [
      {
        action: "play card",
        params: {
          card: {
            options: [
              { id: "h1", label: "Falling Star (0 energy, 2 stars): Deal 8 damage", playable: false, why: "needs 2 stars" },
              { id: "h2", label: "Strike (1 energy): Deal 6 damage" },
            ],
          },
        },
      },
    ],
  };
  expect(decisionLine(fight)).toContain("Falling Star (0 energy, 2 stars): Deal 8 damage [not now: needs 2 stars] / Strike");
  expect(resolveMove(fight, "play card", { card: "Falling Star" })).toEqual({
    error: "Falling Star can't be chosen now: it needs 2 stars. You can choose: Strike (1 energy): Deal 6 damage.",
  });
  // The only card she can play is the one meant.
  expect(resolveMove(fight, "play card")).toEqual({ action: "play card", args: { card: "h2" } });
});

test("a decision that isn't hers yet says what the game is doing, never \"Your move\"", () => {
  const waiting: Decision = { id: "d4", kind: "waiting", ready: false, prompt: "The enemies' turn is playing out.", actions: [] };
  expect(decisionLine(waiting)).toBe("Nothing for you to decide yet: The enemies' turn is playing out.");
});
