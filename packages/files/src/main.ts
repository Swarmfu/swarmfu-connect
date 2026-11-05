#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseArgs } from "node:util";
import { createFileAdapter } from "./adapter.ts";
import { PACKS, packFolder } from "./packs/index.ts";

/**
 * Runs the file adapter as an MCP server on stdio, the way the bridge
 * launches adapters: `bun src/main.ts --pack projectzomboid [--dir <folder>]
 * [--from-start] [--poll 500]`. Events are logged to stderr; stdout is the
 * MCP channel.
 */

const { values } = parseArgs({
  options: {
    pack: { type: "string" },
    dir: { type: "string" },
    "from-start": { type: "boolean", default: false },
    poll: { type: "string", default: "500" },
    quiet: { type: "boolean", default: false },
  },
});

const fail = (message: string): never => {
  console.error(`[files] ${message}`);
  process.exit(1);
};

const pack = PACKS[values.pack ?? ""] ?? fail(`--pack must be one of: ${Object.keys(PACKS).join(", ")}`);
const dir = values.dir ?? packFolder(pack) ?? fail(`${pack.game}'s pack has no folder for ${process.platform}; pass --dir.`);
const pollMs = Math.max(100, Number(values.poll) || 500);

const adapter = createFileAdapter(pack, {
  dir,
  fromStart: values["from-start"],
  onEvent: values.quiet ? undefined : (event) => console.error(`[${event.lane}${event.tally ? ", tally" : ""}] ${event.kind}: ${event.summary}`),
  log: (line) => console.error(`[files] ${line}`),
});

console.error(`[files] following ${pack.game} in ${dir}`);
// Connected first: an event raised before there's a connection is never sent, and the first poll has the most.
await adapter.server.connect(new StdioServerTransport());
adapter.poll();
setInterval(() => adapter.poll(), pollMs);
