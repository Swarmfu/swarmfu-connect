import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;
const RELEASES = "https://api.github.com/repos/Swarmfu/swarmfu-connect/releases/latest";

/** The latest release's version if it's newer than this one; null otherwise, or if GitHub can't be reached. */
export async function newerRelease(fetcher: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await fetcher(RELEASES, { signal: AbortSignal.timeout(3_000), headers: { accept: "application/vnd.github+json" } });
    if (!response.ok) return null;
    const { tag_name } = (await response.json()) as { tag_name?: string };
    const latest = tag_name?.replace(/^v/, "");
    return latest && newer(latest, VERSION) ? latest : null;
  } catch {
    return null;
  }
}

/** Whether version `a` is newer than `b` (dotted numbers). */
export function newer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}
