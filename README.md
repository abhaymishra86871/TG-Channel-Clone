# Telegram Channel Copier (free: Render + UptimeRobot + GitHub Pages)

```
repo/
├── server/   -> deployed on Render (Node, no dependencies)
└── docs/     -> GitHub Pages control panel
```

## 1. Telegram
1. @BotFather -> `/newbot` -> copy the token.
2. Add the bot as **admin** in the source channel (Telegram does not allow plain "members" in channels; no special rights needed) and as **admin with "Post messages"** in the destination.
3. Channel ID: forward a channel post to @RawDataBot / @username_to_id_bot -> `-100xxxxxxxxxx`.
4. Message ID: right-click a post -> Copy Link -> the last number (`t.me/c/123/456` -> `456`).

## 2. (Recommended) Free progress storage - Upstash Redis
Render's free disk is wiped on every redeploy/sleep, so a `state.json` alone can be lost.
1. upstash.com -> Create Database (free) -> copy **REST URL** and **REST TOKEN**.

## 3. GitHub
Push this repo to GitHub. Settings -> Pages -> Deploy from branch -> `main` / `/docs`.
Your panel is at `https://<user>.github.io/<repo>/`.

## 4. Render
New -> Web Service -> connect repo.
- Root Directory: `server`
- Build Command: *(empty or `npm install`)*
- Start Command: `node server.js`
- Instance type: **Free**

Environment variables:

| Name | Value |
|---|---|
| `BOT_TOKEN` | token from BotFather |
| `PIN` | your PIN (2 digits works; longer is safer) |
| `ALLOWED_ORIGIN` | `https://<user>.github.io` (origin only, **no** `/repo` path, no trailing slash) |
| `UPSTASH_REDIS_REST_URL` | from Upstash (optional) |
| `UPSTASH_REDIS_REST_TOKEN` | from Upstash (optional) |
| `DELAY_MS` | optional, default `3000` (= 20 msgs/min, Telegram's per-chat limit) |

## 5. UptimeRobot (keeps Render awake)
New monitor -> HTTP(s) -> URL `https://<your-service>.onrender.com/health` -> interval 5 min.
Render free sleeps after 15 min without traffic; this ping prevents that.

## 6. Use it
Open the GitHub page -> Render URL, source ID, destination ID, start ID, end ID, PIN -> **Start**.
Stop / Resume / Refresh are on the same page.

## Behaviour
- Progress saved after every message (local file) and every 5 messages (Upstash).
- On crash / redeploy / restart, a running job **auto-resumes** at the next un-copied ID.
- Telegram 429 -> waits `retry_after`+1 s, retries the same message, and permanently slows down a bit.
- Network / 5xx errors -> exponential backoff (2s..60s), retried forever.
- Deleted or non-copyable IDs are skipped and counted.
- Fatal problems (bad token, bot kicked, no admin rights) stop the job with the error shown on the page.
- 5 wrong PINs -> locked 15 min (doubling each time, max 24 h). Requests from any origin other than `ALLOWED_ORIGIN` are rejected.

## Limits worth knowing
- Channels with "Restrict saving content" cannot be copied (Telegram blocks it).
- Albums are copied as separate messages, in order.
- Message dates/authors are those of the bot's new posts, not the originals.
- Render free = 750 h/month, enough for one always-on service.
