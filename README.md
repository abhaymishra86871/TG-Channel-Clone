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
| `DELAY_MS` | optional default delay (ms); the page has its own "Delay (seconds)" field per run |

Open `<render-url>/health` -> should say `ok`.

## STEP 7 - UptimeRobot
Add Monitor -> HTTP(s) -> `https://<render-url>/health` -> every 5 minutes. Keeps Render from sleeping.

## STEP 8 - Use the panel
1. Enter the **PIN** (top of the page). The server URL is prefilled. The PIN is remembered only until the tab closes, so a reload keeps showing live progress.
2. Choose **Bot token** or **My account**.
   - *Already have a session string?* Enter API ID + API hash + the session string, and skip the OTP step.
   - *No session yet:* enter API ID + API hash, then **Generate session (OTP)** -> phone number with country code -> code from your Telegram app -> 2-step password if you have one -> the session is filled in. Save it in a password manager.
3. Enter source/destination IDs, start/end message IDs and the delay in seconds.
4. Progress messages (optional): bot mode -> your Telegram user ID (you must have pressed Start on the bot); account mode -> tick "Show progress in Saved Messages".
5. **Check setup** -> popup shows the bot/account name, both channel names with admin status, and whether progress messages can be delivered. Fix any red items.
6. **Start**. Stop / Resume are on the same page. You can close the page; the job keeps running.

## Behaviour
- Progress saved after every message (local) and every 5 messages (Upstash). After a crash/restart a running job resumes automatically.
- The page shows % done and the message ID it is currently at; it reads this from the server, so reloading the page never loses it.
- Progress message: one message is **edited in place** about every 15 s (never a stream of new messages): in Saved Messages (account mode) or in the chat of the user ID you entered (bot mode). On Stop/error it shows the final state.
- **On success nothing is left behind:** stored credentials, the state file and the Upstash key are deleted, and the progress message is deleted. (The page keeps showing "done" until the server next restarts.)
- Flood limits (429 / FLOOD_WAIT): waits the time Telegram asks, retries the same message, then slows down a bit.
- Network / 5xx errors: backoff 2 s..60 s, retried forever.
- Deleted / non-copyable IDs are skipped and counted. Fatal problems (revoked session, no rights, restricted channel) stop the job with the error shown.
- 5 wrong PINs -> locked 15 min (doubling each time, max 24 h). Other origins are rejected.

## PIN vs ENC_KEY (two different jobs, keep both)
- **PIN** = the door. Without it nobody can call the server (start, stop, status, login).
- **ENC_KEY** = a lock on the stored data. The token/session is kept on Render's disk and in Upstash so a crashed job can resume; ENC_KEY encrypts it there, so someone who sees your Upstash dashboard or the disk can't read your session. It is never typed on the page, so it can't replace the PIN.

## Security notes
- A session string = full access to that Telegram account. Revoke it any time: Telegram -> Settings -> Devices.
- Logging in from Render (a datacenter IP) can trigger Telegram's security checks; sometimes the code is delayed or refused. Retry later or use bot mode.
- Don't run the same session in two places at once (also during a Render redeploy overlap): Telegram may kill it (`AUTH_KEY_DUPLICATED`).

## Limits
- Channels with "Restrict saving content" cannot be copied in either mode.
- Albums are copied as separate messages, in order.
- Copied posts get new dates.
- Render free = 750 h/month, enough for one always-on service.
