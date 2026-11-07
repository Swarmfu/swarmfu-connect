import {
  connectorPointerSchema,
  POINTERS_FOLDER,
  type ConnectorPointer,
} from "@swarmfu/connect-protocol";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Pointer files (docs/mod-guide.md, "Finding the files"): a game that can
 * write anywhere leaves one per running copy in ~/.swarmfu/connectors, saying
 * which folder holds that copy's manifest. The mod doesn't know where swarmfu
 * keeps its config, so this is always the home folder's, whatever
 * $SWARMFU_HOME says.
 */

/** Most pointer files read at once; a folder with more is someone else's mess. */
const MAX_POINTERS = 64;

export function pointersFolder(home: string = homedir()): string {
  return join(home, ".swarmfu", POINTERS_FOLDER);
}

/** The pointers in `folder` (for one game, if `source` is given), newest first. Unreadable ones are skipped. */
export function readPointers(
  folder: string = pointersFolder(),
  source?: string,
): ConnectorPointer[] {
  let files: string[];
  try {
    files = readdirSync(folder).filter((file) => file.endsWith(".json"));
  } catch {
    return [];
  }
  const pointers: ConnectorPointer[] = [];
  for (const file of files.slice(0, MAX_POINTERS)) {
    try {
      const parsed = connectorPointerSchema.safeParse(
        JSON.parse(readFileSync(join(folder, file), "utf8")),
      );
      if (parsed.success && (!source || parsed.data.source === source))
        pointers.push(parsed.data);
    } catch {
      // Caught mid-write, or not a pointer: the next look gets it.
    }
  }
  return pointers.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
}
