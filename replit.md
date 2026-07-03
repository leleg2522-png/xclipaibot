# Telegram Bot - AI Video Generator (Flora AI)

## Overview
A Telegram bot that generates videos using **Flora AI**, specifically the **Kling 2.6 Pro Motion Control** model. Users send a character photo plus a reference motion video, and the bot produces a video of the character performing that motion. Bot messages are in Indonesian.

## Purpose on Replit
This project runs directly on Replit. The "Start application" workflow runs `npm start` (Node.js) which starts the Telegram bot together with a small Express file/health server on port 5000.

## Structure
- `index.js` — Main bot logic: Telegram interactions, Flora AI API, multi-key pool management, Express file/health server
- `package.json` — Node.js dependencies (includes a `form-data` override)

## Flora AI integration
- Base URL: `https://app.flora.ai`, auth via `Authorization: Bearer <FLORA_API_KEY>`.
- Model discovery: `GET /api/v1/models` → the "Kling 2.6 Pro Motion Control" endpoint id is `iv2v-kling-2.6-motion` (discovered at runtime, cached).
- Context discovery per key: `GET /api/v1/workspaces` → `workspace_id`, `GET /api/v1/projects?workspace_id=...` → `project_id` (created if missing, cached per key).
- **Media host allowlist:** Flora only fetches input media from allowlisted hosts (`media.flora.ai`, `storage.googleapis.com`, S3). Our own file server (Railway/Replit domain) is NOT accepted — passing such URLs makes `/generate` accept + charge, then fail instantly with `GENERATION_GENERIC_ERROR`.
- **Upload flow (required before generate):** `POST /api/v1/assets` with `{ source:"signed-url", workspace_id, filename, content_type }` → returns `url` (final `media.flora.ai` URL) + `upload` (an ImageKit signed multipart form). POST the file bytes to `upload.url` using `upload.form_fields` + the `upload.file_field` (default `file`). The returned `media.flora.ai` URL is public and reusable across keys.
- Submit: `POST /api/v1/generate` with body `{ type:"video", model, workspace_id, project_id, prompt, params:{ image_url, video_url, character_orientation } }` — where `image_url`/`video_url` are the uploaded `media.flora.ai` URLs. `params.character_orientation` is `image`|`video`.
- Poll: `GET` the returned `poll_url` until `status` is `completed`/`failed`; on completion, video URL is at `outputs[].url`.

## Identity & saldo (balance) system
- **No login.** Identity is the Telegram user ID. Every incoming message upserts a row in `xclipaibot_users` (refreshes `username`/`first_name`).
- **Saldo = per-generate credits.** 1 saldo = 1 video. Saldo is deducted **only on success** (video completed with a usable output URL), never on submit or on failure. The atomic `deductBalance` (`UPDATE ... WHERE balance >= amount`) prevents negative/racey balances.
- `/generate` requires `balance > 0` plus the cooldown; the daily-limit system was removed.
- **Migration `/link email password`:** one-time claim. Authenticates against the shared `users` table + `checkSubscription`; if the account has an active subscription it grants a FLAT `CONVERSION_CREDITS` (100) saldo, sets `converted=TRUE` and `linked_user_id`. Anti-double-claim via `WHERE converted=FALSE`; an account already linked to another Telegram ID is rejected. The command message is auto-deleted (contains a password).
- User commands: `/saldo` (check balance), `/topup` (buy saldo), `/link` (claim), `/status`.
- Admin commands: `/addcredit <telegram_id> <jumlah>` (add/subtract saldo, negative allowed), `/users` (list users: name / @username / id / balance), `/resetlimit <telegram_id>` (clear cooldown), `/topuphistory [telegram_id]` (recent top-ups).

## Auto top-up (KlikQRIS payment gateway)
- Users buy saldo themselves via `/topup` → pick a package → receive a QRIS image + payment link. On payment, saldo is credited **automatically**.
- Provider: **KlikQRIS "MY PG" v2**, base `https://klikqris.com/api/qrisv2`. Auth via headers `x-api-key` + `id_merchant`.
- Create: `POST /create` `{ order_id, id_merchant, amount, keterangan }` → `data.total_amount` (charge this to the buyer), `data.qris_url` (QR image), `data.direct_url` (pay page), `data.signature`, `data.expired_at`, `status:"PENDING"`.
- Status: `GET /status/{id_merchant}/{order_id}`.
- **Crediting is NOT webhook-dependent.** KlikQRIS "MY PG v2" has no self-service webhook-URL field in its dashboard (setup requires contacting them), so the reliable path is **auto-polling**: a background sweep (`startTopupPoller`/`sweepPendingTopups`, every `TOPUP_POLL_INTERVAL_MS`≈15s) checks each recent `PENDING` order via `/status` and credits automatically on `PAID`. Reads from the DB so it survives restarts; only polls orders newer than `TOPUP_POLL_WINDOW_MINUTES` (120) to bound load, and **never force-expires by age** (that could block a legitimate late payment) — an order only becomes `EXPIRED` when the provider itself reports `EXPIRED`. Concurrency-limited (`TOPUP_POLL_CONCURRENCY`).
- **Webhook** `POST /webhook/klikqris` still exists as an optional accelerator if KlikQRIS is configured to POST to it — fired on `PAID`/`EXPIRED`, verified by matching the webhook's `data.signature` against the signature stored at create time (NOT HMAC), idempotent, always returns HTTP 200. The manual "Cek pembayaran" button also polls `/status`.
- All three paths (auto-poll, webhook, manual button) funnel through the idempotent, transactional `creditTopupIfPaid` (row lock → add balance → mark `PAID` in one commit), so saldo is credited **exactly once** per order.
- **No fixed packages.** Price is flat: `PRICE_PER_VIDEO` (Rp2.000) per video (`index.js`). Users pick a quick amount or type `/topup <jumlah>` (e.g. `/topup 7`); charge = `jumlah × PRICE_PER_VIDEO`. Quick-pick buttons come from `TOPUP_QUICK_PICKS`; min/max from `TOPUP_MIN_VIDEOS`/`TOPUP_MAX_VIDEOS`.

## Multi-key pool system
- Flora API keys are stored in the `api_key_pool` table; each user is assigned keys from the pool (`user_api_keys`).
- On submit, keys are rotated. A dead/exhausted key (HTTP 401/402/403/429) is automatically replaced from the pool.
- Admins load keys in-bot via `/addkeys`; inspect with `/poolstatus`.

## Key Dependencies
- `node-telegram-bot-api` — Telegram bot library
- `axios` — HTTP client for the Flora API
- `express` — File/health server
- `pg` — PostgreSQL client
- `bcryptjs` — Password hashing

## Environment Variables / Secrets
- `FLORA_API_KEY` — a Flora AI API key (used for model/context discovery; per-user generation uses pooled keys). Configured.
- `RAILWAY_DATABASE_URL` / `DATABASE_URL` — PostgreSQL connection string. Configured.
- `TELEGRAM_BOT_TOKEN` — Telegram bot token from @BotFather. **Required for the bot to run.**
- `ADMIN_TELEGRAM_IDS` — comma-separated Telegram user IDs allowed to use admin commands (`/addkeys`, `/poolstatus`, `/addcredit`, `/users`, `/resetlimit`, `/topuphistory`).
- `KLIKQRIS_API_KEY` — KlikQRIS `x-api-key` for the top-up gateway. **Required for `/topup` to work.**
- `KLIKQRIS_MERCHANT_ID` — KlikQRIS `id_merchant`. **Required for `/topup` to work.**
- `REPLIT_DEV_DOMAIN` / `RAILWAY_PUBLIC_DOMAIN` — used to build public URLs for uploaded media (runtime-provided). The webhook URL registered at KlikQRIS is `https://<public-domain>/webhook/klikqris`.

## Database
- **The Postgres instance (`RAILWAY_DATABASE_URL`) is SHARED across multiple bots.** Tables `users`, `subscriptions`, `motion_subscriptions`, `motion_rooms`, `subscription_plans`, `payments` are owned by other apps and treated as **READ-ONLY** here (used only by `/link`). Never write to them. `xclipmotion_bot_users` belongs to a different bot — do not touch.
- **All tables owned by this bot are prefixed `xclipaibot_`.** New tables must keep that prefix.
- Tables this bot owns/writes: `api_key_pool`, `user_api_keys`, `xclipaibot_users` (`telegram_id` PK, `username`, `first_name`, `balance`, `linked_user_id`, `converted`, timestamps), `xclipaibot_topups` (`order_id` PK, `telegram_id`, `amount`, `total_amount`, `video_count`, `signature`, `status`, timestamps).

## User limits
- Generation requires available saldo (1 per video).
- Cooldown: 3 minutes between generations.

## User preferences
- Communicate with the user in Indonesian.
