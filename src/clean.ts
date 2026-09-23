// Brave's maintained tracker list: https://github.com/brave/adblock-lists (MPL-2.0).
const RULES_URL = "https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/clean-urls.json";
// Brave strips these in browser code rather than in clean-urls.json.
const EXTRA_PARAMS = new Set(["fbclid", "msclkid", "dclid", "twclid"]);

const X_HOSTS = new Set(["x.com", "twitter.com", "mobile.twitter.com", "mobile.x.com"]);
const INSTAGRAM_POST_PATH = /^\/(reels?|p|tv)\//;
const REDDIT_SHARE_PATH = /^\/(r|u|user)\/[^/]+\/s\/[^/]+\/?$/;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
interface RawRule { include: string[]; exclude: string[]; params: string[] }
export interface Rule { include: RegExp[]; exclude: RegExp[]; params: Set<string> }

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

// Reddit /s/ share links redirect to the canonical /comments/<id>/<title_slug>/ URL.
async function resolveRedditShare(url: URL, fetchFn: Fetch): Promise<URL> {
  const res = await fetchFn(url.href, {
    redirect: "manual",
    headers: { "User-Agent": "Mozilla/5.0 (compatible; url-cleaner-telegram)" },
  });
  const location = res.headers.get("location");
  if (res.status < 300 || res.status >= 400 || !location) return url;
  const target = new URL(location, url);
  // Anything other than a post (login wall, over-18 gate) is not worth replacing the share link with.
  return target.pathname.includes("/comments/") ? target : url;
}

/** Returns the cleaned URL, or null when there is nothing to change. */
export async function cleanUrl(raw: string, rules: Rule[], fetchFn: Fetch = fetch): Promise<string | null> {
  const original = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  let url = new URL(original);

  if (/(^|\.)reddit\.com$/.test(url.hostname) && REDDIT_SHARE_PATH.test(url.pathname)) {
    try {
      url = await resolveRedditShare(url, fetchFn);
    } catch {
      // Reddit unreachable: fall through and just strip trackers.
    }
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
    url.hostname = "instagram7.com";
  }

  return url.href === original.href ? null : url.href;
}
