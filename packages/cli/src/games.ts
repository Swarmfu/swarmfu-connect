import { PACKS, packFolder } from "@swarmfu/connect-files/packs";
import { pointersFolder, readPointers } from "@swarmfu/connect-files/pointers";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

/** A game swarmfu found on this computer. */
export interface InstalledGame {
  id: string;
  name: string;
  folder: string;
}

/**
 * The games with a connector mod that's run here: their pack's folder
 * exists, or a copy of the game left a pointer file saying where it writes.
 * (Games whose adapter joins as a player, like Minecraft, are started by name.)
 */
export function installedGames(os: string = process.platform, home: string = homedir()): InstalledGame[] {
  const pointers = readPointers(pointersFolder(home));
  return Object.values(PACKS).flatMap((pack) => {
    const folder = packFolder(pack, os, home);
    if (folder && existsSync(folder)) return [{ id: pack.id, name: pack.game, folder }];
    const pointer = pointers.find((p) => p.source === pack.id);
    return pointer ? [{ id: pack.id, name: pack.game, folder: pointer.root }] : [];
  });
}
