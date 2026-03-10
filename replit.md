# Telegram Bot - Kling 2.6 Motion Control

## Overview
Telegram bot that generates motion control videos using Freepik's Kling 2.6 Motion Control API. The bot transfers motion from a reference video to a character image.

## Architecture
- **Runtime**: Node.js 22
- **Entry point**: `index.js`
- **Dependencies**: `node-telegram-bot-api`, `axios`, `express`
- **Workflow**: "Telegram Bot" runs `node index.js`
- **File server**: Express serves uploaded files on configurable port (default 3000)

## How It Works
1. User sends a character image via Telegram
2. User sends a reference motion video
3. Bot downloads files locally and serves them via public URL
4. Bot submits both to Freepik Kling 2.6 Motion Control API
5. Bot polls for task completion and sends the resulting video back

## API Endpoints Used
- **Generate (Standard)**: `POST https://api.freepik.com/v1/ai/video/kling-v2-6-motion-control-std`
- **Generate (Pro)**: `POST https://api.freepik.com/v1/ai/video/kling-v2-6-motion-control-pro`
- **Check Status**: `GET https://api.freepik.com/v1/ai/video/kling-v2-6-motion-control/{task-id}`

## Environment Variables (Secrets)
- `TELEGRAM_BOT_TOKEN` — Telegram bot token from @BotFather
- `FREEPIK_API_KEY` — Freepik API key
- `PORT` — (optional) Port for Express file server, defaults to 3000
- `RAILWAY_PUBLIC_DOMAIN` — (auto-set by Railway) Public domain for file URLs
- `REPLIT_DEV_DOMAIN` — (auto-set by Replit) Public domain for file URLs

## Bot Commands
- `/start` — Show usage guide
- `/generate` — Generate motion control video
- `/prompt [text]` — Set optional text prompt
- `/orientation [video|image]` — Set character orientation
- `/quality [std|pro]` — Set quality tier
- `/status` — Check current session
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
3. Add environment variables: `TELEGRAM_BOT_TOKEN`, `FREEPIK_API_KEY`
4. Enable public networking (generates `RAILWAY_PUBLIC_DOMAIN`)
5. Deploy
