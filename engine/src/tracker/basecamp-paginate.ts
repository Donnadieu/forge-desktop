/**
 * Basecamp's REST API paginates list endpoints via an RFC 5988 `Link` response
 * header (`<url>; rel="next"`) rather than Linear's GraphQL cursor connections.
 * This mirrors `linear-paginate.ts`'s role: centralise the page-walking
 * bookkeeping that `fetchCandidates` / `fetchTerminalIssues` / `fetchProgressCounts`
 * would otherwise each hand-roll.
 */

/** One page of list results plus the path (if any) of the next page. */
export interface BasecampPage<T> {
  items: T[];
  nextPath: string | null;
}

/**
 * Parse the `Link` response header for a `rel="next"` URL and return it as a
 * path relative to `baseUrl` (so callers can feed it straight back into the
 * same request method on the next iteration). Returns null when there is no
 * next page.
 */
export function parseNextLink(linkHeader: string | null, baseUrl: string): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) {
      const url = match[1];
      return url.startsWith(baseUrl) ? url.slice(baseUrl.length) : url;
    }
  }
  return null;
}

/**
 * Walk a Basecamp list endpoint to exhaustion, following `nextPath` until it
 * is null, and return every item collected. Guards against a non-advancing
 * `Link` header (a `next` path that repeats) so a malformed/looping response
 * cannot wedge the caller's poll forever — the same defensive guard
 * `linear-paginate.ts` applies to a non-advancing GraphQL cursor.
 */
export async function paginateBasecamp<T>(
  fetchPage: (path: string) => Promise<BasecampPage<T>>,
  initialPath: string,
): Promise<T[]> {
  const results: T[] = [];
  let path: string | null = initialPath;
  const seen = new Set<string>();

  while (path) {
    if (seen.has(path)) break;
    seen.add(path);
    const page = await fetchPage(path);
    results.push(...page.items);
    path = page.nextPath;
  }

  return results;
}
