import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";

test("failed Reddit share link replies to the original message and logs the failure", async (t) => {
  const link = "https://www.reddit.com/r/cats/s/77w4Bp190I";
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (new URL(url).hostname === "raw.githubusercontent.com") return Response.json([]);
    assert.equal(url, link);
    return new Response(null, { status: 403 });
  });
  const warn = t.mock.method(console, "warn", () => {});
  const response = await worker.fetch(new Request("https://worker.example/", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": "test-secret" },
    body: JSON.stringify({ message: {
      message_id: 42,
      chat: { id: 123 },
      text: link,
      entities: [{ type: "url", offset: 0, length: link.length }],
    } }),
  }), { WEBHOOK_SECRET: "test-secret" });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    method: "sendMessage",
    chat_id: 123,
    text: `Couldn't resolve this share link. Please try again later.\n${link}`,
    reply_parameters: { message_id: 42, allow_sending_without_reply: true },
  });
  assert.equal(warn.mock.callCount(), 1);
  assert.deepEqual(warn.mock.calls[0].arguments, [{
    event: "link_resolution_failed",
    url: link,
    reason: "Expected a redirect, got HTTP 403",
  }]);
});

test("already-clean URLs still return no reply", async (t) => {
  const link = "https://example.com/page";
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.equal(new URL(url).hostname, "raw.githubusercontent.com");
    return Response.json([]);
  });
  const warn = t.mock.method(console, "warn", () => {});
  const response = await worker.fetch(new Request("https://worker.example/", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": "test-secret" },
    body: JSON.stringify({ message: {
      message_id: 42,
      chat: { id: 123 },
      text: link,
      entities: [{ type: "url", offset: 0, length: link.length }],
    } }),
  }), { WEBHOOK_SECRET: "test-secret" });

  assert.equal(response.status, 204);
  assert.equal(warn.mock.callCount(), 0);
});

test("a failed share link does not hide other cleaned links in the message", async (t) => {
  const reddit = "https://www.reddit.com/r/cats/s/77w4Bp190I";
  const twitter = "https://x.com/user/status/123?s=20";
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (new URL(url).hostname === "raw.githubusercontent.com") return Response.json([]);
    assert.equal(url, reddit);
    return new Response(null, { status: 403 });
  });
  t.mock.method(console, "warn", () => {});
  const response = await worker.fetch(new Request("https://worker.example/", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": "test-secret" },
    body: JSON.stringify({ message: {
      message_id: 42,
      chat: { id: 123 },
      text: `${reddit}\n${twitter}`,
      entities: [
        { type: "url", offset: 0, length: reddit.length },
        { type: "url", offset: reddit.length + 1, length: twitter.length },
      ],
    } }),
  }), { WEBHOOK_SECRET: "test-secret" });

  assert.equal(response.status, 200);
  const reply = await response.json() as { text: string };
  assert.equal(reply.text, `Couldn't resolve this share link. Please try again later.\n${reddit}\nhttps://fixvx.com/user/status/123`);
});
