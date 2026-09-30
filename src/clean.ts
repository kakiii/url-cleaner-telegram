// Brave's maintained tracker list: https://github.com/brave/adblock-lists (MPL-2.0).
const RULES_URL = "https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/clean-urls.json";
// Brave strips these in browser code rather than in clean-urls.json.
const EXTRA_PARAMS = new Set(["fbclid", "msclkid", "dclid", "twclid"]);

const X_HOSTS = new Set(["x.com", "twitter.com", "mobile.twitter.com", "mobile.x.com"]);
const INSTAGRAM_POST_PATH = /^\/(reels?|p|tv)\//;
const REDDIT_SHARE_PATH = /^\/(r|u|user)\/[^/]+\/s\/[^/]+\/?$/;
// Bilibili share URLs carry a dozen tracking params not covered by Brave's list; keep only part and timestamp.
const BILIBILI_KEEP_PARAMS = new Set(["p", "t"]);

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
interface RawRule { include: string[]; exclude: string[]; params: string[] }
export interface Rule { include: RegExp[]; exclude: RegExp[]; params: Set<string> }
export class LinkResolutionError extends Error {}

// Chrome match pattern (e.g. "*://*.youtube.com/watch?*") -> RegExp; null if malformed.
function matchPattern(pattern: string): RegExp | null {
  const m = pattern.match(/^(\*|https?):\/\/([^/]+)(\/.*)$/);
  if (!m) return null;
  const glob = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const [, scheme, host, path] = m;
  const hostRe = host === "*" ? "[^/]+" : host.startsWith("*.") ? `(?:[^/]+\\.)?${glob(host.slice(2))}` : glob(host);
  return new RegExp(`^${scheme === "*" ? "https?" : scheme}://${hostRe}${glob(path)}$`);
}

export function compileRules(raw: RawRule[]): Rule[] {
  const patterns = (list: string[]) => list.map(matchPattern).filter((r) => r !== null);
  return raw.map((r) => ({
    include: patterns(r.include),
    exclude: patterns(r.exclude),
    params: new Set(r.params.map((p) => decodeURIComponent(p))),
  }));
}

let rulesPromise: Promise<Rule[]> | undefined;

// Cached per isolate and at Cloudflare's edge for a day; without rules we still apply EXTRA_PARAMS and utm_*.
export function loadRules(fetchFn: Fetch = fetch): Promise<Rule[]> {
  rulesPromise ??= fetchFn(RULES_URL, { cf: { cacheTtl: 86400, cacheEverything: true } })
    .then((res) => {
      if (!res.ok) throw new Error(`rules fetch ${res.status}`);
      return res.json() as Promise<RawRule[]>;
    })
    .then(compileRules)
    .catch(() => {
      rulesPromise = undefined;
      return [];
    });
  return rulesPromise;
}

function stripTrackers(url: URL, rules: Rule[]): void {
  const target = `${url.protocol}//${url.hostname}${url.pathname}${url.search}`;
  const tracking = new Set(EXTRA_PARAMS);
  for (const rule of rules) {
    if (rule.include.some((re) => re.test(target)) && !rule.exclude.some((re) => re.test(target))) {
      rule.params.forEach((p) => tracking.add(p));
    }
  }
  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith("utm_") || tracking.has(key)) url.searchParams.delete(key);
  }
}

// Follows one redirect hop of a share link.
async function followRedirect(url: URL, fetchFn: Fetch): Promise<URL> {
  let res: Response;
  try {
    res = await fetchFn(url.href, {
      redirect: "manual",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; url-cleaner-telegram)" },
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    throw new LinkResolutionError("Network request failed", { cause: error });
  }
  if (res.status < 300 || res.status >= 400) {
    throw new LinkResolutionError(`Expected a redirect, got HTTP ${res.status}`);
  }
  const location = res.headers.get("location");
  if (!location) throw new LinkResolutionError("Redirect has no Location header");
  try {
    return new URL(location, url);
  } catch (error) {
    throw new LinkResolutionError("Redirect has an invalid Location header", { cause: error });
  }
}

/** Returns the cleaned URL, or null when there is nothing to change. */
export async function cleanUrl(raw: string, rules: Rule[], fetchFn: Fetch = fetch): Promise<string | null> {
  const original = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  let url = new URL(original);

  if (/(^|\.)reddit\.com$/.test(url.hostname) && REDDIT_SHARE_PATH.test(url.pathname)) {
    const target = await followRedirect(url, fetchFn);
    if (!/(^|\.)reddit\.com$/.test(target.hostname) || !target.pathname.includes("/comments/")) {
      throw new LinkResolutionError("Redirect did not lead to a Reddit post or comment");
    }
    url = target;
  } else if (url.hostname === "b23.tv") {
    const target = await followRedirect(url, fetchFn);
    if (!/(^|\.)bilibili\.com$/.test(target.hostname)) {
      throw new LinkResolutionError("Redirect did not lead to Bilibili");
    }
    url = target;
    if (!url.pathname.endsWith("/")) url.pathname += "/";
  }

  // Strip before rewriting hosts, since the rules are keyed on the original sites.
  stripTrackers(url, rules);

  const host = url.hostname.replace(/^www\./, "");
  if (X_HOSTS.has(host)) {
    url.hostname = "fixvx.com";
    url.search = "";
  } else if (host === "youtu.be") {
    url = new URL(`https://www.youtube.com/watch?v=${url.pathname.slice(1)}${url.search.replace(/^\?/, "&")}`);
  } else if (host === "instagram.com" && INSTAGRAM_POST_PATH.test(url.pathname)) {
    // Third-party embed frontend; if it dies, swap this host (see README).
    url.hostname = "kkinstagram.com";
  } else if (/(^|\.)bilibili\.com$/.test(host) && url.pathname.startsWith("/video/")) {
    for (const key of [...url.searchParams.keys()]) {
      if (!BILIBILI_KEEP_PARAMS.has(key)) url.searchParams.delete(key);
    }
    if (url.searchParams.get("p") === "1") url.searchParams.delete("p");
  }

  return url.href === original.href ? null : url.href;
}
