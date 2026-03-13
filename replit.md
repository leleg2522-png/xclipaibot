# Telegram Bot - Kling Motion Control (Glio.io)

## Overview
Telegram bot that generates motion control videos using Glio.io's unified API for Kling Motion Control (v2.6 and v3). The bot transfers motion from a reference video to a character image. Users must login with their xclip account and have an active Motion Control subscription.

## Architecture
- **Runtime**: Node.js 22
- **Entry point**: `index.js`
- **Dependencies**: `node-telegram-bot-api`, `axios`, `express`, `pg`, `bcrypt`, `https-proxy-agent`
- **Workflow**: "Telegram Bot" runs `node index.js`
- **File server**: Express serves uploaded files on configurable port (default 3000)
- **Database**: PostgreSQL on Railway (user accounts, motion subscriptions)
- **API Provider**: Glio.io (pay-per-use GL tokens, unified API)

## How It Works
1. User logs in with `/login username password` (verified against Railway PostgreSQL)
2. Bot checks `motion_subscriptions` table for active subscription
3. User sends a character image via Telegram
4. User sends a reference motion video
5. Bot downloads files locally and serves them via public URL
6. User selects model (Kling 2.6 or Kling 3) and quality (720p or 1080p)
7. Bot submits job to Glio.io API
8. Bot polls for job completion and sends the resulting video back

## Database Integration
- **Connection**: Railway PostgreSQL via `RAILWAY_DATABASE_URL`
- **Tables used**:
  - `users` — username, email, password_hash (bcrypt)
  - `motion_subscriptions` — user_id, motion_room_id, expired_at, is_active
  - `motion_rooms` — room name and capacity
- **Auth flow**: bcrypt password comparison, subscription expiry check

## Glio.io API Integration
- **Submit Job**: `POST https://api.glio.io/v1/jobs` with `{ model, params }`
- **Check Status**: `GET https://api.glio.io/v1/jobs/{id}`
- **Auth**: `Authorization: Bearer <API_KEY>`
- **Models**:
  - `kling-v2.6-motion-control` — Kling 2.6 motion control
  - `kling-3.0-motion-control` — Kling 3.0 motion control
- **Params**: `image_url`, `video_url`, `mode` (720p/1080p), `character_orientation`, `prompt`
- **Response**: Job ID → poll until `status: "completed"` → get `result.url`

## Multi-API Key System
- `GLIO_API_KEY` supports comma-separated keys for parallel tasks
- Each active task locks one key exclusively (1 task = 1 key)
- Keys auto-unlock when task completes, fails, or times out
- Failed keys get cooldown (429→5min, 401/402/403→24h)

## Proxy Infrastructure (Optional)
- `PROXY_LIST` supports comma-separated proxies (format: `host:port:user:pass`)
- `USE_PROXY` flag to enable/disable proxy (default: true)
- Proxies rotate with least-recently-used algorithm
- Blocked proxies get 2-hour cooldown
- Note: Proxies may not be needed with Glio.io (no IP blocking)

## Environment Variables (Secrets)
- `TELEGRAM_BOT_TOKEN` — Telegram bot token from @BotFather
- `GLIO_API_KEY` — Comma-separated Glio.io API keys (fallback: `FREEPIK_API_KEY`)
- `RAILWAY_DATABASE_URL` — PostgreSQL connection string for user auth
- `PROXY_LIST` — (optional) Comma-separated proxies (host:port:user:pass)
- `USE_PROXY` — (optional) Enable/disable proxy (true/false)
- `PORT` — (optional) Port for Express file server, defaults to 3000
- `RAILWAY_PUBLIC_DOMAIN` — (auto-set by Railway) Public domain for file URLs

## Bot Commands
- `/start` — Show usage guide
- `/login username password` — Login with xclip account
- `/logout` — Logout
- `/generate` — Generate motion control video (select model → quality)
- `/prompt [text]` — Set optional text prompt
- `/orientation [video|image]` — Set character orientation
- `/model [v2.6|v3]` — Set model (Kling 2.6 or Kling 3)
- `/quality [std|pro]` — Set quality tier (720p or 1080p)
- `/status` — Check current session (includes subscription info)
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
3. Add environment variables: `TELEGRAM_BOT_TOKEN`, `GLIO_API_KEY`, `RAILWAY_DATABASE_URL`
4. Enable public networking (generates `RAILWAY_PUBLIC_DOMAIN`)
5. Deploy
