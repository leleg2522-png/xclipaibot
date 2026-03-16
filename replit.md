# Telegram Bot - Kling Motion Control (Freepik API)

## Overview
Telegram bot that generates motion control videos using Freepik's API for Kling 2.6 Motion Control. The bot transfers motion from a reference video to a character image. Users must login with their xclip account and have an active Motion Control subscription.

## Architecture
- **Runtime**: Node.js 20
- **Entry point**: `index.js`
- **Dependencies**: `node-telegram-bot-api`, `axios`, `express`, `pg`, `bcryptjs`, `https-proxy-agent`
- **Workflow**: "Telegram Bot" runs `node index.js`
- **File server**: Express serves uploaded files on configurable port (default 3000)
- **Database**: PostgreSQL on Railway (user accounts, motion subscriptions)
- **API Provider**: Freepik API (Kling 2.6 Motion Control)

## How It Works
1. User logs in with `/login username password` (verified against Railway PostgreSQL)
2. Bot checks `motion_subscriptions` table for active subscription
3. User sends a character image via Telegram
4. User sends a reference motion video
5. Bot downloads files locally and serves them via public URL
6. User selects quality (Standard or Pro)
7. Bot submits job to Freepik API
8. Bot polls for job completion and sends the resulting video back

## Database Integration
- **Connection**: Railway PostgreSQL via `RAILWAY_DATABASE_URL`
- **Tables used**:
  - `users` — username, email, password_hash (bcrypt)
  - `motion_subscriptions` — user_id, motion_room_id, expired_at, is_active
  - `motion_rooms` — room name and capacity
- **Auth flow**: bcrypt password comparison, subscription expiry check

## Freepik API Integration
- **Submit Job (Pro)**: `POST https://api.freepik.com/v1/ai/video/kling-v2-6-motion-control-pro`
- **Submit Job (Std)**: `POST https://api.freepik.com/v1/ai/video/kling-v2-6-motion-control-std`
- **Check Status**: `GET https://api.freepik.com/v1/ai/image-to-video/kling-v2-6/{task-id}`
- **Auth**: `x-freepik-api-key: <API_KEY>` header
- **Request body**: `{ image_url, video_url, character_orientation, cfg_scale, prompt }`
- **Response**: `{ data: { task_id, status, generated: [...] } }`

## Multi-API Key System
- `FREEPIK_API_KEY` supports comma-separated keys for parallel tasks
- Each active task locks one key exclusively (1 task = 1 key)
- Keys auto-unlock when task completes, fails, or times out
- Failed keys get cooldown (429→5min, 401/402/403→24h)

## Cooldown System
- 10-minute cooldown between generates per user (no daily limit)
- Tracked in-memory via Map

## Proxy Infrastructure (Optional)
- `PROXY_LIST` supports comma-separated proxies (format: `host:port:user:pass`)
- `USE_PROXY` flag to enable/disable proxy (default: true)
- Proxies rotate with least-recently-used algorithm
- Blocked proxies get 2-hour cooldown

## Environment Variables (Secrets)
- `TELEGRAM_BOT_TOKEN` — Telegram bot token from @BotFather
- `FREEPIK_API_KEY` — Comma-separated Freepik API keys
- `RAILWAY_DATABASE_URL` — PostgreSQL connection string for user auth
- `PROXY_LIST` — (optional) Comma-separated proxies (host:port:user:pass)
- `USE_PROXY` — (optional) Enable/disable proxy (true/false)
- `PORT` — (optional) Port for Express file server, defaults to 3000

## Bot Commands
- `/start` — Show usage guide
- `/login username password` — Login with xclip account
- `/logout` — Logout
- `/generate` — Generate motion control video (select quality)
- `/prompt [text]` — Set optional text prompt
- `/orientation [video|image]` — Set character orientation
- `/quality [std|pro]` — Set quality tier
- `/status` — Check current session (includes subscription info, cooldown)
- `/reset` — Reset session
