# Telegram Bot - Kling 2.6 Motion Control

## Overview
Telegram bot that generates motion control videos using Freepik's Kling 2.6 Motion Control API. The bot transfers motion from a reference video to a character image. Users must login with their xclip account and have an active Motion Control subscription.

## Architecture
- **Runtime**: Node.js 22
- **Entry point**: `index.js`
- **Dependencies**: `node-telegram-bot-api`, `axios`, `express`, `pg`, `bcrypt`, `https-proxy-agent`
- **Workflow**: "Telegram Bot" runs `node index.js`
- **File server**: Express serves uploaded files on configurable port (default 3000)
- **Database**: PostgreSQL on Railway (user accounts, motion subscriptions)

## How It Works
1. User logs in with `/login username password` (verified against Railway PostgreSQL)
2. Bot checks `motion_subscriptions` table for active subscription
3. User sends a character image via Telegram
4. User sends a reference motion video
5. Bot downloads files locally and serves them via public URL
6. Bot submits both to Freepik Kling 2.6 Motion Control API (via proxy)
7. Bot polls for task completion and sends the resulting video back

## Database Integration
- **Connection**: Railway PostgreSQL via `RAILWAY_DATABASE_URL`
- **Tables used**:
  - `users` — username, email, password_hash (bcrypt)
  - `motion_subscriptions` — user_id, motion_room_id, expired_at, is_active
  - `motion_rooms` — room name and capacity
- **Auth flow**: bcrypt password comparison, subscription expiry check

## Multi-API Key & Proxy Rotation
- `FREEPIK_API_KEY` supports comma-separated keys (currently 10 keys)
- `PROXY_LIST` supports comma-separated proxies (format: `host:port:user:pass`)
- `USE_PROXY` flag to enable/disable proxy (default: true)
- Automatic round-robin rotation for both keys and proxies
- Failed keys get cooldown period (120s for 429/403 errors)

## API Endpoints Used
- **Generate (Standard)**: `POST https://api.freepik.com/v1/ai/video/kling-v2-6-motion-control-std`
- **Generate (Pro)**: `POST https://api.freepik.com/v1/ai/video/kling-v2-6-motion-control-pro`
- **Check Status**: `GET https://api.freepik.com/v1/ai/image-to-video/kling-v2-6/{task-id}`

## Environment Variables (Secrets)
- `TELEGRAM_BOT_TOKEN` — Telegram bot token from @BotFather
- `FREEPIK_API_KEY` — Comma-separated Freepik API keys
- `RAILWAY_DATABASE_URL` — PostgreSQL connection string for user auth
- `PROXY_LIST` — Comma-separated proxies (host:port:user:pass)
- `USE_PROXY` — Enable/disable proxy (true/false)
- `PORT` — (optional) Port for Express file server, defaults to 3000
- `RAILWAY_PUBLIC_DOMAIN` — (auto-set by Railway) Public domain for file URLs
- `REPLIT_DEV_DOMAIN` — (auto-set by Replit) Public domain for file URLs

## Bot Commands
- `/start` — Show usage guide
- `/login username password` — Login with xclip account
- `/logout` — Logout
- `/generate` — Generate motion control video (requires login + active subscription)
- `/prompt [text]` — Set optional text prompt
- `/orientation [video|image]` — Set character orientation
- `/quality [std|pro]` — Set quality tier
- `/status` — Check current session (includes subscription info)
- `/reset` — Reset session

## Proxy Infrastructure
- VPS proxy on DigitalOcean (Squid) for clean IP routing to Freepik
- Proxy credentials stored in `PROXY_LIST` env var

## Railway Deployment
Project is ready for Railway deployment:
- `Dockerfile` included for container build
- Uses `PORT` env var from Railway
- Uses `RAILWAY_PUBLIC_DOMAIN` for public file URLs
- Health check endpoint at `GET /`

### Railway Setup Steps
1. Push code to GitHub
2. Create new project in Railway, connect the repo
3. Add environment variables: `TELEGRAM_BOT_TOKEN`, `FREEPIK_API_KEY`, `RAILWAY_DATABASE_URL`, `PROXY_LIST`, `USE_PROXY`
4. Enable public networking (generates `RAILWAY_PUBLIC_DOMAIN`)
5. Deploy
