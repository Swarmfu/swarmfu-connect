import type { AdapterMain } from "./adapter.ts";

/**
 * `swarmfu-connect adapter <name> [args…]`: one of the built-in adapters, in this
 * process, as an MCP server on stdio. The bridge starts these from the
 * compiled binary, which carries no scripts to hand to Bun. Each import is
 * written out so the compiler bundles it.
 */
export async function runAdapter(argv: string[]): Promise<never> {
  const [name, ...args] = argv;
  // The adapters read their options from process.argv, as when run on their own.
  process.argv = [process.argv[0]!, `swarmfu-connect adapter ${name}`, ...args];
  switch (name as AdapterMain) {
    case "files":
      await import("@swarmfu/connect-files/main");
      break;
    case "minecraft":
      // Mineflayer carries data for every Minecraft version (hundreds of MB), so the
      // everyday build leaves it out (SWARMFU_WITH_MINECRAFT=0); swarmfu-connect-minecraft has it.
      if (process.env.SWARMFU_WITH_MINECRAFT !== "0") await import("@swarmfu/connect-minecraft/main");
      else throw new Error("this swarmfu-connect was built without Minecraft; use swarmfu-connect-minecraft");
      break;
    case "simulator":
      await import("@swarmfu/connect-simulator/main");
      break;
    default:
      throw new Error(`no built-in adapter called ${name}`);
  }
  // It serves until the bridge closes its stdin and stops it.
  return await new Promise<never>(() => {});
}
