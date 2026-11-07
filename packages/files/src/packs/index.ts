import type { GamePack, PackOs } from "@swarmfu/connect-protocol";
import { homedir } from "node:os";
import { join } from "node:path";
import { projectzomboid } from "./projectzomboid.ts";
import { slaythespire2 } from "./slaythespire2.ts";

/**
 * The games the file adapter knows, one pack each
 * (docs/game-connectors/mod-guide.md). Adding a game is a pack here, by PR.
 */
export const PACKS: Record<string, GamePack> = {
  [projectzomboid.id]: projectzomboid,
  [slaythespire2.id]: slaythespire2,
};

/** The connector's folder for a pack on this computer, or null if the pack doesn't say for this OS. */
export function packFolder(pack: GamePack, os: string = process.platform, home: string = homedir()): string | null {
  const folder = pack.folder[os as PackOs];
  if (!folder) return null;
  return folder.startsWith("~/") ? join(home, folder.slice(2)) : folder;
}
