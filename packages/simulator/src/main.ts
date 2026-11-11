#!/usr/bin/env bun
/// <reference path="./text.d.ts" />
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseRecording } from "@swarmfu/connect-protocol";
import { readFileSync } from "node:fs";
import firstNight from "../recordings/minecraft-first-night.jsonl" with { type: "text" };
import { parseArgs } from "node:util";
import { createSimulator } from "./server.ts";

/**
 * Runs the simulator as an MCP server on stdio, the way the bridge launches
 * adapters: `bun src/main.ts [recording.jsonl] [--speed 4] [--loop]`.
 * Events are logged to stderr; stdout is the MCP channel.
 */

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    speed: { type: "string", default: "1" },
    loop: { type: "boolean", default: false },
    quiet: { type: "boolean", default: false },
  },
});

// The bundled recording is embedded, so the compiled swarmfu-connect carries it too.
const recording = parseRecording(positionals[0] ? readFileSync(positionals[0], "utf8") : firstNight);

const { server } = createSimulator(recording, {
  speed: Number(values.speed),
  loop: values.loop,
  onEvent: values.quiet
    ? undefined
    : (event) =>
        console.error(`[${event.lane}] ${event.kind}: ${event.summary}`),
});

console.error(
  `[simulator] ${recording.header.description} (${Math.round(recording.durationMs / 1000)}s at ${values.speed}x)`,
);
await server.connect(new StdioServerTransport());
