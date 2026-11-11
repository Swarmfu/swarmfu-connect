#!/usr/bin/env bun
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

/**
 * Builds the swarmfu-connect binaries:
 *   bun scripts/build.ts                 this computer only
 *   bun scripts/build.ts --all           every release target
 *   bun scripts/build.ts --target linux-x64 --minecraft
 * `swarmfu-connect` leaves out Minecraft, whose data files run to hundreds of MB;
 * `--minecraft` builds `swarmfu-connect-minecraft`, which has it.
 */

export const TARGETS = {
  "darwin-arm64": "bun-darwin-arm64",
  "darwin-x64": "bun-darwin-x64",
  "linux-x64": "bun-linux-x64",
  "linux-arm64": "bun-linux-arm64",
  "windows-x64": "bun-windows-x64",
} as const;
type Target = keyof typeof TARGETS;

const host = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}` as Target;

const { values } = parseArgs({
  options: {
    all: { type: "boolean", default: false },
    target: { type: "string", multiple: true },
    minecraft: { type: "boolean", default: false },
    out: { type: "string", default: "dist" },
  },
});

const targets: Target[] = values.all ? (Object.keys(TARGETS) as Target[]) : ((values.target as Target[] | undefined) ?? [host]);
for (const target of targets) if (!(target in TARGETS)) throw new Error(`unknown target ${target}; one of ${Object.keys(TARGETS).join(", ")}`);

mkdirSync(values.out!, { recursive: true });
const name = values.minecraft ? "swarmfu-connect-minecraft" : "swarmfu-connect";
for (const target of targets) {
  const outfile = join(values.out!, `${name}-${target}${target.startsWith("windows") ? ".exe" : ""}`);
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "../packages/cli/src/cli.ts")],
    minify: true,
    sourcemap: "linked",
    define: { "process.env.SWARMFU_WITH_MINECRAFT": JSON.stringify(values.minecraft ? "1" : "0") },
    compile: { target: TARGETS[target], outfile },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  // A Mac only runs a signed binary, and a cross-compiled one's signature is broken by the
  // code appended to it, so each macOS build gets a fresh ad-hoc one (Developer ID replaces it).
  if (target.startsWith("darwin") && process.platform === "darwin") {
    const signed = Bun.spawnSync(["codesign", "--force", "--sign", "-", outfile]);
    if (signed.exitCode !== 0) throw new Error(`codesign ${outfile}: ${signed.stderr.toString()}`);
  }
  console.log(`built ${outfile}`);
}
