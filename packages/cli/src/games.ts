import { PACKS, packFolder } from "@swarmfu/connect-files/packs";
import { existsSync } from "node:fs";

/** A game swarmfu found on this computer. */
export interface InstalledGame {
  id: string;
  name: string;
  folder: string;
}

/**
 * The games with a connector mod that's run here: their pack's folder exists.
 * (Games whose adapter joins as a player, like Minecraft, are started by name.)
 */
export function installedGames(os: string = process.platform, home?: string): InstalledGame[] {
  return Object.values(PACKS).flatMap((pack) => {
    const folder = packFolder(pack, os, home);
    return folder && existsSync(folder) ? [{ id: pack.id, name: pack.game, folder }] : [];
  });
}
