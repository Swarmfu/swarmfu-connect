import { afterEach, expect, test } from "bun:test";
import { BRIDGE_PROTOCOL } from "@swarmfu/connect-protocol";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowedOrigins, configSchema } from "./config.ts";
import { installedGames } from "./games.ts";
import { readPairingLine, resolveSite } from "./site.ts";
import { newer } from "./version.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const site = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

test("a site's connect.json says where its backend is", async () => {
  const resolved = await resolveSite(
    "https://swarmfu-git-feature-x.vercel.app/stream?x=1",
    site({ convexUrl: "https://happy-otter-123.convex.cloud", protocol: BRIDGE_PROTOCOL }),
  );
  expect(resolved).toEqual({ site: "https://swarmfu-git-feature-x.vercel.app", convexUrl: "https://happy-otter-123.convex.cloud" });
});

test("a site that isn't Swarmfu, or speaks another protocol, says what to do", async () => {
  await expect(resolveSite("https://example.com", site({ hello: "world" }))).rejects.toThrow("doesn't look like a Swarmfu site");
  await expect(resolveSite("https://example.com", site({}, 404))).rejects.toThrow("Couldn't reach Swarmfu");
  await expect(
    resolveSite("https://www.swarmfu.com", site({ convexUrl: "https://a.convex.cloud", protocol: BRIDGE_PROTOCOL + 1 })),
  ).rejects.toThrow("too old");
  await expect(resolveSite("not a url")).rejects.toThrow("Not a URL");
});

test("the site it was paired through may open the local socket", () => {
  const config = configSchema.parse({
    site: "https://www.swarmfu.com",
    convexUrl: "https://a.convex.cloud",
    token: "wb_x",
    name: "Desk",
    origins: ["https://beta.swarmfu.com", "https://www.swarmfu.com"],
  });
  expect(allowedOrigins(config)).toEqual(["https://www.swarmfu.com", "https://beta.swarmfu.com"]);
  // A config from before machine ids gets one.
  expect(config.machineId).toMatch(/^[0-9a-f-]{36}$/);
});

test("a game counts as installed once its connector's folder exists", () => {
  const home = mkdtempSync(join(tmpdir(), "home-"));
  dirs.push(home);
  expect(installedGames("darwin", home)).toEqual([]);
  mkdirSync(join(home, "Zomboid/Lua/swarmfu-connector"), { recursive: true });
  writeFileSync(join(home, "Zomboid/Lua/swarmfu-connector/manifest.json"), "{}");
  expect(installedGames("darwin", home)).toEqual([
    { id: "projectzomboid", name: "Project Zomboid", folder: join(home, "Zomboid/Lua/swarmfu-connector") },
  ]);
  expect(existsSync(join(home, ".swarmfu"))).toBe(false);
});

test("a game with no folder yet counts as installed once a copy leaves a pointer", () => {
  const home = mkdtempSync(join(tmpdir(), "home-"));
  dirs.push(home);
  const root = join(home, "elsewhere", "swarmfu");
  mkdirSync(join(home, ".swarmfu", "connectors"), { recursive: true });
  writeFileSync(
    join(home, ".swarmfu", "connectors", "slaythespire2-a91f.json"),
    JSON.stringify({ v: 1, source: "slaythespire2", instance: "a91f", root }),
  );
  expect(installedGames("darwin", home)).toEqual([{ id: "slaythespire2", name: "Slay the Spire 2", folder: root }]);
});

test("release versions compare by number", () => {
  expect(newer("0.2.0", "0.1.9")).toBe(true);
  expect(newer("0.10.0", "0.9.0")).toBe(true);
  expect(newer("0.1.0", "0.1.0")).toBe(false);
  expect(newer("0.1", "0.1.1")).toBe(false);
});

test("the pairing prompt takes the code, or the whole line the Game card copies", () => {
  expect(readPairingLine("  K7QM2P ")).toEqual({ code: "K7QM2P" });
  expect(readPairingLine("swarmfu pair K7QM2P --site https://swarmfu-git-x.vercel.app")).toEqual({
    code: "K7QM2P",
    site: "https://swarmfu-git-x.vercel.app",
  });
  expect(readPairingLine(".\\swarmfu.exe pair K7QM2P --site=https://a.vercel.app")).toEqual({ code: "K7QM2P", site: "https://a.vercel.app" });
  expect(readPairingLine("K7QM2P https://a.vercel.app")).toEqual({ code: "K7QM2P", site: "https://a.vercel.app" });
  expect(readPairingLine("swarmfu-connect pair K7QM2P --site https://a.vercel.app")).toEqual({ code: "K7QM2P", site: "https://a.vercel.app" });
  expect(readPairingLine("swarmfu-connect.exe pair K7QM2P")).toEqual({ code: "K7QM2P" });
  expect(readPairingLine("swarmfu pair")).toBeNull();
  expect(readPairingLine("")).toBeNull();
});
