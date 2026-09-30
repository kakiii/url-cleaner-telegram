# url-cleaner-telegram

Telegram group bot on Cloudflare Workers (free plan) that replies with cleaned links:

- `x.com` / `twitter.com` → `fixvx.com`, query string dropped
- `youtu.be/<id>` → `youtube.com/watch?v=<id>` (timestamp kept)
- Reddit `/s/` share links → resolved to the full `/comments/<id>/<title>/` URL
- `b23.tv` short links → resolved to `bilibili.com`, keeping only the part (`p`) and timestamp (`t`) params (also applied to direct `bilibili.com/video/` links)
- Instagram posts/reels → `kkinstagram.com` for a playable preview
- tracker params stripped using [Brave's `clean-urls.json`](https://github.com/brave/adblock-lists/blob/master/brave-lists/clean-urls.json) (fetched at runtime, cached for a day), plus `utm_*`, `fbclid`, `msclkid`, `dclid`, `twclid`

`kkinstagram.com` is an anonymous third-party frontend with no fallback. If Instagram previews stop working, pick a working alternative and change the host in `src/clean.ts`.

Links that are already clean get no reply. If a Reddit or Bilibili share link cannot be resolved within 10 seconds, the bot replies with a failure notice and the original link. The failure reason is recorded in Cloudflare Workers Logs. The bot answers through the webhook response, so the Worker never stores the bot token.

## Deploy

1. In [@BotFather](https://t.me/BotFather): `/newbot` (save the token), then `/setprivacy` → your bot → **Disable** so it sees ordinary group messages.
2. Deploy the Worker and set a random webhook secret:
   ```sh
   npm install
   npx wrangler login
   npm run deploy                       # prints https://url-cleaner-telegram.<you>.workers.dev
   openssl rand -hex 32                 # use as the secret below
   npx wrangler secret put WEBHOOK_SECRET
   ```
3. Point Telegram at the Worker:
   ```sh
   curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
     -d url=https://url-cleaner-telegram.<you>.workers.dev \
     -d secret_token=<WEBHOOK_SECRET> \
     -d 'allowed_updates=["message"]'
   ```
4. Add the bot to the group. If privacy mode was changed after the bot joined, remove and re-add it.

## Updates

Pushing to `main` deploys automatically via Cloudflare Workers Builds (no build command; deploy command `npx wrangler deploy`). Run `npm test` before pushing. Manual deploy: `npm run deploy`.

## Develop

```sh
npm test          # unit tests (node --test)
npm run check     # type check
echo WEBHOOK_SECRET=localtest > .dev.vars && npm run dev
```
