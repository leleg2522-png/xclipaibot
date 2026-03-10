# Telegram Bot - Kling 2.6 Motion Control

## Overview
Telegram bot that generates motion control videos using Freepik's Kling 2.6 Motion Control API. The bot transfers motion from a reference video to a character image.

## Architecture
- **Runtime**: Node.js 22
- **Entry point**: `index.js`
- **Dependencies**: `node-telegram-bot-api`, `axios`
- **Workflow**: "Telegram Bot" runs `node index.js`

## How It Works
1. User sends a character image via Telegram
2. User sends a reference motion video
3. Bot submits both to Freepik Kling 2.6 Motion Control API
4. Bot polls for task completion and sends the resulting video back

## API Endpoints Used
- **Generate (Standard)**: `POST https://api.freepik.com/v1/ai/video/kling-v2-6-motion-control-std`
- **Generate (Pro)**: `POST https://api.freepik.com/v1/ai/video/kling-v2-6-motion-control-pro`
- **Check Status**: `GET https://api.freepik.com/v1/ai/video/kling-v2-6-motion-control/{task-id}`

## Environment Variables (Secrets)
- `TELEGRAM_BOT_TOKEN` — Telegram bot token from @BotFather
- `FREEPIK_API_KEY` — Freepik API key

## Bot Commands
- `/start` — Show usage guide
- `/generate` — Generate motion control video
- `/prompt [text]` — Set optional text prompt
- `/orientation [video|image]` — Set character orientation
- `/quality [std|pro]` — Set quality tier
- `/status` — Check current session
- `/reset` — Reset session
