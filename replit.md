# Telegram Bot - Kling Motion Control (Freepik API)

## Overview
Telegram bot that generates motion control videos using Freepik's API for Kling 2.6 Motion Control. The bot transfers motion from a reference video to a character image. Only users with active monthly subscriptions can access the bot.

## Architecture
- **Runtime**: Node.js 20
- **Entry point**: `index.js`
- **Dependencies**: `node-telegram-bot-api`, `axios`, `express`, `pg`, `bcryptjs`, `https-proxy-agent`
- **Workflow**: "Telegram Bot" runs `node index.js`
- **File server**: Express serves uploaded files on configurable port (default 3000)
- **Database**: PostgreSQL on Railway (user accounts, subscriptions, API key pool)
- **API Provider**: Freepik API (Kling 2.6 Motion Control)

## How It Works
1. User logs in with `/login username password` (verified against Railway PostgreSQL)
2. Bot checks subscription: must be monthly (28+ days), active, not expired
3. If no monthly subscription → login rejected
4. User sends a character image via Telegram
5. User sends a reference motion video
6. Bot downloads files locally and serves them via public URL
7. User selects quality (Standard or Pro)
8. Bot assigns 3 API keys from pool to user (if not already assigned)
9. Bot submits job to Freepik API using user's keys
10. Bot polls for job completion and sends the resulting video back

## Database Tables
- **users** — username, email, password_hash (bcrypt)
- **motion_subscriptions** — user_id, motion_room_id, expired_at, is_active
- **motion_rooms** — room name and capacity
- **subscriptions** — user_id, plan_id, expired_at, status
- **subscription_plans** — plan name, duration_days
- **api_key_pool** — api_key, status (available/assigned/dead), assigned_to, created_at, dead_at
- **user_api_keys** — user_id, api_key, assigned_at

## Per-User API Key Pool System
- Admin adds Freepik API keys to pool via `/addkeys key1,key2,...`
- Each user gets 2 dedicated keys assigned on first generate
- Keys stay with the user as long as they work
- If a key dies (402/403 error) → auto-replaced from pool
- If a key hits rate limit (429) → rotate to next user key, 5min cooldown
- Admin monitors with `/poolstatus`

## Subscription Enforcement
- Only monthly subscriptions (28+ days duration) are accepted
- Daily/weekly plans are rejected at login
- Subscription checked again at generate time

## Freepik API Integration
- **Submit Job (Pro)**: `POST https://api.freepik.com/v1/ai/video/kling-v2-6-motion-control-pro`
- **Submit Job (Std)**: `POST https://api.freepik.com/v1/ai/video/kling-v2-6-motion-control-std`
- **Check Status**: `GET https://api.freepik.com/v1/ai/image-to-video/kling-v2-6/{task-id}`
- **Auth**: `x-freepik-api-key: <API_KEY>` header
- **Request body**: `{ image_url, video_url, character_orientation, cfg_scale, prompt }`
- **Response**: `{ data: { task_id, status, generated: [...] } }`

## Cooldown System
- 10-minute cooldown between generates per user (no daily limit)
- Tracked in-memory via Map

## Proxy Infrastructure (Decodo — Bandwidth-Optimized)
- `VPS_PROXIES` — Decodo rotating proxy (format: `host:port:username:password`)
- Proxy used ONLY for small JSON requests (submit task ~1-2KB, poll status ~500B)
- Image upload and video download go DIRECT (no proxy) to save bandwidth
- Auto-retry with IP rotation on socket errors or blocks (max 10 attempts)
- Fallback to direct connection if no proxy configured

## Environment Variables (Secrets)
- `TELEGRAM_BOT_TOKEN` — Telegram bot token from @BotFather
- `ADMIN_TELEGRAM_IDS` — Comma-separated Telegram user IDs for admin access
- `RAILWAY_DATABASE_URL` — PostgreSQL connection string for user auth & key pool
- `VPS_PROXIES` — (optional) Decodo proxy (gate.decodo.com:10001:username:password)
- `PORT` — (optional) Port for Express file server, defaults to 3000

## Bot Commands
### User Commands
- `/start` — Show usage guide
- `/login username password` — Login (requires monthly subscription)
- `/logout` — Logout
- `/generate` — Generate motion control video
- `/prompt [text]` — Set optional text prompt
- `/orientation [video|image]` — Set character orientation
- `/quality [std|pro]` — Set quality tier
- `/status` — Check current session
- `/reset` — Reset session

### Admin Commands
- `/addkeys key1,key2,...` — Add Freepik API keys to pool
- `/poolstatus` — View pool statistics
