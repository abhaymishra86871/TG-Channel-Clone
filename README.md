# Telegram Channel Copier (free: Render + UptimeRobot + GitHub Pages + Upstash)

```
repo/
├── server/   -> runs on Render (Node)
└── docs/     -> GitHub Pages control panel
```

Two ways to copy, chosen per run on the panel:

| | Bot token | My account (session) |
|---|---|---|
| Source channel | bot must be **admin** | account only needs to be a **member** |
| Destination | bot must be admin + "Post messages" | account must be admin + "Post messages" |
| Ban risk | none for your account | **your account can be limited or banned by Telegram** (use a spare account) |
| "Forwarded from" shown? | no | no |

The token / session is typed into the panel each run (never saved in the page).
The server keeps it only so a crashed or restarted job can resume, encrypted with `ENC_KEY`.

## STEP 1 - Telegram bot (skip if you only use account mode)
1. @BotFather -> `/newbot` -> copy the token (`123456:ABC...`).
2. Add the bot as admin to the source channel (no special rights needed) and to the destination (with Post Messages).

## STEP 2 - Account mode only: API ID and hash
1. Go to **my.telegram.org** -> log in with the phone number -> API development tools.
2. Create an application (any name) -> copy **api_id** (number) and **api_hash** (32 characters).
3. Add that account as admin (Post Messages ON) in the destination channel, and make sure it has joined the source channel.

## STEP 3 - Channel IDs and message IDs
- Channel ID: forward a post from the channel to **@RawDataBot** -> `forward_from_chat.id` -> `-1001234567890`.
- Message ID: right-click a post -> Copy Post Link -> last number (`t.me/c/123/456` -> `456`).

## STEP 4 - Upstash Redis (free, remembers progress)
Render's free disk is wiped on redeploy/sleep. Upstash keeps the progress JSON (about 300 bytes plus encrypted credentials), never media.
1. upstash.com -> Create Database (free) -> REST API section -> copy `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.

## STEP 5 - GitHub
1. New **public** repo; upload `server/` and `docs/` (keep the folders), `README.md`, `.gitignore`.
2. Settings -> Pages -> Deploy from a branch -> `main` / `/docs`.
3. Panel URL: `https://<github-username>.github.io/<repo>/`.

## STEP 6 - Render
New -> Web Service -> your repo. Root Directory `server`, Build Command `npm install`, Start Command `node server.js`, Instance Type **Free**.

Environment variables:

| Name | Value |
|---|---|
| `PIN` | exactly 4 digits, e.g. `4827` |
| `ALLOWED_ORIGIN` | `https://<github-username>.github.io` (no repo path, no trailing slash) |
| `ENC_KEY` | long random text (20+ chars). **Required for account mode**; recommended always. Never change it while a job is saved, or resume cannot decrypt. |
| `UPSTASH_REDIS_REST_URL` | from Step 4 |
| `UPSTASH_REDIS_REST_TOKEN` | from Step 4 |
| `BOT_TOKEN` | optional default bot token (panel field can stay empty) |
| `DELAY_MS` | optional, default `3000` ms between messages |

Open `<render-url>/health` -> should say `ok`.

## STEP 7 - UptimeRobot
Add Monitor -> HTTP(s) -> `https://<render-url>/health` -> every 5 minutes. Keeps Render from sleeping.

## STEP 8 - Use the panel
1. Enter Render URL, PIN, choose **Bot token** or **My account**.
2. *Account mode first time:* enter API ID + API hash -> **Generate session (OTP)** -> phone number with country code -> code from your Telegram app -> 2-step password if you have one -> session is filled in. Save it in a password manager so you can reuse it.
3. Enter source/destination IDs and start/end message IDs.
4. **Check setup** -> popup shows the bot/account name and both channel names with admin status. Fix any red items.
5. **Start**. Stop / Resume are on the same page. You can close the page; the job keeps running.

## Behaviour
- Progress saved after every message (local) and every 5 messages (Upstash). After a crash/restart a running job resumes automatically.
- Flood limits (429 / FLOOD_WAIT): waits the time Telegram asks, retries the same message, then slows down a bit.
- Network / 5xx errors: backoff 2 s..60 s, retried forever.
- Deleted / non-copyable IDs are skipped and counted. Fatal problems (revoked session, no rights, restricted channel) stop the job with the error shown.
- 5 wrong PINs -> locked 15 min (doubling each time, max 24 h). Other origins are rejected.

## Security notes
- A session string = full access to that Telegram account. Revoke it any time: Telegram -> Settings -> Devices.
- Logging in from Render (a datacenter IP) can trigger Telegram's security checks; sometimes the code is delayed or refused. Retry later or use bot mode.
- Don't run the same session in two places at once (also during a Render redeploy overlap): Telegram may kill it (`AUTH_KEY_DUPLICATED`).

## Limits
- Channels with "Restrict saving content" cannot be copied in either mode.
- Albums are copied as separate messages, in order.
- Copied posts get new dates.
- Render free = 750 h/month, enough for one always-on service.
