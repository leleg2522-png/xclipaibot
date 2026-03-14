# Telegram Bot - Kling Motion Control (apimodels.app)

## Overview
Telegram bot that generates motion control videos using apimodels.app's API for Kling Motion Control. The bot transfers motion from a reference video to a character image. Users must login with their xclip account and have an active Motion Control subscription.

## Architecture
- **Runtime**: Node.js 22
- **Entry point**: `index.js`
- **Dependencies**: `node-telegram-bot-api`, `axios`, `express`, `pg`, `bcrypt`, `https-proxy-agent`
- **Workflow**: "Telegram Bot" runs `node index.js`
- **File server**: Express serves uploaded files on configurable port (default 3000)
- **Database**: PostgreSQL on Railway (user accounts, motion subscriptions, daily usage tracking)
- **API Provider**: apimodels.app (pay-per-use credits)

## How It Works
1. User logs in with `/login username password` (verified against Railway PostgreSQL)
2. Bot checks `motion_subscriptions` table for active subscription
3. User sends a character image via Telegram
4. User sends a reference motion video
5. Bot downloads files locally and serves them via public URL
6. User selects quality (720p or 1080p)
7. Bot submits job to apimodels.app API
8. Bot polls for job completion and sends the resulting video back

## Database Integration
- **Connection**: Railway PostgreSQL via `RAILWAY_DATABASE_URL`
- **Tables used**:
  - `users` — username, email, password_hash (bcrypt)
  - `motion_subscriptions` — user_id, motion_room_id, expired_at, is_active
  - `motion_rooms` — room name and capacity
  - `daily_usage` — user_id, usage_date, count (5 per day limit)
- **Auth flow**: bcrypt password comparison, subscription expiry check

## apimodels.app API Integration
- **Submit Job**: `POST https://apimodels.app/api/v1/video/generations` with `{ model, input_urls, video_urls, mode, character_orientation }`
- **Check Status**: `GET https://apimodels.app/api/v1/video/generations?task_id=xxx`
- **Auth**: `Authorization: Bearer <API_KEY>`
- **Model**: `kling-motion-control`
- **Request body**: `input_urls` (array of image URLs), `video_urls` (array of video URLs), `mode` (720p/1080p), `character_orientation` (image/video)
- **Response**: `{ code: 200, data: { task_id, status, videos: [...] } }`

## Multi-API Key System
- `APIMODELS_API_KEY` supports comma-separated keys for parallel tasks (fallback: `GLIO_API_KEY`, `FREEPIK_API_KEY`)
- Each active task locks one key exclusively (1 task = 1 key)
- Keys auto-unlock when task completes, fails, or times out
- Failed keys get cooldown (429→5min, 401/402/403→24h)

## Daily Usage Limit
- Each user limited to 5 generations per day
- Tracked in `daily_usage` table (resets daily)
- 10-minute cooldown between generates

## Proxy Infrastructure (Optional)
- `PROXY_LIST` supports comma-separated proxies (format: `host:port:user:pass`)
- `USE_PROXY` flag to enable/disable proxy (default: true)
- Proxies rotate with least-recently-used algorithm
- Blocked proxies get 2-hour cooldown

## Environment Variables (Secrets)
- `TELEGRAM_BOT_TOKEN` — Telegram bot token from @BotFather
- `APIMODELS_API_KEY` — Comma-separated apimodels.app API keys (fallback: `GLIO_API_KEY`, `FREEPIK_API_KEY`)
- `RAILWAY_DATABASE_URL` — PostgreSQL connection string for user auth
- `PROXY_LIST` — (optional) Comma-separated proxies (host:port:user:pass)
- `USE_PROXY` — (optional) Enable/disable proxy (true/false)
- `PORT` — (optional) Port for Express file server, defaults to 3000
- `RAILWAY_PUBLIC_DOMAIN` — (auto-set by Railway) Public domain for file URLs

## Bot Commands
- `/start` — Show usage guide
- `/login username password` — Login with xclip account
- `/logout` — Logout
- `/generate` — Generate motion control video (select quality)
- `/prompt [text]` — Set optional text prompt
- `/orientation [video|image]` — Set character orientation
- `/quality [std|pro]` — Set quality tier (720p or 1080p)
- `/status` — Check current session (includes subscription info, daily usage)
- `/reset` — Reset session

## Railway Deployment
Project is ready for Railway deployment:
- `Dockerfile` included for container build
- Uses `PORT` env var from Railway
- Uses `RAILWAY_PUBLIC_DOMAIN` for public file URLs
- Health check endpoint at `GET /`

### Railway Setup Steps
1. Push code to GitHub
2. Create new project in Railway, connect the repo
3. Add environment variables: `TELEGRAM_BOT_TOKEN`, `APIMODELS_API_KEY`, `RAILWAY_DATABASE_URL`
4. Enable public networking (generates `RAILWAY_PUBLIC_DOMAIN`)
5. Deploy
