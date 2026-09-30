import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanUrl, compileRules, LinkResolutionError, loadRules } from "../src/clean.ts";

// Subset of brave-lists/clean-urls.json entries, copied verbatim.
const rules = compileRules([
  { include: ["*://*/*"], exclude: ["https://urldefense.com/v3/*"], params: ["gclid", "mc_cid", "utm_source", "utm_medium"] },
  { include: ["*://new.reddit.com/*", "*://old.reddit.com/*", "*://www.reddit.com/*"], exclude: [], params: ["%24deep_link", "post_index", "correlation_id", "ref", "ref_source", "share_id"] },
  { include: ["*://www.instagram.com/*"], exclude: [], params: ["igsh", "igshid", "ig_rid"] },
  { include: ["*://youtu.be/*", "*://*.youtube.com/watch?*"], exclude: [], params: ["feature", "pp", "si"] },
]);

const noFetch = () => assert.fail("unexpected fetch");

test("x.com and twitter.com go to fixvx.com without query", async () => {
  assert.equal(await cleanUrl("https://x.com/user/status/123?s=20&t=abc", rules, noFetch), "https://fixvx.com/user/status/123");
  assert.equal(await cleanUrl("twitter.com/user/status/123", rules, noFetch), "https://fixvx.com/user/status/123");
});

test("youtu.be becomes youtube.com/watch, keeps timestamp, drops si", async () => {
  assert.equal(await cleanUrl("https://youtu.be/dQw4w9WgXcQ?si=XYZ&t=42", rules, noFetch), "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42");
});

test("youtube.com drops si/feature but keeps v and list", async () => {
  assert.equal(
    await cleanUrl("https://www.youtube.com/watch?v=abc&list=PL1&si=x&feature=share", rules, noFetch),
    "https://www.youtube.com/watch?v=abc&list=PL1",
  );
});

test("instagram posts go to kkinstagram.com without igsh", async () => {
  assert.equal(await cleanUrl("https://www.instagram.com/reel/Dc4fAOCs97R/?igsh=abc", rules, noFetch), "https://kkinstagram.com/reel/Dc4fAOCs97R/");
  assert.equal(await cleanUrl("https://www.instagram.com/p/Dc4fAOCs97R/", rules, noFetch), "https://kkinstagram.com/p/Dc4fAOCs97R/");
  assert.equal(await cleanUrl("https://www.instagram.com/someprofile/", rules, noFetch), null);
});

test("reddit /s/ link resolves via redirect and is cleaned", async () => {
  const fetchFn = async (url: string, init: RequestInit) => {
    assert.equal(url, "https://www.reddit.com/r/pics/s/AbCdEf12");
    assert.equal(init.redirect, "manual");
    assert.ok(init.signal instanceof AbortSignal);
    return new Response(null, {
      status: 301,
      headers: { location: "https://www.reddit.com/r/pics/comments/abc123/some_title/?share_id=zz&utm_medium=android_app&utm_term=1" },
    });
  };
  assert.equal(await cleanUrl("https://www.reddit.com/r/pics/s/AbCdEf12", rules, fetchFn), "https://www.reddit.com/r/pics/comments/abc123/some_title/");
});

test("reddit /s/ link reports blocked responses, network failures and login redirects", async () => {
  const link = "https://www.reddit.com/r/pics/s/AbCdEf12";
  await assert.rejects(cleanUrl(link, rules, async () => new Response(null, { status: 403 })), {
    constructor: LinkResolutionError, message: "Expected a redirect, got HTTP 403",
  });
  const error = new Error("down");
  await assert.rejects(cleanUrl(link, rules, async () => { throw error; }), {
    constructor: LinkResolutionError, message: "Network request failed", cause: error,
  });
  const toLogin = async () => new Response(null, { status: 302, headers: { location: "/login/?dest=x" } });
  await assert.rejects(cleanUrl(link, rules, toLogin), {
    constructor: LinkResolutionError, message: "Redirect did not lead to a Reddit post or comment",
  });
});

test("share links report missing or invalid redirect locations", async () => {
  const link = "https://www.reddit.com/r/cats/s/77w4Bp190I";
  await assert.rejects(cleanUrl(link, rules, async () => new Response(null, { status: 301 })), {
    constructor: LinkResolutionError, message: "Redirect has no Location header",
  });
  await assert.rejects(cleanUrl(link, rules, async () => new Response(null, {
    status: 301, headers: { location: "https://[" },
  })), {
    constructor: LinkResolutionError, message: "Redirect has an invalid Location header",
  });
});

test("b23.tv resolves to bilibili.com with tracking params dropped", async () => {
  const fetchFn = async (url: string, init: RequestInit) => {
    assert.equal(url, "https://b23.tv/IYQRdVm");
    assert.equal(init.redirect, "manual");
    return new Response(null, {
      status: 302,
      headers: { location: "https://www.bilibili.com/video/BV1wwtz6pERs?buvid=Y74&from_spmid=main.my-history.0.0&is_story_h5=false&mid=uvS&p=1&plat_id=116&share_from=ugc&share_medium=iphone_i&share_plat=ios&share_session_id=380&share_source=COPY&share_tag=s_i&spmid=united.player-video-detail.0.0&timestamp=1790623233&unique_k=IYQRdVm&up_id=392208938" },
    });
  };
  assert.equal(await cleanUrl("https://b23.tv/IYQRdVm", rules, fetchFn), "https://www.bilibili.com/video/BV1wwtz6pERs/");
});

test("bilibili video keeps part and timestamp", async () => {
  assert.equal(await cleanUrl("https://www.bilibili.com/video/BV1wwtz6pERs/?p=2&t=30&vd_source=abc", rules, noFetch), "https://www.bilibili.com/video/BV1wwtz6pERs/?p=2&t=30");
  assert.equal(await cleanUrl("https://www.bilibili.com/video/BV1wwtz6pERs/", rules, noFetch), null);
  assert.equal(await cleanUrl("https://www.bilibili.com/video/BV1wwtz6pERs", rules, noFetch), null);
});

test("b23.tv link reports failed resolution", async () => {
  const link = "https://b23.tv/IYQRdVm";
  await assert.rejects(cleanUrl(link, rules, async () => new Response("not found", { status: 200 })), LinkResolutionError);
  await assert.rejects(cleanUrl(link, rules, async () => { throw new Error("down"); }), LinkResolutionError);
  const elsewhere = async () => new Response(null, { status: 302, headers: { location: "https://example.com/" } });
  await assert.rejects(cleanUrl(link, rules, elsewhere), {
    constructor: LinkResolutionError, message: "Redirect did not lead to Bilibili",
  });
});

test("reddit keeps functional context param", async () => {
  assert.equal(await cleanUrl("https://www.reddit.com/r/a/comments/1/t/c2/?context=3&utm_source=share", rules, noFetch), "https://www.reddit.com/r/a/comments/1/t/c2/?context=3");
});

test("generic trackers stripped on any host, functional params kept", async () => {
  assert.equal(await cleanUrl("https://example.com/a?id=5&utm_campaign=x&fbclid=y&gclid=z#frag", rules, noFetch), "https://example.com/a?id=5#frag");
});

test("exclude patterns are respected", async () => {
  assert.equal(await cleanUrl("https://urldefense.com/v3/x?gclid=1", rules, noFetch), null);
});

test("already-clean URLs return null", async () => {
  assert.equal(await cleanUrl("https://example.com", rules, noFetch), null);
  assert.equal(await cleanUrl("example.com/page?ref=me", rules, noFetch), null);
  assert.equal(await cleanUrl("https://fixvx.com/user/status/1", rules, noFetch), null);
});

test("without rules, utm_* and extra params are still stripped", async () => {
  const failing = async () => new Response("nope", { status: 500 });
  const none = await loadRules(failing);
  assert.deepEqual(none, []);
  assert.equal(await cleanUrl("https://example.com/?utm_source=a&fbclid=b&id=1", none, noFetch), "https://example.com/?id=1");
});
