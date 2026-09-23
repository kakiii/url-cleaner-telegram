import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanUrl, compileRules, loadRules } from "../src/clean.ts";

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

test("instagram posts go to instagram7.com without igsh", async () => {
  assert.equal(await cleanUrl("https://www.instagram.com/reel/Dc4fAOCs97R/?igsh=abc", rules, noFetch), "https://instagram7.com/reel/Dc4fAOCs97R/");
  assert.equal(await cleanUrl("https://www.instagram.com/p/Dc4fAOCs97R/", rules, noFetch), "https://instagram7.com/p/Dc4fAOCs97R/");
  assert.equal(await cleanUrl("https://www.instagram.com/someprofile/", rules, noFetch), null);
});

test("reddit /s/ link resolves via redirect and is cleaned", async () => {
  const fetchFn = async (url: string, init: RequestInit) => {
    assert.equal(url, "https://www.reddit.com/r/pics/s/AbCdEf12");
    assert.equal(init.redirect, "manual");
    return new Response(null, {
      status: 301,
      headers: { location: "https://www.reddit.com/r/pics/comments/abc123/some_title/?share_id=zz&utm_medium=android_app&utm_term=1" },
    });
  };
  assert.equal(await cleanUrl("https://www.reddit.com/r/pics/s/AbCdEf12", rules, fetchFn), "https://www.reddit.com/r/pics/comments/abc123/some_title/");
});

test("reddit /s/ link is left alone when reddit blocks, errors or redirects elsewhere", async () => {
  const link = "https://www.reddit.com/r/pics/s/AbCdEf12";
  assert.equal(await cleanUrl(link, rules, async () => new Response(null, { status: 403 })), null);
  assert.equal(await cleanUrl(link, rules, async () => { throw new Error("down"); }), null);
  const toLogin = async () => new Response(null, { status: 302, headers: { location: "/login/?dest=x" } });
  assert.equal(await cleanUrl(link, rules, toLogin), null);
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
