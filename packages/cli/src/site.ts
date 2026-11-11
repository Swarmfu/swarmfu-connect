import { BRIDGE_PROTOCOL, CONNECT_INFO_PATH, connectInfoSchema } from "@swarmfu/connect-protocol";

const TIMEOUT_MS = 10_000;

/**
 * The backend behind a Swarmfu site, from its `connect.json`: the site's own
 * origin and its Convex URL. Throws, saying what to do, if the site can't be
 * reached or speaks another bridge protocol.
 */
export async function resolveSite(site: string, fetcher: typeof fetch = fetch): Promise<{ site: string; convexUrl: string }> {
  if (!URL.canParse(site)) throw new Error(`Not a URL: ${site}`);
  const origin = new URL(site).origin;
  let body: unknown;
  try {
    const response = await fetcher(`${origin}${CONNECT_INFO_PATH}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) throw new Error(`${response.status}`);
    body = await response.json();
  } catch (error) {
    throw new Error(`Couldn't reach Swarmfu at ${origin} (${error instanceof Error ? error.message : error}). Check the address, or your connection.`);
  }
  const parsed = connectInfoSchema.safeParse(body);
  if (!parsed.success) throw new Error(`${origin} doesn't look like a Swarmfu site.`);
  if (parsed.data.protocol !== BRIDGE_PROTOCOL)
    throw new Error(
      parsed.data.protocol > BRIDGE_PROTOCOL
        ? "This swarmfu-connect is too old for Swarmfu now. Download the latest from github.com/Swarmfu/swarmfu-connect/releases."
        : `${origin} runs an older Swarmfu than this swarmfu-connect expects.`,
    );
  return { site: origin, convexUrl: parsed.data.convexUrl };
}

/**
 * What someone typed at the "Pairing code:" prompt: the code alone, or the
 * whole line the Game card copies off www.swarmfu.com
 * (`swarmfu-connect pair <CODE> --site <url>`), so a double-clicked swarmfu-connect pairs
 * with a preview too. Null when there's no code in it.
 */
export function readPairingLine(line: string): { code: string; site?: string } | null {
  const words = line.trim().split(/\s+/).filter(Boolean);
  let site: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (word === "--site") site = words[++i];
    else if (word.startsWith("--site=")) site = word.slice("--site=".length);
    else if (/^https?:\/\//i.test(word)) site = word;
    else rest.push(word);
  }
  // Drop the program's name and the subcommand, however the line was copied.
  while (rest.length && /^(\.[/\\])?swarmfu(-connect)?(\.exe)?$|^pair$/i.test(rest[0]!)) rest.shift();
  const code = rest.find((word) => !word.startsWith("-"));
  return code ? { code, ...(site ? { site } : {}) } : null;
}
