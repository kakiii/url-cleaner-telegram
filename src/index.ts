import { cleanUrl, loadRules } from "./clean.ts";

interface Env {
  WEBHOOK_SECRET: string;
}

interface MessageEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
}

interface Message {
  message_id: number;
  chat: { id: number };
  text?: string;
  caption?: string;
  entities?: MessageEntity[];
  caption_entities?: MessageEntity[];
}

function extractUrls(message: Message): string[] {
  const text = message.text ?? message.caption ?? "";
  const entities = message.entities ?? message.caption_entities ?? [];
  // Entity offsets are UTF-16 code units, which is what String.slice uses.
  return entities.flatMap((e) =>
    e.type === "url" ? [text.slice(e.offset, e.offset + e.length)]
    : e.type === "text_link" && e.url ? [e.url]
    : [],
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST" || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
      return new Response("Not found", { status: 404 });
    }

    const update = (await request.json()) as { message?: Message };
    const message = update.message;
    if (!message) return new Response(null, { status: 204 });

    const urls = [...new Set(extractUrls(message))];
    if (urls.length === 0) return new Response(null, { status: 204 });
    const rules = await loadRules();
    // Entity text can still be something new URL() rejects; skip those links rather than fail the update.
    const cleaned = await Promise.all(urls.map((u) => cleanUrl(u, rules).catch(() => null)));
    const changed = cleaned.filter((c) => c !== null);
    if (changed.length === 0) return new Response(null, { status: 204 });

    // Replying in the webhook response lets Telegram send the message without the Worker holding the bot token.
    return Response.json({
      method: "sendMessage",
      chat_id: message.chat.id,
      text: changed.join("\n"),
      reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
    });
  },
} satisfies ExportedHandler<Env>;
