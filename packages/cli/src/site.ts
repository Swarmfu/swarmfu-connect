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
        ? "This swarmfu is too old for Swarmfu now. Download the latest from github.com/Swarmfu/swarmfu-connect/releases."
        : `${origin} runs an older Swarmfu than this swarmfu expects.`,
    );
  return { site: origin, convexUrl: parsed.data.convexUrl };
}
