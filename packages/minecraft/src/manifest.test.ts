import { expect, test } from "bun:test";
import {
  MINECRAFT_EVENTS,
  MINECRAFT_MANIFEST,
  MINECRAFT_TOOL_INPUTS,
} from "./manifest.ts";
import {
  acceptEvent,
  parseResourceUri,
  resourceUri,
  routeLane,
  toolAllowed,
} from "@swarmfu/connect-protocol";

const base = {
  id: "e1",
  subject: "self",
  summary: "A creeper started hissing right behind her.",
  at: 1,
} as const;

test("reflexes get the kind's default reaction, and must have one", () => {
  const ok = acceptEvent(MINECRAFT_MANIFEST, {
    ...base,
    kind: "creeper_fuse",
    lane: "reflex",
  });
  expect(ok).toEqual({
    event: expect.objectContaining({ reaction: "startle" }),
  });
  const own = acceptEvent(MINECRAFT_MANIFEST, {
    ...base,
    kind: "creeper_fuse",
    lane: "reflex",
    reaction: "panic",
  });
  expect(own).toEqual({
    event: expect.objectContaining({ reaction: "panic" }),
  });
  // death has no default reaction, so it can't be promoted to a reflex bare.
  expect(
    acceptEvent(MINECRAFT_MANIFEST, { ...base, kind: "death", lane: "reflex" }),
  ).toEqual({
    error: "reflex without a reaction: death",
  });
});

test("undeclared kinds and malformed events are refused", () => {
  expect(
    acceptEvent(MINECRAFT_MANIFEST, {
      ...base,
      kind: "dance_off",
      lane: "respond",
    }),
  ).toEqual({
    error: "undeclared event kind: dance_off",
  });
  expect(
    "error" in
      acceptEvent(MINECRAFT_MANIFEST, {
        ...base,
        kind: "Death",
        lane: "respond",
      }),
  ).toBe(true);
  expect(
    "error" in
      acceptEvent(MINECRAFT_MANIFEST, { ...base, kind: "death", lane: "loud" }),
  ).toBe(true);
  expect(
    "error" in
      acceptEvent(MINECRAFT_MANIFEST, {
        ...base,
        kind: "death",
        lane: "respond",
        summary: "",
      }),
  ).toBe(true);
});

test("lane overrides win over the adapter's suggestion", () => {
  expect(routeLane({ kind: "chat", lane: "respond" })).toBe("respond");
  expect(routeLane({ kind: "chat", lane: "respond" }, { chat: "silent" })).toBe(
    "silent",
  );
  expect(
    routeLane({ kind: "death", lane: "respond" }, { chat: "silent" }),
  ).toBe("respond");
});

test("destructive tools need allowing; undeclared tools never pass", () => {
  expect(toolAllowed(MINECRAFT_MANIFEST, "follow_player")).toBe(true);
  expect(toolAllowed(MINECRAFT_MANIFEST, "break_block")).toBe(false);
  expect(
    toolAllowed(MINECRAFT_MANIFEST, "break_block", new Set(["break_block"])),
  ).toBe(true);
  expect(toolAllowed(MINECRAFT_MANIFEST, "run_command")).toBe(false);
});

test("resource URIs round-trip", () => {
  expect(resourceUri("minecraft", "nearby_entities")).toBe(
    "game://minecraft/nearby_entities",
  );
  expect(parseResourceUri("game://minecraft/nearby_entities")).toEqual({
    adapterId: "minecraft",
    name: "nearby_entities",
  });
  expect(parseResourceUri("file:///etc/passwd")).toBeNull();
});

test("the Minecraft manifest is consistent", () => {
  expect(Object.keys(MINECRAFT_MANIFEST.tools).sort()).toEqual(
    Object.keys(MINECRAFT_TOOL_INPUTS).sort(),
  );
  for (const [kind, spec] of Object.entries(MINECRAFT_EVENTS)) {
    expect(kind).toMatch(/^[a-z][a-z0-9_]*$/);
    if (spec.lane === "reflex") expect("reaction" in spec).toBe(true);
  }
});
